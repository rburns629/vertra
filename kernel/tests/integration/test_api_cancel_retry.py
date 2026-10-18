# SPDX-License-Identifier: MIT
"""Integration tests for the cancel/retry FastAPI routes — a real ASGI app over HTTP,
mixed with direct scheduler ticks (via the same `db_session` the API's DB dependency
is overridden to) to drive executions into the states these routes need to react to.
"""

from datetime import UTC, datetime, timedelta

from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.contracts.execution import ExecutionSubmission
from app.contracts.result import StructuredError
from app.contracts.task import TaskDefinition
from app.persistence.models import ExecutionTask
from app.scheduler.service import run_scheduler_tick
from tests.fakes import FakeExecutor


def _single_task_payload(idempotency_key: str) -> dict[str, object]:
    submission = ExecutionSubmission(
        external_reference="demo-order-1",
        idempotency_key=idempotency_key,
        tasks=[
            TaskDefinition(
                id="create-project",
                image="x:local",
                action="create",
                team="test-team",
                serviceAccount="default",
            )
        ],
    )
    return submission.model_dump(by_alias=True)


async def _current_task(session: AsyncSession, execution_id: str) -> ExecutionTask:
    result = await session.execute(
        select(ExecutionTask).where(ExecutionTask.execution_id == execution_id)
    )
    return result.scalars().one()


class TestCancelRoute:
    async def test_cancel_pending_execution_returns_200_cancelled(
        self, api_client: AsyncClient
    ) -> None:
        create_response = await api_client.post(
            "/v1/executions", json=_single_task_payload("idem-api-cancel-pending")
        )
        execution_id = create_response.json()["executionId"]

        response = await api_client.post(f"/v1/executions/{execution_id}/cancel")

        assert response.status_code == 200
        assert response.json() == {"executionId": execution_id, "state": "CANCELLED"}

    async def test_cancelling_twice_is_idempotent(self, api_client: AsyncClient) -> None:
        create_response = await api_client.post(
            "/v1/executions", json=_single_task_payload("idem-api-cancel-twice")
        )
        execution_id = create_response.json()["executionId"]

        first = await api_client.post(f"/v1/executions/{execution_id}/cancel")
        second = await api_client.post(f"/v1/executions/{execution_id}/cancel")

        assert first.status_code == 200
        assert second.status_code == 200
        assert second.json()["state"] == "CANCELLED"

    async def test_cancel_unknown_execution_returns_404(self, api_client: AsyncClient) -> None:
        response = await api_client.post(
            "/v1/executions/00000000-0000-0000-0000-000000000000/cancel"
        )
        assert response.status_code == 404

    async def test_cancel_finished_execution_returns_409(
        self, api_client: AsyncClient, db_session: AsyncSession
    ) -> None:
        create_response = await api_client.post(
            "/v1/executions", json=_single_task_payload("idem-api-cancel-finished")
        )
        execution_id = create_response.json()["executionId"]

        executor = FakeExecutor()
        t0 = datetime.now(UTC)
        await run_scheduler_tick(
            db_session, executor, owner="scheduler-1", lease_duration=timedelta(seconds=60), now=t0
        )
        task = await _current_task(db_session, execution_id)
        assert task.executor_handle is not None
        executor.complete(task.executor_handle, {"projectId": "demo-project-123"})
        await run_scheduler_tick(
            db_session,
            executor,
            owner="scheduler-1",
            lease_duration=timedelta(seconds=60),
            now=t0 + timedelta(seconds=1),
        )

        response = await api_client.post(f"/v1/executions/{execution_id}/cancel")

        assert response.status_code == 409


class TestRetryRoute:
    async def test_retry_failed_task_returns_200_running(
        self, api_client: AsyncClient, db_session: AsyncSession
    ) -> None:
        create_response = await api_client.post(
            "/v1/executions", json=_single_task_payload("idem-api-retry-failed")
        )
        execution_id = create_response.json()["executionId"]

        executor = FakeExecutor()
        t0 = datetime.now(UTC)
        await run_scheduler_tick(
            db_session, executor, owner="scheduler-1", lease_duration=timedelta(seconds=60), now=t0
        )
        task = await _current_task(db_session, execution_id)
        assert task.executor_handle is not None
        executor.fail(
            task.executor_handle, StructuredError(code="BOOM", message="failed", retryable=False)
        )
        await run_scheduler_tick(
            db_session,
            executor,
            owner="scheduler-1",
            lease_duration=timedelta(seconds=60),
            now=t0 + timedelta(seconds=1),
        )

        response = await api_client.post(
            f"/v1/executions/{execution_id}/tasks/create-project/retry"
        )

        assert response.status_code == 200
        assert response.json() == {"executionId": execution_id, "state": "RUNNING"}

    async def test_retry_on_unknown_execution_returns_404(self, api_client: AsyncClient) -> None:
        response = await api_client.post(
            "/v1/executions/00000000-0000-0000-0000-000000000000/tasks/create-project/retry"
        )
        assert response.status_code == 404

    async def test_retry_on_unknown_task_returns_404(self, api_client: AsyncClient) -> None:
        create_response = await api_client.post(
            "/v1/executions", json=_single_task_payload("idem-api-retry-unknown-task")
        )
        execution_id = create_response.json()["executionId"]

        response = await api_client.post(
            f"/v1/executions/{execution_id}/tasks/does-not-exist/retry"
        )

        assert response.status_code == 404

    async def test_retry_non_failed_task_returns_409(self, api_client: AsyncClient) -> None:
        create_response = await api_client.post(
            "/v1/executions", json=_single_task_payload("idem-api-retry-not-failed")
        )
        execution_id = create_response.json()["executionId"]

        response = await api_client.post(
            f"/v1/executions/{execution_id}/tasks/create-project/retry"
        )

        assert response.status_code == 409
