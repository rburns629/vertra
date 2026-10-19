# SPDX-License-Identifier: MIT
"""The sleeper's entry point: one look, then exit (the chart runs it as a
CronJob every few minutes).

    python -m app.sleeper          sleep if idle for sleeper_idle_after_seconds
    python -m app.sleeper --now    a scheduled sleep: wait for unfinished
                                   executions (up to
                                   sleeper_scheduled_wait_seconds), then sleep

Asleep already (every Deployment at zero, the database included): nothing
to do. A failure is logged and exits non-zero; the next run starts afresh.
"""

import asyncio
import logging
import sys
from datetime import UTC, datetime, timedelta

from app.config import Settings, get_settings
from app.executors.kubernetes import load_kube_config
from app.observability.logging import configure_logging
from app.persistence.database import create_engine, create_session_factory, session_scope
from app.sleeper.activity import KernelActivity, kernel_activity
from app.sleeper.decision import last_activity, should_sleep
from app.sleeper.platform import Platform

logger = logging.getLogger("app.sleeper")

_SCHEDULED_POLL_SECONDS = 60


async def _kernel_activity(settings: Settings) -> KernelActivity:
    engine = create_engine(
        settings.database_url, command_timeout_seconds=settings.database_command_timeout_seconds
    )
    try:
        async with session_scope(create_session_factory(engine)) as session:
            return await kernel_activity(session)
    finally:
        await engine.dispose()


async def run(settings: Settings, *, now_mode: bool) -> None:
    platform = Platform(
        settings.sleeper_namespace, timeout_seconds=settings.kubernetes_request_timeout_seconds
    )
    names = settings.sleeper_deployments + settings.sleeper_database_deployments
    current = await asyncio.to_thread(platform.replicas, names)
    awake = {name: replicas for name, replicas in current.items() if replicas > 0}
    if not awake:
        # Asleep some other way (acyclixctl sleep, by hand): stop looking.
        await asyncio.to_thread(platform.suspend, settings.sleeper_cronjob)
        logger.info("already asleep")
        return

    deadline = datetime.now(UTC) + timedelta(seconds=settings.sleeper_scheduled_wait_seconds)
    while True:
        kernel = await _kernel_activity(settings)
        if not now_mode or not kernel.busy:
            break
        if datetime.now(UTC) >= deadline:
            logger.info("scheduled sleep skipped: executions still unfinished")
            return
        logger.info("scheduled sleep waiting for unfinished executions")
        await asyncio.sleep(_SCHEDULED_POLL_SECONDS)

    if not now_mode:
        console = await asyncio.to_thread(
            platform.console_activity, settings.sleeper_console_activity_configmap
        )
        api_started = await asyncio.to_thread(
            platform.newest_pod_start, settings.sleeper_api_pod_selector
        )
        last = last_activity(kernel.last, console, api_started)
        idle_after = timedelta(seconds=settings.sleeper_idle_after_seconds)
        if not should_sleep(
            now=datetime.now(UTC), busy=kernel.busy, last=last, idle_after=idle_after
        ):
            logger.info(
                "awake",
                extra={"busy": kernel.busy, "last_activity": last.isoformat() if last else None},
            )
            return

    # The databases last, so nothing is left running against a stopped one.
    order = [n for n in settings.sleeper_deployments if n in awake] + [
        n for n in settings.sleeper_database_deployments if n in awake
    ]
    await asyncio.to_thread(platform.sleep, awake, order, settings.sleeper_state_configmap)
    await asyncio.to_thread(platform.suspend, settings.sleeper_cronjob)
    logger.info("asleep", extra={"deployments": order, "scheduled": now_mode})


def main() -> None:
    configure_logging(service="kernel-sleeper")
    settings = get_settings()
    load_kube_config()
    try:
        asyncio.run(run(settings, now_mode="--now" in sys.argv[1:]))
    except Exception:
        logger.exception("sleeper failed")
        sys.exit(1)


if __name__ == "__main__":
    main()
