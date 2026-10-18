# SPDX-License-Identifier: MIT
"""Async SQLAlchemy engine, session factory, and the declarative base.

The API and scheduler each construct their own engine from the same
``DATABASE_URL`` and talk to each other only through the rows it produces —
neither holds the other's state in memory.
"""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.orm import DeclarativeBase

from app.observability.metrics import EVENTS_TOTAL, PENDING_EVENTS_KEY


class Base(DeclarativeBase):
    """Declarative base shared by every table in app.persistence.models."""


def create_engine(database_url: str, *, command_timeout_seconds: float = 60.0) -> AsyncEngine:
    """``command_timeout_seconds`` bounds every statement: asyncpg's default is
    to wait forever, so a query stuck on a lock would hold its caller (and
    any row locks it has) indefinitely instead of failing."""
    return create_async_engine(
        database_url,
        pool_pre_ping=True,
        connect_args={"command_timeout": command_timeout_seconds},
    )


def create_session_factory(engine: AsyncEngine) -> async_sessionmaker[AsyncSession]:
    return async_sessionmaker(engine, expire_on_commit=False)


@asynccontextmanager
async def session_scope(
    session_factory: async_sessionmaker[AsyncSession],
) -> AsyncIterator[AsyncSession]:
    """Run a block of work in one transaction: commit on success, roll back on error."""
    async with session_factory() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            session.info.pop(PENDING_EVENTS_KEY, None)
            await session.rollback()
            raise
        for event_type in session.info.pop(PENDING_EVENTS_KEY, []):
            EVENTS_TOTAL.labels(event_type=event_type).inc()
