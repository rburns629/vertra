# SPDX-License-Identifier: MIT
"""The executor abstraction the scheduler dispatches through.

The scheduler must never contain Kubernetes-specific logic of its own —
everything about actually running a task as a Kubernetes Job lives behind
this ``Executor`` protocol instead, so scheduler logic (claiming, retries,
DAG progression) can be tested against ``tests.fakes.FakeExecutor`` without
a real cluster. ``KubernetesExecutor`` is the only real implementation;
the Protocol earns its keep on testability alone, not on having multiple
production backends. ``ResolvedTask``, ``ExecutionHandle``, and
``ExecutionStatus`` are the only things that cross that boundary.
"""

from enum import StrEnum
from typing import Any, Protocol, runtime_checkable

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.contracts.result import StructuredError
from app.contracts.task import ProductRequest, TaskResources

# Opaque outside the executor that produced it -- KubernetesExecutor stores
# {"namespace": ..., "jobName": ...}. The scheduler persists this verbatim
# (as JSONB) and passes it back unexamined for get_status/cancel/get_logs
# calls, including after its own restart.
type ExecutionHandle = dict[str, Any]


class ResolvedTask(BaseModel):
    """Everything an executor needs to launch one attempt of one task.

    Built by the scheduler from a persisted ``ExecutionTask`` row plus its
    resolved inputs (see ``app.scheduler.input_resolution``). ``image`` and
    ``timeout_seconds`` are excluded from ``to_product_request()`` — the
    container itself doesn't need to know either.
    """

    model_config = ConfigDict(extra="forbid")

    execution_id: str
    task_key: str
    image: str
    action: str
    attempt: int = Field(ge=1)
    resolved_inputs: dict[str, Any] = Field(default_factory=dict)
    timeout_seconds: int = Field(gt=0)
    # Which team owns this task and which ServiceAccount its Pod runs as —
    # see TaskDefinition. Load-bearing for KubernetesExecutor: team becomes
    # the dispatch namespace, service_account becomes the Pod's identity.
    team: str = Field(min_length=1)
    service_account: str = Field(min_length=1)
    # Names of Kubernetes Secrets to mount into the task's Pod -- see
    # TaskDefinition (app.contracts.task) for the authorization story.
    secret_refs: list[str] = Field(default_factory=list)
    # The task's own resources, before the deployment's defaults are applied.
    resources: TaskResources | None = None

    def to_product_request(self) -> ProductRequest:
        return ProductRequest(
            executionId=self.execution_id,
            taskId=self.task_key,
            action=self.action,
            attempt=self.attempt,
            inputs=self.resolved_inputs,
        )


class ExecutorRunState(StrEnum):
    """The underlying execution unit's status, as observed by an executor.

    Deliberately smaller than ``TaskState``: an executor knows nothing about
    DAG blocking or claiming, only whether the thing it launched is still
    running or has finished.
    """

    RUNNING = "RUNNING"
    SUCCEEDED = "SUCCEEDED"
    FAILED = "FAILED"


class ExecutionStatus(BaseModel):
    """The result of polling an executor for one attempt's current status."""

    model_config = ConfigDict(extra="forbid")

    state: ExecutorRunState
    outputs: dict[str, Any] | None = None
    error: StructuredError | None = None

    @model_validator(mode="after")
    def _check_consistency(self) -> "ExecutionStatus":
        if self.state is ExecutorRunState.RUNNING and (
            self.outputs is not None or self.error is not None
        ):
            raise ValueError("A RUNNING status must not include outputs or an error.")
        if self.state is ExecutorRunState.SUCCEEDED and self.outputs is None:
            raise ValueError("A SUCCEEDED status must include outputs.")
        if self.state is ExecutorRunState.FAILED and self.error is None:
            raise ValueError("A FAILED status must include a structured error.")
        return self


@runtime_checkable
class Executor(Protocol):
    """Runs one task attempt somewhere — a local container, a Kubernetes Job, or a test double."""

    async def start(self, task: ResolvedTask) -> ExecutionHandle:
        """Launch one attempt of ``task``.

        Must not block until completion — returns as soon as the underlying
        unit of execution (container, Job) has been created, so the
        scheduler can move on to claiming and dispatching other tasks.
        """
        ...

    async def get_status(self, handle: ExecutionHandle) -> ExecutionStatus:
        """Poll the current status of a previously started execution."""
        ...

    async def cancel(self, handle: ExecutionHandle) -> None:
        """Request cancellation of a running execution.

        Idempotent: cancelling an execution that already finished or was
        already cancelled must not raise.
        """
        ...

    async def get_logs(self, handle: ExecutionHandle) -> list[str]:
        """Return the captured output lines for ``handle``, for diagnostics."""
        ...

    async def discard(self, task: ResolvedTask) -> None:
        """Remove whatever a ``start`` of this attempt may have left behind.

        Called when the scheduler gives up on starting an attempt (or the
        cluster refused it): a start that raised may still have created
        something, half set up, that nobody would otherwise clean up.
        Idempotent: nothing there must not raise.
        """
        ...
