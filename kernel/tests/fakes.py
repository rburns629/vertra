# SPDX-License-Identifier: MIT
"""Shared test doubles used by both unit and integration tests."""

from datetime import UTC, datetime

from app.contracts.result import StructuredError
from app.executors.base import (
    ExecutionHandle,
    ExecutionStatus,
    ExecutorRunState,
    LaunchedAttempt,
    ResolvedTask,
)


class FakeExecutor:
    """A minimal in-memory ``Executor``.

    Proves the Protocol is actually implementable, and gives higher layers
    (the scheduler loop) something deterministic and controllable to test
    dispatch/polling logic against without a real Kubernetes cluster. Tests
    drive outcomes explicitly via ``complete()``/``fail()`` rather than the
    fake resolving on its own.
    """

    def __init__(self) -> None:
        self._statuses: dict[str, ExecutionStatus] = {}
        self._logs: dict[str, list[str]] = {}
        self._next_id = 0
        self.cancelled: list[str] = []
        self.start_error: Exception | None = None
        self.status_error: Exception | None = None
        self.started: list[ResolvedTask] = []
        # Every start call, raising or not, and every discard.
        self.start_calls: list[ResolvedTask] = []
        self.discarded: list[ResolvedTask] = []
        self.released: list[str] = []
        # Every attempt start() launched, as list_attempts() reports it until
        # it's released or cancelled. Tests may backdate created_at.
        self.launched: dict[str, LaunchedAttempt] = {}
        # Raised by cancel() while set; cleared to let cancels through.
        self.cancel_error: Exception | None = None

    async def start(self, task: ResolvedTask) -> ExecutionHandle:
        self.start_calls.append(task)
        if self.start_error is not None:
            raise self.start_error
        self.started.append(task)
        self._next_id += 1
        handle_id = str(self._next_id)
        self._statuses[handle_id] = ExecutionStatus(state=ExecutorRunState.RUNNING)
        self._logs[handle_id] = [f"started {task.task_key} attempt {task.attempt}"]
        handle = {"fakeId": handle_id}
        self.launched[handle_id] = LaunchedAttempt(
            handle=handle,
            execution_id=task.execution_id,
            task_key=task.task_key,
            attempt=task.attempt,
            created_at=datetime.now(UTC),
        )
        return handle

    async def get_status(self, handle: ExecutionHandle) -> ExecutionStatus:
        if self.status_error is not None:
            raise self.status_error
        return self._statuses[handle["fakeId"]]

    async def cancel(self, handle: ExecutionHandle) -> None:
        if self.cancel_error is not None:
            raise self.cancel_error
        handle_id = handle["fakeId"]
        self.cancelled.append(handle_id)
        self.launched.pop(handle_id, None)  # cancelling removes the unit, as the real one does
        if self._statuses[handle_id].state is ExecutorRunState.RUNNING:
            error = StructuredError(code="CANCELLED", message="cancelled", retryable=False)
            self._statuses[handle_id] = ExecutionStatus(state=ExecutorRunState.FAILED, error=error)

    async def get_logs(self, handle: ExecutionHandle) -> list[str]:
        return self._logs[handle["fakeId"]]

    async def release(self, handle: ExecutionHandle) -> None:
        self.released.append(handle["fakeId"])
        self.launched.pop(handle["fakeId"], None)

    async def list_attempts(self) -> list[LaunchedAttempt]:
        return list(self.launched.values())

    async def discard(self, task: ResolvedTask) -> None:
        self.discarded.append(task)

    def complete(self, handle: ExecutionHandle, outputs: dict[str, object]) -> None:
        """Test-only helper: simulate the underlying execution succeeding."""
        self._statuses[handle["fakeId"]] = ExecutionStatus(
            state=ExecutorRunState.SUCCEEDED, outputs=outputs
        )

    def fail(self, handle: ExecutionHandle, error: StructuredError) -> None:
        """Test-only helper: simulate the underlying execution failing."""
        self._statuses[handle["fakeId"]] = ExecutionStatus(
            state=ExecutorRunState.FAILED, error=error
        )
