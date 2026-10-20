// SPDX-License-Identifier: MIT

package executor

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"

	"github.com/rburns629/acyclix/kernel/internal/domain"
)

// One task attempt runs as a single-Pod Job. Its request goes in as a
// ConfigMap (request.json) mounted read-only at /platform/input; its result
// comes back through the container's termination message, which points at
// /platform/output/result.json (an emptyDir). So no sidecar, no object
// storage, no exec into a dead container. The kubelet caps the message at
// 4096 bytes: step outputs are references, not data.
const (
	requestMountPath = "/platform/input"
	resultMountPath  = "/platform/output"
	resultFilePath   = resultMountPath + "/result.json"
	secretMountPath  = "/platform/secrets"
	containerName    = "product"
	kernelLabel      = "app=execution-kernel"
	// How long a finished Job's result stays cached: past the pass that
	// reads it and that pass's retries.
	terminalRetention = 15 * time.Minute
)

// KubernetesOptions configure every step Pod and how the executor talks to
// the API (see the execution-kernel chart's values).
type KubernetesOptions struct {
	JobTTL           time.Duration
	ImagePullGrace   time.Duration
	JobDeadlineGrace time.Duration
	RequestTimeout   time.Duration
	WatchResync      time.Duration
	ExtraEnvironment map[string]string
	DefaultResources *domain.TaskResources
	NodeSelector     map[string]string
	Tolerations      []corev1.Toleration
	Affinity         *corev1.Affinity
	PodHardening     bool
	ImagePullSecret  string
	LogMaxLines      int
	LogMaxBytes      int
}

type terminalRecord struct {
	status     Status
	logs       []string
	recordedAt time.Time
}

// Kubernetes is the Executor backed by Kubernetes Jobs.
type Kubernetes struct {
	client kubernetes.Interface
	opts   KubernetesOptions
	log    *slog.Logger
	watch  *jobWatch

	mu sync.Mutex
	// Captured once a Job finishes, so a pass that rolls back can read the
	// result again after the Job's release. Pruned to terminalRetention.
	terminal map[string]terminalRecord
	// When each running Job was last read with its Pod ready: while the
	// watch is healthy, a Job isn't re-read until it changes or WatchResync
	// passes.
	quietSince map[string]time.Time
}

// NewKubernetes is an executor on client; call Watch to follow changes.
func NewKubernetes(client kubernetes.Interface, opts KubernetesOptions, log *slog.Logger) *Kubernetes {
	return &Kubernetes{client: client, opts: opts, log: log, terminal: map[string]terminalRecord{}, quietSince: map[string]time.Time{}}
}

// call bounds one API request: the client's own default is to wait forever,
// so one half-open connection would stall a pass and the row locks it holds.
func (k *Kubernetes) call(ctx context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(ctx, k.opts.RequestTimeout)
}

var nameUnsafe = regexp.MustCompile(`[^a-z0-9-]`)

// JobName is an attempt's Job and ConfigMap name: deterministic,
// DNS-1123-safe, at most 63 characters; the same as the Python kernel's, so
// either adopts the other's Jobs.
func JobName(executionID, taskKey string, attempt int) string {
	sanitized := strings.Trim(nameUnsafe.ReplaceAllString(strings.ToLower(taskKey), "-"), "-")
	if len(sanitized) > 20 {
		sanitized = sanitized[:20]
	}
	sum := sha256.Sum256([]byte(fmt.Sprintf("%s:%s:%d", executionID, taskKey, attempt)))
	digest := hex.EncodeToString(sum[:])[:16]
	name := "ek-" + digest
	if sanitized != "" {
		name = "ek-" + sanitized + "-" + digest
	}
	if len(name) > 63 {
		name = name[:63]
	}
	return strings.TrimRight(name, "-")
}

// apiMessage is the API server's own message (not the client's dump of it).
func apiMessage(err error) string {
	var status apierrors.APIStatus
	if errors.As(err, &status) {
		if s := status.Status(); s.Message != "" {
			return s.Message
		} else if s.Code != 0 {
			return fmt.Sprintf("%d %s", s.Code, http.StatusText(int(s.Code)))
		}
	}
	return err.Error()
}

// The chart's own policies start their messages with their code.
var policyCodes = []string{"IMAGE_NOT_ALLOWED", "IDENTITY_NOT_ALLOWED", "IMAGE_SCAN_FAILED", "IMAGE_NOT_PINNED"}

