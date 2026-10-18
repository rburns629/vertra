# SPDX-License-Identifier: MIT
"""Integration tests for app.scheduler.claiming — real Postgres row locking, not mocks.

Most of these use the shared `db_session` fixture (one connection, one
uncommitted transaction, rolled back after the test). The one test that
actually proves ``SKIP LOCKED`` prevents two schedulers from double-claiming
the same task needs two *separate* connections racing over *committed*
rows, so it manages its own engine/session/cleanup instead.
"""

import asyncio
from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession

from app.contracts.execution import ExecutionSubmission
from app.contracts.task import TaskDefinition
from app.domain.states import TaskState
from app.persistence.models import Execution, ExecutionTask, TaskAttempt
from app.scheduler.claiming import claim_ready_tasks, recover_expired_leases, release_leases
from app.services.execution_service import submit_execution


def _submission(idempotency_key: str, *, task_count: int = 1) -> ExecutionSubmission:
    return ExecutionSubmission(
        external_reference="demo-order-1",
        idempotency_key=idempotency_key,
        tasks=[
            TaskDefinition(
                id=f"task-{i}",
                image="x:local",
                action="create",
                team="test-team",
                serviceAccount="default",
            )
            for i in range(task_count)
        ],
    )


def _two_task_submission(idempotency_key: str) -> ExecutionSubmission:
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
            ),
            TaskDefinition(
                id="deploy-application",
                image="x:local",
                action="create",
                team="test-team",
                serviceAccount="default",
                dependsOn=["create-project"],
            ),
        ],
    )


async def _load_tasks_by_key(
    session: AsyncSession, execution_id: object
) -> dict[str, ExecutionTask]:
    # A direct query rather than `execution.tasks` — across repeated claim/
    # recovery calls, relying on relationship lazy-loading state is fragile
    # in an async session; an explicit SELECT is simple and always correct.
    result = await session.execute(
        select(ExecutionTask).where(ExecutionTask.execution_id == execution_id)
    )
    return {task.task_key: task for task in result.scalars().all()}


class TestClaimReadyTasks:
    async def test_claims_ready_task_and_sets_lease_and_attempt(
        self, db_session: AsyncSession
    ) -> None:
        result = await submit_execution(db_session, _submission("idem-claim-basic"))
        now = datetime.now(UTC)

        claimed = await claim_ready_tasks(
            db_session, owner="scheduler-1", lease_duration=timedelta(seconds=60), now=now
        )

        assert len(claimed) == 1
        task = claimed[0]
        assert task.state is TaskState.CLAIMED
        assert task.lease_owner == "scheduler-1"
        assert task.lease_expires_at == now + timedelta(seconds=60)
        assert task.attempt_count == 1
        assert task.execution_id == result.execution_id

        attempt_rows = await db_session.execute(
            select(TaskAttempt).where(TaskAttempt.task_id == task.id)
        )
        attempts = attempt_rows.scalars().all()
        assert len(attempts) == 1
        assert attempts[0].attempt_number == 1

    async def test_blocked_tasks_are_never_claimed(self, db_session: AsyncSession) -> None:
        await submit_execution(db_session, _two_task_submission("idem-claim-blocked"))

        claimed = await claim_ready_tasks(
            db_session, owner="scheduler-1", lease_duration=timedelta(seconds=60)
        )

        assert [task.task_key for task in claimed] == ["create-project"]

    async def test_already_claimed_task_is_not_reclaimed(self, db_session: AsyncSession) -> None:
        await submit_execution(db_session, _submission("idem-claim-twice"))

        first = await claim_ready_tasks(
            db_session, owner="scheduler-1", lease_duration=timedelta(seconds=60)
        )
        second = await claim_ready_tasks(
            db_session, owner="scheduler-2", lease_duration=timedelta(seconds=60)
        )

        assert len(first) == 1
        assert second == []

    async def test_respects_limit(self, db_session: AsyncSession) -> None:
        await submit_execution(db_session, _submission("idem-claim-limit", task_count=3))

        claimed = await claim_ready_tasks(
            db_session, owner="scheduler-1", lease_duration=timedelta(seconds=60), limit=2
        )

        assert len(claimed) == 2

    async def test_task_not_yet_available_is_not_claimed(self, db_session: AsyncSession) -> None:
        result = await submit_execution(db_session, _submission("idem-claim-future"))
        tasks_by_key = await _load_tasks_by_key(db_session, result.execution_id)
        tasks_by_key["task-0"].available_at = datetime.now(UTC) + timedelta(hours=1)
        await db_session.flush()

        claimed = await claim_ready_tasks(
            db_session, owner="scheduler-1", lease_duration=timedelta(seconds=60)
        )

        assert claimed == []


