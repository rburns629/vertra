# SPDX-License-Identifier: MIT
"""Transactional task claiming.

Uses ``SELECT ... FOR UPDATE SKIP LOCKED`` so multiple scheduler instances
can poll concurrently without blocking each other or double-claiming the
same task — each caller walks away with a disjoint set of rows. This does
not make execution exactly-once: a task can still run twice (e.g. a
scheduler crashes after a Job's Pod has already acted on the outside world,
and the task is later retried). Execution is at-least-once; product actions
must be idempotent.
"""

import logging
from datetime import UTC, datetime, timedelta

from sqlalchemy import delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.domain.events import EventType
from app.domain.states import ExecutionState, TaskState
from app.persistence.models import Execution, ExecutionTask, TaskAttempt
from app.persistence.repositories import record_event

logger = logging.getLogger(__name__)

# A task only stays claimable-by-recovery in these states: CLAIMED means a
# scheduler claimed it but never got as far as dispatch; RUNNING means
# dispatch happened but the scheduler stopped polling before completion (it
# crashed, was killed, or was replaced by a rollout, which gives the new Pod
# a new name and so a new lease owner).
_RECOVERABLE_STATES = (TaskState.CLAIMED, TaskState.RUNNING)


async def recover_expired_leases(
    session: AsyncSession,
    *,
    owner: str,
    lease_duration: timedelta,
    now: datetime | None = None,
) -> int:
    """Take over every CLAIMED or RUNNING task whose lease has expired.

    An expired lease doesn't mean the task failed — the scheduler instance
    that owned it may have crashed, stalled, or been killed. A RUNNING task
    already has a Job, so ``owner`` adopts it: the lease moves over and the
    next poll reads the same Job through its stored handle. Starting it
    again instead would run every in-flight task twice on each scheduler
    rollout, the old Job still running with nobody watching it. A CLAIMED
    task never got a Job, so it goes back to READY to be claimed normally.
    Neither touches ``attempt_count`` (claiming does that).

    Returns the number of tasks recovered.
    """
    current_time = now or datetime.now(UTC)
    result = await session.execute(
        select(ExecutionTask)
        .where(
            ExecutionTask.state.in_(_RECOVERABLE_STATES),
            ExecutionTask.lease_expires_at < current_time,
        )
        .with_for_update(skip_locked=True)
    )
    expired_tasks = result.scalars().all()

    for task in expired_tasks:
        if task.state is TaskState.RUNNING and task.executor_handle is not None:
            logger.info(
                "adopting running task from an expired lease",
                extra={
                    "executionId": str(task.execution_id),
                    "taskKey": task.task_key,
                    "previousOwner": task.lease_owner,
                    "owner": owner,
                },
            )
            task.lease_owner = owner
            task.lease_expires_at = current_time + lease_duration
            continue
        task.state = TaskState.READY
        task.lease_owner = None
        task.lease_expires_at = None
        task.executor_handle = None

    if expired_tasks:
        await session.flush()

    return len(expired_tasks)


async def return_unstarted_attempt(session: AsyncSession, task: ExecutionTask) -> None:
    """Hand a claimed task back as if this claim never happened.

    For a start that raised: undoes what claiming did (its attempt row, the
    attempt number), so the next claim gets the same attempt number, and with
    it the same Job name, which ``KubernetesExecutor.start`` adopts if that
    start did create it. The caller sets when it may be claimed again.
    """
    await session.execute(
        delete(TaskAttempt).where(
            TaskAttempt.task_id == task.id, TaskAttempt.attempt_number == task.attempt_count
        )
    )
    task.attempt_count -= 1
    task.state = TaskState.READY
    task.lease_owner = None
    task.lease_expires_at = None
    task.executor_handle = None


async def release_leases(session: AsyncSession, *, owner: str, now: datetime) -> int:
    """Expire every lease ``owner`` holds, for a scheduler that's shutting down.

    The tasks themselves are left as they are: the next scheduler to claim
    recovers them through ``recover_expired_leases`` (adopting the RUNNING
    ones), at once rather than when the leases would have run out.

    Returns the number of leases released.
    """
    result = await session.execute(
        update(ExecutionTask)
        .where(ExecutionTask.state.in_(_RECOVERABLE_STATES), ExecutionTask.lease_owner == owner)
        .values(lease_expires_at=now)
        .returning(ExecutionTask.id)
        .execution_options(synchronize_session="fetch")
    )
    return len(result.all())


