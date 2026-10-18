# SPDX-License-Identifier: MIT
"""Integration tests for app.services.execution_service.cancel_execution / retry_task —
real Postgres, a FakeExecutor (this is about the state machine, not container mechanics).
"""

import asyncio
import uuid
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession

from app.contracts.execution import ExecutionSubmission
from app.contracts.result import StructuredError
from app.contracts.task import TaskDefinition
from app.domain.states import ExecutionState, TaskState
from app.persistence.models import Execution, ExecutionEvent, ExecutionTask
from app.scheduler.service import run_scheduler_tick
from app.services.execution_service import (
    CancelOutcome,
    RetryOutcome,
    cancel_execution,
    retry_task,
)
from app.services.execution_service import submit_execution as do_submit_execution
from tests.fakes import FakeExecutor


def _two_task_submission(idempotency_key: str, *, max_attempts: int = 1) -> ExecutionSubmission:
    return ExecutionSubmission(
        external_reference="demo-order-1",
        idempotency_key=idempotency_key,
        tasks=[
            TaskDefinition(
                id="create-project",
                image="x:local",
                action="create",
                team="test-team",
                serviceAccount="default",
                maxAttempts=max_attempts,
            ),
            TaskDefinition(
                id="deploy-application",
                image="x:local",
                action="create",
                team="test-team",
                serviceAccount="default",
                dependsOn=["create-project"],
                inputs={"projectId": {"$fromTask": "create-project", "$output": "projectId"}},
                maxAttempts=max_attempts,
            ),
        ],
    )


def _single_task_submission(idempotency_key: str, *, max_attempts: int = 1) -> ExecutionSubmission:
    return ExecutionSubmission(
        external_reference="demo-order-1",
        idempotency_key=idempotency_key,
        tasks=[
            TaskDefinition(
                id="create-project",
                image="x:local",
                action="create",
                team="test-team",
                serviceAccount="default",
                maxAttempts=max_attempts,
            )
        ],
    )


def _ticker(
    session: AsyncSession, executor: FakeExecutor, *, owner: str = "scheduler-1"
) -> Callable[[datetime], Awaitable[None]]:
    async def tick(now: datetime) -> None:
        await run_scheduler_tick(
            session, executor, owner=owner, lease_duration=timedelta(seconds=60), now=now
        )

    return tick


async def _tasks_by_key(session: AsyncSession, execution_id: object) -> dict[str, ExecutionTask]:
    result = await session.execute(
        select(ExecutionTask).where(ExecutionTask.execution_id == execution_id)
    )
    return {task.task_key: task for task in result.scalars().all()}


def _handle(task: ExecutionTask) -> dict[str, object]:
    assert task.executor_handle is not None
    return task.executor_handle


async def _event_types(session: AsyncSession, execution_id: object) -> list[str]:
    result = await session.execute(
        select(ExecutionEvent)
        .where(ExecutionEvent.execution_id == execution_id)
        .order_by(ExecutionEvent.id)
    )
    return [event.event_type for event in result.scalars().all()]


