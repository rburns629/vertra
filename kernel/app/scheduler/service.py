# SPDX-License-Identifier: MIT
"""The scheduler loop: claims ready tasks, resolves inputs, dispatches, and reacts to completion.

``run_scheduler_tick`` is the single entry point — one pass of:

1. Claim READY tasks (``app.scheduler.claiming``).
2. Dispatch the newly-claimed tasks: resolve their inputs, start them
   through the executor (concurrently), persist the handles.
3. Poll every RUNNING task this scheduler instance owns, its status read
   concurrently with the others': on completion, persist outputs or a
   structured failure, release newly-ready dependents, and update the
   execution's overall state.

Nothing here commits — the caller controls the transaction boundary, same
as every other service function. Dispatch and polling go only through the
``Executor`` protocol, so this logic is tested against ``FakeExecutor``
without a cluster.
"""

import asyncio
import contextlib
import logging
import uuid
from collections.abc import Awaitable, Callable, Sequence
from datetime import UTC, datetime, timedelta
from functools import partial

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import (
    DEFAULT_EXECUTOR_CONCURRENCY,
    DEFAULT_JOB_DEADLINE_GRACE_SECONDS,
    DEFAULT_MAX_DISPATCH_FAILURES,
)
from app.contracts.result import StructuredError
from app.contracts.task import TaskResources
from app.domain.errors import DispatchRejectedError, MissingOutputError
from app.domain.events import EventType
from app.domain.states import (
    ACTIVE_EXECUTION_STATES,
    ExecutionState,
    RetryBackoff,
    TaskState,
    should_retry,
)
from app.executors.base import (
    ExecutionHandle,
    ExecutionStatus,
    Executor,
    ExecutorRunState,
    ResolvedTask,
)
from app.observability.metrics import SCHEDULER_STATUS_READ_ERRORS_TOTAL
from app.persistence.models import (
    Execution,
    ExecutionTask,
    TaskAttempt,
    TaskDependency,
    TaskLog,
    TaskOutput,
)
from app.persistence.repositories import record_event, transition_execution_state
from app.scheduler.claiming import claim_ready_tasks, return_unstarted_attempt
from app.scheduler.input_resolution import resolve_task_inputs

logger = logging.getLogger(__name__)


DEFAULT_RETRY_BACKOFF = RetryBackoff()

async def _gather_bounded[T](
    calls: Sequence[Callable[[], Awaitable[T]]], limit: int
) -> list[T | Exception]:
    """Run ``calls`` concurrently, at most ``limit`` at once; results in call order.

    A call that raises yields its exception in its place, so one failure
    doesn't abandon the others.
    """
    semaphore = asyncio.Semaphore(limit)

    async def run(call: Callable[[], Awaitable[T]]) -> T | Exception:
        async with semaphore:
            try:
                return await call()
            except Exception as error:
                return error

    return list(await asyncio.gather(*(run(call) for call in calls)))


