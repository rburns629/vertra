# SPDX-License-Identifier: MIT
"""Whether the database schema is the one this code expects, and waiting until it is.

On a fresh install the migration Job is a Helm ``post-install`` hook: it only
runs once the release's Pods are up, so kernel-scheduler starts against an
empty database. Waiting here, rather than in an init container, keeps the Pod
ready, so the install can finish and the migration can run.
"""

import asyncio
import logging
import time
from collections.abc import Callable
from pathlib import Path

from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncEngine

logger = logging.getLogger(__name__)

# The kernel's root, where alembic.ini sits beside the app package, in a
# checkout and in the image (/app) alike. The migrations are this package's.
_KERNEL_ROOT = Path(__file__).resolve().parents[2]
_MIGRATIONS = Path(__file__).resolve().parent / "migrations"
_WAIT_LOG_INTERVAL_SECONDS = 15.0


def expected_revision() -> str:
    """The newest migration this code ships with."""
    config = Config(str(_KERNEL_ROOT / "alembic.ini"))
    config.set_main_option("script_location", str(_MIGRATIONS))
    head = ScriptDirectory.from_config(config).get_current_head()
    assert head is not None  # the kernel always ships migrations
    return head


async def current_revision(engine: AsyncEngine) -> str | None:
    """The database's migration revision, or None if it has none yet (or can't be reached)."""
    try:
        async with engine.connect() as connection:
            result = await connection.execute(text("SELECT version_num FROM alembic_version"))
            row = result.first()
    except DBAPIError:
        # No alembic_version table yet, or Postgres not accepting connections.
        return None
    return None if row is None else str(row[0])


async def wait_for_schema(
    engine: AsyncEngine,
    *,
    poll_seconds: float = 1.0,
    on_poll: Callable[[], object] | None = None,
) -> None:
    """Return once the database is at this code's revision, saying so calmly while it isn't."""
    expected = expected_revision()
    last_logged = 0.0
    while (found := await current_revision(engine)) != expected:
        if time.monotonic() - last_logged >= _WAIT_LOG_INTERVAL_SECONDS:
            logger.info(
                "waiting for database migrations before scheduling",
                extra={"expectedRevision": expected, "foundRevision": found},
            )
            last_logged = time.monotonic()
        if on_poll is not None:
            on_poll()  # the scheduler's heartbeat: still waiting, not hung
        await asyncio.sleep(poll_seconds)
    logger.info("database schema is current", extra={"revision": expected})