// Sigstore's policy-controller refuses with a 400 and this in its message.
const signatureWebhookMarker = `admission webhook "policy.sigstore.dev" denied the request`

func dispatchRejection(err error) *DispatchRejected {
	message := apiMessage(err)
	if strings.Contains(message, signatureWebhookMarker) {
		lines := strings.Split(strings.TrimSpace(message), "\n")
		detail := strings.TrimSpace(lines[len(lines)-1])
		return &DispatchRejected{Code: "IMAGE_NOT_SIGNED", Message: detail + ". The cluster only runs images from the source registry that catalog CI signed after they passed its security scans."}
	}
	for _, code := range policyCodes {
		if i := strings.Index(message, code+": "); i >= 0 {
			return &DispatchRejected{Code: code, Message: message[i+len(code)+2:]}
		}
	}
	return &DispatchRejected{Code: "DISPATCH_REJECTED", Message: message}
}

func isRejection(err error) bool {
	return apierrors.IsForbidden(err) || (apierrors.IsBadRequest(err) && strings.Contains(apiMessage(err), signatureWebhookMarker))
}

// Start creates the attempt's Job, then its request ConfigMap (owned by the
// Job, so Kubernetes removes it with the Job). Idempotent per attempt: a Job
// already there under this attempt's name was made for this same attempt
// (by a pass that rolled back, or a start that raised), and is adopted.
func (k *Kubernetes) Start(ctx context.Context, task ResolvedTask) (Handle, error) {
	name := JobName(task.ExecutionID, task.TaskKey, task.Attempt)
	request, err := json.Marshal(task.ProductRequest())
	if err != nil {
		return nil, err
	}
	job, err := k.jobFor(name, task)
	if err != nil {
		return nil, &DispatchRejected{Code: "DISPATCH_REJECTED", Message: err.Error()}
	}
	uid, err := k.createJob(ctx, task.Team, job)
	if err != nil {
		if isRejection(err) {
			return nil, dispatchRejection(err)
		}
		return nil, err
	}
	if err := k.createConfigMap(ctx, task.Team, name, uid, string(request)); err != nil {
		if apierrors.IsForbidden(err) {
			// Refused by policy: this attempt would never get its request,
			// so its Job would wait for it forever.
			_ = k.deleteJob(ctx, task.Team, name)
			return nil, dispatchRejection(err)
		}
		// Maybe transient: the scheduler retries the same attempt, which
		// adopts the Job and creates the ConfigMap, or discards both.
		return nil, err
	}
	return Handle{"namespace": task.Team, "jobName": name}, nil
}

func (k *Kubernetes) createJob(ctx context.Context, namespace string, job *batchv1.Job) (string, error) {
	callCtx, cancel := k.call(ctx)
	defer cancel()
	created, err := k.client.BatchV1().Jobs(namespace).Create(callCtx, job, metav1.CreateOptions{})
	if apierrors.IsAlreadyExists(err) {
		callCtx, cancel := k.call(ctx)
		defer cancel()
		created, err = k.client.BatchV1().Jobs(namespace).Get(callCtx, job.Name, metav1.GetOptions{})
		if err != nil {
			return "", err
		}
		if created.DeletionTimestamp != nil {
			// Being deleted: nothing left to adopt; the next start retries.
			return "", fmt.Errorf("job %s/%s is being deleted", namespace, job.Name)
		}
		k.log.Info("adopting this attempt's existing Job", "namespace", namespace, "job", job.Name)
		return string(created.UID), nil
	}
	if err != nil {
		return "", err
	}
	return string(created.UID), nil
}

func (k *Kubernetes) createConfigMap(ctx context.Context, namespace, name, jobUID, request string) error {
	callCtx, cancel := k.call(ctx)
	defer cancel()
	_, err := k.client.CoreV1().ConfigMaps(namespace).Create(callCtx, &corev1.ConfigMap{
		ObjectMeta: metav1.ObjectMeta{
			Name:   name,
			Labels: map[string]string{"app": "execution-kernel"},
			OwnerReferences: []metav1.OwnerReference{{
				APIVersion: "batch/v1", Kind: "Job", Name: name, UID: typesUID(jobUID),
			}},
		},
		Data: map[string]string{"request.json": request},
	}, metav1.CreateOptions{})
	if apierrors.IsAlreadyExists(err) { // created along with an adopted Job
		return nil
	}
	return err
}

