# SPDX-License-Identifier: MIT
"""Kubernetes executor: runs one task attempt as a single-Pod Job via the Kubernetes API.

Every kubernetes-client call is blocking, so each one is pushed off the
event loop with ``asyncio.to_thread``.

Getting the request JSON in and the result JSON out without a privileged
Pod or extra infrastructure (no object storage, no NFS, no message broker)
takes two Kubernetes-native mechanisms:

- **Input**: a ConfigMap holding ``request.json``, mounted read-only at
  ``/platform/input``.
- **Output**: the container's ``terminationMessagePath`` is pointed directly
  at ``/platform/output/result.json`` (itself an ``emptyDir`` volume, so the
  path exists and is writable). Kubernetes already reads whatever a
  container wrote to its termination-message path and surfaces it on the
  Pod's status after the container exits — normally used for a short human
  -readable error, but nothing requires that; pointing it at the product's
  own result file means the kernel gets it back through the API with no
  sidecar and no exec-into-a-dead-container tricks. The kubelet caps this at
  4096 bytes, which is fine for this MVP's small JSON outputs and is a
  documented limitation, not a silent one.
"""

import asyncio
import contextlib
import hashlib
import json
import logging
import re
import threading
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from kubernetes import client, config, watch
from kubernetes.client.exceptions import ApiException
from kubernetes.config.config_exception import ConfigException

from app.contracts.result import StructuredError, TaskResult
from app.contracts.task import TaskResources
from app.domain.credentials import find_credential, redact_lines, redact_text
from app.domain.errors import DispatchRejectedError
from app.executors.base import (
    ExecutionHandle,
    ExecutionStatus,
    ExecutorRunState,
    LaunchedAttempt,
    ResolvedTask,
)

REQUEST_MOUNT_PATH = "/platform/input"
RESULT_MOUNT_PATH = "/platform/output"
RESULT_FILE_PATH = f"{RESULT_MOUNT_PATH}/result.json"
SECRET_MOUNT_PATH = "/platform/secrets"
CONTAINER_NAME = "product"

logger = logging.getLogger(__name__)


def load_kube_config() -> None:
    """In-cluster when running as a Pod (the real deployment); the local
    kubeconfig otherwise (developing or testing against kind/minikube)."""
    try:
        config.load_incluster_config()
    except ConfigException:
        config.load_kube_config()


def _api_error_message(error: ApiException) -> str:
    """The API server's own ``message`` from a Status body, falling back to
    the HTTP reason. ``str(error)`` would include every response header,
    which is noise to whoever reads the task's failure in the console."""
    try:
        message = json.loads(error.body or "")["message"]
    except (ValueError, KeyError, TypeError):
        return f"{error.status} {error.reason}"
    return str(message)


# The chart's own policies start their messages with their code:
# image-policy.yaml, identity-policy.yaml and scan-policy.yaml.
_POLICY_CODES = (
    "IMAGE_NOT_ALLOWED",
    "IDENTITY_NOT_ALLOWED",
    "IMAGE_SCAN_FAILED",
    "IMAGE_NOT_PINNED",
)
# Sigstore's policy-controller (signature verification, see the
# execution-kernel chart's imageSignature) refuses with a 400, not a 403,
# and this in its message.
_SIGNATURE_WEBHOOK_MARKER = 'admission webhook "policy.sigstore.dev" denied the request'


def _dispatch_rejection(error: ApiException) -> DispatchRejectedError:
    """The policy's own explanation, without the API server's wrapper
    ('jobs.batch "ek-..." is forbidden: ValidatingAdmissionPolicy ... denied
    request: '), with the image and identity policies' refusals given their own codes."""
    message = _api_error_message(error)
    if _SIGNATURE_WEBHOOK_MARKER in message:
        # "... failed policy: <policy>: spec...image\n<image>@<digest> <reason>"
        # -> "<image>@<digest> <reason>", the part that says what and why.
        detail = message.splitlines()[-1].strip()
        return DispatchRejectedError(
            f"{detail}. The cluster only runs images from the source registry that "
            "catalog CI signed after they passed its security scans.",
            code="IMAGE_NOT_SIGNED",
        )
    for code in _POLICY_CODES:
        marker = message.find(f"{code}: ")
        if marker >= 0:
            return DispatchRejectedError(message[marker + len(code) + 2 :], code=code)
    return DispatchRejectedError(message)


def job_name_for(execution_id: str, task_key: str, attempt: int) -> str:
    """A deterministic, DNS-1123-safe, sufficiently-unique Job/ConfigMap name.

    Kubernetes names must be lowercase alphanumeric/hyphens and at most 63
    characters; a raw ``{execution_id}-{task_key}-{attempt}`` can violate
    both, so the identifying triple is hashed and a sanitized, truncated
    task key kept only for human readability.
    """
    sanitized = re.sub(r"[^a-z0-9-]", "-", task_key.lower()).strip("-")[:20]
    digest = hashlib.sha256(f"{execution_id}:{task_key}:{attempt}".encode()).hexdigest()[:16]
    name = f"ek-{sanitized}-{digest}" if sanitized else f"ek-{digest}"
    return name[:63].rstrip("-")


