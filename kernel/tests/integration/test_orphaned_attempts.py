# SPDX-License-Identifier: MIT
"""The sweep that removes attempts' Jobs no task can use any more (R4).

The case it exists for: a pass starts a task's Job, its commit fails (the
task is READY again, one attempt behind the Job), and the execution is
cancelled before any pass claims the task again. Nothing would ever stop
that Job before its deadline. The sweep must also never touch a Job a task
still needs: the running attempt's, or the one a ready task will adopt.
"""

from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.contracts.execution import ExecutionSubmission
from app.contracts.result import StructuredError
from app.contracts.task import TaskDefinition
from app.executors.base import ResolvedTask
from app.persistence.models import ExecutionTask
from app.scheduler.orphans import release_orphaned_attempts
from app.scheduler.service import run_scheduler_tick
from app.services.execution_service import cancel_execution, submit_execution
from tests.fakes import FakeExecutor

LEASE = timedelta(seconds=60)


def _submission(key: str, *, max_attempts: int = 1) -> ExecutionSubmission:
    return ExecutionSubmission(
        external_reference="orphans",
        idempotency_key=key,
        tasks=[
            TaskDefinition(
                id="provision",
                image="demo-project-product:local",
                action="create",
                team="test-team",
                serviceAccount="default",
                maxAttempts=max_attempts,
            )
        ],
    )


async def _task(session: AsyncSession, execution_id: object) -> ExecutionTask:
    result = await session.execute(
        select(ExecutionTask)
        .where(ExecutionTask.execution_id == execution_id)
        .execution_options(populate_existing=True)
    )
    return result.scalar_one()


async def _start_as_a_rolled_back_pass_would(executor: FakeExecutor, task: ExecutionTask) -> str:
    """Starts the attempt the task's next claim would make, without recording it."""
    handle = await executor.start(
        ResolvedTask(
            execution_id=str(task.execution_id),
            task_key=task.task_key,
            image=task.image,
            action=task.action,
            attempt=task.attempt_count + 1,
            timeout_seconds=task.timeout_seconds,
            team=task.team,
            service_account=task.service_account,
        )
    )
    return str(handle["fakeId"])


def _age_everything(executor: FakeExecutor, by: timedelta) -> None:
    for attempt in executor.launched.values():
        attempt.created_at -= by


async def _sweep(session: AsyncSession, executor: FakeExecutor) -> int:
    return await release_orphaned_attempts(
        session, executor, older_than=datetime.now(UTC) - timedelta(minutes=5)
    )


async def test_a_job_left_for_a_task_cancelled_before_its_retry_is_removed(
    db_session: AsyncSession,
) -> None:
    result = await submit_execution(db_session, _submission("orphan-cancelled"))
    executor = FakeExecutor()
    orphan = await _start_as_a_rolled_back_pass_would(
        executor, await _task(db_session, result.execution_id)
    )
    await cancel_execution(db_session, result.execution_id)
    _age_everything(executor, timedelta(minutes=10))

    assert await _sweep(db_session, executor) == 1
    assert executor.released == [orphan]


async def test_the_job_a_ready_task_will_adopt_is_kept(db_session: AsyncSession) -> None:
    result = await submit_execution(db_session, _submission("orphan-adoptable"))
    executor = FakeExecutor()
    await _start_as_a_rolled_back_pass_would(executor, await _task(db_session, result.execution_id))
    _age_everything(executor, timedelta(minutes=10))

    assert await _sweep(db_session, executor) == 0
    assert executor.released == []


async def test_a_running_tasks_current_job_is_kept_and_its_earlier_ones_removed(
    db_session: AsyncSession,
) -> None:
    result = await submit_execution(db_session, _submission("orphan-earlier", max_attempts=2))
    executor = FakeExecutor()
    t0 = datetime.now(UTC)
    await run_scheduler_tick(db_session, executor, owner="s-1", lease_duration=LEASE, now=t0)
    first = (await _task(db_session, result.execution_id)).executor_handle
    assert first is not None
    executor.fail(first, StructuredError(code="FLAKY", message="flaky", retryable=True))
    # Its release after the commit never happened (the caller isn't called here).
    await run_scheduler_tick(
        db_session, executor, owner="s-1", lease_duration=LEASE, now=t0 + timedelta(seconds=1)
    )
    await run_scheduler_tick(
        db_session, executor, owner="s-1", lease_duration=LEASE, now=t0 + timedelta(seconds=60)
    )
    second = (await _task(db_session, result.execution_id)).executor_handle
    assert second is not None and second != first
    _age_everything(executor, timedelta(minutes=10))

    assert await _sweep(db_session, executor) == 1
    assert executor.released == [first["fakeId"]]


async def test_a_young_job_is_left_alone(db_session: AsyncSession) -> None:
    result = await submit_execution(db_session, _submission("orphan-young"))
    executor = FakeExecutor()
    await _start_as_a_rolled_back_pass_would(executor, await _task(db_session, result.execution_id))
    await cancel_execution(db_session, result.execution_id)

    assert await _sweep(db_session, executor) == 0


async def test_a_job_whose_execution_is_gone_is_removed(db_session: AsyncSession) -> None:
    executor = FakeExecutor()
    handle = await executor.start(
        ResolvedTask(
            execution_id="00000000-0000-0000-0000-00000000dead",
            task_key="gone",
            image="demo-project-product:local",
            action="create",
            attempt=1,
            timeout_seconds=60,
            team="test-team",
            service_account="default",
        )
    )
    _age_everything(executor, timedelta(minutes=10))

    assert await _sweep(db_session, executor) == 1
    assert executor.released == [handle["fakeId"]]
