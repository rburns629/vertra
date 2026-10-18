# SPDX-License-Identifier: MIT
"""Integration tests for app.scheduler.service.run_scheduler_tick — real Postgres, a fake executor.

The fake executor (tests.fakes.FakeExecutor) is deliberate: these tests are
about the scheduler's own orchestration logic — claim, dispatch, poll,
release dependents, finalize execution, retry, timeout — not about Docker
mechanics, which tests/integration/test_docker_executor.py already covers
separately. The full stack (real Docker, real product containers, this
same scheduler loop) is proven end-to-end in a later step.
"""

import asyncio
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.contracts.execution import ExecutionSubmission
from app.contracts.result import StructuredError
from app.contracts.task import TaskDefinition, TaskResources
from app.domain.errors import DispatchRejectedError
from app.domain.states import ExecutionState, TaskState
from app.executors.base import ExecutionHandle, ExecutionStatus
from app.persistence.models import Execution, ExecutionEvent, ExecutionTask, TaskLog, TaskOutput
from app.scheduler.service import run_scheduler_tick
from app.services.execution_service import get_execution_events, submit_execution
from tests.fakes import FakeExecutor


def _two_task_submission(
    idempotency_key: str, *, output_key: str = "projectId", max_attempts: int = 1
) -> ExecutionSubmission:
    return ExecutionSubmission(
        external_reference="demo-order-1",
        idempotency_key=idempotency_key,
        tasks=[
            TaskDefinition(
                id="create-project",
                image="demo-project-product:local",
                action="create", team="test-team", serviceAccount="default",
                inputs={"projectName": "demo-project"},
                maxAttempts=max_attempts,
            ),
            TaskDefinition(
                id="deploy-application",
                image="demo-application-product:local",
                action="create", team="test-team", serviceAccount="default",
                dependsOn=["create-project"],
                inputs={"projectId": {"$fromTask": "create-project", "$output": output_key}},
                maxAttempts=max_attempts,
            ),
        ],
    )


def _single_task_submission(
    idempotency_key: str, *, max_attempts: int = 1, timeout_seconds: int = 300
) -> ExecutionSubmission:
    return ExecutionSubmission(
        external_reference="demo-order-1",
        idempotency_key=idempotency_key,
        tasks=[
            TaskDefinition(
                id="create-project",
                image="demo-project-product:local",
                action="create", team="test-team", serviceAccount="default",
                maxAttempts=max_attempts,
                timeoutSeconds=timeout_seconds,
            )
        ],
    )


def _ticker(
    session: AsyncSession,
    executor: FakeExecutor,
    *,
    owner: str = "scheduler-1",
    lease_seconds: int = 60,
) -> Callable[[datetime], Awaitable[None]]:
    """A per-test shorthand: `tick = _ticker(db_session, executor)`, then `await tick(t0)`."""
    lease_duration = timedelta(seconds=lease_seconds)

    async def tick(now: datetime) -> None:
        await run_scheduler_tick(
            session, executor, owner=owner, lease_duration=lease_duration, now=now
        )

    return tick


async def _tasks_by_key(session: AsyncSession, execution_id: object) -> dict[str, ExecutionTask]:
    # A direct query rather than `execution.tasks` — across many ticks and
    # mutations, relying on relationship lazy-loading state is fragile in an
    # async session; an explicit SELECT is simple and always correct.
    result = await session.execute(
        select(ExecutionTask).where(ExecutionTask.execution_id == execution_id)
    )
    return {task.task_key: task for task in result.scalars().all()}


def _handle(task: ExecutionTask) -> dict[str, object]:
    """The task's executor handle, asserted non-None — set by dispatch, needed to drive the fake."""
    assert task.executor_handle is not None
    return task.executor_handle


async def _event_types(session: AsyncSession, execution_id: object) -> list[str]:
    result = await session.execute(
        select(ExecutionEvent)
        .where(ExecutionEvent.execution_id == execution_id)
        .order_by(ExecutionEvent.id)
    )
    return [event.event_type for event in result.scalars().all()]