class TestCancelExecution:
    async def test_cancel_pending_execution_cancels_not_yet_started_tasks(
        self, db_session: AsyncSession
    ) -> None:
        result = await do_submit_execution(db_session, _two_task_submission("idem-cancel-pending"))

        outcome = await cancel_execution(db_session, result.execution_id)

        assert outcome is CancelOutcome.CANCELLED
        execution = await db_session.get(Execution, result.execution_id)
        assert execution is not None
        assert execution.state is ExecutionState.CANCELLED

        tasks = await _tasks_by_key(db_session, result.execution_id)
        assert tasks["create-project"].state is TaskState.CANCELLED
        assert tasks["deploy-application"].state is TaskState.CANCELLED

        event_types = await _event_types(db_session, result.execution_id)
        assert event_types[0] == "EXECUTION_CREATED"
        assert event_types[1] == "EXECUTION_CANCELLED"
        assert event_types.count("TASK_CANCELLED") == 2

    async def test_cancel_running_execution_stops_in_flight_task_on_next_tick(
        self, db_session: AsyncSession
    ) -> None:
        result = await do_submit_execution(db_session, _two_task_submission("idem-cancel-running"))
        executor = FakeExecutor()
        tick = _ticker(db_session, executor)
        t0 = datetime.now(UTC)

        await tick(t0)  # claims + dispatches create-project
        tasks = await _tasks_by_key(db_session, result.execution_id)
        assert tasks["create-project"].state is TaskState.RUNNING
        handle = _handle(tasks["create-project"])

        outcome = await cancel_execution(db_session, result.execution_id)
        assert outcome is CancelOutcome.CANCELLED

        # Immediately: the execution and the not-yet-started sibling are
        # cancelled, but the in-flight task is untouched — the API has no
        # live executor to stop it with.
        tasks = await _tasks_by_key(db_session, result.execution_id)
        assert tasks["create-project"].state is TaskState.RUNNING
        assert tasks["deploy-application"].state is TaskState.CANCELLED
        assert handle["fakeId"] not in executor.cancelled

        # The next tick is what actually stops it.
        await tick(t0 + timedelta(seconds=1))
        tasks = await _tasks_by_key(db_session, result.execution_id)
        assert tasks["create-project"].state is TaskState.CANCELLED
        assert handle["fakeId"] in executor.cancelled

    async def test_cancel_is_idempotent(self, db_session: AsyncSession) -> None:
        result = await do_submit_execution(db_session, _single_task_submission("idem-cancel-twice"))

        first = await cancel_execution(db_session, result.execution_id)
        second = await cancel_execution(db_session, result.execution_id)

        assert first is CancelOutcome.CANCELLED
        assert second is CancelOutcome.ALREADY_CANCELLED
        event_types = await _event_types(db_session, result.execution_id)
        assert event_types.count("EXECUTION_CANCELLED") == 1

    async def test_cancel_already_finished_execution_is_rejected(
        self, db_session: AsyncSession
    ) -> None:
        result = await do_submit_execution(db_session, _single_task_submission("idem-cancel-done"))
        executor = FakeExecutor()
        tick = _ticker(db_session, executor)
        t0 = datetime.now(UTC)

        await tick(t0)
        tasks = await _tasks_by_key(db_session, result.execution_id)
        executor.complete(_handle(tasks["create-project"]), {"projectId": "demo-project-123"})
        await tick(t0 + timedelta(seconds=1))

        execution = await db_session.get(Execution, result.execution_id)
        assert execution is not None
        assert execution.state is ExecutionState.SUCCEEDED

        outcome = await cancel_execution(db_session, result.execution_id)
        assert outcome is CancelOutcome.EXECUTION_ALREADY_TERMINAL
        execution = await db_session.get(Execution, result.execution_id)
        assert execution is not None
        assert execution.state is ExecutionState.SUCCEEDED

    async def test_cancel_unknown_execution_returns_not_found(
        self, db_session: AsyncSession
    ) -> None:
        outcome = await cancel_execution(db_session, uuid.uuid4())
        assert outcome is CancelOutcome.EXECUTION_NOT_FOUND