func (k *Kubernetes) resources(task ResolvedTask) (corev1.ResourceRequirements, error) {
	own := domain.TaskResources{}
	if task.Resources != nil {
		own = *task.Resources
	}
	r := own.Over(k.opts.DefaultResources)
	var requirements corev1.ResourceRequirements
	parse := func(name corev1.ResourceName, value string, into *corev1.ResourceList) error {
		if value == "" {
			return nil
		}
		q, err := resource.ParseQuantity(value)
		if err != nil {
			return fmt.Errorf("resources: %s %q isn't a Kubernetes quantity", name, value)
		}
		if *into == nil {
			*into = corev1.ResourceList{}
		}
		(*into)[name] = q
		return nil
	}
	if err := parse(corev1.ResourceCPU, r.CPU, &requirements.Requests); err != nil {
		return requirements, err
	}
	if err := parse(corev1.ResourceMemory, r.Memory, &requirements.Requests); err != nil {
		return requirements, err
	}
	limit := r.MemoryLimit
	if limit == "" {
		limit = r.Memory
	}
	return requirements, parse(corev1.ResourceMemory, limit, &requirements.Limits)
}

func (k *Kubernetes) jobFor(name string, task ResolvedTask) (*batchv1.Job, error) {
	resources, err := k.resources(task)
	if err != nil {
		return nil, err
	}
	// One volume per Secret, mounted at /platform/secrets/<name>/ (one file
	// per key). Named by position: a Secret name may be longer than a
	// volume name may be. A missing Secret fails the Pod's mount visibly.
	mounts := []corev1.VolumeMount{
		{Name: "input", MountPath: requestMountPath, ReadOnly: true},
		{Name: "output", MountPath: resultMountPath},
	}
	volumes := []corev1.Volume{
		{Name: "input", VolumeSource: corev1.VolumeSource{ConfigMap: &corev1.ConfigMapVolumeSource{LocalObjectReference: corev1.LocalObjectReference{Name: name}}}},
		{Name: "output", VolumeSource: corev1.VolumeSource{EmptyDir: &corev1.EmptyDirVolumeSource{}}},
	}
	for i, secret := range task.SecretRefs {
		volume := fmt.Sprintf("secret-%d", i)
		mounts = append(mounts, corev1.VolumeMount{Name: volume, MountPath: secretMountPath + "/" + secret, ReadOnly: true})
		volumes = append(volumes, corev1.Volume{Name: volume, VolumeSource: corev1.VolumeSource{Secret: &corev1.SecretVolumeSource{SecretName: secret}}})
	}
	var env []corev1.EnvVar
	keys := make([]string, 0, len(k.opts.ExtraEnvironment))
	for key := range k.opts.ExtraEnvironment {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		env = append(env, corev1.EnvVar{Name: key, Value: k.opts.ExtraEnvironment[key]})
	}
	// Images are pinned to a digest at submission (repo:latest@sha256:…),
	// and a digest never changes. A registry ":latest" that arrives
	// unpinned is pulled every time; a bare "name:latest" (a kind-loaded
	// image) has nowhere to pull from.
	pullPolicy := corev1.PullIfNotPresent
	if strings.HasSuffix(task.Image, ":latest") && strings.Contains(task.Image, "/") {
		pullPolicy = corev1.PullAlways
	}
	f := false
	security := &corev1.SecurityContext{Privileged: &f, AllowPrivilegeEscalation: &f}
	var podSecurity *corev1.PodSecurityContext
	var automount *bool
	if k.opts.PodHardening {
		// Pod Security's restricted: non-root (a numeric non-root USER), a
		// read-only root filesystem with a writable /tmp, no capabilities,
		// the runtime's seccomp profile, no Kubernetes token.
		t := true
		seccomp := &corev1.SeccompProfile{Type: corev1.SeccompProfileTypeRuntimeDefault}
		security.RunAsNonRoot, security.ReadOnlyRootFilesystem = &t, &t
		security.Capabilities = &corev1.Capabilities{Drop: []corev1.Capability{"ALL"}}
		security.SeccompProfile = seccomp
		podSecurity = &corev1.PodSecurityContext{RunAsNonRoot: &t, SeccompProfile: seccomp}
		automount = &f
		mounts = append(mounts, corev1.VolumeMount{Name: "tmp", MountPath: "/tmp"})
		volumes = append(volumes[:2], append([]corev1.Volume{{Name: "tmp", VolumeSource: corev1.VolumeSource{EmptyDir: &corev1.EmptyDirVolumeSource{}}}}, volumes[2:]...)...)
	}
	var pullSecrets []corev1.LocalObjectReference
	if k.opts.ImagePullSecret != "" {
		pullSecrets = []corev1.LocalObjectReference{{Name: k.opts.ImagePullSecret}}
	}
	// So the console can show a Pod as "task X of execution Y": the task
	// key is caller-chosen (maybe not a valid label), so an annotation.
	labels := map[string]string{"app": "execution-kernel", "acyclix.dev/execution-id": task.ExecutionID, "acyclix.dev/attempt": strconv.Itoa(task.Attempt)}
	annotations := map[string]string{"acyclix.dev/task": task.TaskKey}
	backoff := int32(0) // one attempt per Job: the scheduler owns retries
	ttl := int32(k.opts.JobTTL.Seconds())
	// A backstop: a Job the scheduler lost track of mustn't run forever.
	deadline := int64(task.TimeoutSeconds) + int64(k.opts.JobDeadlineGrace.Seconds())
	return &batchv1.Job{
		ObjectMeta: metav1.ObjectMeta{Name: name, Labels: labels, Annotations: annotations},
		Spec: batchv1.JobSpec{
			BackoffLimit: &backoff, TTLSecondsAfterFinished: &ttl, ActiveDeadlineSeconds: &deadline,
			Template: corev1.PodTemplateSpec{
				ObjectMeta: metav1.ObjectMeta{Labels: labels, Annotations: annotations},
				Spec: corev1.PodSpec{
					RestartPolicy: corev1.RestartPolicyNever,
					Containers: []corev1.Container{{
						Name: containerName, Image: task.Image, ImagePullPolicy: pullPolicy, Args: []string{task.Action},
						Env: env, VolumeMounts: mounts, TerminationMessagePath: resultFilePath,
						TerminationMessagePolicy: corev1.TerminationMessageReadFile, SecurityContext: security, Resources: resources,
					}},
					AutomountServiceAccountToken: automount,
					SecurityContext:              podSecurity,
					ServiceAccountName:           task.ServiceAccount,
					Volumes:                      volumes,
					NodeSelector:                 k.opts.NodeSelector,
					Tolerations:                  k.opts.Tolerations,
					Affinity:                     k.opts.Affinity,
					ImagePullSecrets:             pullSecrets,
				},
			},
		},
	}, nil
}

