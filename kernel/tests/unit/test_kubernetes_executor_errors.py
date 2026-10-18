# SPDX-License-Identifier: MIT
"""How KubernetesExecutor.start creates a task's Job and ConfigMap, and reports
a cluster refusing to.

No cluster needed: the executor takes its API clients as arguments, so a
stub that raises the same ApiException the real client would is enough to
pin down the mapping. The real admission-policy rejection is proven
against kind (see helm/charts/execution-kernel/templates/dispatch-policy.yaml).
"""

import json
from types import SimpleNamespace
from typing import Any

import pytest
from kubernetes.client.exceptions import ApiException

from app.domain.errors import DispatchRejectedError
from app.executors.base import ExecutionStatus, ExecutorRunState, ResolvedTask
from app.executors.kubernetes import (
    _TERMINAL_RETENTION_SECONDS,
    KubernetesExecutor,
    _TerminalRecord,
    job_name_for,
)

POLICY_MESSAGE = (
    'jobs.batch "ek-env-1" is forbidden: ValidatingAdmissionPolicy '
    "'kernel-execution-kernel-dispatch' denied request: namespace acyclix-system "
    "is not an Acyclix team namespace"
)
JOB_UID = "6b1f3d0e-0000-0000-0000-000000000001"


def _api_exception(status: int, body: str | None) -> ApiException:
    error = ApiException(status=status, reason="Forbidden" if status == 403 else "Error")
    error.body = body
    return error


def _status_body(message: str) -> str:
    return json.dumps({"kind": "Status", "status": "Failure", "message": message})


def _job(uid: str = JOB_UID, *, deleting: bool = False) -> SimpleNamespace:
    deletion_timestamp = "2026-10-16T00:00:00Z" if deleting else None
    return SimpleNamespace(metadata=SimpleNamespace(uid=uid, deletion_timestamp=deletion_timestamp))


class _BatchApi:
    """Creates Jobs, or raises ``create_error``; ``existing`` is what a read returns."""

    def __init__(
        self, create_error: ApiException | None = None, existing: SimpleNamespace | None = None
    ) -> None:
        self._create_error = create_error
        self._existing = existing
        self.created_jobs: list[Any] = []
        self.deleted_jobs: list[str] = []

    def create_namespaced_job(self, namespace: str, body: Any, **_: object) -> SimpleNamespace:
        if self._create_error is not None:
            raise self._create_error
        self.created_jobs.append(body)
        return _job()

    def read_namespaced_job(self, name: str, namespace: str, **_: object) -> SimpleNamespace:
        assert self._existing is not None
        return self._existing

    def delete_namespaced_job(self, name: str, namespace: str, **_: object) -> None:
        self.deleted_jobs.append(name)


class _CoreApi:
    def __init__(self, create_error: Exception | None = None) -> None:
        self._create_error = create_error
        self.created_config_maps: list[Any] = []
        self.deleted_config_maps: list[str] = []

    def create_namespaced_config_map(self, namespace: str, body: Any, **_: object) -> None:
        if self._create_error is not None:
            raise self._create_error
        self.created_config_maps.append(body)

    def delete_namespaced_config_map(self, name: str, namespace: str, **_: object) -> None:
        self.deleted_config_maps.append(name)

    log_text = ""
    log_requests: list[dict[str, object]] = []

    def read_namespaced_pod_log(
        self, name: str, namespace: str, **kwargs: object
    ) -> SimpleNamespace:
        self.log_requests.append(kwargs)
        return SimpleNamespace(data=self.log_text.encode())


def _task() -> ResolvedTask:
    return ResolvedTask(
        execution_id="00000000-0000-0000-0000-000000000001",
        task_key="env",
        image="test-environment-product:local",
        action="create",
        attempt=1,
        timeout_seconds=60,
        team="acyclix-system",
        service_account="default",
    )


def _executor(
    batch: _BatchApi | None = None, core: _CoreApi | None = None
) -> tuple[KubernetesExecutor, _BatchApi, _CoreApi]:
    batch = batch or _BatchApi()
    core = core or _CoreApi()
    return KubernetesExecutor(batch_api=batch, core_api=core), batch, core


# --- creating the Job and its ConfigMap ---------------------------------------


async def test_the_configmap_is_owned_by_its_job() -> None:
    """So Kubernetes deletes it along with a Job the scheduler never finalizes."""
    executor, _, core = _executor()
    await executor.start(_task())
    [config_map] = core.created_config_maps
    [owner] = config_map.metadata.owner_references
    assert (owner.kind, owner.name, owner.uid) == ("Job", config_map.metadata.name, JOB_UID)


async def test_an_existing_job_for_this_attempt_is_adopted() -> None:
    """A tick that created the Job and then rolled back retries the same
    attempt, so the same name: that Job is the one to keep polling."""
    existing = _job("uid-of-the-earlier-job")
    executor, _, core = _executor(_BatchApi(_api_exception(409, None), existing=existing))
    handle = await executor.start(_task())
    assert handle["namespace"] == "acyclix-system"
    [config_map] = core.created_config_maps
    assert config_map.metadata.owner_references[0].uid == "uid-of-the-earlier-job"


