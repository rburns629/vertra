# SPDX-License-Identifier: MIT
"""Liveness/readiness endpoints, per the brief's observability requirements.

Kept deliberately minimal — no dependency on business logic, so these
answer even if something else in the app is misbehaving. Liveness never
touches the database (a slow or down database shouldn't get the process
killed by an orchestrator's liveness probe); readiness does, since a
process that can't reach Postgres genuinely isn't ready to serve traffic.
"""

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.dependencies import get_db_session

router = APIRouter(prefix="/health", tags=["health"])


@router.get("/live")
async def live() -> dict[str, str]:
    return {"status": "ok"}


@router.get("/ready")
async def ready(session: AsyncSession = Depends(get_db_session)) -> dict[str, str]:
    try:
        await session.execute(text("SELECT 1"))
    except Exception as error:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Database unavailable."
        ) from error
    return {"status": "ok"}