async def run_scheduler_tick(
    session: AsyncSession,
    executor: Executor,
    *,
    owner: str,
    lease_duration: timedelta,
    claim_limit: int = 50,
    executor_concurrency: int = DEFAULT_EXECUTOR_CONCURRENCY,
    max_running: int | None = None,
    max_running_per_team: int | None = None,
    retry_backoff: RetryBackoff = DEFAULT_RETRY_BACKOFF,
    max_dispatch_failures: int = DEFAULT_MAX_DISPATCH_FAILURES,
    log_refresh: timedelta | None = None,
    job_deadline_grace: timedelta = timedelta(seconds=DEFAULT_JOB_DEADLINE_GRACE_SECONDS),
    finished: list[ExecutionHandle] | None = None,
    now: datetime | None = None,
) -> bool:
    """Run one scheduling pass: claim, dispatch, poll. Safe to call repeatedly and concurrently.

    A tick that raises leaves nothing partially committed (the caller's
    transaction is the unit of atomicity), so retrying a failed tick from
    scratch is always safe — claiming, dispatch, and polling are each
    idempotent-safe operations in their own right.

    Only the executor calls overlap (starting Jobs, reading their status):
    the database session can't be shared between concurrent tasks, so every
    row read and write stays in order.

    Returns whether the pass moved anything (claimed a task, or saw a running
    one finish), so the caller can run the next pass at once instead of
    waiting out its poll interval: a finished task's dependents are claimable
    on the very next pass.

    ``finished`` collects the handles of tasks that left RUNNING in this
    pass. The caller releases them (``Executor.release``) only after the
    transaction commits, so a pass that rolls back can read the same results
    again.
    """
    current_time = now or datetime.now(UTC)

    claimed_tasks = await claim_ready_tasks(
        session,
        owner=owner,
        lease_duration=lease_duration,
        limit=claim_limit,
        max_running=max_running,
        max_running_per_team=max_running_per_team,
        now=current_time,
    )
    await _dispatch_tasks(
        session,
        executor,
        claimed_tasks,
        concurrency=executor_concurrency,
        retry_backoff=retry_backoff,
        max_dispatch_failures=max_dispatch_failures,
        now=current_time,
    )

    running_tasks = await _load_running_tasks_owned_by(session, owner)
    statuses = await _gather_bounded(
        [partial(executor.get_status, _running_handle(task)) for task in running_tasks],
        executor_concurrency,
    )
    finished_count = 0
    for task, status in zip(running_tasks, statuses, strict=True):
        handle = _running_handle(task)
        if await _poll_task(
            session,
            executor,
            task,
            status=status,
            owner=owner,
            lease_duration=lease_duration,
            retry_backoff=retry_backoff,
            log_refresh=log_refresh,
            job_deadline_grace=job_deadline_grace,
            now=current_time,
        ):
            finished_count += 1
            if finished is not None:
                finished.append(handle)
    return bool(claimed_tasks) or finished_count > 0


def _running_handle(task: ExecutionTask) -> ExecutionHandle:
    # A RUNNING task always has a handle — _record_start sets both together.
    assert task.executor_handle is not None
    return task.executor_handle


async def _load_running_tasks_owned_by(
    session: AsyncSession, owner: str
) -> Sequence[ExecutionTask]:
    result = await session.execute(
        select(ExecutionTask)
        .where(ExecutionTask.state == TaskState.RUNNING, ExecutionTask.lease_owner == owner)
        .with_for_update(skip_locked=True)
    )
    return result.scalars().all()


async def _dispatch_tasks(
    session: AsyncSession,
    executor: Executor,
    tasks: Sequence[ExecutionTask],
    *,
    concurrency: int,
    retry_backoff: RetryBackoff,
    max_dispatch_failures: int,
    now: datetime,
) -> None:
    """Resolve each claimed task's inputs, start them all, then record each start.

    Resolution and every row write happen in order on the session; only the
    executor's ``start`` calls overlap.
    """
    prepared: list[tuple[ExecutionTask, ResolvedTask]] = []
    for task in tasks:
        resolved = await _resolve_task(session, task, retry_backoff=retry_backoff, now=now)
        if resolved is not None:
            prepared.append((task, resolved))

    outcomes = await _gather_bounded(
        [partial(executor.start, resolved) for _, resolved in prepared], concurrency
    )
    for (task, resolved), outcome in zip(prepared, outcomes, strict=True):
        await _record_start(
            session,
            executor,
            task,
            resolved,
            outcome,
            retry_backoff=retry_backoff,
            max_dispatch_failures=max_dispatch_failures,
            now=now,
        )


async def _resolve_task(
    session: AsyncSession, task: ExecutionTask, *, retry_backoff: RetryBackoff, now: datetime
) -> ResolvedTask | None:
    """The task with its inputs resolved, or None after failing it."""
    try:
        resolved_inputs = await resolve_task_inputs(session, task)
    except MissingOutputError as error:
        # A declared output that never showed up is a product-contract
        # violation, not a transient problem — never worth retrying.
        await _handle_task_failure(
            session,
            task,
            retry_backoff=retry_backoff,
            error=StructuredError(
                code="MISSING_UPSTREAM_OUTPUT", message=str(error), retryable=False
            ),
            now=now,
        )
        return None

    return ResolvedTask(
        execution_id=str(task.execution_id),
        task_key=task.task_key,
        image=task.image,
        action=task.action,
        attempt=task.attempt_count,
        resolved_inputs=resolved_inputs,
        timeout_seconds=task.timeout_seconds,
        team=task.team,
        service_account=task.service_account,
        secret_refs=task.secret_refs,
        resources=TaskResources.model_validate(task.resources) if task.resources else None,
    )


