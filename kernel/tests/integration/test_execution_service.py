# SPDX-License-Identifier: MIT
"""Integration tests for app.services.execution_service — real Postgres, not mocks."""

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.contracts.execution import ExecutionSubmission
from app.contracts.task import TaskDefinition
from app.domain.errors import DAGValidationError
from app.domain.states import ExecutionState, TaskState
from app.persistence.models import Execution, ExecutionEvent, TaskDependency
from app.services.execution_service import submit_execution


def _two_task_submission(idempotency_key: str) -> ExecutionSubmission:
    return ExecutionSubmission(
        external_reference="demo-order-1",
        idempotency_key=idempotency_key,
        tasks=[
            TaskDefinition(
                id="create-project",
                image="demo-project-product:local",
                action="create",
                team="test-team",
                serviceAccount="default",
                inputs={"projectName": "demo-project"},
            ),
            TaskDefinition(
                id="deploy-application",
                image="demo-application-product:local",
                action="create",
                team="test-team",
                serviceAccount="default",
                dependsOn=["create-project"],
                inputs={"projectId": {"$fromTask": "create-project", "$output": "projectId"}},
            ),
        ],
    )


class TestSubmitExecution:
    async def test_new_submission_persists_execution_tasks_and_event(
        self, db_session: AsyncSession
    ) -> None:
        result = await submit_execution(db_session, _two_task_submission("idem-submit-new"))

        assert result.created is True
        assert result.state is ExecutionState.PENDING

        execution = await db_session.get(Execution, result.execution_id)
        assert execution is not None
        tasks_by_key = {task.task_key: task for task in execution.tasks}
        assert tasks_by_key["create-project"].state is TaskState.READY
        assert tasks_by_key["deploy-application"].state is TaskState.BLOCKED
        assert tasks_by_key["create-project"].original_inputs == {"projectName": "demo-project"}

        dependency_rows = await db_session.execute(
            select(TaskDependency).where(
                TaskDependency.task_id == tasks_by_key["deploy-application"].id
            )
        )
        dependency = dependency_rows.scalar_one()
        assert dependency.depends_on_task_id == tasks_by_key["create-project"].id

        event_rows = await db_session.execute(
            select(ExecutionEvent).where(ExecutionEvent.execution_id == result.execution_id)
        )
        events = event_rows.scalars().all()
        assert [event.event_type for event in events] == ["EXECUTION_CREATED"]

    async def test_resubmitting_the_same_idempotency_key_does_not_duplicate(
        self, db_session: AsyncSession
    ) -> None:
        submission = _two_task_submission("idem-submit-dup")

        first = await submit_execution(db_session, submission)
        second = await submit_execution(db_session, submission)

        assert first.created is True
        assert second.created is False
        assert second.execution_id == first.execution_id

        count = await db_session.scalar(
            select(func.count())
            .select_from(Execution)
            .where(Execution.idempotency_key == "idem-submit-dup")
        )
        assert count == 1

    async def test_invalid_dag_is_rejected_and_nothing_is_persisted(
        self, db_session: AsyncSession
    ) -> None:
        submission = ExecutionSubmission(
            external_reference="demo-order-2",
            idempotency_key="idem-submit-invalid",
            tasks=[
                TaskDefinition(
                    id="a",
                    image="x:local",
                    action="create",
                    team="test-team",
                    serviceAccount="default",
                    dependsOn=["b"],
                ),
                TaskDefinition(
                    id="b",
                    image="x:local",
                    action="create",
                    team="test-team",
                    serviceAccount="default",
                    dependsOn=["a"],
                ),
            ],
        )

        with pytest.raises(DAGValidationError):
            await submit_execution(db_session, submission)

        existing = await db_session.execute(
            select(Execution).where(Execution.idempotency_key == "idem-submit-invalid")
        )
        assert existing.scalar_one_or_none() is None
