# SPDX-License-Identifier: MIT
"""How KubernetesExecutor reports a task whose image can't be pulled.

The classification is a pure function of the kubelet's waiting state; the
get_status wiring is checked with stub API clients. A real missing image on
kind is covered in tests/integration/test_kubernetes_executor.py.
"""

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

from app.executors.base import ExecutorRunState
from app.executors.kubernetes import CONTAINER_NAME, KubernetesExecutor, image_pull_failure

IMAGE = "us-central1-docker.pkg.dev/p/catalog-products/demo-3-deploy-product:abc"
GAR_NOT_FOUND = (
    f'failed to pull and unpack image "{IMAGE}": failed to resolve reference '
    f'"{IMAGE}": {IMAGE}: not found'
)
DOCKER_HUB_DENIED = (
    'pull access denied, repository does not exist or may require authorization: '
    "server message: insufficient_scope: authorization failed"
)


def classify(reason: str, message: str, age: float = 5) -> str | None:
    error = image_pull_failure(reason, message, IMAGE, age, grace_seconds=120)
    return None if error is None else f"{error.code}/{error.retryable}"


def test_a_missing_image_fails_at_once_and_is_not_retried() -> None:
    assert classify("ErrImagePull", GAR_NOT_FOUND) == "IMAGE_NOT_FOUND/False"
    assert classify("ImagePullBackOff", "manifest unknown") == "IMAGE_NOT_FOUND/False"
    assert classify("ErrImageNeverPull", "image not present with pull policy of Never") == (
        "IMAGE_NOT_FOUND/False"
    )


def test_a_malformed_reference_fails_at_once() -> None:
    assert classify("InvalidImageName", "couldn't parse image reference") == "IMAGE_INVALID/False"


def test_other_pull_errors_get_the_grace_period_then_fail_retryably() -> None:
    assert classify("ErrImagePull", DOCKER_HUB_DENIED, age=30) is None
    assert classify("ImagePullBackOff", "dial tcp: i/o timeout", age=30) is None
    assert classify("ImagePullBackOff", DOCKER_HUB_DENIED, age=121) == "IMAGE_PULL_FAILED/True"


def test_ordinary_waiting_states_are_left_alone() -> None:
    assert classify("ContainerCreating", "", age=999) is None
    assert classify("PodInitializing", "", age=999) is None


def test_the_kubelet_message_is_carried_but_bounded() -> None:
    # The deciding phrase can sit past the part kept for the error message.
    error = image_pull_failure("ErrImagePull", "x " * 2500 + GAR_NOT_FOUND, IMAGE, 1, 120)
    assert error is not None
    assert error.code == "IMAGE_NOT_FOUND"
    assert IMAGE in error.message
    assert len(error.message) < 1200


class _StubBatchApi:
    def __init__(self) -> None:
        self.deleted: list[str] = []

    def read_namespaced_job_status(self, name: str, namespace: str, **_: object) -> object:
        return SimpleNamespace(status=SimpleNamespace(succeeded=None, failed=None, ready=0))

    def delete_namespaced_job(self, name: str, namespace: str, **_: object) -> None:
        self.deleted.append(name)


class _StubCoreApi:
    def __init__(self, reason: str, message: str) -> None:
        self._waiting = SimpleNamespace(reason=reason, message=message)
        self.deleted_config_maps: list[str] = []

    def list_namespaced_pod(self, namespace: str, label_selector: str, **_: object) -> object:
        status = SimpleNamespace(
            name=CONTAINER_NAME, image=IMAGE, state=SimpleNamespace(waiting=self._waiting)
        )
        pod = SimpleNamespace(
            metadata=SimpleNamespace(creation_timestamp=datetime.now(UTC) - timedelta(seconds=10)),
            status=SimpleNamespace(container_statuses=[status]),
        )
        return SimpleNamespace(items=[pod])

    def delete_namespaced_config_map(self, name: str, namespace: str, **_: object) -> None:
        self.deleted_config_maps.append(name)


async def test_get_status_fails_the_task_and_cleans_up_when_its_image_is_missing() -> None:
    batch, core = _StubBatchApi(), _StubCoreApi("ErrImagePull", GAR_NOT_FOUND)
    executor = KubernetesExecutor(batch_api=batch, core_api=core)
    handle = {"namespace": "demo-3", "jobName": "ek-deploy-1"}

    status = await executor.get_status(handle)

    assert status.state is ExecutorRunState.FAILED
    assert status.error is not None and status.error.code == "IMAGE_NOT_FOUND"
    assert batch.deleted == ["ek-deploy-1"] and core.deleted_config_maps == ["ek-deploy-1"]
    # Cached like any other terminal state: the Job is gone now.
    assert (await executor.get_status(handle)) == status


async def test_get_status_keeps_running_while_a_transient_pull_error_is_within_grace() -> None:
    batch, core = _StubBatchApi(), _StubCoreApi("ImagePullBackOff", "dial tcp: i/o timeout")
    executor = KubernetesExecutor(batch_api=batch, core_api=core)

    status = await executor.get_status({"namespace": "demo-3", "jobName": "ek-deploy-1"})

    assert status.state is ExecutorRunState.RUNNING
    assert batch.deleted == []