async def _discard(executor: Executor, task: ResolvedTask) -> None:
    """Best effort: a Job left behind still has its activeDeadlineSeconds."""
    try:
        await executor.discard(task)
    except Exception:
        logger.exception(
            "couldn't remove what a failed start left behind",
            extra={
                "executionId": task.execution_id,
                "taskKey": task.task_key,
                "attempt": task.attempt,
            },
        )


async def _record_start(
    session: AsyncSession,
    executor: Executor,
    task: ExecutionTask,
    resolved_task: ResolvedTask,
    outcome: ExecutionHandle | Exception,
    *,
    retry_backoff: RetryBackoff,
    max_dispatch_failures: int,
    now: datetime,
) -> None:
    if isinstance(outcome, DispatchRejectedError):
        # The cluster refused on policy grounds (not a team namespace, an
        # image from outside the allowed sources) -- the same attempt would
        # be refused again, so don't retry it.
        logger.warning(
            "task dispatch rejected by cluster policy",
            extra={
                "code": outcome.code,
                "executionId": str(task.execution_id),
                "taskKey": task.task_key,
                "team": task.team,
                "image": task.image,
                "reason": outcome.message,
            },
        )
        await _discard(executor, resolved_task)
        task.dispatch_failures = 0
        await _handle_task_failure(
            session,
            task,
            retry_backoff=retry_backoff,
            error=StructuredError(code=outcome.code, message=outcome.message, retryable=False),
            now=now,
        )
        return
    if isinstance(outcome, Exception):
        # The start raised, but may still have created the Job (a timeout,
        # a lost response, a later call failing). Retrying the *same*
        # attempt reuses its Job name, so the retry adopts that Job instead
        # of starting a second one next to it, and a Job half set up gets its
        # ConfigMap. Bounded: past the limit the attempt fails, and whatever
        # it left is removed.
        task.dispatch_failures += 1
        if task.dispatch_failures < max_dispatch_failures:
            logger.warning(
                "starting a task failed; retrying the same attempt",
                extra={
                    "executionId": str(task.execution_id),
                    "taskKey": task.task_key,
                    "attempt": task.attempt_count,
                    "dispatchFailures": task.dispatch_failures,
                    "error": str(outcome),
                },
            )
            await record_event(
                session,
                execution_id=task.execution_id,
                task_id=task.id,
                event_type=EventType.TASK_DISPATCH_RETRY,
                payload={
                    "taskKey": task.task_key,
                    "attempt": task.attempt_count,
                    "dispatchFailures": task.dispatch_failures,
                    "error": str(outcome)[:500],
                },
            )
            await return_unstarted_attempt(session, task)
            task.available_at = now + retry_backoff.delay(task.dispatch_failures)
            return
        task.dispatch_failures = 0
        await _discard(executor, resolved_task)
        await _handle_task_failure(
            session,
            task,
            retry_backoff=retry_backoff,
            error=StructuredError(
                code="EXECUTOR_START_FAILED", message=str(outcome), retryable=True
            ),
            now=now,
        )
        return

    handle = outcome
    task.dispatch_failures = 0
    task.resolved_inputs = resolved_task.resolved_inputs
    task.executor_handle = handle
    task.state = TaskState.RUNNING

    attempt = await _get_current_attempt(session, task)
    attempt.started_at = now
    attempt.executor_handle = handle

    await _mark_execution_running_if_needed(session, task.execution_id)

    await record_event(
        session,
        execution_id=task.execution_id,
        task_id=task.id,
        event_type=EventType.TASK_STARTED,
        payload={"taskKey": task.task_key, "attempt": task.attempt_count},
    )