class TestSchedulerHappyPath:
    async def test_full_two_task_chain_succeeds_with_ordered_events(
        self, db_session: AsyncSession
    ) -> None:
        result = await submit_execution(db_session, _two_task_submission("idem-sched-success"))
        executor = FakeExecutor()
        tick = _ticker(db_session, executor)
        t0 = datetime.now(UTC)

        # Tick 1: claims and dispatches create-project (deploy-application still BLOCKED).
        await tick(t0)
        tasks = await _tasks_by_key(db_session, result.execution_id)
        assert tasks["create-project"].state is TaskState.RUNNING
        assert tasks["deploy-application"].state is TaskState.BLOCKED
        execution = await db_session.get(Execution, result.execution_id)
        assert execution is not None
        assert execution.state is ExecutionState.RUNNING

        # Tick 2: create-project finishes; deploy-application is released to READY.
        executor.complete(
            _handle(tasks["create-project"]), {"projectId": "demo-project-123"}
        )
        await tick(t0 + timedelta(seconds=1))
        tasks = await _tasks_by_key(db_session, result.execution_id)
        assert tasks["create-project"].state is TaskState.SUCCEEDED
        assert tasks["deploy-application"].state is TaskState.READY

        # Tick 3: deploy-application is claimed and dispatched with the resolved value.
        await tick(t0 + timedelta(seconds=2))
        tasks = await _tasks_by_key(db_session, result.execution_id)
        assert tasks["deploy-application"].state is TaskState.RUNNING
        assert tasks["deploy-application"].resolved_inputs == {"projectId": "demo-project-123"}

        # Tick 4: deploy-application finishes; execution finalizes as SUCCEEDED.
        executor.complete(
            _handle(tasks["deploy-application"]), {"applicationUrl": "https://demo.example"}
        )
        await tick(t0 + timedelta(seconds=3))
        tasks = await _tasks_by_key(db_session, result.execution_id)
        assert tasks["deploy-application"].state is TaskState.SUCCEEDED
        execution = await db_session.get(Execution, result.execution_id)
        assert execution is not None
        assert execution.state is ExecutionState.SUCCEEDED

        create_project_output = await db_session.get(TaskOutput, tasks["create-project"].id)
        assert create_project_output is not None
        assert create_project_output.outputs == {"projectId": "demo-project-123"}
        deploy_application_output = await db_session.get(TaskOutput, tasks["deploy-application"].id)
        assert deploy_application_output is not None
        assert deploy_application_output.outputs == {"applicationUrl": "https://demo.example"}

        # Captured at the exact moment the scheduler itself noticed each
        # task finish (FakeExecutor.start seeds one real line per task) --
        # proves the scheduler actually calls get_logs and persists the
        # result, not just that the plumbing compiles.
        create_project_log = await db_session.get(TaskLog, tasks["create-project"].id)
        assert create_project_log is not None
        assert create_project_log.lines == ["started create-project attempt 1"]
        deploy_application_log = await db_session.get(TaskLog, tasks["deploy-application"].id)
        assert deploy_application_log is not None
        assert deploy_application_log.lines == ["started deploy-application attempt 1"]

        assert await _event_types(db_session, result.execution_id) == [
            "EXECUTION_CREATED",
            "TASK_CLAIMED",
            "EXECUTION_STARTED",
            "TASK_STARTED",
            "TASK_SUCCEEDED",
            "TASK_CLAIMED",
            "TASK_STARTED",
            "TASK_SUCCEEDED",
            "EXECUTION_SUCCEEDED",
        ]

        # Each task-scoped event resolves back to the human task key
        # ("create-project"), not ExecutionEvent's own internal task_id --
        # proves get_execution_events' resolution actually runs, not just
        # that it typechecks. Execution-level events (EXECUTION_CREATED/
        # STARTED/SUCCEEDED) carry no task at all, so `None` there is
        # correct, not a missed resolution.
        events = await get_execution_events(db_session, result.execution_id)
        assert events is not None
        assert [event.task_key for event in events] == [
            None,
            "create-project",
            None,
            "create-project",
            "create-project",
            "deploy-application",
            "deploy-application",
            "deploy-application",
            None,
        ]

    async def test_lease_is_renewed_while_task_is_still_running(
        self, db_session: AsyncSession
    ) -> None:
        result = await submit_execution(db_session, _single_task_submission("idem-sched-renew"))
        executor = FakeExecutor()
        tick = _ticker(db_session, executor)
        t0 = datetime.now(UTC)

        await tick(t0)
        tasks = await _tasks_by_key(db_session, result.execution_id)
        first_lease_expiry = tasks["create-project"].lease_expires_at
        assert first_lease_expiry is not None

        # Still RUNNING (never completed): the second tick should push the
        # lease further out, not let it lapse.
        await tick(t0 + timedelta(seconds=30))
        tasks = await _tasks_by_key(db_session, result.execution_id)
        assert tasks["create-project"].state is TaskState.RUNNING
        assert tasks["create-project"].lease_expires_at is not None
        assert tasks["create-project"].lease_expires_at > first_lease_expiry