# The kubelet's waiting reasons for a container whose image can't be pulled.
_IMAGE_PULL_REASONS = frozenset({"ErrImagePull", "ImagePullBackOff"})
# How registries and runtimes word "this image doesn't exist": containerd's
# "failed to resolve reference ...: not found", the OCI "manifest unknown".
# Deliberately not Docker Hub's "pull access denied, repository does not
# exist or may require authorization": that can also mean a missing
# credential, so it waits out the grace period like any other pull error.
_IMAGE_NOT_FOUND = re.compile(r"\bnot found\b|manifest unknown|NotFound", re.IGNORECASE)
_KUBELET_MESSAGE_LIMIT = 1000


def image_pull_failure(
    waiting_reason: str | None,
    waiting_message: str | None,
    image: str,
    pod_age_seconds: float,
    grace_seconds: int,
) -> StructuredError | None:
    """The failure for a container stuck on its image, or None to keep waiting.

    Without this a task whose image is gone sits in ImagePullBackOff until
    its timeout, fails as a retryable TASK_TIMEOUT, and is retried into the
    same wait. A missing or malformed image can't recover, so it fails at
    once and isn't retried; anything else (registry auth, network) gets
    ``grace_seconds`` to clear up first.
    """
    full_message = waiting_message or ""
    message = full_message[:_KUBELET_MESSAGE_LIMIT]
    if waiting_reason == "InvalidImageName":
        return StructuredError(
            code="IMAGE_INVALID",
            message=f'Image reference "{image}" is invalid: {message}',
            retryable=False,
        )
    if waiting_reason == "ErrImageNeverPull" or (
        waiting_reason in _IMAGE_PULL_REASONS and _IMAGE_NOT_FOUND.search(full_message)
    ):
        return StructuredError(
            code="IMAGE_NOT_FOUND",
            message=f'Image "{image}" no longer exists or was never published: {message}',
            retryable=False,
        )
    if waiting_reason in _IMAGE_PULL_REASONS and pod_age_seconds > grace_seconds:
        return StructuredError(
            code="IMAGE_PULL_FAILED",
            message=(
                f'Image "{image}" couldn\'t be pulled for {int(pod_age_seconds)}s: {message}'
            ),
            retryable=True,
        )
    return None


# Every Job and Pod the kernel creates carries this label (see _create_job).
_KERNEL_LABEL_SELECTOR = "app=execution-kernel"
# How long one watch request stays open before it's listed afresh. The
# fresh list doubles as a periodic resync of every Job and Pod.
_WATCH_TIMEOUT_SECONDS = 300
# A watch's client-side limit: its server-side timeout plus slack, so a
# half-open connection is dropped and the watch restarted instead of
# blocking its thread forever.
_WATCH_REQUEST_TIMEOUT_SECONDS = _WATCH_TIMEOUT_SECONDS + 30
_WATCH_MAX_BACKOFF_SECONDS = 30.0


def _job_name_of(kind: str, obj: object) -> str | None:
    """The Job a watched Job or Pod belongs to."""
    metadata = getattr(obj, "metadata", None)
    if metadata is None:
        return None
    if kind == "jobs":
        name: str | None = metadata.name
        return name
    labels = metadata.labels or {}
    return labels.get("batch.kubernetes.io/job-name") or labels.get("job-name")


