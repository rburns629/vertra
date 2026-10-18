# SPDX-License-Identifier: MIT
"""The end-to-end proof: the two-task chain, through real Postgres, a real Kubernetes cluster
(kind), and the real product containers — not a fake executor, not a hand-driven simulation.

This is the milestone the whole MVP has been building toward: submit the
DAG from the project brief, let the real scheduler loop run it against
real containers dispatched as real Kubernetes Jobs, and confirm
`deploy-application` actually receives `"demo-project-123"` from
`create-project`'s real output.
"""

import asyncio
import time
from datetime import UTC, datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.contracts.execution import ExecutionSubmission
from app.contracts.task import TaskDefinition
from app.domain.states import TERMINAL_EXECUTION_STATES, ExecutionState, TaskState
from app.executors.base import Executor
from app.executors.kubernetes import KubernetesExecutor
from app.persistence.models import Execution, ExecutionEvent, ExecutionTask, TaskOutput
from app.scheduler.service import run_scheduler_tick
from app.services.execution_service import submit_execution
from tests.conftest import K8sApis

# Must be a namespace that actually exists in the test cluster (see
# tests.conftest.K8S_NAMESPACE) -- this is what KubernetesExecutor
# dispatches each task's Job into.
TEST_TEAM = "execution-kernel"


def _two_task_submission(
    idempotency_key: str,
    project_image: str,
    application_image: str,
    *,
    project_inputs: dict[str, object] | None = None,
    output_key: str = "projectId",
) -> ExecutionSubmission:
    return ExecutionSubmission(
        external_reference="demo-order-1",
        idempotency_key=idempotency_key,
        tasks=[
            TaskDefinition(
                id="create-project",
                image=project_image,
                action="create", team=TEST_TEAM, serviceAccount="default",
                inputs=(
                    project_inputs
                    if project_inputs is not None
                    else {"projectName": "demo-project"}
                ),
            ),
            TaskDefinition(
                id="deploy-application",
                image=application_image,
                action="create", team=TEST_TEAM, serviceAccount="default",
                dependsOn=["create-project"],
                inputs={"projectId": {"$fromTask": "create-project", "$output": output_key}},
            ),
        ],
    )


async def _run_scheduler_until_terminal(
    session: AsyncSession,
    executor: Executor,
    execution_id: object,
    *,
    owner: str = "scheduler-1",
    lease_duration: timedelta = timedelta(seconds=60),
    poll_interval: float = 0.3,
    timeout: float = 60.0,
) -> Execution:
    """Run real scheduler ticks against a real executor until the execution finishes.

    Unlike the FakeExecutor-based scheduler tests, real containers take real
    wall-clock time, so this polls with an actual sleep between ticks rather
    than the test controlling completion directly.
    """
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        await run_scheduler_tick(
            session, executor, owner=owner, lease_duration=lease_duration, now=datetime.now(UTC)
        )
        execution = await session.get(Execution, execution_id)
        assert execution is not None
        if execution.state in TERMINAL_EXECUTION_STATES:
            return execution
        await asyncio.sleep(poll_interval)
    raise AssertionError(f"execution did not reach a terminal state within {timeout}s")


async def _tasks_by_key(session: AsyncSession, execution_id: object) -> dict[str, ExecutionTask]:
    result = await session.execute(
        select(ExecutionTask).where(ExecutionTask.execution_id == execution_id)
    )
    return {task.task_key: task for task in result.scalars().all()}


async def _event_types(session: AsyncSession, execution_id: object) -> list[str]:
    result = await session.execute(
        select(ExecutionEvent)
        .where(ExecutionEvent.execution_id == execution_id)
        .order_by(ExecutionEvent.id)
    )
    return [event.event_type for event in result.scalars().all()]


def _executor(k8s_apis: K8sApis) -> KubernetesExecutor:
    return KubernetesExecutor(batch_api=k8s_apis.batch, core_api=k8s_apis.core)


class TestTwoTaskChainSucceeds:
    async def test_full_chain_through_real_kubernetes_and_real_products(
        self,
        db_session: AsyncSession,
        k8s_apis: K8sApis,
        k8s_project_product_image: str,
        k8s_application_product_image: str,
    ) -> None:
        submission = _two_task_submission(
            "idem-e2e-success", k8s_project_product_image, k8s_application_product_image
        )
        result = await submit_execution(db_session, submission)
        executor = _executor(k8s_apis)

        execution = await _run_scheduler_until_terminal(db_session, executor, result.execution_id)

        assert execution.state is ExecutionState.SUCCEEDED

        tasks = await _tasks_by_key(db_session, result.execution_id)
        assert tasks["create-project"].state is TaskState.SUCCEEDED
        assert tasks["deploy-application"].state is TaskState.SUCCEEDED

        # The application task actually received create-project's real output.
        assert tasks["deploy-application"].resolved_inputs == {"projectId": "demo-project-123"}

        create_project_output = await db_session.get(TaskOutput, tasks["create-project"].id)
        assert create_project_output is not None
        assert create_project_output.outputs == {"projectId": "demo-project-123"}
        deploy_application_output = await db_session.get(TaskOutput, tasks["deploy-application"].id)
        assert deploy_application_output is not None
        assert deploy_application_output.outputs == {"applicationUrl": "https://demo.example"}

        # Exact event sequence: this is also the proof that the application
        # task never starts first — its TASK_CLAIMED only appears after
        # create-project's full TASK_STARTED -> TASK_SUCCEEDED cycle. Real
        # container timing changes how many ticks it takes to get here, but
        # never how many state-transition events are recorded.
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