async def _poll_task(
    session: AsyncSession,
    executor: Executor,
    task: ExecutionTask,
    *,
    status: ExecutionStatus | Exception,
    owner: str,
    lease_duration: timedelta,
    retry_backoff: RetryBackoff,
    log_refresh: timedelta | None = None,
    job_deadline_grace: timedelta = timedelta(seconds=DEFAULT_JOB_DEADLINE_GRACE_SECONDS),
    now: datetime,
) -> bool:
    """Act on a RUNNING task's ``status``, read before this call (alongside every
    other running task's). Returns whether the task left RUNNING.

    A task only leaves RUNNING for a retry once its attempt is known to have
    stopped: it finished, its Job was stopped, or its Job's own deadline
    (timeout plus ``job_deadline_grace``) has passed. Otherwise a retry could
    run beside the attempt still going.
    """
    attempt = await _get_current_attempt(session, task)
    handle = _running_handle(task)

    execution = await session.get(Execution, task.execution_id)
    assert execution is not None
    if execution.state is ExecutionState.CANCELLED:
        # A user requested cancellation (app.services.execution_service.
        # cancel_execution) — that already marked the execution and any
        # not-yet-started tasks CANCELLED, but only the scheduler holds a
        # live executor, so an in-flight task is only actually stopped here.
        with contextlib.suppress(Exception):
            await executor.cancel(handle)
        attempt.completed_at = now
        task.state = TaskState.CANCELLED
        await record_event(
            session,
            execution_id=task.execution_id,
            task_id=task.id,
            event_type=EventType.TASK_CANCELLED,
            payload={"taskKey": task.task_key, "attempt": task.attempt_count},
        )
        return True

    # A result already in wins over the timeout: a task that finished is
    # never cancelled and failed for taking too long, even when this
    # scheduler only sees it late (it was down, or its pass ran slow).
    if isinstance(status, ExecutionStatus) and status.state is ExecutorRunState.SUCCEEDED:
        assert status.outputs is not None  # enforced by ExecutionStatus's own validator
        attempt.completed_at = now
        session.add(TaskOutput(task_id=task.id, outputs=status.outputs))
        await _capture_task_logs(session, executor, task, handle)
        task.state = TaskState.SUCCEEDED
        await record_event(
            session,
            execution_id=task.execution_id,
            task_id=task.id,
            event_type=EventType.TASK_SUCCEEDED,
            payload={
                "taskKey": task.task_key,
                "attempt": task.attempt_count,
                "outputs": status.outputs,
            },
        )
        await _release_ready_dependents(session, task, now=now)
        await _settle_execution(session, task.execution_id)
        return True

    if isinstance(status, ExecutionStatus) and status.state is ExecutorRunState.FAILED:
        assert status.error is not None  # enforced by ExecutionStatus's own validator
        await _handle_task_failure(
            session,
            task,
            retry_backoff=retry_backoff,
            attempt=attempt,
            error=status.error,
            now=now,
            executor=executor,
            handle=handle,
        )
        return True

    if attempt.started_at is not None:
        elapsed_seconds = (now - attempt.started_at).total_seconds()
        if elapsed_seconds > task.timeout_seconds:
            try:
                await executor.cancel(handle)
            except Exception as error:
                # Past the Job's own deadline Kubernetes has stopped it,
                # confirmed or not; before it, the attempt may still be
                # running, so it stays ours and the cancel is tried again.
                if elapsed_seconds <= task.timeout_seconds + job_deadline_grace.total_seconds():
                    logger.warning(
                        "couldn't stop a task past its timeout; trying again next pass",
                        extra={
                            "executionId": str(task.execution_id),
                            "taskKey": task.task_key,
                            "attempt": task.attempt_count,
                            "error": str(error),
                        },
                    )
                    task.lease_expires_at = now + lease_duration
                    return False
            await _handle_task_failure(
                session,
                task,
                retry_backoff=retry_backoff,
                attempt=attempt,
                error=StructuredError(
                    code="TASK_TIMEOUT",
                    message=f"Task exceeded its {task.timeout_seconds}s timeout.",
                    retryable=True,
                ),
                now=now,
                executor=executor,
                handle=handle,
            )
            return True

    if isinstance(status, Exception):
        # Not knowing isn't failing: the attempt may well still be running,
        # and failing it here (to retry) would start a second one beside it.
        # It stays ours and is read again; its timeout still applies above.
        SCHEDULER_STATUS_READ_ERRORS_TOTAL.inc()
        logger.warning(
            "couldn't read a running task's status; reading it again next pass",
            extra={
                "executionId": str(task.execution_id),
                "taskKey": task.task_key,
                "attempt": task.attempt_count,
                "error": str(status),
            },
        )
        task.lease_expires_at = now + lease_duration
        return False

    task.lease_expires_at = now + lease_duration  # heartbeat: still alive, still ours
    if log_refresh is not None:
        # So a long step's progress shows while it runs, not only at the end.
        captured = await session.get(TaskLog, task.id)
        if captured is None or now - captured.created_at >= log_refresh:
            await _capture_task_logs(session, executor, task, handle, now=now)
    return False


