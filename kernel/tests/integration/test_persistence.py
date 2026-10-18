# SPDX-License-Identifier: MIT
"""Integration tests for the persistence layer, exercised against real Postgres.

These prove the ORM models and the migration they came from actually agree
with each other: JSONB round-trips, enum columns, uniqueness constraints,
and cascade deletes all behave the way the domain layer will assume they do.
"""

import uuid

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.domain.states import ExecutionState, TaskState
from app.persistence.models import (
    Execution,
    ExecutionEvent,
    ExecutionTask,
    TaskDependency,
    TaskOutput,
)


def _build_two_task_execution(
    idempotency_key: str,
) -> tuple[Execution, ExecutionTask, ExecutionTask]:
    execution = Execution(
        external_reference="demo-order-1",
        idempotency_key=idempotency_key,
        state=ExecutionState.PENDING,
    )
    create_project = ExecutionTask(
        execution=execution,
        task_key="create-project",
        image="demo-project-product:local",
        action="create", team="test-team", service_account="default",
        state=TaskState.READY,
        original_inputs={"projectName": "demo-project"},
        timeout_seconds=300,
        max_attempts=2,
    )
    deploy_application = ExecutionTask(
        execution=execution,
        task_key="deploy-application",
        image="demo-application-product:local",
        action="create", team="test-team", service_account="default",
        state=TaskState.BLOCKED,
        original_inputs={"projectId": {"$fromTask": "create-project", "$output": "projectId"}},
        timeout_seconds=300,
        max_attempts=2,
    )
    return execution, create_project, deploy_application


class TestExecutionAndTaskPersistence:
    async def test_execution_and_tasks_round_trip(self, db_session: AsyncSession) -> None:
        execution, create_project, deploy_application = _build_two_task_execution("idem-round-trip")
        db_session.add(execution)
        await db_session.flush()  # populate generated ids before linking the dependency edge

        db_session.add(
            TaskDependency(task_id=deploy_application.id, depends_on_task_id=create_project.id)
        )
        await db_session.flush()

        reloaded = await db_session.get(Execution, execution.id)
        assert reloaded is not None
        assert reloaded.external_reference == "demo-order-1"
        assert reloaded.state is ExecutionState.PENDING

        tasks_by_key = {task.task_key: task for task in reloaded.tasks}
        assert tasks_by_key["create-project"].original_inputs == {"projectName": "demo-project"}
        assert tasks_by_key["deploy-application"].original_inputs["projectId"] == {
            "$fromTask": "create-project",
            "$output": "projectId",
        }
        assert tasks_by_key["create-project"].state is TaskState.READY
        assert tasks_by_key["deploy-application"].state is TaskState.BLOCKED

    async def test_idempotency_key_must_be_unique(self, db_session: AsyncSession) -> None:
        db_session.add(
            Execution(
                external_reference="a", idempotency_key="dup-key", state=ExecutionState.PENDING
            )
        )
        await db_session.flush()

        db_session.add(
            Execution(
                external_reference="b", idempotency_key="dup-key", state=ExecutionState.PENDING
            )
        )
        with pytest.raises(IntegrityError):
            await db_session.flush()

    async def test_task_output_persists_and_is_queryable(self, db_session: AsyncSession) -> None:
        execution, create_project, _ = _build_two_task_execution("idem-outputs")
        db_session.add(execution)
        await db_session.flush()

        db_session.add(
            TaskOutput(task_id=create_project.id, outputs={"projectId": "demo-project-123"})
        )
        await db_session.flush()

        output = await db_session.get(TaskOutput, create_project.id)
        assert output is not None
        assert output.outputs == {"projectId": "demo-project-123"}

    async def test_execution_events_are_returned_in_insertion_order(
        self, db_session: AsyncSession
    ) -> None:
        execution, _, _ = _build_two_task_execution("idem-events")
        db_session.add(execution)
        await db_session.flush()

        for event_type in ["EXECUTION_CREATED", "TASK_CLAIMED", "TASK_SUCCEEDED"]:
            db_session.add(
                ExecutionEvent(execution_id=execution.id, event_type=event_type, payload={})
            )
        await db_session.flush()

        result = await db_session.execute(
            select(ExecutionEvent)
            .where(ExecutionEvent.execution_id == execution.id)
            .order_by(ExecutionEvent.id)
        )
        event_types = [event.event_type for event in result.scalars().all()]
        assert event_types == ["EXECUTION_CREATED", "TASK_CLAIMED", "TASK_SUCCEEDED"]

    async def test_deleting_execution_cascades_to_tasks_and_events(
        self, db_session: AsyncSession
    ) -> None:
        execution, _, _ = _build_two_task_execution("idem-cascade")
        db_session.add(execution)
        await db_session.flush()  # populate execution.id before the event references it
        execution_id = execution.id

        db_session.add(
            ExecutionEvent(execution_id=execution_id, event_type="EXECUTION_CREATED", payload={})
        )
        await db_session.flush()

        await db_session.delete(execution)
        await db_session.flush()

        remaining_tasks = await db_session.execute(
            select(ExecutionTask).where(ExecutionTask.execution_id == execution_id)
        )
        remaining_events = await db_session.execute(
            select(ExecutionEvent).where(ExecutionEvent.execution_id == execution_id)
        )
        assert remaining_tasks.scalars().all() == []
        assert remaining_events.scalars().all() == []

    async def test_unknown_execution_returns_none(self, db_session: AsyncSession) -> None:
        assert await db_session.get(Execution, uuid.uuid4()) is None