class TestRecoverExpiredLeases:
    async def test_expired_claimed_task_is_reset_to_ready(self, db_session: AsyncSession) -> None:
        await submit_execution(db_session, _submission("idem-recover-basic"))
        claim_time = datetime.now(UTC)
        await claim_ready_tasks(
            db_session,
            owner="scheduler-1",
            lease_duration=timedelta(seconds=30),
            now=claim_time,
        )

        recovered_count = await recover_expired_leases(
            db_session,
            owner="scheduler-2",
            lease_duration=timedelta(seconds=30),
            now=claim_time + timedelta(seconds=31),
        )

        assert recovered_count == 1

    async def test_recovered_task_is_reclaimable_and_gets_a_new_attempt(
        self, db_session: AsyncSession
    ) -> None:
        result = await submit_execution(db_session, _submission("idem-recover-reclaim"))
        claim_time = datetime.now(UTC)
        first_claim = await claim_ready_tasks(
            db_session,
            owner="scheduler-1",
            lease_duration=timedelta(seconds=30),
            now=claim_time,
        )
        assert first_claim[0].attempt_count == 1

        later = claim_time + timedelta(seconds=31)
        second_claim = await claim_ready_tasks(
            db_session, owner="scheduler-2", lease_duration=timedelta(seconds=30), now=later
        )

        assert len(second_claim) == 1
        reclaimed_task = second_claim[0]
        assert reclaimed_task.lease_owner == "scheduler-2"
        assert reclaimed_task.attempt_count == 2

        tasks_by_key = await _load_tasks_by_key(db_session, result.execution_id)
        assert tasks_by_key["task-0"].id == reclaimed_task.id

    async def test_unexpired_claimed_task_is_left_alone(self, db_session: AsyncSession) -> None:
        await submit_execution(db_session, _submission("idem-recover-unexpired"))
        claim_time = datetime.now(UTC)
        await claim_ready_tasks(
            db_session,
            owner="scheduler-1",
            lease_duration=timedelta(seconds=300),
            now=claim_time,
        )

        recovered_count = await recover_expired_leases(
            db_session,
            owner="scheduler-2",
            lease_duration=timedelta(seconds=30),
            now=claim_time + timedelta(seconds=30),
        )

        assert recovered_count == 0

    async def test_expired_running_task_is_adopted_not_restarted(
        self, db_session: AsyncSession
    ) -> None:
        """A rollout gives the scheduler a new name, so the old Pod's leases
        expire. Its RUNNING tasks already have Jobs; the new owner keeps
        polling those rather than starting each task a second time."""
        result = await submit_execution(db_session, _submission("idem-recover-adopt"))
        claim_time = datetime.now(UTC)
        [task] = await claim_ready_tasks(
            db_session,
            owner="scheduler-1",
            lease_duration=timedelta(seconds=30),
            now=claim_time,
        )
        handle = {"namespace": "test-team", "jobName": "ek-task-0-abc"}
        task.state = TaskState.RUNNING
        task.executor_handle = handle
        await db_session.flush()

        later = claim_time + timedelta(seconds=31)
        reclaimed = await claim_ready_tasks(
            db_session, owner="scheduler-2", lease_duration=timedelta(seconds=30), now=later
        )

        assert reclaimed == []
        adopted = (await _load_tasks_by_key(db_session, result.execution_id))["task-0"]
        assert adopted.state is TaskState.RUNNING
        assert adopted.lease_owner == "scheduler-2"
        assert adopted.lease_expires_at == later + timedelta(seconds=30)
        assert adopted.executor_handle == handle
        assert adopted.attempt_count == 1


class TestReleaseLeases:
    async def test_released_running_task_is_adopted_at_once(
        self, db_session: AsyncSession
    ) -> None:
        """A scheduler shutting down releases its leases, so the next one adopts
        its RUNNING tasks on its next pass, long before the lease would expire."""
        result = await submit_execution(db_session, _submission("idem-release-adopt"))
        claim_time = datetime.now(UTC)
        [task] = await claim_ready_tasks(
            db_session, owner="scheduler-1", lease_duration=timedelta(seconds=60), now=claim_time
        )
        handle = {"namespace": "test-team", "jobName": "ek-task-0-abc"}
        task.state = TaskState.RUNNING
        task.executor_handle = handle
        await db_session.flush()

        stop_time = claim_time + timedelta(seconds=5)
        released = await release_leases(db_session, owner="scheduler-1", now=stop_time)
        next_pass = stop_time + timedelta(seconds=1)
        reclaimed = await claim_ready_tasks(
            db_session, owner="scheduler-2", lease_duration=timedelta(seconds=60), now=next_pass
        )

        assert released == 1
        assert reclaimed == []
        adopted = (await _load_tasks_by_key(db_session, result.execution_id))["task-0"]
        assert adopted.state is TaskState.RUNNING
        assert adopted.lease_owner == "scheduler-2"
        assert adopted.executor_handle == handle
        assert adopted.attempt_count == 1

    async def test_only_the_stopping_owners_leases_are_released(
        self, db_session: AsyncSession
    ) -> None:
        result = await submit_execution(
            db_session, _submission("idem-release-own", task_count=2)
        )
        claim_time = datetime.now(UTC)
        await claim_ready_tasks(
            db_session,
            owner="scheduler-1",
            lease_duration=timedelta(seconds=60),
            limit=1,
            now=claim_time,
        )
        await claim_ready_tasks(
            db_session,
            owner="scheduler-2",
            lease_duration=timedelta(seconds=60),
            limit=1,
            now=claim_time,
        )

        released = await release_leases(
            db_session, owner="scheduler-1", now=claim_time + timedelta(seconds=5)
        )

        assert released == 1
        tasks = (await _load_tasks_by_key(db_session, result.execution_id)).values()
        expiry_by_owner = {task.lease_owner: task.lease_expires_at for task in tasks}
        assert expiry_by_owner == {
            "scheduler-1": claim_time + timedelta(seconds=5),
            "scheduler-2": claim_time + timedelta(seconds=60),
        }