async def test_an_existing_configmap_is_left_as_it_is() -> None:
    executor, _, _ = _executor(core=_CoreApi(_api_exception(409, None)))
    await executor.start(_task())


async def test_a_job_being_deleted_isnt_adopted() -> None:
    existing = _job(deleting=True)
    executor, _, _ = _executor(_BatchApi(_api_exception(409, None), existing=existing))
    with pytest.raises(ApiException):
        await executor.start(_task())


@pytest.mark.parametrize(
    "error",
    [_api_exception(500, None), TimeoutError("read timed out")],
    ids=["server error", "timeout"],
)
async def test_a_configmap_that_fails_for_now_leaves_the_job_for_retry(error: Exception) -> None:
    """The scheduler retries this same attempt, whose start adopts the Job and
    creates the ConfigMap; deleting it here would only race that retry."""
    executor, batch, _ = _executor(core=_CoreApi(error))
    with pytest.raises(type(error)):
        await executor.start(_task())
    assert batch.deleted_jobs == []


async def test_a_refused_configmap_takes_its_job_with_it() -> None:
    """Refused for good, so its Pod would wait for request.json forever."""
    executor, batch, _ = _executor(core=_CoreApi(_api_exception(403, _status_body(POLICY_MESSAGE))))
    with pytest.raises(DispatchRejectedError):
        await executor.start(_task())
    assert len(batch.deleted_jobs) == 1


async def test_every_job_has_a_deadline_past_its_tasks_timeout() -> None:
    """A backstop for a Job the scheduler loses track of."""
    batch, core = _BatchApi(), _CoreApi()
    executor = KubernetesExecutor(batch_api=batch, core_api=core, job_deadline_grace_seconds=600)
    await executor.start(_task())
    assert batch.created_jobs[0].spec.active_deadline_seconds == 60 + 600


async def test_a_step_pod_meets_pod_security_restricted() -> None:
    executor, batch, _ = _executor()
    await executor.start(_task())
    pod = batch.created_jobs[0].spec.template.spec
    container = pod.containers[0]
    assert pod.automount_service_account_token is False
    assert pod.security_context.run_as_non_root is True
    assert pod.security_context.seccomp_profile.type == "RuntimeDefault"
    assert container.security_context.read_only_root_filesystem is True
    assert container.security_context.allow_privilege_escalation is False
    assert container.security_context.capabilities.drop == ["ALL"]
    assert "/tmp" in [mount.mount_path for mount in container.volume_mounts]


async def test_pod_hardening_can_be_turned_off_for_images_that_need_it() -> None:
    batch, core = _BatchApi(), _CoreApi()
    await KubernetesExecutor(batch_api=batch, core_api=core, pod_hardening=False).start(_task())
    pod = batch.created_jobs[0].spec.template.spec
    assert pod.security_context is None
    assert pod.containers[0].security_context.allow_privilege_escalation is False


async def test_discard_removes_the_attempts_job_and_configmap() -> None:
    executor, batch, core = _executor()
    await executor.discard(_task())
    name = job_name_for("00000000-0000-0000-0000-000000000001", "env", 1)
    assert batch.deleted_jobs == [name]
    assert core.deleted_config_maps == [name]


# --- refusals ---------------------------------------------------------------------


def _job_refused(status: int, message: str | None) -> tuple[KubernetesExecutor, _CoreApi]:
    body = None if message is None else _status_body(message)
    executor, _, core = _executor(_BatchApi(_api_exception(status, body)))
    return executor, core


async def test_forbidden_create_becomes_dispatch_rejected_with_the_api_servers_message() -> None:
    executor, _ = _job_refused(403, POLICY_MESSAGE)
    with pytest.raises(DispatchRejectedError) as raised:
        await executor.start(_task())
    assert raised.value.message == POLICY_MESSAGE


async def test_forbidden_create_without_a_status_body_still_says_what_happened() -> None:
    executor, _ = _job_refused(403, None)
    with pytest.raises(DispatchRejectedError) as raised:
        await executor.start(_task())
    assert raised.value.message == "403 Forbidden"


async def test_other_api_errors_are_not_treated_as_policy_rejections() -> None:
    executor, _ = _job_refused(500, None)
    with pytest.raises(ApiException):
        await executor.start(_task())


async def test_a_namespace_refusal_keeps_the_generic_code() -> None:
    executor, _ = _job_refused(403, POLICY_MESSAGE)
    with pytest.raises(DispatchRejectedError) as raised:
        await executor.start(_task())
    assert raised.value.code == "DISPATCH_REJECTED"


async def test_a_refused_configmap_is_a_dispatch_rejection_too() -> None:
    executor, batch, _ = _executor(core=_CoreApi(_api_exception(403, _status_body(POLICY_MESSAGE))))
    with pytest.raises(DispatchRejectedError):
        await executor.start(_task())
    assert len(batch.deleted_jobs) == 1


