# SPDX-License-Identifier: MIT
"""A finished Job is only removed by release(), never by reading its result.

Reading the result happens inside the scheduler's pass, before it commits;
removing the Job then lost the result whenever that commit failed and the
task's lease passed to another scheduler, which found no Job and ran the
step again. No cluster needed: stub API clients stand in for the real ones.
"""

import json
from datetime import UTC, datetime
from types import SimpleNamespace

from app.executors.base import ExecutorRunState
from app.executors.kubernetes import CONTAINER_NAME, KubernetesExecutor

HANDLE = {"namespace": "demo-3", "jobName": "ek-greet-1"}


class _BatchApi:
    def __init__(self) -> None:
        self.deleted: list[str] = []

    def read_namespaced_job_status(self, name: str, namespace: str, **_: object) -> object:
        return SimpleNamespace(status=SimpleNamespace(succeeded=1, failed=None, ready=0))

    def delete_namespaced_job(self, name: str, namespace: str, **_: object) -> None:
        self.deleted.append(name)


class _CoreApi:
    def __init__(self) -> None:
        self.deleted_config_maps: list[str] = []

    def list_namespaced_pod(self, namespace: str, label_selector: str, **_: object) -> object:
        result = json.dumps({"status": "succeeded", "outputs": {"greeting": "hello"}})
        terminated = SimpleNamespace(message=result, exit_code=0)
        status = SimpleNamespace(name=CONTAINER_NAME, state=SimpleNamespace(terminated=terminated))
        pod = SimpleNamespace(
            metadata=SimpleNamespace(name="ek-greet-1-abcde"),
            status=SimpleNamespace(container_statuses=[status]),
        )
        return SimpleNamespace(items=[pod])

    def read_namespaced_pod_log(self, name: str, namespace: str, **_: object) -> object:
        return SimpleNamespace(data=b"hello\n")

    def delete_namespaced_config_map(self, name: str, namespace: str, **_: object) -> None:
        self.deleted_config_maps.append(name)


async def test_reading_a_finished_jobs_result_leaves_the_job() -> None:
    batch, core = _BatchApi(), _CoreApi()
    executor = KubernetesExecutor(batch_api=batch, core_api=core)

    status = await executor.get_status(HANDLE)

    assert status.state is ExecutorRunState.SUCCEEDED
    assert status.outputs == {"greeting": "hello"}
    assert batch.deleted == [] and core.deleted_config_maps == []


async def test_release_removes_the_job_and_configmap_and_keeps_the_result() -> None:
    batch, core = _BatchApi(), _CoreApi()
    executor = KubernetesExecutor(batch_api=batch, core_api=core)
    status = await executor.get_status(HANDLE)

    await executor.release(HANDLE)
    await executor.release(HANDLE)  # idempotent: a second release changes nothing

    assert batch.deleted == ["ek-greet-1", "ek-greet-1"]
    assert core.deleted_config_maps == ["ek-greet-1", "ek-greet-1"]
    assert (await executor.get_status(HANDLE)) == status


class _ListingBatchApi:
    def list_job_for_all_namespaces(self, label_selector: str, **_: object) -> object:
        assert label_selector == "app=execution-kernel"
        created = datetime(2026, 10, 20, 12, 0, tzinfo=UTC)

        def job(name: str, labels: dict[str, str], annotations: dict[str, str]) -> object:
            return SimpleNamespace(
                metadata=SimpleNamespace(
                    name=name,
                    namespace="demo-3",
                    labels={"app": "execution-kernel", **labels},
                    annotations=annotations,
                    creation_timestamp=created,
                )
            )

        return SimpleNamespace(
            items=[
                job(
                    "ek-greet-1",
                    {"acyclix.dev/execution-id": "e-1", "acyclix.dev/attempt": "2"},
                    {"acyclix.dev/task": "greet"},
                ),
                job("ek-hand-made", {}, {}),  # not made the way the kernel makes Jobs
            ]
        )


async def test_list_attempts_reads_each_jobs_identity_from_its_labels() -> None:
    executor = KubernetesExecutor(batch_api=_ListingBatchApi(), core_api=_CoreApi())

    attempts = await executor.list_attempts()

    assert len(attempts) == 1
    attempt = attempts[0]
    assert attempt.handle == {"namespace": "demo-3", "jobName": "ek-greet-1"}
    assert (attempt.execution_id, attempt.task_key, attempt.attempt) == ("e-1", "greet", 2)
    assert attempt.created_at == datetime(2026, 10, 20, 12, 0, tzinfo=UTC)
