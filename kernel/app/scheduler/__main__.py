# SPDX-License-Identifier: MIT
"""Scheduler process entry point: runs scheduling passes forever, dispatching
ready tasks as Kubernetes Jobs. A pass that made progress is followed by the
next at once; otherwise the loop waits until a watched Job or Pod changes, or
the poll interval passes.

Run with:

    python -m app.scheduler

A tick that raises is logged and skipped rather than crashing the process —
the next tick picks up from whatever is durably persisted, since every
scheduler operation is designed to be safe to retry from scratch.

On SIGTERM (a rollout, a node drain) or SIGINT, the scheduler finishes the
pass in progress, claims nothing more, and releases its leases so another
scheduler adopts its tasks at once instead of when the leases run out.
"""

import asyncio
import logging
import signal
import socket
import time
from collections.abc import Awaitable
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from pathlib import Path

from prometheus_client import start_http_server

from app.config import get_settings
from app.domain.states import RetryBackoff
from app.executors.kubernetes import KubernetesExecutor
from app.observability.logging import configure_logging
from app.observability.metrics import SCHEDULER_TICK_DURATION_SECONDS, SCHEDULER_TICK_ERRORS_TOTAL
from app.persistence.database import create_engine, create_session_factory, session_scope
from app.persistence.schema import wait_for_schema
from app.scheduler.claiming import release_leases
from app.scheduler.retention import delete_finished_executions
from app.scheduler.service import run_scheduler_tick

logger = logging.getLogger("app.scheduler")

# Between back-to-back passes, so a run of progress (or a task that keeps
# failing to start and being retried) can't hold the database in a tight loop.
_PAUSE_AFTER_PROGRESS_SECONDS = 0.05

# How often finished executions past their retention are swept (a few
# hundred at a time, so each pass is short).
_RETENTION_INTERVAL_SECONDS = 3600

# Threads beyond scheduler_executor_concurrency, for the executor calls made
# one at a time outside a pass's concurrent batches (cancels, log reads).
_SPARE_THREADS = 4


def thread_pool_for(executor_concurrency: int) -> ThreadPoolExecutor:
    """The event loop's default thread pool, sized for the scheduler's executor calls.

    Every Kubernetes call runs through ``asyncio.to_thread``, which uses this
    pool. Python's own default is "CPUs + 4", counting the node's CPUs rather
    than the container's: on a 2-vCPU node that's 6 threads, so at most 6
    calls would really overlap however high the concurrency was set.
    """
    return ThreadPoolExecutor(
        max_workers=executor_concurrency + _SPARE_THREADS, thread_name_prefix="kernel-executor"
    )


async def wait_unless_stopping(stopping: asyncio.Event, waiting: Awaitable[None]) -> None:
    """Await ``waiting``, cut short (and cancelled) if ``stopping`` is set first."""
    waiter = asyncio.ensure_future(waiting)
    stopper = asyncio.ensure_future(stopping.wait())
    try:
        await asyncio.wait({waiter, stopper}, return_when=asyncio.FIRST_COMPLETED)
    finally:
        waiter.cancel()
        stopper.cancel()


