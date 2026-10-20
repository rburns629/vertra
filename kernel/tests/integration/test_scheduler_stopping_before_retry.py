# SPDX-License-Identifier: MIT
"""An attempt is only given up on once it's known to have stopped, and a
finished task's Job is only removed after its outcome is committed.

Before: a failed read of a running task's status failed the attempt and left
its Job running, so a retry ran beside it; a timed-out task whose Job
couldn't be stopped was retried anyway; and a finished Job was deleted
before the pass recording it committed.
"""

from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.contracts.execution import ExecutionSubmission
from app.contracts.task import TaskDefinition
from app.domain.states import TaskState
from app.executors.base import ExecutionHandle
from app.persistence.models import ExecutionTask
from app.scheduler.__main__ import release_finished
from app.scheduler.service import run_scheduler_tick
from app.services.execution_service import submit_execution
from tests.fakes import FakeExecutor

LEASE = timedelta(seconds=60)
GRACE = timedelta(seconds=600)


def _submission(
    key: str, *, max_attempts: int = 2, timeout_seconds: int = 30
) -> ExecutionSubmission:
    return ExecutionSubmission(
        external_reference="stop-before-retry",
        idempotency_key=key,
        tasks=[
            TaskDefinition(
                id="provision",
                image="demo-project-product:local",
                action="create",
                team="test-team",
                serviceAccount="default",
                maxAttempts=max_attempts,
                timeoutSeconds=timeout_seconds,
            )
        ],
    )


async def _tick(
    session: AsyncSession,
    executor: FakeExecutor,
    now: datetime,
    finished: list[ExecutionHandle] | None = None,
) -> None:
    await run_scheduler_tick(
        session,
        executor,
        owner="scheduler-1",
        lease_duration=LEASE,
        job_deadline_grace=GRACE,
        finished=finished,
        now=now,
    )


async def _task(session: AsyncSession, execution_id: object) -> ExecutionTask:
    result = await session.execute(
        select(ExecutionTask)
        .where(ExecutionTask.execution_id == execution_id)
        .execution_options(populate_existing=True)
    )
    return result.scalar_one()


async def test_a_failed_status_read_keeps_the_task_running(db_session: AsyncSession) -> None:
    result = await submit_execution(db_session, _submission("status-read-fails"))
    executor = FakeExecutor()
    t0 = datetime.now(UTC)
    await _tick(db_session, executor, t0)
    handle = (await _task(db_session, result.execution_id)).executor_handle
    assert handle is not None

    executor.status_error = TimeoutError("read timed out")
    await _tick(db_session, executor, t0 + timedelta(seconds=10))

    task = await _task(db_session, result.execution_id)
    assert task.state is TaskState.RUNNING
    assert task.attempt_count == 1
    assert task.lease_expires_at == t0 + timedelta(seconds=10) + LEASE  # still ours
    assert executor.cancelled == []

    executor.status_error = None
    executor.complete(handle, {"projectId": "p-1"})
    await _tick(db_session, executor, t0 + timedelta(seconds=20))

    task = await _task(db_session, result.execution_id)
    assert task.state is TaskState.SUCCEEDED
    assert len(executor.started) == 1


async def test_a_timed_out_task_is_stopped_before_its_retry(db_session: AsyncSession) -> None:
    result = await submit_execution(db_session, _submission("timeout-stopped"))
    executor = FakeExecutor()
    t0 = datetime.now(UTC)
    await _tick(db_session, executor, t0)
    handle = (await _task(db_session, result.execution_id)).executor_handle
    assert handle is not None

    executor.status_error = TimeoutError("read timed out")  # nothing known about it
    await _tick(db_session, executor, t0 + timedelta(seconds=31))

    assert handle["fakeId"] in executor.cancelled
    task = await _task(db_session, result.execution_id)
    assert task.state is TaskState.READY  # retried, now that the attempt is stopped
    assert task.attempt_count == 1


async def test_a_timed_out_task_that_cant_be_stopped_waits_for_its_jobs_deadline(
    db_session: AsyncSession,
) -> None:
    result = await submit_execution(db_session, _submission("timeout-unstoppable"))
    executor = FakeExecutor()
    t0 = datetime.now(UTC)
    await _tick(db_session, executor, t0)

    executor.status_error = TimeoutError("read timed out")
    executor.cancel_error = TimeoutError("delete timed out")
    await _tick(db_session, executor, t0 + timedelta(seconds=31))

    task = await _task(db_session, result.execution_id)
    assert task.state is TaskState.RUNNING  # may still be running: no retry beside it
    assert len(executor.start_calls) == 1

    # Past the timeout plus the grace, Kubernetes has stopped the Job itself.
    await _tick(db_session, executor, t0 + timedelta(seconds=31) + GRACE)

    task = await _task(db_session, result.execution_id)
    assert task.state is TaskState.READY
    assert task.attempt_count == 1


async def test_a_finished_task_is_handed_back_for_release_not_released(
    db_session: AsyncSession,
) -> None:
    result = await submit_execution(db_session, _submission("release-after-commit"))
    executor = FakeExecutor()
    t0 = datetime.now(UTC)
    await _tick(db_session, executor, t0)
    handle = (await _task(db_session, result.execution_id)).executor_handle
    assert handle is not None
    executor.complete(handle, {"projectId": "p-1"})

    finished: list[ExecutionHandle] = []
    await _tick(db_session, executor, t0 + timedelta(seconds=5), finished)

    assert finished == [handle]
    assert executor.released == []  # the pass hasn't committed: the caller releases

    await release_finished(executor, finished)
    assert executor.released == [handle["fakeId"]]


async def test_a_release_that_fails_doesnt_stop_the_others() -> None:
    class _Flaky(FakeExecutor):
        async def release(self, handle: ExecutionHandle) -> None:
            if handle["fakeId"] == "1":
                raise TimeoutError("delete timed out")
            await super().release(handle)

    executor = _Flaky()
    await release_finished(executor, [{"fakeId": "1"}, {"fakeId": "2"}])

    assert executor.released == ["2"]
