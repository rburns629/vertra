# SPDX-License-Identifier: MIT
"""A running step's log is captured as it goes, and finished executions are
deleted once past retention (F-08)."""

from datetime import UTC, datetime, timedelta

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.contracts.execution import ExecutionSubmission
from app.persistence.models import Execution, ExecutionEvent, ExecutionTask, TaskLog
from app.scheduler.retention import delete_finished_executions
from app.scheduler.service import run_scheduler_tick
from app.services.execution_service import submit_execution
from tests.fakes import FakeExecutor

LEASE = timedelta(seconds=60)


async def _submit(session: AsyncSession, key: str) -> ExecutionTask:
    submission = ExecutionSubmission.model_validate(
        {
            "name": key,
            "requestId": key,
            "tasks": [
                {
                    "id": "only",
                    "image": "x:1",
                    "action": "run",
                    "team": "t",
                    "serviceAccount": "default",
                }
            ],
        }
    )
    execution_id = (await submit_execution(session, submission)).execution_id
    query = select(ExecutionTask).where(ExecutionTask.execution_id == execution_id)
    return (await session.execute(query)).scalar_one()


async def _now(session: AsyncSession) -> datetime:
    database_now: datetime = (await session.execute(select(func.now()))).scalar_one()
    return database_now + timedelta(seconds=1)


async def _tick(session: AsyncSession, executor: FakeExecutor, now: datetime) -> None:
    await run_scheduler_tick(
        session,
        executor,
        owner="test",
        lease_duration=LEASE,
        log_refresh=timedelta(seconds=60),
        now=now,
    )
    await session.flush()


class TestRunningLogs:
    async def test_a_running_steps_log_is_captured_and_refreshed(
        self, db_session: AsyncSession
    ) -> None:
        executor = FakeExecutor()
        task = await _submit(db_session, "logs-while-running")
        t0 = await _now(db_session)
        await _tick(db_session, executor, t0)  # starts it
        await _tick(db_session, executor, t0 + timedelta(seconds=1))  # running: first capture
        log = await db_session.get(TaskLog, task.id, populate_existing=True)
        assert log is not None and log.lines == ["started only attempt 1"]

        executor._logs["1"].append("halfway")
        await _tick(db_session, executor, t0 + timedelta(seconds=30))  # not due yet
        log = await db_session.get(TaskLog, task.id, populate_existing=True)
        assert log is not None and "halfway" not in log.lines
        await _tick(db_session, executor, t0 + timedelta(seconds=62))  # due
        log = await db_session.get(TaskLog, task.id, populate_existing=True)
        assert log is not None and log.lines[-1] == "halfway"


class TestRetention:
    async def test_deletes_finished_executions_past_retention_only(
        self, db_session: AsyncSession
    ) -> None:
        old = await _submit(db_session, "retention-old")
        recent = await _submit(db_session, "retention-recent")
        running = await _submit(db_session, "retention-running")
        long_ago = datetime(2000, 1, 1, tzinfo=UTC)
        for task, state in ((old, "SUCCEEDED"), (recent, "FAILED"), (running, "RUNNING")):
            await db_session.execute(
                update(Execution).where(Execution.id == task.execution_id).values(state=state)
            )
        for task in (old, running):
            await db_session.execute(
                update(ExecutionEvent)
                .where(ExecutionEvent.execution_id == task.execution_id)
                .values(created_at=long_ago)
            )
        await db_session.flush()

        deleted = await delete_finished_executions(
            db_session, finished_before=await _now(db_session) - timedelta(days=90)
        )
        assert deleted >= 1
        remaining = set(
            (
                await db_session.execute(
                    select(Execution.id).where(
                        Execution.id.in_(
                            [old.execution_id, recent.execution_id, running.execution_id]
                        )
                    )
                )
            ).scalars()
        )
        assert old.execution_id not in remaining  # finished long ago
        assert recent.execution_id in remaining  # finished, but recently
        assert running.execution_id in remaining  # never deleted while running