IMAGE_POLICY_MESSAGE = (
    'jobs.batch "ek-env-1" is forbidden: ValidatingAdmissionPolicy '
    "'kernel-execution-kernel-image' with binding 'kernel-execution-kernel-image' denied "
    "request: IMAGE_NOT_ALLOWED: docker.io/evil/app is not from an allowed image source. "
    "Allowed: localhost:5001/. An admin can allow more on the console's Admin page."
)


async def test_an_image_policy_refusal_gets_its_own_code_and_just_the_policys_explanation() -> None:
    executor, _ = _job_refused(403, IMAGE_POLICY_MESSAGE)
    with pytest.raises(DispatchRejectedError) as raised:
        await executor.start(_task())
    assert raised.value.code == "IMAGE_NOT_ALLOWED"
    assert raised.value.message.startswith(
        "docker.io/evil/app is not from an allowed image source."
    )


IDENTITY_POLICY_MESSAGE = (
    'jobs.batch "ek-env-1" is forbidden: ValidatingAdmissionPolicy '
    "'kernel-execution-kernel-identity' with binding 'kernel-execution-kernel-identity' denied "
    'request: IDENTITY_NOT_ALLOWED: localhost:5001/app (action "create") may not run as '
    'ServiceAccount "billing-sa" in team-a.'
)


async def test_an_identity_policy_refusal_gets_its_own_code() -> None:
    executor, _ = _job_refused(403, IDENTITY_POLICY_MESSAGE)
    with pytest.raises(DispatchRejectedError) as raised:
        await executor.start(_task())
    assert raised.value.code == "IDENTITY_NOT_ALLOWED"
    assert raised.value.message.startswith('localhost:5001/app (action "create") may not run as')


async def test_a_refused_job_creates_no_configmap() -> None:
    executor, core = _job_refused(403, IMAGE_POLICY_MESSAGE)
    with pytest.raises(DispatchRejectedError):
        await executor.start(_task())
    assert core.created_config_maps == []


# Sigstore policy-controller's refusal, as kind returned it: a 400, not a 403.
SIGNATURE_MESSAGE = (
    'admission webhook "policy.sigstore.dev" denied the request: validation failed: '
    "failed policy: kernel-execution-kernel-signed-images: spec.template.spec.containers[0].image\n"
    "us-central1-docker.pkg.dev/p/catalog-products/app@sha256:f75f no signatures found"
)


async def test_an_unsigned_image_is_a_non_retryable_signature_refusal() -> None:
    executor, core = _job_refused(400, SIGNATURE_MESSAGE)
    with pytest.raises(DispatchRejectedError) as raised:
        await executor.start(_task())
    assert raised.value.code == "IMAGE_NOT_SIGNED"
    assert raised.value.message.startswith(
        "us-central1-docker.pkg.dev/p/catalog-products/app@sha256:f75f no signatures found."
    )
    assert core.created_config_maps == []


async def test_other_400s_are_still_ordinary_start_failures() -> None:
    executor, _ = _job_refused(400, "Job.batch is invalid")
    with pytest.raises(ApiException):
        await executor.start(_task())


# --- the finished-Job cache -----------------------------------------------------


def _record(recorded_at: float) -> _TerminalRecord:
    return _TerminalRecord(
        status=ExecutionStatus(state=ExecutorRunState.SUCCEEDED, outputs={}),
        logs=[],
        recorded_at=recorded_at,
    )


def test_cached_results_expire(monkeypatch: pytest.MonkeyPatch) -> None:
    executor, _, _ = _executor()
    monkeypatch.setattr("app.executors.kubernetes.time.monotonic", lambda: 10_000.0)
    executor._remember("old", _record(10_000.0 - _TERMINAL_RETENTION_SECONDS - 1))
    executor._remember("recent", _record(10_000.0 - 1))
    executor._remember("new", _record(10_000.0))
    assert list(executor._terminal) == ["recent", "new"]


def test_a_steps_log_is_capped_and_says_so() -> None:
    core = _CoreApi()
    executor = KubernetesExecutor(
        batch_api=_BatchApi(), core_api=core, log_max_lines=3, log_max_bytes=10_000
    )
    core.log_text = "a\nb\nc\n"
    lines = executor._read_logs("ns", "pod")
    assert core.log_requests[-1]["tail_lines"] == 3
    assert core.log_requests[-1]["limit_bytes"] == 10_000
    assert lines[0].startswith("[acyclix: earlier output not kept")
    assert lines[1:] == ["a", "b", "c"]
    core.log_text = "short\n"
    assert executor._read_logs("ns", "pod") == ["short"]



async def test_step_pods_name_the_pull_secret_when_one_is_set() -> None:
    names = []
    for pull_secret in ("acyclix-pull", ""):
        batch = _BatchApi()
        executor = KubernetesExecutor(
            batch_api=batch, core_api=_CoreApi(), image_pull_secret=pull_secret
        )
        await executor.start(_task())
        refs = batch.created_jobs[0].spec.template.spec.image_pull_secrets
        names.append([ref.name for ref in refs or []])
    assert names == [["acyclix-pull"], []]
