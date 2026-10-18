# SPDX-License-Identifier: MIT
"""Every Kubernetes API call the executor makes carries a request timeout.

The client's own default is to wait forever, so a single half-open
connection would stall a scheduling pass, and the row locks it holds. A
recording stub stands in for both APIs and answers each call just well
enough for the executor to go through a task's whole life.
"""

import json
from types import SimpleNamespace
from typing import Any

from app.executors.base import ResolvedTask
from app.executors.kubernetes import KubernetesExecutor


class _RecordingApi:
    """Answers any API method, recording its name and keyword arguments."""

    def __init__(self, answers: dict[str, Any]) -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self._answers = answers

    def __getattr__(self, name: str) -> Any:
        def call(*_args: object, **kwargs: Any) -> Any:
            self.calls.append((name, kwargs))
            return self._answers.get(name)

        return call


def _task() -> ResolvedTask:
    return ResolvedTask(
        execution_id="e",
        task_key="t",
        image="registry.example/app:1",
        action="create",
        attempt=1,
        resolved_inputs={},
        timeout_seconds=300,
        team="team-a",
        service_account="default",
        secret_refs=[],
    )


async def test_every_call_through_a_tasks_life_has_a_timeout() -> None:
    finished = SimpleNamespace(status=SimpleNamespace(succeeded=1, failed=None, ready=None))
    result = json.dumps({"status": "succeeded", "outputs": {}})
    pod = SimpleNamespace(
        metadata=SimpleNamespace(name="pod-1", creation_timestamp=None),
        status=SimpleNamespace(
            container_statuses=[
                SimpleNamespace(
                    name="product",
                    image="registry.example/app:1",
                    state=SimpleNamespace(
                        terminated=SimpleNamespace(message=result, exit_code=0), waiting=None
                    ),
                )
            ]
        ),
    )
    batch = _RecordingApi(
        {
            "create_namespaced_job": SimpleNamespace(metadata=SimpleNamespace(uid="uid-1")),
            "read_namespaced_job_status": finished,
        }
    )
    core = _RecordingApi(
        {
            "list_namespaced_pod": SimpleNamespace(items=[pod]),
            "read_namespaced_pod_log": SimpleNamespace(data=b"done\n"),
        }
    )
    executor = KubernetesExecutor(batch_api=batch, core_api=core, request_timeout_seconds=7)

    handle = await executor.start(_task())
    status = await executor.get_status(handle)  # finished: reads the Pod, its logs, then deletes
    assert status.state.value == "SUCCEEDED"
    await executor.cancel({"namespace": "team-a", "jobName": "another"})

    calls = batch.calls + core.calls
    assert {name for name, _ in calls} >= {
        "create_namespaced_job",
        "create_namespaced_config_map",
        "read_namespaced_job_status",
        "list_namespaced_pod",
        "read_namespaced_pod_log",
        "delete_namespaced_job",
        "delete_namespaced_config_map",
    }
    assert [name for name, kwargs in calls if kwargs.get("_request_timeout") != 7] == []
