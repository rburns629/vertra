# SPDX-License-Identifier: MIT
"""The scheduler waits for migrations instead of failing every pass until they run.

Real Postgres: the migrated test database, and a throwaway empty one standing
in for a fresh install before its migration hook has run.
"""

import asyncio
import uuid
from collections.abc import AsyncIterator

import pytest
import pytest_asyncio
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

from app.persistence.schema import current_revision, expected_revision, wait_for_schema
from tests.conftest import TEST_DATABASE_URL


@pytest_asyncio.fixture
async def empty_database() -> AsyncIterator[AsyncEngine]:
    """A database with nothing in it, dropped afterwards."""
    name = f"schema_wait_{uuid.uuid4().hex[:8]}"
    admin = create_async_engine(TEST_DATABASE_URL, isolation_level="AUTOCOMMIT")
    async with admin.connect() as connection:
        await connection.execute(text(f'CREATE DATABASE "{name}"'))
    engine = create_async_engine(TEST_DATABASE_URL.rsplit("/", 1)[0] + f"/{name}")
    try:
        yield engine
    finally:
        await engine.dispose()
        async with admin.connect() as connection:
            await connection.execute(text(f'DROP DATABASE "{name}"'))
        await admin.dispose()


async def test_a_migrated_database_is_at_the_expected_revision(engine: AsyncEngine) -> None:
    assert await current_revision(engine) == expected_revision()


async def test_a_database_before_its_migrations_has_no_revision(
    empty_database: AsyncEngine,
) -> None:
    assert await current_revision(empty_database) is None


async def test_waiting_returns_at_once_when_the_schema_is_current(engine: AsyncEngine) -> None:
    await asyncio.wait_for(wait_for_schema(engine, poll_seconds=0.01), timeout=5)


async def test_waiting_returns_once_the_migration_has_run(empty_database: AsyncEngine) -> None:
    waiting = asyncio.create_task(wait_for_schema(empty_database, poll_seconds=0.05))
    await asyncio.sleep(0.3)
    assert not waiting.done(), "should still be waiting: nothing has migrated the database"

    # What the migration Job leaves behind, as far as the wait is concerned.
    async with empty_database.begin() as connection:
        await connection.execute(text("CREATE TABLE alembic_version (version_num varchar(32))"))
        await connection.execute(
            text("INSERT INTO alembic_version VALUES (:revision)"),
            {"revision": expected_revision()},
        )

    await asyncio.wait_for(waiting, timeout=5)


async def test_waiting_doesnt_log_errors(
    empty_database: AsyncEngine, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level("INFO")
    waiting = asyncio.create_task(wait_for_schema(empty_database, poll_seconds=0.05))
    await asyncio.sleep(0.2)
    waiting.cancel()
    messages = [record for record in caplog.records if record.name == "app.persistence.schema"]
    assert messages and all(record.levelname == "INFO" for record in messages)
    assert "waiting for database migrations" in messages[0].getMessage()
