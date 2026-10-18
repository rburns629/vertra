# SPDX-License-Identifier: MIT
"""Unit tests for app.executors.base — the Executor protocol and its boundary types."""

import pytest
from pydantic import ValidationError

from app.contracts.result import StructuredError
from app.executors.base import (
    ExecutionStatus,
    Executor,
    ExecutorRunState,
    ResolvedTask,
)
from tests.fakes import FakeExecutor


def _resolved_task(**overrides: object) -> ResolvedTask:
    defaults: dict[str, object] = {
        "execution_id": "exec-1",
        "task_key": "create-project",
        "image": "demo-project-product:local",
        "action": "create",
        "attempt": 1,
        "resolved_inputs": {"projectName": "demo-project"},
        "timeout_seconds": 300,
        "team": "test-team",
        "service_account": "default",
    }
    defaults.update(overrides)
    return ResolvedTask(**defaults)  # type: ignore[arg-type]


class TestResolvedTask:
    def test_to_product_request_maps_fields_correctly(self) -> None:
        task = _resolved_task()
        request = task.to_product_request()

        assert request.execution_id == "exec-1"
        assert request.task_id == "create-project"
        assert request.action == "create"
        assert request.attempt == 1
        assert request.inputs == {"projectName": "demo-project"}

    def test_image_and_timeout_are_not_part_of_the_product_request(self) -> None:
        request = _resolved_task().to_product_request()
        assert not hasattr(request, "image")
        assert not hasattr(request, "timeout_seconds")


class TestExecutionStatus:
    def test_running_status_is_valid_without_outputs_or_error(self) -> None:
        status = ExecutionStatus(state=ExecutorRunState.RUNNING)
        assert status.outputs is None
        assert status.error is None

    def test_running_status_rejects_outputs(self) -> None:
        with pytest.raises(ValidationError):
            ExecutionStatus(state=ExecutorRunState.RUNNING, outputs={"x": 1})

    def test_succeeded_status_requires_outputs(self) -> None:
        with pytest.raises(ValidationError):
            ExecutionStatus(state=ExecutorRunState.SUCCEEDED)

    def test_succeeded_status_with_outputs_is_valid(self) -> None:
        status = ExecutionStatus(
            state=ExecutorRunState.SUCCEEDED, outputs={"projectId": "demo-project-123"}
        )
        assert status.outputs == {"projectId": "demo-project-123"}

    def test_failed_status_requires_error(self) -> None:
        with pytest.raises(ValidationError):
            ExecutionStatus(state=ExecutorRunState.FAILED)

    def test_failed_status_with_error_is_valid(self) -> None:
        error = StructuredError(code="PRODUCT_EXECUTION_FAILED", message="boom", retryable=False)
        status = ExecutionStatus(state=ExecutorRunState.FAILED, error=error)
        assert status.error is not None
        assert status.error.code == "PRODUCT_EXECUTION_FAILED"


class TestExecutorProtocolConformance:
    async def test_fake_executor_satisfies_the_protocol(self) -> None:
        executor: Executor = FakeExecutor()
        assert isinstance(executor, Executor)

    async def test_start_then_get_status_reports_running(self) -> None:
        executor = FakeExecutor()
        handle = await executor.start(_resolved_task())
        status = await executor.get_status(handle)
        assert status.state is ExecutorRunState.RUNNING

    async def test_completed_execution_reports_outputs(self) -> None:
        executor = FakeExecutor()
        handle = await executor.start(_resolved_task())
        executor.complete(handle, {"projectId": "demo-project-123"})

        status = await executor.get_status(handle)

        assert status.state is ExecutorRunState.SUCCEEDED
        assert status.outputs == {"projectId": "demo-project-123"}

    async def test_cancel_is_idempotent(self) -> None:
        executor = FakeExecutor()
        handle = await executor.start(_resolved_task())

        await executor.cancel(handle)
        await executor.cancel(handle)  # must not raise

        status = await executor.get_status(handle)
        assert status.state is ExecutorRunState.FAILED

    async def test_get_logs_returns_captured_lines(self) -> None:
        executor = FakeExecutor()
        handle = await executor.start(_resolved_task(task_key="deploy-application", attempt=2))

        logs = await executor.get_logs(handle)

        assert logs == ["started deploy-application attempt 2"]
