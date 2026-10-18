# SPDX-License-Identifier: MIT
"""Integration tests for app.scheduler.input_resolution.resolve_task_inputs — real Postgres.

These are the tests that prove the chaining mechanism itself: that a value
persisted as one task's output is actually what a downstream task's
resolved inputs contain.
"""

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.contracts.execution import ExecutionSubmission
from app.contracts.task import TaskDefinition
from app.domain.errors import MissingOutputError
from app.persistence.models import Execution, ExecutionTask, TaskOutput
from app.scheduler.input_resolution import resolve_task_inputs
from app.services.execution_service import submit_execution


def _two_task_submission(idempotency_key: str) -> ExecutionSubmission:
    return ExecutionSubmission(
        external_reference="demo-order-1",
        idempotency_key=idempotency_key,
        tasks=[
            TaskDefinition(
                id="create-project",
                image="demo-project-product:local",
                action="create", team="test-team", serviceAccount="default",
                inputs={"projectName": "demo-project"},
            ),
            TaskDefinition(
                id="deploy-application",
                image="demo-application-product:local",
                action="create", team="test-team", serviceAccount="default",
                dependsOn=["create-project"],
                inputs={"projectId": {"$fromTask": "create-project", "$output": "projectId"}},
            ),
        ],
    )


async def _load_tasks_by_key(
    session: AsyncSession, execution_id: object
) -> dict[str, ExecutionTask]:
    execution = await session.get(Execution, execution_id)
    assert execution is not None
    return {task.task_key: task for task in execution.tasks}


class TestResolveTaskInputs:
    async def test_task_with_no_dependencies_returns_original_inputs_unchanged(
        self, db_session: AsyncSession
    ) -> None:
        result = await submit_execution(db_session, _two_task_submission("idem-resolve-no-deps"))
        tasks_by_key = await _load_tasks_by_key(db_session, result.execution_id)

        resolved = await resolve_task_inputs(db_session, tasks_by_key["create-project"])

        assert resolved == {"projectName": "demo-project"}

    async def test_reference_resolves_to_upstream_task_output(
        self, db_session: AsyncSession
    ) -> None:
        result = await submit_execution(db_session, _two_task_submission("idem-resolve-chain"))
        tasks_by_key = await _load_tasks_by_key(db_session, result.execution_id)

        db_session.add(
            TaskOutput(
                task_id=tasks_by_key["create-project"].id,
                outputs={"projectId": "demo-project-123"},
            )
        )
        await db_session.flush()

        resolved = await resolve_task_inputs(db_session, tasks_by_key["deploy-application"])

        assert resolved == {"projectId": "demo-project-123"}

    async def test_missing_upstream_output_raises(self, db_session: AsyncSession) -> None:
        result = await submit_execution(db_session, _two_task_submission("idem-resolve-missing"))
        tasks_by_key = await _load_tasks_by_key(db_session, result.execution_id)

        # create-project has not produced any output yet — deploy-application
        # should not be resolvable.
        with pytest.raises(MissingOutputError) as exc_info:
            await resolve_task_inputs(db_session, tasks_by_key["deploy-application"])

        assert exc_info.value.task_id == "create-project"
        assert exc_info.value.output_name == "projectId"

    async def test_wrong_output_key_raises(self, db_session: AsyncSession) -> None:
        result = await submit_execution(
            db_session, _two_task_submission("idem-resolve-wrong-key")
        )
        tasks_by_key = await _load_tasks_by_key(db_session, result.execution_id)

        db_session.add(
            TaskOutput(
                task_id=tasks_by_key["create-project"].id,
                outputs={"somethingElse": "value"},
            )
        )
        await db_session.flush()

        with pytest.raises(MissingOutputError) as exc_info:
            await resolve_task_inputs(db_session, tasks_by_key["deploy-application"])

        assert exc_info.value.output_name == "projectId"
