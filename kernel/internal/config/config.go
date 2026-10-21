// SPDX-License-Identifier: MIT

// Package config is the kernel's settings, read once from the environment
// (the chart's ConfigMap) and checked at startup, so a misconfiguration
// fails at once and legibly. One Settings for every process (kernel-api,
// kernel-scheduler, the sleeper): each reads what it needs; they share the
// ConfigMap.
package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	"k8s.io/apimachinery/pkg/util/validation"

	"github.com/rburns629/vertra/kernel/internal/domain"
)

// Toleration is one Pod toleration, as the Pod spec spells it.
type Toleration struct {
	Key               string `json:"key,omitempty"`
	Operator          string `json:"operator,omitempty"`
	Value             string `json:"value,omitempty"`
	Effect            string `json:"effect,omitempty"`
	TolerationSeconds *int64 `json:"tolerationSeconds,omitempty"`
}

// Settings is every process's settings.
type Settings struct {
	DatabaseURL string
	// Longest any one statement may run before it fails.
	DatabaseCommandTimeout time.Duration

	// kernel-api. Who may call it: each request carries a Kubernetes
	// ServiceAccount token issued for APITokenAudience; a TokenReview checks
	// it, and its username must be in APIAllowedCallers
	// ("system:serviceaccount:<namespace>:<name>": the console's). An empty
	// list refuses everyone. APIAuth "disabled" skips the check, for running
	// kernel-api outside a cluster in development only.
	APIAuth              string
	APITokenAudience     string
	APIAllowedCallers    []string
	APIPort              int
	MaxTasksPerExecution int

	// The sleeper (`kernel sleep`, the chart's scaleDown CronJob): scales
	// the platform's Deployments to zero once nothing has happened for
	// SleeperIdleAfter: no execution unfinished, none finished, nobody using
	// the console (its activity ConfigMap), kernel-api not restarted (woken
	// or upgraded). The databases go last.
	SleeperNamespace   string
	SleeperIdleAfter   time.Duration
	SleeperDeployments []string
	SleeperDatabases   []string
	// Where each Deployment's copies are kept while asleep, for waking.
	SleeperStateConfigMap string
	// The console's activity ConfigMap; empty: not consulted.
	SleeperConsoleActivityConfigMap string
	// kernel-api's Pods: the newest one's start counts as activity.
	SleeperAPIPodSelector string
	// The sleeper's own CronJob: suspended while asleep, so it doesn't start
	// a Pod (on EKS Auto Mode, a node) every few minutes to find nothing to
	// do. Waking resumes it (vertra wake). Empty: never suspended.
	SleeperCronJob string
	// A scheduled sleep (--now) waits this long for unfinished executions.
	SleeperScheduledWait time.Duration

	// kernel-scheduler, below.

	// The longest the scheduler waits between passes when nothing has
	// happened. A watched change (a step finishing) wakes it sooner, and a
	// pass that made progress is followed by the next one at once.
	PollInterval  time.Duration
	LeaseDuration time.Duration
	// How many READY tasks one pass claims, and how many executor calls
	// (Job starts, status reads) it has in flight at once.
	ClaimLimit          int
	ExecutorConcurrency int
	// The most tasks claimed or running at once, across the platform and
	// per team (0: no limit), so a burst can't run up the bill or crowd out
	// other teams. Tasks over a limit wait, READY, for a later pass. Exact
	// with one scheduler; see claimReadyTasks for several.
	MaxRunning        int
	MaxRunningPerTeam int
	// Between a failed task's attempts: Base after the first failure,
	// doubling after each, at most Max.
	RetryBackoff domain.RetryBackoff
	// How many times in a row the scheduler retries starting the same
	// attempt after the start erred (each retry adopts the Job that start
	// may have made), before failing the attempt.
	MaxDispatchFailures int
	// A running step whose Job and Pod haven't changed (per the watch) isn't
	// re-read from the API, except once this often, in case an event was
	// missed.
	WatchResync time.Duration

	// Env vars set on every step container, whatever its image: knobs every
	// Pod needs the same value for (GCP_TARGET_SERVICE_ACCOUNT, say). One
	// that varies per task belongs in that task's inputs.
	TaskExtraEnvironment map[string]string
	// The Pod size for any part a task doesn't set itself. Unset, a task
	// with no size of its own requests nothing and the cluster's defaults
	// apply (on GKE Autopilot, 0.5 vCPU and 2 GiB).
	TaskDefaultResources *domain.TaskResources
	// Where step Pods may run, each in the Pod spec's own shape: how a
	// deployment sends steps to cheaper (Spot) capacity; see the per-cloud
	// examples in the execution-kernel chart's values.yaml.
	TaskNodeSelector map[string]string
	TaskTolerations  []Toleration
	TaskAffinity     map[string]any
	// Labels added to every step Pod, for webhooks that act on a label
	// (AKS Workload Identity's azure.workload.identity/use). Never the
	// kernel's own: app and vertra.dev/* are refused.
	TaskPodLabels map[string]string
	// The imagePullSecret every step Pod names, for private registries: the
	// console copies the platform's pull Secret into each team namespace
	// under this name. Empty: none.
	TaskImagePullSecret string
	// Step Pods meet Pod Security's restricted: non-root (a numeric USER), a
	// read-only root filesystem with a writable /tmp, no capabilities, no
	// privilege escalation, the runtime's seccomp profile, no Kubernetes
	// token. Off only for images that can't.
	TaskPodHardening bool

	JobTTL time.Duration
	// How long an image may keep failing to pull for a reason other than
	// "it doesn't exist" (registry auth, network) before the task fails as
	// IMAGE_PULL_FAILED. A missing image fails at once.
	ImagePullGrace time.Duration
	// Longest any one Kubernetes API call may take before it fails.
	KubernetesTimeout time.Duration
	// A Job's activeDeadlineSeconds is its task's timeout plus this: a
	// backstop for a Job the scheduler lost track of. The scheduler relies
	// on it too: a timed-out task whose Job it can't stop is failed (and
	// maybe retried) only once this deadline has passed.
	JobDeadlineGrace time.Duration

	// A step's stored output: its last TaskLogMaxLines lines, at most
	// TaskLogMaxBytes, refreshed this often while it runs and once more
	// when it ends.
	TaskLogMaxLines int
	TaskLogMaxBytes int
	TaskLogRefresh  time.Duration

	// Finished executions (tasks, outputs, logs, events) are deleted this
	// many days after their last event; 0 keeps them forever.
	ExecutionRetentionDays int
	// Touched each time the loop comes round (and while it waits for
	// migrations); the liveness probe restarts the Pod if it goes stale.
	HeartbeatFile string
	// The port /metrics is served on (the scheduler has no other server).
	MetricsPort int
}

