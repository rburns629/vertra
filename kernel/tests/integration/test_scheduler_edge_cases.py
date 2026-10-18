# SPDX-License-Identifier: MIT
"""Scheduler paths the main tests don't reach: a result seen only after the
task's timeout, a retry of one of several failed tasks, a dependency listed
twice. Each was a real defect (found 2026-10-17)."""

from datetime import datetime, timedelta

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.contracts.execution import ExecutionSubmission
from app.contracts.result import StructuredError
from app.domain.errors import DAGValidationError, ValidationIssueCode
from app.domain.states import ExecutionState, TaskState
from app.persistence.models import Execution, ExecutionTask
from app.scheduler.service import run_scheduler_tick
from app.services.execution_service import retry_task, submit_execution
from tests.fakes import FakeExecutor

LEASE = timedelta(seconds=60)


def _task(task_id: str, **fields: object) -> dict[str, object]:
    return {
        "id": task_id,
        "image": "x:1",
        "action": "run",
        "team": "test-team",
        "serviceAccount": "default",
        **fields,
    }


async def _submit(session: AsyncSession, key: str, tasks: list[dict[str, object]]) -> object:
    submission = ExecutionSubmission.model_validate({"name": key, "requestId": key, "tasks": tasks})
    return (await submit_execution(session, submission)).execution_id


async def _now(session: AsyncSession) -> datetime:
    """The database's clock: tasks become claimable at its now(), and the test
    Postgres (in Docker) can run ahead of this host's clock."""
    database_now: datetime = (await session.execute(select(func.now()))).scalar_one()
    return database_now + timedelta(seconds=1)


async def _tick(session: AsyncSession, executor: FakeExecutor, now: datetime) -> None:
    await run_scheduler_tick(session, executor, owner="test", lease_duration=LEASE, now=now)
    await session.flush()


async def _states(
    session: AsyncSession, execution_id: object
) -> tuple[ExecutionState, dict[str, TaskState]]:
    execution = await session.get(Execution, execution_id, populate_existing=True)
    assert execution is not None
    tasks = (
        await session.execute(
            select(ExecutionTask)
            .where(ExecutionTask.execution_id == execution_id)
            .execution_options(populate_existing=True)
        )
    ).scalars()
    return execution.state, {task.task_key: task.state for task in tasks}


class TestResultSeenAfterTimeout:
    async def test_a_success_seen_late_counts_and_isnt_run_again(
        self, db_session: AsyncSession
    ) -> None:
        """The scheduler was down past the task's timeout; its Job had succeeded."""
        executor = FakeExecutor()
        t0 = await _now(db_session)
        execution_id = await _submit(
            db_session, "late-success", [_task("only", timeoutSeconds=300, maxAttempts=2)]
        )
        await _tick(db_session, executor, t0)
        executor.complete({"fakeId": "1"}, {"done": True})

        await _tick(db_session, executor, t0 + timedelta(seconds=400))

        assert await _states(db_session, execution_id) == (
            ExecutionState.SUCCEEDED,
            {"only": TaskState.SUCCEEDED},
        )
        assert len(executor.started) == 1
        assert executor.cancelled == []

    async def test_a_task_still_running_past_its_timeout_still_times_out(
        self, db_session: AsyncSession
    ) -> None:
        executor = FakeExecutor()
        t0 = await _now(db_session)
        execution_id = await _submit(
            db_session, "late-running", [_task("only", timeoutSeconds=300)]
        )
        await _tick(db_session, executor, t0)

        await _tick(db_session, executor, t0 + timedelta(seconds=400))

        state, tasks = await _states(db_session, execution_id)
        assert (state, tasks) == (ExecutionState.FAILED, {"only": TaskState.FAILED})
        assert executor.cancelled == ["1"]


class TestRetryingOneOfSeveralFailures:
    async def test_the_execution_fails_again_when_the_retry_succeeds_but_others_failed(
        self, db_session: AsyncSession
    ) -> None:
        executor = FakeExecutor()
        t0 = await _now(db_session)
        execution_id = await _submit(db_session, "two-failures", [_task("a"), _task("b")])
        await _tick(db_session, executor, t0)
        error = StructuredError(code="BOOM", message="boom", retryable=False)
        executor.fail({"fakeId": "1"}, error)
        executor.fail({"fakeId": "2"}, error)
        await _tick(db_session, executor, t0 + timedelta(seconds=1))

        await retry_task(db_session, execution_id, "a")  # type: ignore[arg-type]
        await db_session.flush()
        await _tick(db_session, executor, t0 + timedelta(seconds=2))
        executor.complete({"fakeId": "3"}, {})
        await _tick(db_session, executor, t0 + timedelta(seconds=3))

        assert await _states(db_session, execution_id) == (
            ExecutionState.FAILED,
            {"a": TaskState.SUCCEEDED, "b": TaskState.FAILED},
        )

    async def test_retrying_every_failure_can_still_succeed(self, db_session: AsyncSession) -> None:
        executor = FakeExecutor()
        t0 = await _now(db_session)
        execution_id = await _submit(db_session, "retry-both", [_task("a"), _task("b")])
        await _tick(db_session, executor, t0)
        error = StructuredError(code="BOOM", message="boom", retryable=False)
        executor.fail({"fakeId": "1"}, error)
        executor.fail({"fakeId": "2"}, error)
        await _tick(db_session, executor, t0 + timedelta(seconds=1))

        await retry_task(db_session, execution_id, "a")  # type: ignore[arg-type]
        await retry_task(db_session, execution_id, "b")  # type: ignore[arg-type]
        await db_session.flush()
        await _tick(db_session, executor, t0 + timedelta(seconds=2))
        executor.complete({"fakeId": "3"}, {})
        await _tick(db_session, executor, t0 + timedelta(seconds=3))
        assert (await _states(db_session, execution_id))[0] is ExecutionState.RUNNING

        executor.complete({"fakeId": "4"}, {})
        await _tick(db_session, executor, t0 + timedelta(seconds=4))
        assert (await _states(db_session, execution_id))[0] is ExecutionState.SUCCEEDED


async def test_a_dependency_listed_twice_is_a_validation_error(db_session: AsyncSession) -> None:
    with pytest.raises(DAGValidationError) as raised:
        await _submit(db_session, "dup-dep", [_task("a"), _task("b", dependsOn=["a", "a"])])
    assert [issue.code for issue in raised.value.issues] == [
        ValidationIssueCode.DUPLICATE_DEPENDENCY
    ]
