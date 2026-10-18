# SPDX-License-Identifier: MIT
"""Deleting finished executions once they're old: every row of theirs goes
with them (tasks, attempts, outputs, logs, events cascade). An execution has
no timestamps of its own; its last event says when it finished."""

from datetime import datetime

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.domain.states import ExecutionState
from app.persistence.models import Execution, ExecutionEvent

_FINISHED = (ExecutionState.SUCCEEDED, ExecutionState.FAILED, ExecutionState.CANCELLED)


async def delete_finished_executions(
    session: AsyncSession, *, finished_before: datetime, limit: int = 500
) -> int:
    """Deletes up to ``limit`` finished executions whose last event is older
    than ``finished_before``; returns how many. Called repeatedly, a few at
    a time, so one pass never holds a long transaction."""
    last_event = (
        select(ExecutionEvent.execution_id)
        .group_by(ExecutionEvent.execution_id)
        .having(func.max(ExecutionEvent.created_at) < finished_before)
    )
    expired = (
        select(Execution.id)
        .where(Execution.state.in_(_FINISHED), Execution.id.in_(last_event))
        .limit(limit)
        .with_for_update(skip_locked=True)
    )
    result = await session.execute(
        delete(Execution).where(Execution.id.in_(expired)).returning(Execution.id)
    )
    return len(result.all())