func handleParts(handle Handle) (namespace, name string) {
	namespace, _ = handle["namespace"].(string)
	name, _ = handle["jobName"].(string)
	return namespace, name
}

func (k *Kubernetes) remember(name string, record terminalRecord) {
	k.mu.Lock()
	defer k.mu.Unlock()
	delete(k.quietSince, name)
	record.recordedAt = time.Now()
	k.terminal[name] = record
	cutoff := time.Now().Add(-terminalRetention)
	for n, r := range k.terminal {
		if r.recordedAt.Before(cutoff) {
			delete(k.terminal, n)
		}
	}
}

func (k *Kubernetes) cached(name string) (terminalRecord, bool) {
	k.mu.Lock()
	defer k.mu.Unlock()
	r, ok := k.terminal[name]
	return r, ok
}

func (k *Kubernetes) unchangedSinceLastRead(name string) bool {
	if k.watch == nil || !k.watch.healthy() {
		return false
	}
	// Taken before deciding, so a change during the read marks it again.
	changed := k.watch.takeChanged(name)
	k.mu.Lock()
	readAt, ok := k.quietSince[name]
	k.mu.Unlock()
	if changed || !ok {
		return false
	}
	return time.Since(readAt) < k.opts.WatchResync
}

// Status reads an attempt's Job.
func (k *Kubernetes) Status(ctx context.Context, handle Handle) (Status, error) {
	namespace, name := handleParts(handle)
	if record, ok := k.cached(name); ok {
		return record.status, nil
	}
	if k.unchangedSinceLastRead(name) {
		return Status{State: Running}, nil
	}
	callCtx, cancel := k.call(ctx)
	defer cancel()
	job, err := k.client.BatchV1().Jobs(namespace).Get(callCtx, name, metav1.GetOptions{})
	if apierrors.IsNotFound(err) {
		// A Job is only deleted after its outcome is committed, and never
		// polled after that: this one went another way (by hand, or its TTL
		// while no scheduler ran). Its result is lost; a retry may make up.
		record := terminalRecord{status: Status{State: Failed, Error: &domain.StructuredError{
			Code: "JOB_NOT_FOUND", Message: "The task's Job no longer exists, so its result was lost.", Retryable: true}}}
		k.remember(name, record)
		return record.status, nil
	}
	if err != nil {
		return Status{}, err
	}
	if job.Status.Succeeded == 0 && job.Status.Failed == 0 {
		// A ready Pod has its image; only one not yet ready can be stuck
		// pulling it. A ready one is left alone until the watch reports a
		// change; a stuck pull is caught by the grace period.
		if job.Status.Ready != nil && *job.Status.Ready > 0 {
			k.mu.Lock()
			k.quietSince[name] = time.Now()
			k.mu.Unlock()
			return Status{State: Running}, nil
		}
		pullError, err := k.imagePullError(ctx, namespace, name)
		if err != nil {
			return Status{}, err
		}
		if pullError == nil {
			return Status{State: Running}, nil
		}
		k.log.Warn("task image can't be pulled", "namespace", namespace, "job", name, "code", pullError.Code)
		// Left in place until the failure is committed (Release).
		record := terminalRecord{status: Status{State: Failed, Error: pullError}}
		k.remember(name, record)
		return record.status, nil
	}
	record, err := k.finalize(ctx, namespace, name)
	if err != nil {
		return Status{}, err
	}
	k.remember(name, record)
	return record.status, nil
}

