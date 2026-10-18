# SPDX-License-Identifier: MIT
"""Turns a validated execution submission into durable rows.

``submit_execution`` is the single entry point, and the single place that
decides: is this a brand-new execution, or an idempotent replay of one that
already exists? It does not commit — the caller (the API route, or a test
fixture) controls the transaction boundary, per the rule that the API and
scheduler talk to each other only through durable database state.
"""

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from enum import StrEnum
from typing import Any

from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.contracts.execution import ExecutionSubmission
from app.contracts.task import TaskDefinition
from app.domain.dag_validation import DEFAULT_MAX_TASKS, validate_dag
from app.domain.events import EventType
from app.domain.states import (
    ACTIVE_EXECUTION_STATES,
    TERMINAL_EXECUTION_STATES,
    ExecutionState,
    TaskState,
    initial_task_state,
)
from app.persistence.models import (
    Execution,
    ExecutionTask,
    TaskAttempt,
    TaskDependency,
    TaskLog,
    TaskOutput,
)
from app.persistence.repositories import (
    get_execution_by_id,
    get_execution_by_idempotency_key,
    record_event,
    transition_execution_state,
)
from app.persistence.repositories import (
    get_execution_events as _fetch_execution_events,
)


@dataclass(frozen=True, slots=True)
class ExecutionSubmissionResult:
    execution_id: uuid.UUID
    state: ExecutionState
    created: bool  # False when this is an idempotent replay of an existing execution


async def submit_execution(
    session: AsyncSession,
    submission: ExecutionSubmission,
    *,
    max_tasks: int = DEFAULT_MAX_TASKS,
) -> ExecutionSubmissionResult:
    """Validate and persist ``submission``, or return the existing execution if its
    idempotency key was already used.

    Raises ``DAGValidationError`` if the task graph itself is invalid; nothing
    is persisted in that case.
    """
    existing = await get_execution_by_idempotency_key(session, submission.idempotency_key)
    if existing is not None:
        return ExecutionSubmissionResult(
            execution_id=existing.id, state=existing.state, created=False
        )

    validate_dag(submission.tasks, max_tasks=max_tasks)

    execution, dependencies = _build_execution_graph(submission)

    try:
        # A savepoint, not the whole transaction: if a concurrent request with
        # the same idempotency key committed first, only this insert attempt
        # rolls back — the caller's transaction stays usable.
        async with session.begin_nested():
            session.add(execution)
            # TaskDependency has no ORM relationship() to ExecutionTask (plain
            # FK columns only), so the flush order between them isn't
            # automatic — the execution_tasks rows must exist before the
            # task_dependencies rows that reference them.
            await session.flush()

            session.add_all(dependencies)
            await record_event(
                session,
                execution_id=execution.id,
                event_type=EventType.EXECUTION_CREATED,
                payload={"taskCount": len(submission.tasks)},
            )
            await session.flush()
    except IntegrityError:
        existing = await get_execution_by_idempotency_key(session, submission.idempotency_key)
        if existing is None:
            raise
        return ExecutionSubmissionResult(
            execution_id=existing.id, state=existing.state, created=False
        )

    return ExecutionSubmissionResult(execution_id=execution.id, state=execution.state, created=True)


def _build_execution_graph(
    submission: ExecutionSubmission,
) -> tuple[Execution, list[TaskDependency]]:
    # Ids are assigned here (not left to the column default) so dependency
    # edges can reference them immediately, without an intermediate flush.
    execution = Execution(
        id=uuid.uuid4(),
        external_reference=submission.external_reference,
        idempotency_key=submission.idempotency_key,
        state=ExecutionState.PENDING,
    )

    tasks_by_key = {
        task_def.id: _build_task(execution, task_def) for task_def in submission.tasks
    }

    dependencies = [
        TaskDependency(
            task_id=tasks_by_key[task_def.id].id,
            depends_on_task_id=tasks_by_key[dep_id].id,
        )
        for task_def in submission.tasks
        for dep_id in task_def.depends_on
    ]

    return execution, dependencies


