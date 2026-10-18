# SPDX-License-Identifier: MIT
"""Two schedulers finishing tasks of the same execution at the same moment.

Each releases dependents, and decides whether the execution is done, inside
its own transaction. Without locking, each saw the other's task as still
running: a task whose two dependencies finished together was never released,
and an execution whose last two tasks finished together never completed
(9 runs in 10, found 2026-10-17). These need committed rows across two real
connections, so, like TestConcurrentClaiming, they manage their own sessions
and clean up after themselves.
"""

import asyncio
import uuid
from datetime import datetime, timedelta

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession

from app.contracts.execution import ExecutionSubmission
from app.domain.states import ExecutionState, TaskState
from app.persistence.models import Execution, ExecutionTask
from app.scheduler.service import run_scheduler_tick
from app.services.execution_service import submit_execution
from tests.fakes import FakeExecutor

LEASE = timedelta(seconds=60)
TRIALS = 5


def _task(task_id: str, **fields: object) -> dict[str, object]:
    return {
        "id": task_id,
        "image": "x:1",
        "action": "run",
        "team": "test-team",
        "serviceAccount": "default",
        **fields,
    }


async def _run_two_schedulers(
    engine: AsyncEngine, tasks: list[dict[str, object]]
) -> tuple[ExecutionState, dict[str, TaskState]]:
    """Scheduler s1 starts one task, s2 another; both then finish together."""
    async with AsyncSession(engine, expire_on_commit=False) as session:
        # The database's clock: a task becomes claimable at its now().
        now: datetime = (await session.execute(select(func.now()))).scalar_one()
        now += timedelta(seconds=1)
        submission = ExecutionSubmission.model_validate(
            {"name": "concurrent-completion", "requestId": str(uuid.uuid4()), "tasks": tasks}
        )
        execution_id = (await submit_execution(session, submission)).execution_id
        await session.commit()

    try:
        executors = {"s1": FakeExecutor(), "s2": FakeExecutor()}
        for owner, executor in executors.items():
            async with AsyncSession(engine, expire_on_commit=False) as session:
                await run_scheduler_tick(
                    session, executor, owner=owner, lease_duration=LEASE, claim_limit=1, now=now
                )
                await session.commit()
        for executor in executors.values():
            executor.complete({"fakeId": "1"}, {})

        async def finish(owner: str) -> None:
            async with AsyncSession(engine, expire_on_commit=False) as session:
                await run_scheduler_tick(
                    session,
                    executors[owner],
                    owner=owner,
                    lease_duration=LEASE,
                    claim_limit=0,
                    now=now + timedelta(seconds=1),
                )
                await session.commit()

        await asyncio.gather(finish("s1"), finish("s2"))

        async with AsyncSession(engine) as session:
            execution = await session.get(Execution, execution_id)
            assert execution is not None
            rows = await session.execute(
                select(ExecutionTask.task_key, ExecutionTask.state).where(
                    ExecutionTask.execution_id == execution_id
                )
            )
            states = {task_key: state for task_key, state in rows.all()}
            return execution.state, states
    finally:
        async with AsyncSession(engine) as session:
            await session.execute(delete(Execution).where(Execution.id == execution_id))
            await session.commit()


async def test_a_task_whose_dependencies_finish_together_is_released(engine: AsyncEngine) -> None:
    for _ in range(TRIALS):
        _, states = await _run_two_schedulers(
            engine, [_task("a"), _task("b"), _task("d", dependsOn=["a", "b"])]
        )
        assert states["d"] is TaskState.READY, states


async def test_an_execution_whose_last_tasks_finish_together_completes(
    engine: AsyncEngine,
) -> None:
    for _ in range(TRIALS):
        execution_state, states = await _run_two_schedulers(engine, [_task("a"), _task("b")])
        assert execution_state is ExecutionState.SUCCEEDED, states