func (k *Kubernetes) pods(ctx context.Context, namespace, job string) ([]corev1.Pod, error) {
	callCtx, cancel := k.call(ctx)
	defer cancel()
	list, err := k.client.CoreV1().Pods(namespace).List(callCtx, metav1.ListOptions{LabelSelector: "job-name=" + job})
	if err != nil {
		return nil, err
	}
	return list.Items, nil
}

func (k *Kubernetes) imagePullError(ctx context.Context, namespace, job string) (*domain.StructuredError, error) {
	pods, err := k.pods(ctx, namespace, job)
	if err != nil {
		return nil, err
	}
	for _, pod := range pods {
		age := time.Since(pod.CreationTimestamp.Time)
		for _, cs := range pod.Status.ContainerStatuses {
			if cs.Name != containerName || cs.State.Waiting == nil {
				continue
			}
			if e := ImagePullFailure(cs.State.Waiting.Reason, cs.State.Waiting.Message, cs.Image, age, k.opts.ImagePullGrace); e != nil {
				return e, nil
			}
		}
	}
	return nil, nil
}

var imageNotFound = regexp.MustCompile(`(?i)\bnot found\b|manifest unknown|NotFound`)

const kubeletMessageLimit = 1000

func truncate(s string, n int) string {
	if r := []rune(s); len(r) > n {
		return string(r[:n])
	}
	return s
}

// ImagePullFailure is the failure for a container stuck on its image, or
// nil to keep waiting. A missing or malformed image can't recover, so it
// fails at once and isn't retried; anything else (registry auth, network)
// gets grace to clear up first.
func ImagePullFailure(reason, message, image string, podAge, grace time.Duration) *domain.StructuredError {
	short := truncate(message, kubeletMessageLimit)
	pulling := reason == "ErrImagePull" || reason == "ImagePullBackOff"
	switch {
	case reason == "InvalidImageName":
		return &domain.StructuredError{Code: "IMAGE_INVALID", Message: fmt.Sprintf("Image reference %q is invalid: %s", image, short)}
	case reason == "ErrImageNeverPull" || (pulling && imageNotFound.MatchString(message)):
		return &domain.StructuredError{Code: "IMAGE_NOT_FOUND", Message: fmt.Sprintf("Image %q no longer exists or was never published: %s", image, short)}
	case pulling && podAge > grace:
		return &domain.StructuredError{Code: "IMAGE_PULL_FAILED", Message: fmt.Sprintf("Image %q couldn't be pulled for %ds: %s", image, int(podAge.Seconds()), short), Retryable: true}
	}
	return nil
}

// finalize captures a finished Job's logs and result. The Job and ConfigMap
// stay until Release: deleting them before the result was committed lost a
// finished step's outputs whenever that commit failed.
func (k *Kubernetes) finalize(ctx context.Context, namespace, job string) (terminalRecord, error) {
	pod, terminated, err := k.terminatedContainer(ctx, namespace, job)
	if err != nil {
		return terminalRecord{}, err
	}
	var logs []string
	if pod != "" {
		logs = k.readLogs(ctx, namespace, pod)
	}
	return terminalRecord{status: buildStatus(terminated, logs), logs: logs}, nil
}