def _build_task(execution: Execution, task_def: TaskDefinition) -> ExecutionTask:
    return ExecutionTask(
        id=uuid.uuid4(),
        execution=execution,
        task_key=task_def.id,
        image=task_def.image,
        action=task_def.action,
        state=initial_task_state(task_def.depends_on),
        original_inputs=task_def.inputs,
        timeout_seconds=task_def.timeout_seconds,
        max_attempts=task_def.max_attempts,
        team=task_def.team,
        service_account=task_def.service_account,
        secret_refs=task_def.secret_refs,
        resources=(
            task_def.resources.model_dump(by_alias=True, exclude_none=True)
            if task_def.resources
            else None
        ),
    )


@dataclass(frozen=True, slots=True)
class TaskDetail:
    task_id: str
    state: TaskState
    attempt_count: int
    outputs: dict[str, Any] | None
    failure: dict[str, Any] | None
    depends_on: list[str]
    started_at: datetime | None
    completed_at: datetime | None


@dataclass(frozen=True, slots=True)
class ExecutionDetail:
    execution_id: uuid.UUID
    external_reference: str
    state: ExecutionState
    tasks: list[TaskDetail]


async def get_execution_detail(
    session: AsyncSession, execution_id: uuid.UUID
) -> ExecutionDetail | None:
    """Everything ``GET /v1/executions/{id}`` needs: the execution plus each task's
    current state, and — once available — its outputs or its failure."""
    execution = await get_execution_by_id(session, execution_id)
    if execution is None:
        return None

    tasks_result = await session.execute(
        select(ExecutionTask).where(ExecutionTask.execution_id == execution_id)
    )
    tasks = tasks_result.scalars().all()

    outputs_result = await session.execute(
        select(TaskOutput).where(TaskOutput.task_id.in_([task.id for task in tasks]))
    )
    outputs_by_task_id = {
        output.task_id: output.outputs for output in outputs_result.scalars().all()
    }

    # The DAG's edges, as task keys (what callers know a task by), not the
    # internal ids they're stored under.
    task_key_by_id = {task.id: task.task_key for task in tasks}
    dependencies_result = await session.execute(
        select(TaskDependency).where(TaskDependency.task_id.in_(task_key_by_id.keys()))
    )
    depends_on_by_task_id: dict[uuid.UUID, list[str]] = {task.id: [] for task in tasks}
    for dependency in dependencies_result.scalars().all():
        depends_on_by_task_id[dependency.task_id].append(
            task_key_by_id[dependency.depends_on_task_id]
        )

    # The *current* (highest attempt_number) attempt's timing, per task --
    # a retried task's earlier attempts are real history, but only the
    # current attempt is what a status view or duration display should
    # reflect, same as execution_tasks.failure only ever holding the
    # current attempt's failure (see TaskAttempt's own docstring).
    attempts_result = await session.execute(
        select(TaskAttempt).where(TaskAttempt.task_id.in_([task.id for task in tasks]))
    )
    latest_attempt_by_task_id: dict[uuid.UUID, TaskAttempt] = {}
    for attempt in attempts_result.scalars().all():
        current = latest_attempt_by_task_id.get(attempt.task_id)
        if current is None or attempt.attempt_number > current.attempt_number:
            latest_attempt_by_task_id[attempt.task_id] = attempt

    task_details = []
    for task in tasks:
        latest_attempt = latest_attempt_by_task_id.get(task.id)
        task_details.append(
            TaskDetail(
                task_id=task.task_key,
                state=task.state,
                attempt_count=task.attempt_count,
                outputs=outputs_by_task_id.get(task.id),
                failure=task.failure,
                depends_on=depends_on_by_task_id[task.id],
                started_at=latest_attempt.started_at if latest_attempt else None,
                completed_at=latest_attempt.completed_at if latest_attempt else None,
            )
        )

    return ExecutionDetail(
        execution_id=execution.id,
        external_reference=execution.external_reference,
        state=execution.state,
        tasks=task_details,
    )


@dataclass(frozen=True, slots=True)
class TaskLogDetail:
    task_id: str
    lines: list[str]


@dataclass(frozen=True, slots=True)
class ExecutionLogs:
    execution_id: uuid.UUID
    tasks: list[TaskLogDetail]