class TestSchedulerFailureHandling:
    async def test_terminal_task_failure_fails_execution_and_cancels_siblings(
        self, db_session: AsyncSession
    ) -> None:
        result = await submit_execution(db_session, _two_task_submission("idem-sched-fail"))
        executor = FakeExecutor()
        tick = _ticker(db_session, executor)
        t0 = datetime.now(UTC)

        await tick(t0)
        tasks = await _tasks_by_key(db_session, result.execution_id)

        executor.fail(
            _handle(tasks["create-project"]),
            StructuredError(code="PRODUCT_EXECUTION_FAILED", message="boom", retryable=False),
        )
        await tick(t0 + timedelta(seconds=1))

        tasks = await _tasks_by_key(db_session, result.execution_id)
        assert tasks["create-project"].state is TaskState.FAILED
        assert tasks["create-project"].failure is not None
        assert tasks["create-project"].failure["code"] == "PRODUCT_EXECUTION_FAILED"
        assert tasks["deploy-application"].state is TaskState.CANCELLED

        execution = await db_session.get(Execution, result.execution_id)
        assert execution is not None
        assert execution.state is ExecutionState.FAILED

        # A failed task's own output is often exactly what someone most
        # wants to see -- captured here too, not just on the success path.
        create_project_log = await db_session.get(TaskLog, tasks["create-project"].id)
        assert create_project_log is not None
        assert create_project_log.lines == ["started create-project attempt 1"]

        assert await _event_types(db_session, result.execution_id) == [
            "EXECUTION_CREATED",
            "TASK_CLAIMED",
            "EXECUTION_STARTED",
            "TASK_STARTED",
            "TASK_FAILED",
            "EXECUTION_FAILED",
        ]

    async def test_retryable_failure_retries_and_eventually_succeeds(
        self, db_session: AsyncSession
    ) -> None:
        result = await submit_execution(
            db_session, _single_task_submission("idem-sched-retry", max_attempts=2)
        )
        executor = FakeExecutor()
        tick = _ticker(db_session, executor)
        t0 = datetime.now(UTC)

        await tick(t0)
        tasks = await _tasks_by_key(db_session, result.execution_id)
        assert tasks["create-project"].attempt_count == 1

        executor.fail(
            _handle(tasks["create-project"]),
            StructuredError(code="TRANSIENT", message="try again", retryable=True),
        )
        await tick(t0 + timedelta(seconds=1))
        tasks = await _tasks_by_key(db_session, result.execution_id)
        assert tasks["create-project"].state is TaskState.READY

        # Not straight away: the first retry waits the backoff's base, 5s.
        await tick(t0 + timedelta(seconds=5))
        tasks = await _tasks_by_key(db_session, result.execution_id)
        assert tasks["create-project"].state is TaskState.READY
        assert tasks["create-project"].attempt_count == 1

        await tick(t0 + timedelta(seconds=7))
        tasks = await _tasks_by_key(db_session, result.execution_id)
        assert tasks["create-project"].state is TaskState.RUNNING
        assert tasks["create-project"].attempt_count == 2

        executor.complete(
            _handle(tasks["create-project"]), {"projectId": "demo-project-123"}
        )
        await tick(t0 + timedelta(seconds=8))
        tasks = await _tasks_by_key(db_session, result.execution_id)
        assert tasks["create-project"].state is TaskState.SUCCEEDED

        execution = await db_session.get(Execution, result.execution_id)
        assert execution is not None
        assert execution.state is ExecutionState.SUCCEEDED

    async def test_missing_declared_output_fails_the_downstream_task(
        self, db_session: AsyncSession
    ) -> None:
        result = await submit_execution(
            db_session, _two_task_submission("idem-sched-missing-output", output_key="doesNotExist")
        )
        executor = FakeExecutor()
        tick = _ticker(db_session, executor)
        t0 = datetime.now(UTC)

        await tick(t0)
        tasks = await _tasks_by_key(db_session, result.execution_id)
        executor.complete(
            _handle(tasks["create-project"]), {"projectId": "demo-project-123"}
        )

        await tick(t0 + timedelta(seconds=1))
        tasks = await _tasks_by_key(db_session, result.execution_id)
        assert tasks["deploy-application"].state is TaskState.READY

        # Claiming deploy-application immediately fails at dispatch time:
        # create-project's real outputs don't contain "doesNotExist".
        await tick(t0 + timedelta(seconds=2))
        tasks = await _tasks_by_key(db_session, result.execution_id)
        assert tasks["deploy-application"].state is TaskState.FAILED
        assert tasks["deploy-application"].failure is not None
        assert tasks["deploy-application"].failure["code"] == "MISSING_UPSTREAM_OUTPUT"
        assert tasks["deploy-application"].failure["retryable"] is False

        execution = await db_session.get(Execution, result.execution_id)
        assert execution is not None
        assert execution.state is ExecutionState.FAILED

    async def test_dispatch_rejected_by_cluster_policy_fails_without_retrying(
        self, db_session: AsyncSession
    ) -> None:
        # maxAttempts=3: a generic start failure would be retried, but a
        # policy rejection (e.g. not a team namespace) never can succeed.
        result = await submit_execution(
            db_session, _single_task_submission("idem-sched-dispatch-rejected", max_attempts=3)
        )
        executor = FakeExecutor()
        executor.start_error = DispatchRejectedError(
            "namespace test-team is not an Acyclix team namespace"
        )
        tick = _ticker(db_session, executor)

        await tick(datetime.now(UTC))

        tasks = await _tasks_by_key(db_session, result.execution_id)
        task = tasks["create-project"]
        assert task.state is TaskState.FAILED
        assert task.attempt_count == 1
        assert task.failure == {
            "code": "DISPATCH_REJECTED",
            "message": "namespace test-team is not an Acyclix team namespace",
            "retryable": False,
        }
        execution = await db_session.get(Execution, result.execution_id)
        assert execution is not None
        assert execution.state is ExecutionState.FAILED

    async def test_task_exceeding_timeout_is_cancelled_and_failed(
        self, db_session: AsyncSession
    ) -> None:
        result = await submit_execution(
            db_session, _single_task_submission("idem-sched-timeout", timeout_seconds=30)
        )
        executor = FakeExecutor()
        tick = _ticker(db_session, executor, lease_seconds=300)
        t0 = datetime.now(UTC)

        await tick(t0)
        tasks = await _tasks_by_key(db_session, result.execution_id)
        handle = tasks["create-project"].executor_handle
        assert handle is not None

        # Never completed by the fake — just too much time passes.
        await tick(t0 + timedelta(seconds=31))

        assert handle["fakeId"] in executor.cancelled
        tasks = await _tasks_by_key(db_session, result.execution_id)
        assert tasks["create-project"].state is TaskState.FAILED
        assert tasks["create-project"].failure is not None
        assert tasks["create-project"].failure["code"] == "TASK_TIMEOUT"