async def _capture_task_logs(
    session: AsyncSession,
    executor: Executor,
    task: ExecutionTask,
    handle: ExecutionHandle,
    *,
    now: datetime | None = None,
) -> None:
    """Best-effort, on purpose: a task's real success/failure outcome (the
    state transition, the retry decision, the recorded event) must never be
    blocked or altered by a problem fetching its logs -- same reasoning as
    the existing `contextlib.suppress(Exception)` around `executor.cancel`
    elsewhere in this module. `merge`, not `add` -- a retried task calls
    this again for the same task_id, and only the current attempt's log is
    meant to be kept (see TaskLog's own docstring)."""
    with contextlib.suppress(Exception):
        lines = await executor.get_logs(handle)
        # created_at: when this capture was made (each one replaces the last).
        captured_at = now or datetime.now(UTC)
        await session.merge(TaskLog(task_id=task.id, lines=lines, created_at=captured_at))


async def _handle_task_failure(
    session: AsyncSession,
    task: ExecutionTask,
    *,
    error: StructuredError,
    retry_backoff: RetryBackoff,
    now: datetime,
    attempt: TaskAttempt | None = None,
    executor: Executor | None = None,
    handle: ExecutionHandle | None = None,
) -> None:
    if attempt is None:
        attempt = await _get_current_attempt(session, task)
    attempt.completed_at = now
    attempt.failure = error.model_dump()
    # executor/handle are only ever None for the two dispatch-time failures
    # (input resolution, executor.start() itself throwing) -- neither has a
    # real Pod to have produced any output at all, so there's nothing to
    # capture. Every failure that happens *after* a task actually started
    # running passes both, and a task that failed is often exactly the case
    # someone most wants its logs for.
    if executor is not None and handle is not None:
        await _capture_task_logs(session, executor, task, handle)

    retry = should_retry(
        attempt_count=task.attempt_count, max_attempts=task.max_attempts, retryable=error.retryable
    )
    await record_event(
        session,
        execution_id=task.execution_id,
        task_id=task.id,
        event_type=EventType.TASK_FAILED,
        payload={
            "taskKey": task.task_key,
            "attempt": task.attempt_count,
            "error": error.model_dump(),
            "willRetry": retry,
        },
    )

    if retry:
        task.state = TaskState.READY
        task.lease_owner = None
        task.lease_expires_at = None
        task.executor_handle = None
        task.available_at = now + retry_backoff.delay(task.attempt_count)
        return

    task.state = TaskState.FAILED
    task.failure = error.model_dump()
    await _fail_execution(session, task.execution_id)


async def _get_current_attempt(session: AsyncSession, task: ExecutionTask) -> TaskAttempt:
    result = await session.execute(
        select(TaskAttempt).where(
            TaskAttempt.task_id == task.id, TaskAttempt.attempt_number == task.attempt_count
        )
    )
    return result.scalar_one()