async def get_execution_logs(
    session: AsyncSession, execution_id: uuid.UUID
) -> ExecutionLogs | None:
    """Every task's captured container output (saved when it finished; its Pod
    is usually gone by then). A task with none yet reports ``[]``."""
    execution = await get_execution_by_id(session, execution_id)
    if execution is None:
        return None

    tasks_result = await session.execute(
        select(ExecutionTask).where(ExecutionTask.execution_id == execution_id)
    )
    tasks = tasks_result.scalars().all()

    logs_result = await session.execute(
        select(TaskLog).where(TaskLog.task_id.in_([task.id for task in tasks]))
    )
    lines_by_task_id = {log.task_id: log.lines for log in logs_result.scalars().all()}

    return ExecutionLogs(
        execution_id=execution.id,
        tasks=[
            TaskLogDetail(task_id=task.task_key, lines=lines_by_task_id.get(task.id, []))
            for task in tasks
        ],
    )


@dataclass(frozen=True, slots=True)
class EventDetail:
    id: int
    event_type: str
    task_key: str | None
    payload: dict[str, Any]
    created_at: datetime


async def get_execution_events(
    session: AsyncSession, execution_id: uuid.UUID, *, after: int | None = None, limit: int = 100
) -> list[EventDetail] | None:
    """The execution's event log, each event's task given by its key (callers
    never see row ids). None if there's no such execution."""
    execution = await get_execution_by_id(session, execution_id)
    if execution is None:
        return None

    tasks_result = await session.execute(
        select(ExecutionTask).where(ExecutionTask.execution_id == execution_id)
    )
    task_key_by_id = {task.id: task.task_key for task in tasks_result.scalars().all()}

    events = await _fetch_execution_events(session, execution_id, after=after, limit=limit)
    return [
        EventDetail(
            id=event.id,
            event_type=event.event_type,
            task_key=task_key_by_id.get(event.task_id) if event.task_id is not None else None,
            payload=event.payload,
            created_at=event.created_at,
        )
        for event in events
    ]


class CancelOutcome(StrEnum):
    CANCELLED = "CANCELLED"
    ALREADY_CANCELLED = "ALREADY_CANCELLED"  # idempotent: calling cancel twice isn't an error
    EXECUTION_NOT_FOUND = "EXECUTION_NOT_FOUND"
    EXECUTION_ALREADY_TERMINAL = "EXECUTION_ALREADY_TERMINAL"  # SUCCEEDED or FAILED


async def cancel_execution(session: AsyncSession, execution_id: uuid.UUID) -> CancelOutcome:
    """Cancel an execution.

    Tasks that haven't started (READY/BLOCKED) are cancelled immediately.
    A CLAIMED/RUNNING task is only actually stopped the next time the
    scheduler polls it — the API process has no live executor to call
    ``cancel()`` on, only the scheduler does, and the two only communicate
    through durable state, so marking the execution CANCELLED here is that
    signal (see ``app.scheduler.service._poll_task``).
    """
    execution = await get_execution_by_id(session, execution_id)
    if execution is None:
        return CancelOutcome.EXECUTION_NOT_FOUND
    if execution.state in TERMINAL_EXECUTION_STATES:
        return _cancel_outcome_when_finished(execution.state)

    # Conditional UPDATEs, not states read first and written back: the
    # scheduler may be dispatching one of these tasks right now, holding its
    # row lock. An UPDATE waits for that lock, then re-checks its WHERE
    # against what the scheduler committed, so a task that has just become
    # RUNNING is left for the scheduler to stop at its next poll instead of
    # being overwritten with CANCELLED, its Job left running unwatched. The
    # same goes for the execution finishing meanwhile. Tasks first, then the
    # execution: the order the scheduler locks them in, so the two don't
    # deadlock.
    try:
        async with session.begin_nested():
            cancelled_tasks = (
                await session.execute(
                    update(ExecutionTask)
                    .where(
                        ExecutionTask.execution_id == execution_id,
                        ExecutionTask.state.in_((TaskState.READY, TaskState.BLOCKED)),
                    )
                    .values(state=TaskState.CANCELLED)
                    .returning(ExecutionTask.id, ExecutionTask.task_key)
                    .execution_options(synchronize_session="fetch")
                )
            ).all()
            if not await transition_execution_state(
                session, execution_id, ExecutionState.CANCELLED, ACTIVE_EXECUTION_STATES
            ):
                raise _ExecutionFinishedMeanwhile
    except _ExecutionFinishedMeanwhile:
        await session.refresh(execution)  # the route answers with its state
        return _cancel_outcome_when_finished(execution.state)

    await record_event(session, execution_id=execution_id, event_type=EventType.EXECUTION_CANCELLED)
    for task_id, task_key in cancelled_tasks:
        await record_event(
            session,
            execution_id=execution_id,
            task_id=task_id,
            event_type=EventType.TASK_CANCELLED,
            payload={"taskKey": task_key},
        )

    return CancelOutcome.CANCELLED


