# SPDX-License-Identifier: MIT
"""Task and execution state enums.

Initial-state and transition rules:

- A task with no dependencies begins as ``READY``; a task with dependencies
  begins as ``BLOCKED``.
- An execution begins as ``PENDING`` and becomes ``RUNNING`` once its first
  task starts.
- An execution succeeds only when every task succeeds. A failed task blocks
  all of its (transitive) dependents; for the MVP, one unrecoverable task
  failure fails the whole execution.
"""

from collections.abc import Collection
from dataclasses import dataclass
from datetime import timedelta
from enum import StrEnum


class TaskState(StrEnum):
    BLOCKED = "BLOCKED"
    READY = "READY"
    CLAIMED = "CLAIMED"
    RUNNING = "RUNNING"
    SUCCEEDED = "SUCCEEDED"
    FAILED = "FAILED"
    CANCELLED = "CANCELLED"


TERMINAL_TASK_STATES: frozenset[TaskState] = frozenset(
    {TaskState.SUCCEEDED, TaskState.FAILED, TaskState.CANCELLED}
)


def initial_task_state(depends_on: Collection[str]) -> TaskState:
    """A task with no declared dependencies starts READY; otherwise it starts BLOCKED."""
    return TaskState.BLOCKED if depends_on else TaskState.READY


class ExecutionState(StrEnum):
    PENDING = "PENDING"
    RUNNING = "RUNNING"
    SUCCEEDED = "SUCCEEDED"
    FAILED = "FAILED"
    CANCELLED = "CANCELLED"


TERMINAL_EXECUTION_STATES: frozenset[ExecutionState] = frozenset(
    {ExecutionState.SUCCEEDED, ExecutionState.FAILED, ExecutionState.CANCELLED}
)
ACTIVE_EXECUTION_STATES: frozenset[ExecutionState] = frozenset(
    {ExecutionState.PENDING, ExecutionState.RUNNING}
)


def should_retry(*, attempt_count: int, max_attempts: int, retryable: bool) -> bool:
    """Whether a failed task should return to READY for another attempt.

    Both conditions must hold: the failure must be one the product (or the
    executor, for infrastructure-side failures) marked retryable, and there
    must be attempts remaining. A non-retryable failure is terminal
    regardless of how many attempts are left.
    """
    return retryable and attempt_count < max_attempts


@dataclass(frozen=True, slots=True)
class RetryBackoff:
    """How long a failed task waits before its next attempt: ``base_seconds``
    after the first failure, doubling with each one after, never more than
    ``max_seconds``. So a brief outage (the Kubernetes API restarting, a
    registry blip) doesn't use up every attempt within a second."""

    base_seconds: float = 5.0
    max_seconds: float = 300.0

    def delay(self, failed_attempt: int) -> timedelta:
        seconds = self.base_seconds * 2 ** max(failed_attempt - 1, 0)
        return timedelta(seconds=min(seconds, self.max_seconds))
