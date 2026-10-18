# SPDX-License-Identifier: MIT
"""Read/write helpers for execution persistence.

Kept to thin query wrappers — anything with actual branching logic (building
the entity graph from a submission, deciding idempotent-replay behavior)
belongs in ``app.services``, not here.
"""

import uuid
from collections.abc import Collection, Sequence
from typing import Any

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.domain.events import EventType
from app.domain.states import ExecutionState
from app.observability.metrics import PENDING_EVENTS_KEY
from app.persistence.models import Execution, ExecutionEvent


async def get_execution_by_idempotency_key(
    session: AsyncSession, idempotency_key: str
) -> Execution | None:
    result = await session.execute(
        select(Execution).where(Execution.idempotency_key == idempotency_key)
    )
    return result.scalar_one_or_none()


async def get_execution_by_id(session: AsyncSession, execution_id: uuid.UUID) -> Execution | None:
    return await session.get(Execution, execution_id)


async def transition_execution_state(
    session: AsyncSession,
    execution_id: uuid.UUID,
    to: ExecutionState,
    from_states: Collection[ExecutionState],
) -> bool:
    """Move an execution to ``to`` only if it's still in one of ``from_states``.

    A compare-and-set, because kernel-api and the scheduler both change an
    execution's state: setting the attribute on a loaded row would write
    back over whatever the other committed since that row was read (a
    cancel lost to the first dispatch, a finished execution cancelled).
    Returns whether this call made the change. "fetch" syncs a loaded
    ``Execution`` only if the database row matched; the default evaluates
    the WHERE against the loaded, possibly stale, object instead.
    """
    result = await session.execute(
        update(Execution)
        .where(Execution.id == execution_id, Execution.state.in_(from_states))
        .values(state=to)
        .returning(Execution.id)
        .execution_options(synchronize_session="fetch")
    )
    return result.first() is not None


async def get_execution_states(
    session: AsyncSession, execution_ids: Sequence[uuid.UUID]
) -> Sequence[Execution]:
    """Many executions' states in one query, for list views."""
    if not execution_ids:
        return []
    result = await session.execute(select(Execution).where(Execution.id.in_(execution_ids)))
    return result.scalars().all()


async def get_execution_events(
    session: AsyncSession,
    execution_id: uuid.UUID,
    *,
    after: int | None = None,
    limit: int = 100,
) -> Sequence[ExecutionEvent]:
    """Fetch up to ``limit`` events for ``execution_id``, ordered by id.

    ``after`` excludes every event at or before that id — pass the previous
    page's last event id to fetch the next page.
    """
    query = select(ExecutionEvent).where(ExecutionEvent.execution_id == execution_id)
    if after is not None:
        query = query.where(ExecutionEvent.id > after)
    result = await session.execute(query.order_by(ExecutionEvent.id).limit(limit))
    return result.scalars().all()


async def record_event(
    session: AsyncSession,
    *,
    execution_id: uuid.UUID,
    event_type: EventType,
    task_id: uuid.UUID | None = None,
    payload: dict[str, Any] | None = None,
) -> None:
    """The one place lifecycle events are written (``execution_events``).

    ``task_id`` is the task's row id, which callers never see, so task-level
    events also put the ``taskKey`` in ``payload``.
    """
    session.add(
        ExecutionEvent(
            execution_id=execution_id,
            task_id=task_id,
            event_type=event_type,
            payload=payload or {},
        )
    )
    session.info.setdefault(PENDING_EVENTS_KEY, []).append(event_type.value)
