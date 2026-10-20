# SPDX-License-Identifier: MIT
"""Removing attempts' Jobs that no task can use any more.

Normally every Job is released once its task's outcome is committed. What
that misses: a Job started in a pass whose commit then failed, for a task
cancelled before any pass claimed it again (it would run to its deadline);
a release that failed; a Job whose execution was deleted. Every few minutes
the scheduler lists the attempts that still exist and releases the ones
that are neither a running task's current attempt nor the one a ready task
will adopt on its next claim.
"""

import logging
import uuid
from datetime import datetime, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.domain.states import TaskState
from app.executors.base import Executor, LaunchedAttempt
from app.persistence.models import ExecutionTask

logger = logging.getLogger(__name__)

# How old an attempt must be before the sweep considers it: well past any
# pass still settling it.
ORPHAN_MIN_AGE = timedelta(minutes=5)


def still_needed(attempt: LaunchedAttempt, task: ExecutionTask | None) -> bool:
    """Whether a task may still use this attempt's unit."""
    if task is None:
        return False
    if task.state is TaskState.RUNNING:
        return task.executor_handle == attempt.handle
    if task.state in (TaskState.READY, TaskState.CLAIMED):
        # A pass that started this attempt and then rolled back left the task
        # READY one attempt behind it; its next claim takes this attempt's
        # number and adopts the Job (KubernetesExecutor.start).
        return attempt.attempt == task.attempt_count + 1 or (
            task.state is TaskState.CLAIMED and attempt.attempt == task.attempt_count
        )
    return False  # finished, or BLOCKED (never started)


async def release_orphaned_attempts(
    session: AsyncSession, executor: Executor, *, older_than: datetime
) -> int:
    """Releases every attempt created before ``older_than`` that no task needs; returns how many.

    Only reads the database. The age limit keeps it clear of a pass in
    progress, whose rows (and Jobs) aren't settled yet.
    """
    attempts = [a for a in await executor.list_attempts() if a.created_at < older_than]
    execution_ids: set[uuid.UUID] = set()
    for attempt in attempts:
        try:
            execution_ids.add(uuid.UUID(attempt.execution_id))
        except ValueError:
            continue
    tasks: dict[tuple[str, str], ExecutionTask] = {}
    if execution_ids:
        result = await session.execute(
            select(ExecutionTask).where(ExecutionTask.execution_id.in_(execution_ids))
        )
        tasks = {(str(task.execution_id), task.task_key): task for task in result.scalars()}

    released = 0
    for attempt in attempts:
        task = tasks.get((attempt.execution_id, attempt.task_key))
        if still_needed(attempt, task):
            continue
        try:
            await executor.release(attempt.handle)
        except Exception:
            logger.warning("couldn't remove an orphaned attempt", extra={"handle": attempt.handle})
            continue
        released += 1
        logger.warning(
            "removed an attempt no task needs",
            extra={
                "executionId": attempt.execution_id,
                "taskKey": attempt.task_key,
                "attempt": attempt.attempt,
                "taskState": task.state.value if task else None,
                "handle": attempt.handle,
            },
        )
    return released

