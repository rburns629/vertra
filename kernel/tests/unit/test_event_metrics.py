# SPDX-License-Identifier: MIT
"""Event metrics count only what a committed transaction recorded (session_scope)."""

from collections.abc import Iterator
from contextlib import asynccontextmanager
from typing import Any

import pytest
from prometheus_client import REGISTRY

from app.observability.metrics import PENDING_EVENTS_KEY
from app.persistence.database import session_scope


class _StubSession:
    def __init__(self) -> None:
        self.info: dict[str, Any] = {}

    async def commit(self) -> None:
        return None

    async def rollback(self) -> None:
        return None


def _factory(session: _StubSession) -> Any:
    @asynccontextmanager
    async def open_session() -> Any:
        yield session

    return open_session


def _count(event_type: str) -> float:
    return REGISTRY.get_sample_value("kernel_events_total", {"event_type": event_type}) or 0.0


@pytest.fixture
def event_type() -> Iterator[str]:
    yield "TEST_EVENT_METRICS"


async def test_counted_after_commit(event_type: str) -> None:
    before = _count(event_type)
    session = _StubSession()
    async with session_scope(_factory(session)) as s:
        s.info.setdefault(PENDING_EVENTS_KEY, []).extend([event_type, event_type])
        assert _count(event_type) == before
    assert _count(event_type) == before + 2


async def test_not_counted_when_rolled_back(event_type: str) -> None:
    before = _count(event_type)
    session = _StubSession()
    with pytest.raises(RuntimeError):
        async with session_scope(_factory(session)) as s:
            s.info.setdefault(PENDING_EVENTS_KEY, []).append(event_type)
            raise RuntimeError("the pass failed")
    assert _count(event_type) == before
    assert PENDING_EVENTS_KEY not in session.info