func (k *Kubernetes) terminatedContainer(ctx context.Context, namespace, job string) (string, *corev1.ContainerStateTerminated, error) {
	pods, err := k.pods(ctx, namespace, job)
	if err != nil || len(pods) == 0 {
		return "", nil, err
	}
	pod := pods[0]
	for _, cs := range pod.Status.ContainerStatuses {
		if cs.Name == containerName && cs.State.Terminated != nil {
			return pod.Name, cs.State.Terminated, nil
		}
	}
	return pod.Name, nil, nil
}

// readLogs is the container's output: its last LogMaxLines lines, at most
// LogMaxBytes, with credentials it printed by mistake redacted.
func (k *Kubernetes) readLogs(ctx context.Context, namespace, pod string) []string {
	callCtx, cancel := k.call(ctx)
	defer cancel()
	tail := int64(k.opts.LogMaxLines)
	limit := int64(k.opts.LogMaxBytes)
	raw, err := k.client.CoreV1().Pods(namespace).GetLogs(pod, &corev1.PodLogOptions{
		Container: containerName, TailLines: &tail, LimitBytes: &limit}).DoRaw(callCtx)
	if err != nil {
		return []string{}
	}
	return k.logLines(raw)
}

// logLines is a log read as lines, redacted, with a note first when it may
// have been cut short.
func (k *Kubernetes) logLines(raw []byte) []string {
	text := strings.ToValidUTF8(string(raw), "�")
	lines := strings.Split(text, "\n")
	if strings.HasSuffix(text, "\n") {
		lines = lines[:len(lines)-1]
	}
	if text == "" {
		lines = []string{}
	}
	lines = domain.RedactLines(splitLines(lines))
	if len(lines) >= k.opts.LogMaxLines || len(raw) >= k.opts.LogMaxBytes {
		lines = append([]string{fmt.Sprintf("[acyclix: earlier output not kept; the last %d lines, at most %d bytes, are]", k.opts.LogMaxLines, k.opts.LogMaxBytes)}, lines...)
	}
	return lines
}

// splitLines also breaks on \r\n and lone \r, as Python's splitlines does.
func splitLines(lines []string) []string {
	var out []string
	for _, l := range lines {
		l = strings.TrimSuffix(l, "\r")
		out = append(out, strings.Split(l, "\r")...)
	}
	if out == nil {
		return []string{}
	}
	return out
}

func buildStatus(terminated *corev1.ContainerStateTerminated, logs []string) Status {
	if terminated == nil {
		return Status{State: Failed, Error: &domain.StructuredError{Code: "POD_TERMINATED_UNEXPECTEDLY",
			Message: "Job finished but no terminated container status was found.", Retryable: true}}
	}
	if terminated.Message == "" {
		tail := logs
		if len(tail) > 50 {
			tail = tail[len(tail)-50:]
		}
		joined := strings.Join(tail, "\n")
		if len(joined) > 2000 {
			joined = joined[len(joined)-2000:]
		}
		return Status{State: Failed, Error: &domain.StructuredError{Code: "PRODUCT_RESULT_MISSING", Retryable: true,
			Message: fmt.Sprintf("Container exited with code %d without writing %s. Recent logs: %s", terminated.ExitCode, resultFilePath, joined)}}
	}
	result, err := domain.ParseTaskResult([]byte(terminated.Message))
	if err != nil {
		return Status{State: Failed, Error: &domain.StructuredError{Code: "PRODUCT_RESULT_INVALID", Retryable: true,
			Message: domain.RedactText("Container's result.json was invalid: " + err.Error())}}
	}
	if result.Status == "succeeded" {
		// Outputs are stored, passed on and readable by anyone who can read
		// the execution: one holding a credential fails the task.
		if kind := domain.FindCredential(result.Outputs); kind != "" {
			return Status{State: Failed, Error: &domain.StructuredError{Code: "OUTPUT_CONTAINS_CREDENTIAL",
				Message: fmt.Sprintf("The step's outputs contain what looks like a credential (%s), so they weren't stored. A step must never return the credentials it uses: output a reference (a name, a URI) instead.", kind)}}
		}
		return Status{State: Succeeded, Outputs: result.Outputs}
	}
	e := *result.Error
	e.Message = domain.RedactText(e.Message)
	return Status{State: Failed, Error: &e}
}