type reader struct {
	getenv   func(string) string
	problems []string
}

func (r *reader) raw(name string) (string, bool) {
	v := strings.TrimSpace(r.getenv(name))
	return v, v != ""
}

func (r *reader) str(name, fallback string) string {
	if v, ok := r.raw(name); ok {
		return v
	}
	return fallback
}

func (r *reader) number(name string, fallback float64, positive bool) float64 {
	v, ok := r.raw(name)
	if !ok {
		return fallback
	}
	n, err := strconv.ParseFloat(v, 64)
	switch {
	case err != nil:
		r.problems = append(r.problems, fmt.Sprintf("%s: not a number: %q", name, v))
	case positive && n <= 0:
		r.problems = append(r.problems, fmt.Sprintf("%s: must be greater than 0, got %s", name, v))
	case n < 0:
		r.problems = append(r.problems, fmt.Sprintf("%s: must not be negative, got %s", name, v))
	}
	return n
}

func (r *reader) integer(name string, fallback int, positive bool) int {
	n := r.number(name, float64(fallback), positive)
	if n != float64(int(n)) {
		r.problems = append(r.problems, fmt.Sprintf("%s: must be a whole number", name))
	}
	return int(n)
}

func (r *reader) seconds(name string, fallback float64, positive bool) time.Duration {
	return time.Duration(r.number(name, fallback, positive) * float64(time.Second))
}