class TestConcurrentClaiming:
    async def test_two_schedulers_racing_never_double_claim(self, engine: AsyncEngine) -> None:
        """SKIP LOCKED under real concurrency: exactly one of two racing
        claimers gets the single available task, never both, never neither.

        This needs committed rows visible across two independent
        connections, which the standard rolled-back `db_session` fixture
        can't provide — so this test manages its own sessions and cleans up
        after itself explicitly.
        """
        idempotency_key = "idem-claim-race"

        setup_session = AsyncSession(bind=engine, expire_on_commit=False)
        async with setup_session:
            result = await submit_execution(setup_session, _submission(idempotency_key))
            await setup_session.commit()
        execution_id = result.execution_id

        try:

            async def attempt_claim(owner: str) -> list[ExecutionTask]:
                session = AsyncSession(bind=engine, expire_on_commit=False)
                async with session:
                    claimed = await claim_ready_tasks(
                        session, owner=owner, lease_duration=timedelta(seconds=60)
                    )
                    await session.commit()
                    return claimed

            results = await asyncio.gather(
                attempt_claim("scheduler-a"), attempt_claim("scheduler-b")
            )
            claimed_counts = sorted(len(claimed) for claimed in results)
            assert claimed_counts == [0, 1]
        finally:
            cleanup_session = AsyncSession(bind=engine, expire_on_commit=False)
            async with cleanup_session:
                execution = await cleanup_session.get(Execution, execution_id)
                if execution is not None:
                    await cleanup_session.delete(execution)
                await cleanup_session.commit()


def _submission_for_teams(idempotency_key: str, teams: list[str]) -> ExecutionSubmission:
    """One independent task per entry in ``teams``, in that order."""
    return ExecutionSubmission(
        external_reference="demo-order-1",
        idempotency_key=idempotency_key,
        tasks=[
            TaskDefinition(
                id=f"task-{i}", image="x:local", action="create",
                team=team, serviceAccount="default",
            )
            for i, team in enumerate(teams)
        ],
    )


class TestRunningCaps:
    async def test_the_platform_cap_limits_what_is_claimed_or_running(
        self, db_session: AsyncSession
    ) -> None:
        await submit_execution(db_session, _submission_for_teams("idem-cap-all", ["a"] * 5))
        lease = timedelta(seconds=60)

        first = await claim_ready_tasks(
            db_session, owner="scheduler-1", lease_duration=lease, limit=10, max_running=2
        )
        second = await claim_ready_tasks(
            db_session, owner="scheduler-1", lease_duration=lease, limit=10, max_running=2
        )

        assert len(first) == 2
        assert second == []  # both still claimed: nothing frees a slot

    async def test_the_per_team_cap_limits_each_team(self, db_session: AsyncSession) -> None:
        await submit_execution(
            db_session, _submission_for_teams("idem-cap-team", ["a", "a", "a", "b", "b", "b"])
        )

        claimed = await claim_ready_tasks(
            db_session,
            owner="scheduler-1",
            lease_duration=timedelta(seconds=60),
            limit=10,
            max_running_per_team=1,
        )

        assert sorted(task.team for task in claimed) == ["a", "b"]

    async def test_a_team_at_its_cap_doesnt_starve_the_others(
        self, db_session: AsyncSession
    ) -> None:
        # Team a's tasks are all older, so they come first in claim order.
        await submit_execution(
            db_session, _submission_for_teams("idem-cap-starve", ["a"] * 5 + ["b"])
        )

        claimed = await claim_ready_tasks(
            db_session,
            owner="scheduler-1",
            lease_duration=timedelta(seconds=60),
            limit=2,
            max_running_per_team=1,
        )

        assert sorted(task.team for task in claimed) == ["a", "b"]