func (k *Kubernetes) deleteJob(ctx context.Context, namespace, name string) error {
	callCtx, cancel := k.call(ctx)
	defer cancel()
	background := metav1.DeletePropagationBackground
	err := k.client.BatchV1().Jobs(namespace).Delete(callCtx, name, metav1.DeleteOptions{PropagationPolicy: &background})
	if apierrors.IsNotFound(err) {
		return nil
	}
	return err
}

func (k *Kubernetes) deleteConfigMap(ctx context.Context, namespace, name string) error {
	callCtx, cancel := k.call(ctx)
	defer cancel()
	err := k.client.CoreV1().ConfigMaps(namespace).Delete(callCtx, name, metav1.DeleteOptions{})
	if apierrors.IsNotFound(err) {
		return nil
	}
	return err
}

func (k *Kubernetes) remove(ctx context.Context, namespace, name string) error {
	k.mu.Lock()
	delete(k.quietSince, name)
	k.mu.Unlock()
	if err := k.deleteJob(ctx, namespace, name); err != nil {
		return err
	}
	return k.deleteConfigMap(ctx, namespace, name)
}

// Cancel stops an attempt; one already finished is left for Release.
func (k *Kubernetes) Cancel(ctx context.Context, handle Handle) error {
	namespace, name := handleParts(handle)
	if _, ok := k.cached(name); ok {
		return nil
	}
	return k.remove(ctx, namespace, name)
}

// Release removes a finished attempt's Job and ConfigMap. Its cached result
// stays, so a late read still finds it. Missed (the scheduler stopped
// first), the Job's TTL removes it.
func (k *Kubernetes) Release(ctx context.Context, handle Handle) error {
	namespace, name := handleParts(handle)
	return k.remove(ctx, namespace, name)
}

// Discard removes what a Start of this attempt may have left.
func (k *Kubernetes) Discard(ctx context.Context, task ResolvedTask) error {
	return k.remove(ctx, task.Team, JobName(task.ExecutionID, task.TaskKey, task.Attempt))
}

// ListAttempts is every kernel Job that still exists, made the way this
// kernel makes them.
func (k *Kubernetes) ListAttempts(ctx context.Context) ([]LaunchedAttempt, error) {
	callCtx, cancel := k.call(ctx)
	defer cancel()
	jobs, err := k.client.BatchV1().Jobs("").List(callCtx, metav1.ListOptions{LabelSelector: kernelLabel})
	if err != nil {
		return nil, err
	}
	var attempts []LaunchedAttempt
	for _, job := range jobs.Items {
		executionID := job.Labels["acyclix.dev/execution-id"]
		attempt, err := strconv.Atoi(job.Labels["acyclix.dev/attempt"])
		taskKey := job.Annotations["acyclix.dev/task"]
		if executionID == "" || err != nil || attempt < 1 || taskKey == "" {
			continue
		}
		attempts = append(attempts, LaunchedAttempt{Handle: Handle{"namespace": job.Namespace, "jobName": job.Name},
			ExecutionID: executionID, TaskKey: taskKey, Attempt: attempt, CreatedAt: job.CreationTimestamp.Time})
	}
	return attempts, nil
}

// Logs are an attempt's output: cached once it finished, else read now.
func (k *Kubernetes) Logs(ctx context.Context, handle Handle) ([]string, error) {
	namespace, name := handleParts(handle)
	if record, ok := k.cached(name); ok {
		return record.logs, nil
	}
	pod, _, err := k.terminatedContainer(ctx, namespace, name)
	if err != nil || pod == "" {
		return []string{}, err
	}
	return k.readLogs(ctx, namespace, pod), nil
}

// WaitForChange waits for a watched Job or Pod to change, at most timeout.
func (k *Kubernetes) WaitForChange(ctx context.Context, timeout time.Duration) {
	if k.watch == nil {
		select {
		case <-ctx.Done():
		case <-time.After(timeout):
		}
		return
	}
	k.watch.wait(ctx, timeout)
	// Forget Jobs no longer polled here (finished elsewhere, or adopted by
	// another scheduler).
	stale := time.Now().Add(-10 * k.opts.WatchResync)
	k.mu.Lock()
	for name, at := range k.quietSince {
		if at.Before(stale) {
			delete(k.quietSince, name)
		}
	}
	k.mu.Unlock()
}