class _JobWatch:
    """Watches the kernel's Jobs and their Pods in every namespace.

    So the scheduler learns at once when a step changes (wake), and needn't
    re-read steps that haven't (take_changed). The client's watch blocks, so
    each kind runs in its own daemon thread and hands every event to the
    event loop. Each watch lists everything first, marking every Job
    changed, then watches from that point; when it ends or fails it lists
    again. While either watch is down, ``healthy`` is False and the executor
    reads every status from the API, as it did before watching.
    """

    def __init__(
        self,
        batch_api: client.BatchV1Api,
        core_api: client.CoreV1Api,
        loop: asyncio.AbstractEventLoop,
    ) -> None:
        self._loop = loop
        self._sources = {
            "jobs": batch_api.list_job_for_all_namespaces,
            "pods": core_api.list_pod_for_all_namespaces,
        }
        self._up = dict.fromkeys(self._sources, False)
        self._changed: set[str] = set()
        self._wake = asyncio.Event()

    def start(self) -> None:
        for kind in self._sources:
            threading.Thread(
                target=self._run, args=(kind,), name=f"kernel-watch-{kind}", daemon=True
            ).start()

    @property
    def healthy(self) -> bool:
        return all(self._up.values())

    def take_changed(self, job_name: str) -> bool:
        """Whether the Job changed since it was last asked about, forgetting it."""
        if job_name in self._changed:
            self._changed.discard(job_name)
            return True
        return False

    async def wait(self, timeout: float) -> None:
        """Until something changes, or ``timeout`` seconds pass."""
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(self._wake.wait(), timeout)
        self._wake.clear()

    def mark_changed(self, job_name: str) -> None:
        self._changed.add(job_name)
        self._wake.set()

    def _set_up(self, kind: str, up: bool) -> None:
        self._up[kind] = up

    def _notify(self, kind: str, obj: object) -> None:
        job_name = _job_name_of(kind, obj)
        if job_name:
            self._loop.call_soon_threadsafe(self.mark_changed, job_name)

    def _run(self, kind: str) -> None:
        source = self._sources[kind]
        backoff = 1.0
        while True:
            try:
                listing = source(
                    label_selector=_KERNEL_LABEL_SELECTOR,
                    _request_timeout=_WATCH_REQUEST_TIMEOUT_SECONDS,
                )
                for item in listing.items:
                    self._notify(kind, item)
                self._loop.call_soon_threadsafe(self._set_up, kind, True)
                for event in watch.Watch().stream(
                    source,
                    label_selector=_KERNEL_LABEL_SELECTOR,
                    resource_version=listing.metadata.resource_version,
                    timeout_seconds=_WATCH_TIMEOUT_SECONDS,
                    _request_timeout=_WATCH_REQUEST_TIMEOUT_SECONDS,
                ):
                    self._notify(kind, event["object"])
                backoff = 1.0
            except Exception:
                # Including 410 Gone (the watch's position expired): list again.
                logger.warning(
                    "watch failed; reading every status from the API until it's back",
                    exc_info=True,
                    extra={"kind": kind},
                )
                self._loop.call_soon_threadsafe(self._set_up, kind, False)
                time.sleep(backoff)
                backoff = min(backoff * 2, _WATCH_MAX_BACKOFF_SECONDS)


@dataclass(frozen=True, slots=True)
class _TerminalRecord:
    """What ``get_status``/``get_logs`` serve once a Job has finished and been cleaned up."""

    status: ExecutionStatus
    logs: list[str]
    recorded_at: float = field(default_factory=time.monotonic)


# How long a finished Job's result stays cached after its Job is deleted.
# The cache only has to outlast the scheduler tick that reads it, plus the
# retries of that tick if its commit fails; after that the task is no
# longer polled. Bounded so the scheduler's memory doesn't grow with every
# task it has ever run. A lookup past it finds no Job (JOB_NOT_FOUND).
_TERMINAL_RETENTION_SECONDS = 900