func (r *reader) boolean(name string, fallback bool) bool {
	v, ok := r.raw(name)
	if !ok {
		return fallback
	}
	switch strings.ToLower(v) {
	case "1", "true", "yes", "on", "t", "y":
		return true
	case "0", "false", "no", "off", "f", "n":
		return false
	}
	r.problems = append(r.problems, fmt.Sprintf("%s: not true or false: %q", name, v))
	return fallback
}

// jsonValue decodes a JSON setting; empty or "null" leaves into as it is.
// An unknown field is refused: a misspelt toleration would otherwise be
// dropped without a word.
func (r *reader) jsonValue(name string, into any) {
	v, ok := r.raw(name)
	if !ok || v == "null" {
		return
	}
	decoder := json.NewDecoder(strings.NewReader(v))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(into); err != nil {
		r.problems = append(r.problems, fmt.Sprintf("%s: not valid JSON of the right shape: %v", name, err))
	}
}

// Load reads the settings from getenv (os.Getenv).
func Load(getenv func(string) string) (Settings, error) {
	r := &reader{getenv: getenv}
	s := Settings{
		DatabaseURL:                     r.str("DATABASE_URL", "postgresql://localhost/execution_kernel"),
		DatabaseCommandTimeout:          r.seconds("DATABASE_COMMAND_TIMEOUT_SECONDS", 60, true),
		APIAuth:                         r.str("API_AUTH", "tokenreview"),
		APITokenAudience:                r.str("API_TOKEN_AUDIENCE", "vertra-kernel-api"),
		APIPort:                         r.integer("API_PORT", 8000, true),
		MaxTasksPerExecution:            r.integer("MAX_TASKS_PER_EXECUTION", 500, true),
		SleeperNamespace:                r.str("SLEEPER_NAMESPACE", ""),
		SleeperIdleAfter:                r.seconds("SLEEPER_IDLE_AFTER_SECONDS", 7200, true),
		SleeperStateConfigMap:           r.str("SLEEPER_STATE_CONFIGMAP", ""),
		SleeperConsoleActivityConfigMap: r.str("SLEEPER_CONSOLE_ACTIVITY_CONFIGMAP", ""),
		SleeperAPIPodSelector:           r.str("SLEEPER_API_POD_SELECTOR", ""),
		SleeperCronJob:                  r.str("SLEEPER_CRONJOB", ""),
		SleeperScheduledWait:            r.seconds("SLEEPER_SCHEDULED_WAIT_SECONDS", 6*3600, true),
		PollInterval:                    r.seconds("SCHEDULER_POLL_INTERVAL_SECONDS", 1, true),
		LeaseDuration:                   r.seconds("LEASE_DURATION_SECONDS", 60, true),
		ClaimLimit:                      r.integer("SCHEDULER_CLAIM_LIMIT", 50, true),
		ExecutorConcurrency:             r.integer("SCHEDULER_EXECUTOR_CONCURRENCY", 16, true),
		MaxRunning:                      r.integer("SCHEDULER_MAX_RUNNING_TASKS", 0, false),
		MaxRunningPerTeam:               r.integer("SCHEDULER_MAX_RUNNING_TASKS_PER_TEAM", 0, false),
		RetryBackoff: domain.RetryBackoff{
			Base: r.seconds("SCHEDULER_RETRY_BACKOFF_SECONDS", 5, false),
			Max:  r.seconds("SCHEDULER_RETRY_BACKOFF_MAX_SECONDS", 300, false),
		},
		MaxDispatchFailures:    r.integer("SCHEDULER_MAX_DISPATCH_FAILURES", 5, true),
		WatchResync:            r.seconds("KUBERNETES_WATCH_RESYNC_SECONDS", 30, true),
		TaskImagePullSecret:    r.str("TASK_IMAGE_PULL_SECRET", ""),
		TaskPodHardening:       r.boolean("TASK_POD_HARDENING", true),
		JobTTL:                 r.seconds("KUBERNETES_JOB_TTL_SECONDS", 3600, false),
		ImagePullGrace:         r.seconds("IMAGE_PULL_GRACE_SECONDS", 120, true),
		KubernetesTimeout:      r.seconds("KUBERNETES_REQUEST_TIMEOUT_SECONDS", 30, true),
		JobDeadlineGrace:       r.seconds("KUBERNETES_JOB_DEADLINE_GRACE_SECONDS", 600, false),
		TaskLogMaxLines:        r.integer("TASK_LOG_MAX_LINES", 5000, true),
		TaskLogMaxBytes:        r.integer("TASK_LOG_MAX_BYTES", 1_048_576, true),
		TaskLogRefresh:         r.seconds("TASK_LOG_REFRESH_SECONDS", 60, true),
		ExecutionRetentionDays: r.integer("EXECUTION_RETENTION_DAYS", 90, false),
		HeartbeatFile:          r.str("SCHEDULER_HEARTBEAT_FILE", "/tmp/vertra-scheduler-heartbeat"),
		MetricsPort:            r.integer("METRICS_PORT", 9090, true),
	}
	if s.APIAuth != "tokenreview" && s.APIAuth != "disabled" {
		r.problems = append(r.problems, fmt.Sprintf("API_AUTH: tokenreview or disabled, got %q", s.APIAuth))
	}
	r.jsonValue("API_ALLOWED_CALLERS", &s.APIAllowedCallers)
	r.jsonValue("SLEEPER_DEPLOYMENTS", &s.SleeperDeployments)
	r.jsonValue("SLEEPER_DATABASE_DEPLOYMENTS", &s.SleeperDatabases)
	r.jsonValue("TASK_EXTRA_ENVIRONMENT", &s.TaskExtraEnvironment)
	r.jsonValue("TASK_NODE_SELECTOR", &s.TaskNodeSelector)
	r.jsonValue("TASK_TOLERATIONS", &s.TaskTolerations)
	r.jsonValue("TASK_AFFINITY", &s.TaskAffinity)
	r.jsonValue("TASK_POD_LABELS", &s.TaskPodLabels)
	for key, value := range s.TaskPodLabels {
		if problem := podLabelProblem(key, value); problem != "" {
			r.problems = append(r.problems, "TASK_POD_LABELS: "+problem)
		}
	}
	var resources domain.TaskResources
	r.jsonValue("TASK_DEFAULT_RESOURCES", &resources)
	if err := resources.Check(); err != nil {
		r.problems = append(r.problems, "TASK_DEFAULT_RESOURCES: "+err.Error())
	}
	if resources != (domain.TaskResources{}) {
		s.TaskDefaultResources = &resources
	}
	// The Python kernel's URL names its driver (postgresql+asyncpg://).
	s.DatabaseURL = strings.Replace(s.DatabaseURL, "postgresql+asyncpg://", "postgresql://", 1)
	if len(r.problems) > 0 {
		return Settings{}, errors.New("invalid settings:\n  " + strings.Join(r.problems, "\n  "))
	}
	return s, nil
}

// podLabelProblem is why a TASK_POD_LABELS entry can't be used: not a
// valid label, or one of the kernel's own, which the executor and console
// read back and a setting mustn't be able to forge.
func podLabelProblem(key, value string) string {
	if errs := validation.IsQualifiedName(key); len(errs) > 0 {
		return fmt.Sprintf("%q isn't a label key: %s", key, strings.Join(errs, "; "))
	}
	if errs := validation.IsValidLabelValue(value); len(errs) > 0 {
		return fmt.Sprintf("%q's value %q isn't a label value: %s", key, value, strings.Join(errs, "; "))
	}
	if key == "app" || strings.HasPrefix(key, "vertra.dev/") {
		return fmt.Sprintf("%q is the kernel's own label", key)
	}
	return ""
}

// FromEnv is Load(os.Getenv).
func FromEnv() (Settings, error) { return Load(os.Getenv) }
