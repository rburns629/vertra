# SPDX-License-Identifier: MIT
"""A start that raises (an API timeout, a lost response) may still have made
the Job. So the scheduler retries the *same* attempt, whose start adopts that
Job, instead of starting a new attempt beside it; past a limit the attempt
fails and whatever it left is discarded (F-04, found 2026-10-17)."""

from datetime import datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.contracts.execution import ExecutionSubmission
from app.domain.errors import DispatchRejectedError
from app.domain.events import EventType
from app.domain.states import TaskState
from app.persistence.models import ExecutionEvent, ExecutionTask, TaskAttempt
from app.scheduler.service import run_scheduler_tick
from app.services.execution_service import submit_execution
from tests.fakes import FakeExecutor

LEASE = timedelta(seconds=60)
LATER = timedelta(hours=1)  # past any backoff


async def _submit(session: AsyncSession, key: str, max_attempts: int = 3) -> ExecutionTask:
    submission = ExecutionSubmission.model_validate(
        {
            "name": key,
            "requestId": key,
            "tasks": [
                {
                    "id": "only",
                    "image": "x:1",
                    "action": "run",
                    "team": "test-team",
                    "serviceAccount": "default",
                    "maxAttempts": max_attempts,
                }
            ],
        }
    )
    execution_id = (await submit_execution(session, submission)).execution_id
    query = select(ExecutionTask).where(ExecutionTask.execution_id == execution_id)
    return (await session.execute(query)).scalar_one()


async def _now(session: AsyncSession) -> datetime:
    """The database's clock: the test Postgres can run ahead of this host's."""
    database_now: datetime = (await session.execute(select(func.now()))).scalar_one()
    return database_now + timedelta(seconds=1)


async def _tick(
    session: AsyncSession, executor: FakeExecutor, now: datetime, max_dispatch_failures: int = 3
) -> None:
    await run_scheduler_tick(
        session,
        executor,
        owner="test",
        lease_duration=LEASE,
        max_dispatch_failures=max_dispatch_failures,
        now=now,
    )
    await session.flush()


async def _reload(session: AsyncSession, task: ExecutionTask) -> ExecutionTask:
    reloaded = await session.get(ExecutionTask, task.id, populate_existing=True)
    assert reloaded is not None
    return reloaded


async def _attempt_numbers(session: AsyncSession, task: ExecutionTask) -> list[int]:
    rows = await session.execute(
        select(TaskAttempt.attempt_number).where(TaskAttempt.task_id == task.id)
    )
    return sorted(rows.scalars())


class TestAStartThatRaises:
    async def test_retries_the_same_attempt_later(self, db_session: AsyncSession) -> None:
        executor = FakeExecutor()
        task = await _submit(db_session, "dispatch-retry-same")
        t0 = await _now(db_session)

        executor.start_error = TimeoutError("read timed out")
        await _tick(db_session, executor, t0)
        task = await _reload(db_session, task)
        assert task.state is TaskState.READY
        assert task.attempt_count == 0  # the claim was handed back
        assert task.dispatch_failures == 1
        assert task.available_at > t0  # after a backoff
        assert await _attempt_numbers(db_session, task) == []
        events = (
            await db_session.execute(
                select(ExecutionEvent.event_type).where(ExecutionEvent.task_id == task.id)
            )
        ).scalars()
        assert EventType.TASK_DISPATCH_RETRY in list(events)

        # The retry starts attempt 1 again: the same Job name, which the
        # Kubernetes executor adopts if the first start made it.
        executor.start_error = None
        await _tick(db_session, executor, t0 + LATER)
        task = await _reload(db_session, task)
        assert [call.attempt for call in executor.start_calls] == [1, 1]
        assert task.state is TaskState.RUNNING
        assert task.attempt_count == 1
        assert task.dispatch_failures == 0
        assert await _attempt_numbers(db_session, task) == [1]
        assert executor.discarded == []

    async def test_gives_up_on_the_attempt_after_the_limit_and_discards_it(
        self, db_session: AsyncSession
    ) -> None:
        executor = FakeExecutor()
        executor.start_error = TimeoutError("read timed out")
        task = await _submit(db_session, "dispatch-retry-limit")
        now = await _now(db_session)

        for _ in range(3):
            await _tick(db_session, executor, now, max_dispatch_failures=3)
            now += LATER
        task = await _reload(db_session, task)

        # Three starts of attempt 1; the third failure fails the attempt
        # (retryable, so attempt 2 comes next) and removes what it left.
        assert [call.attempt for call in executor.start_calls] == [1, 1, 1]
        assert [call.attempt for call in executor.discarded] == [1]
        assert task.state is TaskState.READY
        assert task.attempt_count == 1
        assert task.dispatch_failures == 0
        attempt = (
            await db_session.execute(select(TaskAttempt).where(TaskAttempt.task_id == task.id))
        ).scalar_one()
        assert attempt.failure is not None and attempt.failure["code"] == "EXECUTOR_START_FAILED"

        executor.start_error = None
        await _tick(db_session, executor, now)
        assert executor.start_calls[-1].attempt == 2

    async def test_a_last_attempt_given_up_fails_the_task(self, db_session: AsyncSession) -> None:
        executor = FakeExecutor()
        executor.start_error = TimeoutError("read timed out")
        task = await _submit(db_session, "dispatch-retry-last", max_attempts=1)
        now = await _now(db_session)
        for _ in range(2):
            await _tick(db_session, executor, now, max_dispatch_failures=2)
            now += LATER
        task = await _reload(db_session, task)
        assert task.state is TaskState.FAILED
        assert task.failure is not None and task.failure["code"] == "EXECUTOR_START_FAILED"
        assert len(executor.discarded) == 1


class TestARefusedStart:
    async def test_fails_at_once_and_discards_what_it_left(self, db_session: AsyncSession) -> None:
        executor = FakeExecutor()
        executor.start_error = DispatchRejectedError("not allowed", "IMAGE_NOT_ALLOWED")
        task = await _submit(db_session, "dispatch-refused")
        await _tick(db_session, executor, await _now(db_session))
        task = await _reload(db_session, task)
        assert task.state is TaskState.FAILED
        assert len(executor.start_calls) == 1
        assert len(executor.discarded) == 1
