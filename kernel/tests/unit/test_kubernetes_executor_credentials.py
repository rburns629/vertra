# SPDX-License-Identifier: MIT
"""A credential a step sends back isn't stored (app/domain/credentials.py):
its logs and error messages are redacted, and outputs holding one fail the
task. A stub answers the API calls a finished step's status read makes."""

import json
from types import SimpleNamespace
from typing import Any

from app.executors.base import ResolvedTask
from app.executors.kubernetes import KubernetesExecutor

AWS = "AKIA" + "ABCDEFGHIJKLMNOP"


class _Api:
    def __init__(self, answers: dict[str, Any]) -> None:
        self._answers = answers

    def __getattr__(self, name: str) -> Any:
        return lambda *_args, **_kwargs: self._answers.get(name)


def _executor(result: dict[str, Any], log: str) -> KubernetesExecutor:
    pod = SimpleNamespace(
        metadata=SimpleNamespace(name="pod-1", creation_timestamp=None),
        status=SimpleNamespace(
            container_statuses=[
                SimpleNamespace(
                    name="product",
                    image="registry.example/app:1",
                    state=SimpleNamespace(
                        terminated=SimpleNamespace(message=json.dumps(result), exit_code=0),
                        waiting=None,
                    ),
                )
            ]
        ),
    )
    finished = SimpleNamespace(status=SimpleNamespace(succeeded=1, failed=None, ready=None))
    batch = _Api(
        {
            "create_namespaced_job": SimpleNamespace(metadata=SimpleNamespace(uid="uid-1")),
            "read_namespaced_job_status": finished,
        }
    )
    core = _Api(
        {
            "list_namespaced_pod": SimpleNamespace(items=[pod]),
            "read_namespaced_pod_log": SimpleNamespace(data=log.encode()),
        }
    )
    return KubernetesExecutor(batch_api=batch, core_api=core)


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


async def test_outputs_holding_a_credential_fail_the_task_and_logs_are_redacted() -> None:
    executor = _executor(
        {"status": "succeeded", "outputs": {"accessKey": AWS}}, f"signing in as {AWS}\ndone\n"
    )
    handle = await executor.start(_task())
    status = await executor.get_status(handle)
    assert status.state.value == "FAILED"
    assert status.error is not None
    assert status.error.code == "OUTPUT_CONTAINS_CREDENTIAL"
    assert not status.error.retryable
    assert AWS not in status.error.message
    assert status.outputs in (None, {})
    assert await executor.get_logs(handle) == ["signing in as [redacted AWS access key]", "done"]


async def test_a_products_own_error_message_is_redacted() -> None:
    error = {"code": "AUTH_FAILED", "message": f"key {AWS} was refused", "retryable": False}
    executor = _executor({"status": "failed", "error": error}, "")
    status = await executor.get_status(await executor.start(_task()))
    assert status.error is not None
    assert status.error.message == "key [redacted AWS access key] was refused"


async def test_clean_outputs_pass_through() -> None:
    executor = _executor({"status": "succeeded", "outputs": {"bucket": "b-1"}}, "ok\n")
    status = await executor.get_status(await executor.start(_task()))
    assert status.state.value == "SUCCEEDED"
    assert status.outputs == {"bucket": "b-1"}