class TestFailurePropagation:
    async def test_project_task_failure_prevents_application_from_ever_running(
        self,
        db_session: AsyncSession,
        k8s_apis: K8sApis,
        k8s_project_product_image: str,
        k8s_application_product_image: str,
    ) -> None:
        submission = _two_task_submission(
            "idem-e2e-project-fails",
            k8s_project_product_image,
            k8s_application_product_image,
            project_inputs={},  # missing projectName -> project-product fails
        )
        result = await submit_execution(db_session, submission)
        executor = _executor(k8s_apis)

        execution = await _run_scheduler_until_terminal(db_session, executor, result.execution_id)

        assert execution.state is ExecutionState.FAILED

        tasks = await _tasks_by_key(db_session, result.execution_id)
        assert tasks["create-project"].state is TaskState.FAILED
        assert tasks["create-project"].failure is not None
        assert tasks["create-project"].failure["code"] == "MISSING_INPUT"
        # Never claimed, never started, never ran.
        assert tasks["deploy-application"].state is TaskState.CANCELLED
        assert tasks["deploy-application"].resolved_inputs is None

        # Only create-project was ever claimed — deploy-application was
        # cancelled while still BLOCKED, never reaching READY.
        event_types = await _event_types(db_session, result.execution_id)
        assert event_types.count("TASK_CLAIMED") == 1
        assert event_types[-1] == "EXECUTION_FAILED"

    async def test_missing_declared_output_fails_the_downstream_task(
        self,
        db_session: AsyncSession,
        k8s_apis: K8sApis,
        k8s_project_product_image: str,
        k8s_application_product_image: str,
    ) -> None:
        submission = _two_task_submission(
            "idem-e2e-missing-output",
            k8s_project_product_image,
            k8s_application_product_image,
            output_key="thisOutputDoesNotExist",
        )
        result = await submit_execution(db_session, submission)
        executor = _executor(k8s_apis)

        execution = await _run_scheduler_until_terminal(db_session, executor, result.execution_id)

        assert execution.state is ExecutionState.FAILED

        tasks = await _tasks_by_key(db_session, result.execution_id)
        # create-project succeeded fine on its own — the problem is purely
        # the downstream reference to an output it never promised.
        assert tasks["create-project"].state is TaskState.SUCCEEDED
        assert tasks["deploy-application"].state is TaskState.FAILED
        assert tasks["deploy-application"].failure is not None
        assert tasks["deploy-application"].failure["code"] == "MISSING_UPSTREAM_OUTPUT"
        assert tasks["deploy-application"].failure["retryable"] is False


class TestOperationalResilience:
    async def test_scheduler_restart_does_not_lose_the_execution(
        self,
        db_session: AsyncSession,
        k8s_apis: K8sApis,
        k8s_project_product_image: str,
        k8s_application_product_image: str,
    ) -> None:
        """Nothing about progress lives in the scheduler process's memory.

        Dispatch with one KubernetesExecutor instance, then hand off to a
        brand-new instance (no shared in-memory state — simulating the
        scheduler process restarting) and confirm the execution still
        completes correctly, because the real state — the Job/Pod, the
        task's row — lives in Postgres and the Kubernetes API server, not in
        the executor object.
        """
        submission = _two_task_submission(
            "idem-e2e-restart", k8s_project_product_image, k8s_application_product_image
        )
        result = await submit_execution(db_session, submission)
        owner = "scheduler-1"
        lease_duration = timedelta(seconds=60)

        executor_before_restart = _executor(k8s_apis)
        await run_scheduler_tick(
            db_session,
            executor_before_restart,
            owner=owner,
            lease_duration=lease_duration,
            now=datetime.now(UTC),
        )
        tasks = await _tasks_by_key(db_session, result.execution_id)
        assert tasks["create-project"].state is TaskState.RUNNING

        executor_after_restart = _executor(k8s_apis)
        execution = await _run_scheduler_until_terminal(
            db_session, executor_after_restart, result.execution_id, owner=owner
        )

        assert execution.state is ExecutionState.SUCCEEDED
        tasks = await _tasks_by_key(db_session, result.execution_id)
        assert tasks["create-project"].state is TaskState.SUCCEEDED
        assert tasks["deploy-application"].state is TaskState.SUCCEEDED
        assert tasks["deploy-application"].resolved_inputs == {"projectId": "demo-project-123"}


class TestIdempotentSubmission:
    async def test_duplicate_submission_does_not_create_another_execution(
        self, db_session: AsyncSession
    ) -> None:
        submission = _two_task_submission(
            "idem-e2e-duplicate", "demo-project-product:local", "demo-application-product:local"
        )

        first = await submit_execution(db_session, submission)
        second = await submit_execution(db_session, submission)

        assert first.execution_id == second.execution_id
        assert first.created is True
        assert second.created is False

        count = await db_session.scalar(
            select(func.count())
            .select_from(Execution)
            .where(Execution.idempotency_key == "idem-e2e-duplicate")
        )
        assert count == 1