async def _release_ready_dependents(
    session: AsyncSession, task: ExecutionTask, *, now: datetime
) -> None:
    dependents_result = await session.execute(
        select(TaskDependency.task_id).where(TaskDependency.depends_on_task_id == task.id)
    )
    dependent_ids = [row[0] for row in dependents_result.all()]

    for dependent_id in dependent_ids:
        # Locked before its dependencies are read: two schedulers finishing
        # two of its dependencies at once would otherwise each see the other
        # still running, and neither would release it. The second now waits
        # here for the first to commit, then sees that dependency SUCCEEDED.
        # (Tasks before the execution: the lock order everywhere.) NO KEY
        # UPDATE, like an ordinary UPDATE's lock: rows inserted meanwhile
        # that reference this one (events, outputs) take FOR KEY SHARE on
        # it, which FOR UPDATE would conflict with, deadlocking.
        dependent = (
            await session.execute(
                select(ExecutionTask)
                .where(ExecutionTask.id == dependent_id)
                .with_for_update(key_share=True)
                .execution_options(populate_existing=True)
            )
        ).scalar_one()
        if dependent.state is not TaskState.BLOCKED:
            continue

        dependency_states_result = await session.execute(
            select(ExecutionTask.state)
            .join(TaskDependency, TaskDependency.depends_on_task_id == ExecutionTask.id)
            .where(TaskDependency.task_id == dependent_id)
        )
        dependency_states = [row[0] for row in dependency_states_result.all()]
        if all(state is TaskState.SUCCEEDED for state in dependency_states):
            dependent.state = TaskState.READY
            dependent.available_at = now


# The execution transitions below are compare-and-set
# (transition_execution_state), never a loaded row's state written back:
# kernel-api may have cancelled the execution since this tick read it.


async def _mark_execution_running_if_needed(session: AsyncSession, execution_id: uuid.UUID) -> None:
    if await transition_execution_state(
        session, execution_id, ExecutionState.RUNNING, {ExecutionState.PENDING}
    ):
        await record_event(
            session, execution_id=execution_id, event_type=EventType.EXECUTION_STARTED
        )


# Tasks that can still make progress on their own.
_RUNNABLE_TASK_STATES = (TaskState.READY, TaskState.CLAIMED, TaskState.RUNNING)


async def _settle_execution(session: AsyncSession, execution_id: uuid.UUID) -> None:
    """After a task succeeds: SUCCEEDED once every task has, or FAILED if a task
    has failed and nothing that could still run is left.

    The second only happens after a manual retry (retry_task) resumed an
    execution that had more than one FAILED task: the retried task
    succeeding can't finish the execution, and nothing else would ever move
    it out of RUNNING. Tasks still BLOCKED then wait on a failed task.

    The execution's row is locked before the tasks are counted, for the same
    reason as in _release_ready_dependents: two schedulers finishing its last
    two tasks at once would each count the other's as unfinished.
    """
    await session.execute(
        select(Execution.id).where(Execution.id == execution_id).with_for_update(key_share=True)
    )
    counts_result = await session.execute(
        select(ExecutionTask.state, func.count())
        .where(ExecutionTask.execution_id == execution_id)
        .group_by(ExecutionTask.state)
    )
    counts: dict[TaskState, int] = {state: count for state, count in counts_result.all()}
    if counts.get(TaskState.SUCCEEDED, 0) == sum(counts.values()):
        if await transition_execution_state(
            session, execution_id, ExecutionState.SUCCEEDED, ACTIVE_EXECUTION_STATES
        ):
            await record_event(
                session, execution_id=execution_id, event_type=EventType.EXECUTION_SUCCEEDED
            )
        return
    if counts.get(TaskState.FAILED, 0) and not any(
        counts.get(state, 0) for state in _RUNNABLE_TASK_STATES
    ):
        await _fail_execution(session, execution_id)


async def _fail_execution(session: AsyncSession, execution_id: uuid.UUID) -> None:
    # Tasks that were never going to run anyway (still waiting on a
    # dependency, or waiting to be claimed) are now moot. Before the
    # execution's own row, in the order cancel_execution locks them too.
    # Already the case if the execution had finished: a sibling's failure,
    # or a cancel, did this then.
    await session.execute(
        update(ExecutionTask)
        .where(
            ExecutionTask.execution_id == execution_id,
            ExecutionTask.state.in_((TaskState.READY, TaskState.BLOCKED)),
        )
        .values(state=TaskState.CANCELLED)
        .execution_options(synchronize_session="fetch")
    )
    if await transition_execution_state(
        session, execution_id, ExecutionState.FAILED, ACTIVE_EXECUTION_STATES
    ):
        await record_event(
            session, execution_id=execution_id, event_type=EventType.EXECUTION_FAILED
        )