def _cancel_outcome_when_finished(state: ExecutionState) -> CancelOutcome:
    if state is ExecutionState.CANCELLED:
        return CancelOutcome.ALREADY_CANCELLED
    return CancelOutcome.EXECUTION_ALREADY_TERMINAL


class _ExecutionFinishedMeanwhile(Exception):
    """Rolls back cancel_execution's savepoint when the execution finished
    between being read and being cancelled."""


class RetryOutcome(StrEnum):
    RETRIED = "RETRIED"
    EXECUTION_NOT_FOUND = "EXECUTION_NOT_FOUND"
    TASK_NOT_FOUND = "TASK_NOT_FOUND"
    TASK_NOT_FAILED = "TASK_NOT_FAILED"  # only a FAILED task can be manually retried


async def retry_task(
    session: AsyncSession, execution_id: uuid.UUID, task_key: str
) -> RetryOutcome:
    """Manually retry a FAILED task — one more attempt, triggered by an operator
    instead of the scheduler's own ``should_retry`` decision (e.g. after attempts
    were exhausted, or the failure wasn't marked retryable).

    A FAILED task always means its execution is FAILED too (that's how
    ``app.scheduler.service._fail_execution`` works), so retrying also
    resumes the execution and revives any sibling tasks that were cancelled
    when it originally failed — otherwise the execution could never reach
    SUCCEEDED again, even if this retry eventually works.
    """
    execution = await get_execution_by_id(session, execution_id)
    if execution is None:
        return RetryOutcome.EXECUTION_NOT_FOUND

    task_result = await session.execute(
        select(ExecutionTask).where(
            ExecutionTask.execution_id == execution_id, ExecutionTask.task_key == task_key
        )
    )
    task = task_result.scalar_one_or_none()
    if task is None:
        return RetryOutcome.TASK_NOT_FOUND
    if task.state is not TaskState.FAILED:
        return RetryOutcome.TASK_NOT_FAILED

    now = datetime.now(UTC)
    task.state = TaskState.READY
    task.lease_owner = None
    task.lease_expires_at = None
    task.executor_handle = None
    task.failure = None
    task.available_at = now
    await record_event(
        session,
        execution_id=execution_id,
        task_id=task.id,
        event_type=EventType.TASK_RETRIED,
        payload={"taskKey": task.task_key, "attempt": task.attempt_count},
    )

    # Compare-and-set, like every other execution transition: the scheduler
    # may be changing this execution's state too.
    if await transition_execution_state(
        session, execution_id, ExecutionState.RUNNING, {ExecutionState.FAILED}
    ):
        await record_event(
            session, execution_id=execution_id, event_type=EventType.EXECUTION_RESUMED
        )

    await _revive_cancelled_siblings(session, execution_id, now=now)

    return RetryOutcome.RETRIED


async def _revive_cancelled_siblings(
    session: AsyncSession, execution_id: uuid.UUID, *, now: datetime
) -> None:
    """READY if every dependency already succeeded, otherwise BLOCKED — the same
    rule ``initial_task_state`` applies at submission time, just re-evaluated
    against dependencies that may have already finished."""
    cancelled_result = await session.execute(
        select(ExecutionTask).where(
            ExecutionTask.execution_id == execution_id, ExecutionTask.state == TaskState.CANCELLED
        )
    )
    for sibling in cancelled_result.scalars().all():
        dependency_states_result = await session.execute(
            select(ExecutionTask.state)
            .join(TaskDependency, TaskDependency.depends_on_task_id == ExecutionTask.id)
            .where(TaskDependency.task_id == sibling.id)
        )
        dependency_states = [row[0] for row in dependency_states_result.all()]
        if all(state is TaskState.SUCCEEDED for state in dependency_states):
            sibling.state = TaskState.READY
            sibling.available_at = now
        else:
            sibling.state = TaskState.BLOCKED