class KubernetesExecutor:
    """Executor backed by Kubernetes Jobs, one Pod per task attempt.

    Implements ``app.executors.base.Executor`` structurally — Protocol
    conformance is duck-typed, no explicit inheritance needed.
    """

    def __init__(
        self,
        *,
        batch_api: client.BatchV1Api | None = None,
        core_api: client.CoreV1Api | None = None,
        job_ttl_seconds: int = 3600,
        image_pull_grace_seconds: int = 120,
        extra_environment: dict[str, str] | None = None,
        watch_resync_seconds: int = 30,
        default_resources: TaskResources | None = None,
        node_selector: dict[str, str] | None = None,
        tolerations: list[dict[str, Any]] | None = None,
        affinity: dict[str, Any] | None = None,
        request_timeout_seconds: float = 30.0,
        job_deadline_grace_seconds: int = 600,
        pod_hardening: bool = True,
        log_max_lines: int = 5000,
        log_max_bytes: int = 1_048_576,
        image_pull_secret: str = "",
    ) -> None:
        if batch_api is None or core_api is None:
            load_kube_config()
        # On every API call: the client's own default is to wait forever, so
        # one half-open connection would stall a scheduling pass (and the row
        # locks it holds) indefinitely. A timed-out call fails like any other.
        self._timeout = request_timeout_seconds
        self._batch_api = batch_api or client.BatchV1Api()
        self._core_api = core_api or client.CoreV1Api()
        self._job_ttl_seconds = job_ttl_seconds
        self._job_deadline_grace_seconds = job_deadline_grace_seconds
        self._pod_hardening = pod_hardening
        self._log_max_lines = log_max_lines
        self._log_max_bytes = log_max_bytes
        self._image_pull_secret = image_pull_secret
        self._image_pull_grace_seconds = image_pull_grace_seconds
        # Applied uniformly to every dispatched Pod, unconditionally --
        # deployment-wide configuration (e.g. GCP_TARGET_SERVICE_ACCOUNT),
        # not per-task. A flag that varies by task belongs in that task's
        # own declared `inputs` instead (see catalog/README.md).
        self._extra_environment = extra_environment or {}
        # Fills whatever a task's own resources leave unset (TaskResources.over).
        self._default_resources = default_resources
        # Where every step Pod may run (see app/config.py's task_node_selector).
        self._node_selector = node_selector or {}
        self._tolerations = tolerations or []
        self._affinity = affinity or {}
        # Captured once a Job reaches a terminal state, then the Job/
        # ConfigMap are deleted, so a tick that rolls back can read the
        # result again. Oldest first (insertion order), pruned by _remember.
        self._terminal: dict[str, _TerminalRecord] = {}
        # Set by start_watching. When healthy, a running step's Job is only
        # re-read once its watch reports a change, or watch_resync_seconds
        # after the last read: _quiet_since holds when each Job was last read
        # running with its Pod ready.
        self._watch: _JobWatch | None = None
        self._watch_resync_seconds = watch_resync_seconds
        self._quiet_since: dict[str, float] = {}

    async def start_watching(self) -> None:
        """Watch this executor's Jobs and Pods from now on (see _JobWatch).

        Call once, from the event loop the executor is used on. Without it,
        every status is read from the API on every call.
        """
        self._watch = _JobWatch(self._batch_api, self._core_api, asyncio.get_running_loop())
        self._watch.start()

    async def wait_for_change(self, timeout: float) -> None:
        """Until a watched Job or Pod changes, or ``timeout`` seconds pass."""
        if self._watch is None:
            await asyncio.sleep(timeout)
            return
        await self._watch.wait(timeout)
        # Forget Jobs no longer polled here (finished elsewhere, or taken
        # over by another scheduler after a lease expired).
        stale = time.monotonic() - 10 * self._watch_resync_seconds
        for job_name in [name for name, at in self._quiet_since.items() if at < stale]:
            del self._quiet_since[job_name]

    def _unchanged_since_last_read(self, job_name: str) -> bool:
        if self._watch is None or not self._watch.healthy:
            return False
        # Taken before deciding, so a change that arrives during a read
        # marks the Job again for the next one.
        changed = self._watch.take_changed(job_name)
        read_at = self._quiet_since.get(job_name)
        if changed or read_at is None:
            return False
        return time.monotonic() - read_at < self._watch_resync_seconds

    def _remember(self, job_name: str, record: _TerminalRecord) -> None:
        self._quiet_since.pop(job_name, None)
        self._terminal[job_name] = record
        cutoff = time.monotonic() - _TERMINAL_RETENTION_SECONDS
        while self._terminal:
            oldest_name, oldest = next(iter(self._terminal.items()))
            if oldest.recorded_at >= cutoff:
                break
            del self._terminal[oldest_name]

    async def start(self, task: ResolvedTask) -> ExecutionHandle:
        """Create the attempt's Job, then its request ConfigMap.

        Idempotent per attempt: the names are derived from (execution, task,
        attempt), so a Job already there under this name was created for this
        same attempt, by a scheduler tick whose transaction then rolled back
        or by a start that raised after the Job was made (an API timeout, a
        lost response; the scheduler then retries the same attempt). That Job
        is adopted rather than refused or started twice, and its ConfigMap
        created if it's missing.

        The Job comes first so the ConfigMap can name it as its owner: then
        Kubernetes deletes the ConfigMap with the Job, even for a Job this
        scheduler never finalizes (a crash, a lease taken over, a cancel
        race), when its TTL removes it. The Pod waits for its input volume
        until the ConfigMap exists, a moment later.
        """
        job_name = job_name_for(task.execution_id, task.task_key, task.attempt)
        request = task.to_product_request()
        request_json = json.dumps(request.model_dump(by_alias=True))
        namespace = task.team

        try:
            job_uid = await asyncio.to_thread(self._create_job, namespace, job_name, task)
        except ApiException as error:
            if error.status == 403 or (
                error.status == 400 and _SIGNATURE_WEBHOOK_MARKER in _api_error_message(error)
            ):
                raise _dispatch_rejection(error) from error
            raise
        try:
            await asyncio.to_thread(
                self._create_config_map, namespace, job_name, job_uid, request_json
            )
        except ApiException as error:
            if error.status == 403:
                # Refused by policy: this attempt will never get its
                # request.json, so the Job would wait for it forever.
                await asyncio.to_thread(self._delete_job, namespace, job_name)
                raise _dispatch_rejection(error) from error
            # Anything else may be transient: the scheduler retries this same
            # attempt, which adopts the Job and creates the ConfigMap, or
            # discards both if it gives up.
            raise

        return {"namespace": namespace, "jobName": job_name}

    def _create_config_map(
        self, namespace: str, job_name: str, job_uid: str, request_json: str
    ) -> None:
        config_map = client.V1ConfigMap(
            metadata=client.V1ObjectMeta(
                name=job_name,
                labels={"app": "execution-kernel"},
                owner_references=[
                    client.V1OwnerReference(
                        api_version="batch/v1", kind="Job", name=job_name, uid=job_uid
                    )
                ],
            ),
            data={"request.json": request_json},
        )
        try:
            self._core_api.create_namespaced_config_map(
                namespace, config_map, _request_timeout=self._timeout
            )
        except ApiException as error:
            if error.status != 409:  # created along with an adopted Job
                raise

    def _container_security_context(self) -> client.V1SecurityContext:
        """Pod Security's `restricted`, unless hardening is off: non-root (the
        image must name a numeric non-root USER), a read-only root filesystem,
        no capabilities, no privilege escalation."""
        if not self._pod_hardening:
            return client.V1SecurityContext(privileged=False, allow_privilege_escalation=False)
        return client.V1SecurityContext(
            privileged=False,
            allow_privilege_escalation=False,
            run_as_non_root=True,
            read_only_root_filesystem=True,
            capabilities=client.V1Capabilities(drop=["ALL"]),
            seccomp_profile=client.V1SeccompProfile(type="RuntimeDefault"),
        )

    def _resource_requirements(self, task: ResolvedTask) -> client.V1ResourceRequirements | None:
        """The Pod's requests and memory limit (see TaskResources), or None for none."""
        resources = (task.resources or TaskResources()).over(self._default_resources)
        requests = {
            name: value
            for name, value in (("cpu", resources.cpu), ("memory", resources.memory))
            if value
        }
        memory_limit = resources.memory_limit or resources.memory
        if not requests and not memory_limit:
            return None
        return client.V1ResourceRequirements(
            requests=requests or None,
            limits={"memory": memory_limit} if memory_limit else None,
        )

    def _create_job(self, namespace: str, job_name: str, task: ResolvedTask) -> str:
        """Create the Job, or adopt this attempt's existing one; returns its uid."""
        # One volume per requested Secret, each mounted read-only at a path
        # keyed by the Secret's own name -- e.g. a Secret "gcp-service-
        # account-key" with a data key "key.json" shows up at
        # /platform/secrets/gcp-service-account-key/key.json (Kubernetes'
        # own behavior: one file per key inside a Secret volume's mount
        # path). Volumes are named positionally ("secret-0", "secret-1", ...)
        # rather than after the Secret itself, since a Secret name is only
        # guaranteed to be a valid Kubernetes *object* name (DNS-1123
        # subdomain, up to 253 chars) while a volume name must be a
        # stricter DNS-1123 *label* (up to 63 chars, no dots) -- the mount
        # path is where the real name matters, not the volume identity. If
        # a named Secret doesn't actually exist (or the RBAC/existence
        # check console/'s routes/executions.ts does before forwarding here was
        # somehow bypassed), the Pod fails to start with a real, visible
        # FailedMount event -- Kubernetes' own primitive failing loudly,
        # not something this executor needs to pre-check.
        secret_volume_mounts = [
            client.V1VolumeMount(
                name=f"secret-{i}",
                mount_path=f"{SECRET_MOUNT_PATH}/{secret_name}",
                read_only=True,
            )
            for i, secret_name in enumerate(task.secret_refs)
        ]
        secret_volumes = [
            client.V1Volume(
                name=f"secret-{i}",
                secret=client.V1SecretVolumeSource(secret_name=secret_name),
            )
            for i, secret_name in enumerate(task.secret_refs)
        ]
        container = client.V1Container(
            name=CONTAINER_NAME,
            image=task.image,
            # The console pins every image to its digest at submission
            # ("repo:latest@sha256:…"), and a digest never changes, so
            # IfNotPresent. A registry ":latest" that reaches here unpinned
            # (the console's pinning off) is pulled every time: IfNotPresent
            # would keep whichever digest a node pulled first. A bare
            # "name:latest" (no registry, a `kind load`ed image) has nowhere
            # to pull from.
            image_pull_policy=(
                "Always" if task.image.endswith(":latest") and "/" in task.image else "IfNotPresent"
            ),
            args=[task.action],
            env=[
                client.V1EnvVar(name=name, value=value)
                for name, value in self._extra_environment.items()
            ]
            or None,
            volume_mounts=[
                client.V1VolumeMount(name="input", mount_path=REQUEST_MOUNT_PATH, read_only=True),
                client.V1VolumeMount(name="output", mount_path=RESULT_MOUNT_PATH),
                *secret_volume_mounts,
            ],
            termination_message_path=RESULT_FILE_PATH,
            termination_message_policy="File",
            security_context=self._container_security_context(),
            resources=self._resource_requirements(task),
        )
        if self._pod_hardening:
            # The root filesystem is read-only; a scratch /tmp is the one
            # writable place besides /platform/output.
            container.volume_mounts.append(client.V1VolumeMount(name="tmp", mount_path="/tmp"))
        pod_spec = client.V1PodSpec(
            restart_policy="Never",
            containers=[container],
            # A step needs no Kubernetes API access: no token in the Pod. A
            # cloud identity bound to its ServiceAccount still works (GKE's
            # metadata server, or the token EKS/AKS inject themselves).
            automount_service_account_token=False if self._pod_hardening else None,
            security_context=(
                client.V1PodSecurityContext(
                    run_as_non_root=True,
                    seccomp_profile=client.V1SeccompProfile(type="RuntimeDefault"),
                )
                if self._pod_hardening
                else None
            ),
            # The step's own identity: what a cloud workload identity binds
            # to. The identity policy checks it's the one its product
            # declares (docs/security-model.md).
            service_account_name=task.service_account,
            volumes=[
                client.V1Volume(
                    name="input", config_map=client.V1ConfigMapVolumeSource(name=job_name)
                ),
                client.V1Volume(name="output", empty_dir=client.V1EmptyDirVolumeSource()),
                *(
                    [client.V1Volume(name="tmp", empty_dir=client.V1EmptyDirVolumeSource())]
                    if self._pod_hardening
                    else []
                ),
                *secret_volumes,
            ],
            # Deployment-wide placement (Spot capacity and the like), in the
            # Pod spec's own shape; the API server validates it.
            node_selector=self._node_selector or None,
            tolerations=self._tolerations or None,
            affinity=self._affinity or None,
            image_pull_secrets=(
                [client.V1LocalObjectReference(name=self._image_pull_secret)]
                if self._image_pull_secret
                else None
            ),
        )
        # So the console can show a Pod as "task X of execution Y". The task
        # key is caller-chosen and may not be a valid label value, so it's an
        # annotation; the execution id (a UUID) and attempt are labels.
        labels = {
            "app": "execution-kernel",
            "acyclix.dev/execution-id": task.execution_id,
            "acyclix.dev/attempt": str(task.attempt),
        }
        annotations = {"acyclix.dev/task": task.task_key}
        job = client.V1Job(
            metadata=client.V1ObjectMeta(name=job_name, labels=labels, annotations=annotations),
            spec=client.V1JobSpec(
                # Exactly one attempt per Job — the scheduler owns retry
                # policy (app.domain.states.should_retry); a retrying Job
                # would double up with it.
                backoff_limit=0,
                ttl_seconds_after_finished=self._job_ttl_seconds,
                # A backstop: the scheduler times the task out itself, but a
                # Job it lost track of (a start whose attempt was given up)
                # must not run, or wait for its input, forever.
                active_deadline_seconds=task.timeout_seconds + self._job_deadline_grace_seconds,
                template=client.V1PodTemplateSpec(
                    metadata=client.V1ObjectMeta(labels=labels, annotations=annotations),
                    spec=pod_spec,
                ),
            ),
        )
        try:
            created = self._batch_api.create_namespaced_job(
                namespace, job, _request_timeout=self._timeout
            )
        except ApiException as error:
            if error.status != 409:
                raise
            created = self._batch_api.read_namespaced_job(
                job_name, namespace, _request_timeout=self._timeout
            )
            if created.metadata.deletion_timestamp is not None:
                # Being deleted, so there's nothing left to adopt; the
                # scheduler retries the start once it's gone.
                raise
            logger.info(
                "adopting this attempt's existing Job",
                extra={"namespace": namespace, "job": job_name},
            )
        uid: str = created.metadata.uid
        return uid

    async def get_status(self, handle: ExecutionHandle) -> ExecutionStatus:
        job_name: str = handle["jobName"]
        namespace: str = handle["namespace"]
        cached = self._terminal.get(job_name)
        if cached is not None:
            return cached.status
        if self._unchanged_since_last_read(job_name):
            return ExecutionStatus(state=ExecutorRunState.RUNNING)

        try:
            job = await asyncio.to_thread(
                self._batch_api.read_namespaced_job_status,
                job_name,
                namespace,
                _request_timeout=self._timeout,
            )
        except ApiException as error:
            if error.status != 404:
                raise
            # The scheduler deletes a Job only after committing its outcome
            # (release()), and never polls a handle again after that or after
            # cancelling it, so the Job went away some other way: deleted by
            # hand, or removed by its TTL while no scheduler was running.
            # Either way its result is lost, which a retry, if attempts are
            # left, can make up for.
            record = _TerminalRecord(
                status=ExecutionStatus(
                    state=ExecutorRunState.FAILED,
                    error=StructuredError(
                        code="JOB_NOT_FOUND",
                        message="The task's Job no longer exists, so its result was lost.",
                        retryable=True,
                    ),
                ),
                logs=[],
            )
            self._remember(job_name, record)
            return record.status

        job_status = job.status
        if not (job_status.succeeded or job_status.failed):
            # A ready Pod has its image; only a not-yet-ready one can be
            # stuck pulling it, so only then is the Pod worth reading. Only a
            # ready one is left alone until its watch reports a change: a
            # stuck pull is caught by the grace period, not by an event.
            if job_status.ready:
                self._quiet_since[job_name] = time.monotonic()
                return ExecutionStatus(state=ExecutorRunState.RUNNING)
            pull_error = await asyncio.to_thread(self._image_pull_error, namespace, job_name)
            if pull_error is None:
                return ExecutionStatus(state=ExecutorRunState.RUNNING)
            logger.warning(
                "task image can't be pulled",
                extra={"namespace": namespace, "job": job_name, "code": pull_error.code},
            )
            # Left in place until the failure is committed (release()): a
            # Pod still pulling has run nothing.
            record = _TerminalRecord(
                status=ExecutionStatus(state=ExecutorRunState.FAILED, error=pull_error), logs=[]
            )
            self._remember(job_name, record)
            return record.status

        record = await asyncio.to_thread(self._finalize, namespace, job_name)
        self._remember(job_name, record)
        return record.status

    def _image_pull_error(self, namespace: str, job_name: str) -> StructuredError | None:
        pods = self._core_api.list_namespaced_pod(
            namespace, label_selector=f"job-name={job_name}", _request_timeout=self._timeout
        )
        for pod in pods.items:
            created = pod.metadata.creation_timestamp
            age = (datetime.now(UTC) - created).total_seconds() if created else 0.0
            for container_status in pod.status.container_statuses or []:
                waiting = container_status.state.waiting if container_status.state else None
                if container_status.name != CONTAINER_NAME or waiting is None:
                    continue
                error = image_pull_failure(
                    waiting.reason,
                    waiting.message,
                    container_status.image,
                    age,
                    self._image_pull_grace_seconds,
                )
                if error is not None:
                    return error
        return None

    def _finalize(self, namespace: str, job_name: str) -> _TerminalRecord:
        """Capture logs and result. The Job and ConfigMap stay until release().

        Deleting them here, before the scheduler had committed the result,
        lost a finished step's outputs whenever that commit failed and the
        task's lease passed to another scheduler: it found no Job
        (JOB_NOT_FOUND) and ran the step again.

        Runs inside the worker thread ``get_status`` dispatched to, so the
        kubernetes-client calls here don't need their own
        ``asyncio.to_thread`` wrapping.
        """
        pod_name, terminated = self._find_terminated_container(namespace, job_name)
        logs = self._read_logs(namespace, pod_name) if pod_name else []
        return _TerminalRecord(status=self._build_status(terminated, logs), logs=logs)

    def _find_terminated_container(
        self, namespace: str, job_name: str
    ) -> tuple[str | None, client.V1ContainerStateTerminated | None]:
        pods = self._core_api.list_namespaced_pod(
            namespace, label_selector=f"job-name={job_name}", _request_timeout=self._timeout
        )
        if not pods.items:
            return None, None
        pod = pods.items[0]
        statuses = pod.status.container_statuses or []
        for container_status in statuses:
            if container_status.name == CONTAINER_NAME and container_status.state.terminated:
                return pod.metadata.name, container_status.state.terminated
        return pod.metadata.name, None

    def _read_logs(self, namespace: str, pod_name: str) -> list[str]:
        try:
            # _preload_content=False + manual decode, not the default
            # str-returning call: for this endpoint the generated client's
            # default deserialization path stringifies the raw response
            # bytes (`str(b"...")`) instead of decoding them, so callers get
            # literal "b'...'" text back. This is the documented workaround.
            #
            # Capped: the last log_max_lines lines, at most log_max_bytes,
            # so a chatty step can't fill the database or the scheduler's
            # memory.
            response = self._core_api.read_namespaced_pod_log(
                pod_name,
                namespace,
                container=CONTAINER_NAME,
                tail_lines=self._log_max_lines,
                limit_bytes=self._log_max_bytes,
                _preload_content=False,
                _request_timeout=self._timeout,
            )
            raw: bytes = response.data
        except ApiException:
            return []
        # A credential a step printed by mistake isn't stored (or shown).
        lines = redact_lines(raw.decode("utf-8", errors="replace").splitlines())
        if len(lines) >= self._log_max_lines or len(raw) >= self._log_max_bytes:
            lines.insert(
                0,
                f"[acyclix: earlier output not kept; the last {self._log_max_lines} lines, "
                f"at most {self._log_max_bytes} bytes, are]",
            )
        return lines

    def _build_status(
        self, terminated: client.V1ContainerStateTerminated | None, logs: list[str]
    ) -> ExecutionStatus:
        if terminated is None:
            return ExecutionStatus(
                state=ExecutorRunState.FAILED,
                error=StructuredError(
                    code="POD_TERMINATED_UNEXPECTEDLY",
                    message="Job finished but no terminated container status was found.",
                    retryable=True,
                ),
            )

        message = terminated.message
        if not message:
            log_tail = "\n".join(logs[-50:])
            return ExecutionStatus(
                state=ExecutorRunState.FAILED,
                error=StructuredError(
                    code="PRODUCT_RESULT_MISSING",
                    message=(
                        f"Container exited with code {terminated.exit_code} without writing "
                        f"{RESULT_FILE_PATH}. Recent logs: {log_tail[-2000:]}"
                    ),
                    retryable=True,
                ),
            )

        try:
            result = TaskResult.model_validate(json.loads(message))
        except (json.JSONDecodeError, ValueError) as error:
            return ExecutionStatus(
                state=ExecutorRunState.FAILED,
                error=StructuredError(
                    code="PRODUCT_RESULT_INVALID",
                    # Pydantic quotes the values it rejected.
                    message=redact_text(f"Container's result.json was invalid: {error}"),
                    retryable=True,
                ),
            )

        if result.status == "succeeded":
            # Outputs are stored, passed to later steps and readable by
            # anyone who can read the execution: one holding a credential
            # fails the task rather than being stored or quietly altered.
            credential = find_credential(result.outputs)
            if credential:
                return ExecutionStatus(
                    state=ExecutorRunState.FAILED,
                    error=StructuredError(
                        code="OUTPUT_CONTAINS_CREDENTIAL",
                        message=(
                            "The step's outputs contain what looks like a credential "
                            f"({credential}), so they weren't stored. A step must never return "
                            "the credentials it uses: output a reference (a name, a URI) instead."
                        ),
                        retryable=False,
                    ),
                )
            return ExecutionStatus(state=ExecutorRunState.SUCCEEDED, outputs=result.outputs)
        assert result.error is not None  # enforced by TaskResult's own validator
        product_error = result.error
        return ExecutionStatus(
            state=ExecutorRunState.FAILED,
            error=product_error.model_copy(update={"message": redact_text(product_error.message)}),
        )

    def _delete_job(self, namespace: str, job_name: str) -> None:
        try:
            self._batch_api.delete_namespaced_job(
                job_name, namespace, propagation_policy="Background", _request_timeout=self._timeout
            )
        except ApiException as error:
            if error.status != 404:
                raise

    def _delete_config_map(self, namespace: str, job_name: str) -> None:
        try:
            self._core_api.delete_namespaced_config_map(
                job_name, namespace, _request_timeout=self._timeout
            )
        except ApiException as error:
            if error.status != 404:
                raise

    async def cancel(self, handle: ExecutionHandle) -> None:
        job_name: str = handle["jobName"]
        namespace: str = handle["namespace"]
        if job_name in self._terminal:
            return
        self._quiet_since.pop(job_name, None)
        await asyncio.to_thread(self._delete_job, namespace, job_name)
        await asyncio.to_thread(self._delete_config_map, namespace, job_name)

    async def release(self, handle: ExecutionHandle) -> None:
        # Its cached result stays: a late read still finds it. Missed (the
        # scheduler stopped first), the Job's ttlSecondsAfterFinished removes
        # it, or its activeDeadlineSeconds for one still pulling its image.
        job_name: str = handle["jobName"]
        namespace: str = handle["namespace"]
        self._quiet_since.pop(job_name, None)
        await asyncio.to_thread(self._delete_job, namespace, job_name)
        await asyncio.to_thread(self._delete_config_map, namespace, job_name)

    async def list_attempts(self) -> list[LaunchedAttempt]:
        jobs = await asyncio.to_thread(
            self._batch_api.list_job_for_all_namespaces,
            label_selector=_KERNEL_LABEL_SELECTOR,
            _request_timeout=self._timeout,
        )
        attempts: list[LaunchedAttempt] = []
        for job in jobs.items:
            metadata = job.metadata
            labels = metadata.labels or {}
            annotations = metadata.annotations or {}
            execution_id = labels.get("acyclix.dev/execution-id")
            attempt = labels.get("acyclix.dev/attempt")
            task_key = annotations.get("acyclix.dev/task")
            if not (execution_id and attempt and attempt.isdigit() and task_key):
                continue  # not one this kernel made the way it makes them
            attempts.append(
                LaunchedAttempt(
                    handle={"namespace": metadata.namespace, "jobName": metadata.name},
                    execution_id=execution_id,
                    task_key=task_key,
                    attempt=int(attempt),
                    created_at=metadata.creation_timestamp,
                )
            )
        return attempts

    async def discard(self, task: ResolvedTask) -> None:
        job_name = job_name_for(task.execution_id, task.task_key, task.attempt)
        self._quiet_since.pop(job_name, None)
        await asyncio.to_thread(self._delete_job, task.team, job_name)
        await asyncio.to_thread(self._delete_config_map, task.team, job_name)

    async def get_logs(self, handle: ExecutionHandle) -> list[str]:
        job_name: str = handle["jobName"]
        namespace: str = handle["namespace"]
        cached = self._terminal.get(job_name)
        if cached is not None:
            return cached.logs

        pod_name, _ = await asyncio.to_thread(self._find_terminated_container, namespace, job_name)
        if pod_name is None:
            return []
        return await asyncio.to_thread(self._read_logs, namespace, pod_name)