class TestSchedulerThroughput:
    async def test_a_tick_reports_whether_it_moved_anything(self, db_session: AsyncSession) -> None:
        """The scheduler runs the next tick at once after progress, and waits
        otherwise: a claim or a finished task is progress, a step still running
        isn't."""
        await submit_execution(db_session, _single_task_submission("idem-progress"))
        executor = FakeExecutor()
        lease = timedelta(seconds=60)
        now = datetime.now(UTC)

        async def tick() -> bool:
            return await run_scheduler_tick(
                db_session, executor, owner="scheduler-1", lease_duration=lease, now=now
            )

        assert await tick() is True  # claimed and started
        assert await tick() is False  # still running
        executor.complete({"fakeId": "1"}, {"projectId": "p-1"})
        assert await tick() is True  # finished

    async def test_running_tasks_are_started_and_read_concurrently(
        self, db_session: AsyncSession
    ) -> None:
        class SlowExecutor(FakeExecutor):
            """Every status read takes a moment, and the most at once is recorded."""

            def __init__(self) -> None:
                super().__init__()
                self.in_flight = 0
                self.most_in_flight = 0

            async def get_status(self, handle: ExecutionHandle) -> ExecutionStatus:
                self.in_flight += 1
                self.most_in_flight = max(self.most_in_flight, self.in_flight)
                await asyncio.sleep(0.02)
                self.in_flight -= 1
                return await super().get_status(handle)

        submission = ExecutionSubmission(
            external_reference="demo-order-1",
            idempotency_key="idem-concurrent",
            tasks=[
                TaskDefinition(
                    id=f"task-{i}", image="demo-project-product:local", action="create",
                    team="test-team", serviceAccount="default",
                )
                for i in range(6)
            ],
        )
        await submit_execution(db_session, submission)
        executor = SlowExecutor()

        await run_scheduler_tick(
            db_session,
            executor,
            owner="scheduler-1",
            lease_duration=timedelta(seconds=60),
            executor_concurrency=4,
            now=datetime.now(UTC),
        )

        assert executor.most_in_flight == 4


class TestTaskResources:
    async def test_a_tasks_size_reaches_the_executor(self, db_session: AsyncSession) -> None:
        submission = ExecutionSubmission(
            external_reference="demo-order-1",
            idempotency_key="idem-resources",
            tasks=[
                TaskDefinition(
                    id="sized", image="hello:1", action="greet",
                    team="test-team", serviceAccount="default",
                    resources=TaskResources(cpu="50m", memory="64Mi"),
                ),
                TaskDefinition(
                    id="unsized", image="hello:1", action="greet",
                    team="test-team", serviceAccount="default",
                ),
            ],
        )
        await submit_execution(db_session, submission)
        executor = FakeExecutor()

        await run_scheduler_tick(
            db_session, executor, owner="scheduler-1", lease_duration=timedelta(seconds=60)
        )

        by_key = {task.task_key: task for task in executor.started}
        assert by_key["sized"].resources == TaskResources(cpu="50m", memory="64Mi")
        assert by_key["unsized"].resources is None
