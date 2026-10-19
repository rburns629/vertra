# SPDX-License-Identifier: MIT
"""What the sleeper reads from the kernel's data (app/sleeper/activity.py),
against real Postgres."""

from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from app.contracts.execution import ExecutionSubmission
from app.domain.states import ExecutionState
from app.persistence.models import Execution
from app.services.execution_service import submit_execution
from app.sleeper.activity import kernel_activity


async def test_an_unfinished_execution_is_busy_and_a_finished_one_is_not(
    db_session: AsyncSession,
) -> None:
    before = await kernel_activity(db_session)
    submission = ExecutionSubmission.model_validate(
        {
            "name": "sleeper-activity",
            "requestId": "sleeper-activity",
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
    execution_id = (await submit_execution(db_session, submission)).execution_id
    await db_session.flush()

    during = await kernel_activity(db_session)
    assert during.busy
    assert during.last is not None
    assert before.last is None or during.last >= before.last

    await db_session.execute(
        update(Execution).where(Execution.id == execution_id).values(state=ExecutionState.SUCCEEDED)
    )
    await db_session.flush()
    # Back to what it was before (not busy, unless something else is running).
    assert (await kernel_activity(db_session)).busy == before.busy