class TestRetryTask:
    async def test_retry_failed_task_resumes_execution_and_can_succeed(
        self, db_session: AsyncSession
    ) -> None:
        result = await do_submit_execution(
            db_session, _single_task_submission("idem-retry-basic", max_attempts=1)
        )
        executor = FakeExecutor()
        tick = _ticker(db_session, executor)
        t0 = datetime.now(UTC)

        await tick(t0)
        tasks = await _tasks_by_key(db_session, result.execution_id)
        executor.fail(
            _handle(tasks["create-project"]),
            StructuredError(code="BOOM", message="failed", retryable=False),
        )
        await tick(t0 + timedelta(seconds=1))

        tasks = await _tasks_by_key(db_session, result.execution_id)
        assert tasks["create-project"].state is TaskState.FAILED
        execution = await db_session.get(Execution, result.execution_id)
        assert execution is not None
        assert execution.state is ExecutionState.FAILED

        outcome = await retry_task(db_session, result.execution_id, "create-project")
        assert outcome is RetryOutcome.RETRIED

        tasks = await _tasks_by_key(db_session, result.execution_id)
        assert tasks["create-project"].state is TaskState.READY
        assert tasks["create-project"].failure is None
        execution = await db_session.get(Execution, result.execution_id)
        assert execution is not None
        assert execution.state is ExecutionState.RUNNING

        # max_attempts was 1 — a manual retry grants another attempt anyway.
        await tick(t0 + timedelta(seconds=2))
        tasks = await _tasks_by_key(db_session, result.execution_id)
        assert tasks["create-project"].state is TaskState.RUNNING
        assert tasks["create-project"].attempt_count == 2

        executor.complete(_handle(tasks["create-project"]), {"projectId": "demo-project-123"})
        await tick(t0 + timedelta(seconds=3))

        execution = await db_session.get(Execution, result.execution_id)
        assert execution is not None
        assert execution.state is ExecutionState.SUCCEEDED

    async def test_retry_revives_cancelled_siblings_and_execution_can_still_succeed(
        self, db_session: AsyncSession
    ) -> None:
        result = await do_submit_execution(
            db_session, _two_task_submission("idem-retry-siblings", max_attempts=1)
        )
        executor = FakeExecutor()
        tick = _ticker(db_session, executor)
        t0 = datetime.now(UTC)

        await tick(t0)  # claim+dispatch create-project
        tasks = await _tasks_by_key(db_session, result.execution_id)
        executor.fail(
            _handle(tasks["create-project"]),
            StructuredError(code="BOOM", message="failed", retryable=False),
        )
        await tick(t0 + timedelta(seconds=1))  # create-project FAILED -> execution FAILED

        tasks = await _tasks_by_key(db_session, result.execution_id)
        assert tasks["create-project"].state is TaskState.FAILED
        assert tasks["deploy-application"].state is TaskState.CANCELLED

        outcome = await retry_task(db_session, result.execution_id, "create-project")
        assert outcome is RetryOutcome.RETRIED

        tasks = await _tasks_by_key(db_session, result.execution_id)
        assert tasks["create-project"].state is TaskState.READY
        # Revived, but create-project hasn't succeeded (again) yet, so BLOCKED not READY.
        assert tasks["deploy-application"].state is TaskState.BLOCKED

        await tick(t0 + timedelta(seconds=2))  # claim+dispatch create-project, attempt 2
        tasks = await _tasks_by_key(db_session, result.execution_id)
        executor.complete(_handle(tasks["create-project"]), {"projectId": "demo-project-123"})
        await tick(t0 + timedelta(seconds=3))  # create-project SUCCEEDED, releases deploy-app

        tasks = await _tasks_by_key(db_session, result.execution_id)
        assert tasks["deploy-application"].state is TaskState.READY

        await tick(t0 + timedelta(seconds=4))  # claim+dispatch deploy-application
        tasks = await _tasks_by_key(db_session, result.execution_id)
        assert tasks["deploy-application"].resolved_inputs == {"projectId": "demo-project-123"}
        executor.complete(
            _handle(tasks["deploy-application"]), {"applicationUrl": "https://demo.example"}
        )
        await tick(t0 + timedelta(seconds=5))

        execution = await db_session.get(Execution, result.execution_id)
        assert execution is not None
        assert execution.state is ExecutionState.SUCCEEDED

    async def test_retry_task_that_is_not_failed_is_rejected(
        self, db_session: AsyncSession
    ) -> None:
        result = await do_submit_execution(
            db_session, _single_task_submission("idem-retry-not-failed")
        )

        outcome = await retry_task(db_session, result.execution_id, "create-project")

        assert outcome is RetryOutcome.TASK_NOT_FAILED

    async def test_retry_unknown_task_returns_task_not_found(
        self, db_session: AsyncSession
    ) -> None:
        result = await do_submit_execution(
            db_session, _single_task_submission("idem-retry-unknown-task")
        )

        outcome = await retry_task(db_session, result.execution_id, "does-not-exist")

        assert outcome is RetryOutcome.TASK_NOT_FOUND

    async def test_retry_unknown_execution_returns_execution_not_found(
        self, db_session: AsyncSession
    ) -> None:
        outcome = await retry_task(db_session, uuid.uuid4(), "create-project")

        assert outcome is RetryOutcome.EXECUTION_NOT_FOUND