async def run_forever() -> None:
    settings = get_settings()
    # Python as PID 1 (as in the container) ignores SIGTERM unless it has a
    # handler, so without this a rollout's old Pod kept claiming work for its
    # whole grace period and was then killed, stranding what it had claimed
    # until those leases expired.
    stopping = asyncio.Event()
    for stop_signal in (signal.SIGTERM, signal.SIGINT):
        asyncio.get_running_loop().add_signal_handler(stop_signal, stopping.set)
    asyncio.get_running_loop().set_default_executor(
        thread_pool_for(settings.scheduler_executor_concurrency)
    )
    engine = create_engine(
        settings.database_url, command_timeout_seconds=settings.database_command_timeout_seconds
    )
    heartbeat = Path(settings.scheduler_heartbeat_file)
    heartbeat.touch()
    # On a fresh install the migrations run after this Pod starts (a Helm
    # post-install hook): wait for them rather than fail every pass until then.
    await wait_unless_stopping(stopping, wait_for_schema(engine, on_poll=heartbeat.touch))
    if stopping.is_set():
        await engine.dispose()
        return
    session_factory = create_session_factory(engine)
    executor = KubernetesExecutor(
        job_ttl_seconds=settings.kubernetes_job_ttl_seconds,
        image_pull_grace_seconds=settings.image_pull_grace_seconds,
        extra_environment=settings.task_extra_environment or None,
        watch_resync_seconds=settings.kubernetes_watch_resync_seconds,
        default_resources=settings.task_default_resources,
        node_selector=settings.task_node_selector,
        tolerations=[
            toleration.model_dump(by_alias=True, exclude_none=True)
            for toleration in settings.task_tolerations
        ],
        affinity=settings.task_affinity,
        request_timeout_seconds=settings.kubernetes_request_timeout_seconds,
        job_deadline_grace_seconds=settings.kubernetes_job_deadline_grace_seconds,
        pod_hardening=settings.task_pod_hardening,
        log_max_lines=settings.task_log_max_lines,
        log_max_bytes=settings.task_log_max_bytes,
        image_pull_secret=settings.task_image_pull_secret,
    )
    await executor.start_watching()
    owner = socket.gethostname()
    lease_duration = timedelta(seconds=settings.lease_duration_seconds)
    retry_backoff = RetryBackoff(
        base_seconds=settings.scheduler_retry_backoff_seconds,
        max_seconds=settings.scheduler_retry_backoff_max_seconds,
    )

    logger.info("scheduler starting", extra={"owner": owner})
    next_retention = time.monotonic()
    try:
        while not stopping.is_set():
            tick_start = time.perf_counter()
            progressed = False
            try:
                async with session_scope(session_factory) as session:
                    progressed = await run_scheduler_tick(
                        session,
                        executor,
                        owner=owner,
                        lease_duration=lease_duration,
                        claim_limit=settings.scheduler_claim_limit,
                        executor_concurrency=settings.scheduler_executor_concurrency,
                        max_running=settings.scheduler_max_running_tasks,
                        max_running_per_team=settings.scheduler_max_running_tasks_per_team,
                        retry_backoff=retry_backoff,
                        max_dispatch_failures=settings.scheduler_max_dispatch_failures,
                        log_refresh=timedelta(seconds=settings.task_log_refresh_seconds),
                        now=datetime.now(UTC),
                    )
                if settings.execution_retention_days and time.monotonic() >= next_retention:
                    next_retention = time.monotonic() + _RETENTION_INTERVAL_SECONDS
                    async with session_scope(session_factory) as session:
                        deleted = await delete_finished_executions(
                            session,
                            finished_before=datetime.now(UTC)
                            - timedelta(days=settings.execution_retention_days),
                        )
                    if deleted:
                        logger.info(
                            "deleted finished executions past retention",
                            extra={"deleted": deleted},
                        )
            except Exception:
                SCHEDULER_TICK_ERRORS_TOTAL.inc()
                logger.exception("scheduler tick failed; will retry next poll")
            finally:
                SCHEDULER_TICK_DURATION_SECONDS.observe(time.perf_counter() - tick_start)
            if progressed:
                # More is likely ready (a finished task's dependents, the rest
                # of a burst): go again, after a pause too short to notice.
                await wait_unless_stopping(
                    stopping, asyncio.sleep(_PAUSE_AFTER_PROGRESS_SECONDS)
                )
            else:
                await wait_unless_stopping(
                    stopping, executor.wait_for_change(settings.scheduler_poll_interval_seconds)
                )
            # Only here, once a whole pass is done: a hung pass stops the
            # heartbeat, and the liveness probe restarts the Pod.
            heartbeat.touch()
        # Not caught: if this fails, the leases still expire on their own and
        # are recovered then, which is how a crash is handled anyway.
        async with session_scope(session_factory) as session:
            released = await release_leases(session, owner=owner, now=datetime.now(UTC))
        logger.info(
            "scheduler stopped; leases released", extra={"owner": owner, "released": released}
        )
    finally:
        await engine.dispose()


def main() -> None:
    configure_logging(service="kernel-scheduler")
    settings = get_settings()
    # The scheduler has no other HTTP server of its own (unlike kernel-api,
    # which serves /metrics alongside its normal routes) — this starts one
    # just for /metrics, on its own port, so a Prometheus-compatible scraper
    # can reach it the same way regardless of where the process runs.
    start_http_server(settings.metrics_port)
    logger.info("metrics server listening", extra={"metricsPort": settings.metrics_port})
    asyncio.run(run_forever())


if __name__ == "__main__":
    main()
