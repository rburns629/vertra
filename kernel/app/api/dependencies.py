# SPDX-License-Identifier: MIT
"""FastAPI dependency providers."""

from collections.abc import AsyncIterator

from fastapi import Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.persistence.database import session_scope


async def get_db_session(request: Request) -> AsyncIterator[AsyncSession]:
    """One session per request: committed if the route handler returns normally,
    rolled back if it raises. The session factory is created once at app
    startup (see app.main's lifespan) and stored on app.state.
    """
    session_factory = request.app.state.session_factory
    async with session_scope(session_factory) as session:
        yield session