class TestCancelRacingTheScheduler:
    async def test_a_cancel_during_dispatch_leaves_the_task_for_the_scheduler_to_stop(
        self, engine: AsyncEngine
    ) -> None:
        """The scheduler holds a claimed task's row lock while it dispatches
        it. A cancel arriving then must not overwrite the RUNNING the
        scheduler commits with CANCELLED: that would leave the task's Job
        running with nothing ever stopping it. Instead the task stays RUNNING
        and the scheduler's next poll stops it.

        The second task of a running execution, because dispatching it
        doesn't touch the execution's row: a cancel then reads the task
        before the dispatch commits. Needs committed rows across two
        connections, so, like test_claiming's race, it manages its own
        sessions and cleans up.
        """
        async with AsyncSession(bind=engine, expire_on_commit=False) as setup_session:
            result = await do_submit_execution(
                setup_session, _two_task_submission("idem-cancel-race")
            )
            await setup_session.commit()
        execution_id = result.execution_id
        executor = FakeExecutor()

        async def tick(session: AsyncSession) -> None:
            await run_scheduler_tick(
                session, executor, owner="scheduler-1", lease_duration=timedelta(seconds=60)
            )

        async def committed_tick() -> None:
            async with AsyncSession(bind=engine, expire_on_commit=False) as session:
                await tick(session)
                await session.commit()

        async def cancel() -> CancelOutcome:
            async with AsyncSession(bind=engine, expire_on_commit=False) as session:
                outcome = await cancel_execution(session, execution_id)
                await session.commit()
                return outcome

        async def task_state(task_key: str) -> TaskState:
            async with AsyncSession(bind=engine, expire_on_commit=False) as session:
                task = (
                    await session.execute(
                        select(ExecutionTask).where(
                            ExecutionTask.execution_id == execution_id,
                            ExecutionTask.task_key == task_key,
                        )
                    )
                ).scalar_one()
                return task.state

        try:
            await committed_tick()  # create-project dispatched as "1"
            executor.complete({"fakeId": "1"}, {"projectId": "p-1"})
            await committed_tick()  # create-project done, deploy-application READY

            async with AsyncSession(bind=engine, expire_on_commit=False) as scheduler_session:
                await tick(scheduler_session)  # deploy-application dispatched, uncommitted
                cancelling = asyncio.create_task(cancel())
                await asyncio.sleep(0.5)
                assert not cancelling.done(), "cancel should wait for the dispatch's row lock"
                await scheduler_session.commit()
            assert await cancelling is CancelOutcome.CANCELLED

            async with AsyncSession(bind=engine, expire_on_commit=False) as session:
                execution = await session.get(Execution, execution_id)
                assert execution is not None
                assert execution.state is ExecutionState.CANCELLED
            assert await task_state("deploy-application") is TaskState.RUNNING

            await committed_tick()
            assert executor.cancelled == ["2"]
            assert await task_state("deploy-application") is TaskState.CANCELLED
        finally:
            async with AsyncSession(bind=engine, expire_on_commit=False) as cleanup_session:
                execution = await cleanup_session.get(Execution, execution_id)
                if execution is not None:
                    await cleanup_session.delete(execution)
                await cleanup_session.commit()