# How many candidates to read per claimable slot when a per-team cap applies.
_PER_TEAM_CANDIDATES = 4


async def _running_per_team(session: AsyncSession) -> dict[str, int]:
    """How many tasks each team has claimed or running, across every scheduler."""
    result = await session.execute(
        select(ExecutionTask.team, func.count())
        .where(ExecutionTask.state.in_((TaskState.CLAIMED, TaskState.RUNNING)))
        .group_by(ExecutionTask.team)
    )
    return {team: count for team, count in result.all()}


async def claim_ready_tasks(
    session: AsyncSession,
    *,
    owner: str,
    lease_duration: timedelta,
    limit: int = 10,
    max_running: int | None = None,
    max_running_per_team: int | None = None,
    now: datetime | None = None,
) -> list[ExecutionTask]:
    """Claim up to ``limit`` READY tasks whose ``available_at`` has passed.

    ``max_running`` caps how many tasks are claimed or running at once across
    the whole platform, and ``max_running_per_team`` how many per team, so a
    burst can't run up the bill or crowd out other teams; a task over a cap
    stays READY for a later pass. The caps are exact with one scheduler. With
    several, each counts on its own, so the total can overshoot by up to one
    pass's claims per extra scheduler.

    Only tasks belonging to a still-active execution (PENDING or RUNNING)
    are eligible — once an execution has failed or succeeded, its remaining
    tasks (if any) are never claimed, regardless of their own state.

    Recovers expired leases first, in the same call, so a caller only has to
    poll one function each scheduling tick. Each claimed task is moved to
    CLAIMED, given a lease owned by ``owner`` expiring after
    ``lease_duration``, and gets a new ``TaskAttempt`` row recording the
    (incremented) attempt number. Nothing is committed here: the scheduler
    commits a whole tick at once, claims and dispatches together. If that
    commit fails after a Job was created, the claim rolls back with it, so
    the next claim gets the same attempt number, and with it the same Job
    name, which ``KubernetesExecutor.start`` adopts instead of starting again.
    """
    current_time = now or datetime.now(UTC)
    await recover_expired_leases(
        session, owner=owner, lease_duration=lease_duration, now=current_time
    )

    running_per_team: dict[str, int] = {}
    if max_running is not None or max_running_per_team is not None:
        running_per_team = await _running_per_team(session)
    if max_running is not None:
        limit = min(limit, max_running - sum(running_per_team.values()))
        if limit <= 0:
            return []

    result = await session.execute(
        select(ExecutionTask)
        .join(Execution, Execution.id == ExecutionTask.execution_id)
        .where(
            ExecutionTask.state == TaskState.READY,
            ExecutionTask.available_at <= current_time,
            Execution.state.in_((ExecutionState.PENDING, ExecutionState.RUNNING)),
        )
        .order_by(ExecutionTask.available_at)
        # With a per-team cap, some candidates may belong to teams already
        # at it; reading a few more keeps one busy team from starving the rest.
        .limit(limit if max_running_per_team is None else limit * _PER_TEAM_CANDIDATES)
        .with_for_update(of=ExecutionTask, skip_locked=True)
    )
    candidates = result.scalars().all()

    claimed_tasks: list[ExecutionTask] = []
    for task in candidates:
        if len(claimed_tasks) == limit:
            break
        if max_running_per_team is not None:
            if running_per_team.get(task.team, 0) >= max_running_per_team:
                continue
            running_per_team[task.team] = running_per_team.get(task.team, 0) + 1
        claimed_tasks.append(task)

    for task in claimed_tasks:
        task.state = TaskState.CLAIMED
        task.lease_owner = owner
        task.lease_expires_at = current_time + lease_duration
        task.attempt_count += 1
        session.add(TaskAttempt(task_id=task.id, attempt_number=task.attempt_count))
        await record_event(
            session,
            execution_id=task.execution_id,
            task_id=task.id,
            event_type=EventType.TASK_CLAIMED,
            payload={"taskKey": task.task_key, "owner": owner, "attempt": task.attempt_count},
        )

    if claimed_tasks:
        await session.flush()

    return list(claimed_tasks)
