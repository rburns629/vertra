# SPDX-License-Identifier: MIT
"""The scheduler's waits end as soon as it's told to stop (app/scheduler/__main__.py)."""

import asyncio

from app.scheduler.__main__ import wait_unless_stopping


async def test_stopping_cuts_a_wait_short_and_cancels_it() -> None:
    stopping = asyncio.Event()
    cancelled = asyncio.Event()

    async def long_wait() -> None:
        try:
            await asyncio.sleep(60)
        except asyncio.CancelledError:
            cancelled.set()
            raise

    asyncio.get_running_loop().call_later(0.01, stopping.set)
    await asyncio.wait_for(wait_unless_stopping(stopping, long_wait()), timeout=5)

    await asyncio.sleep(0)  # let the cancellation reach long_wait
    assert cancelled.is_set()


async def test_a_wait_that_finishes_first_returns_without_stopping() -> None:
    stopping = asyncio.Event()
    finished = asyncio.Event()

    async def short_wait() -> None:
        await asyncio.sleep(0.01)
        finished.set()

    await asyncio.wait_for(wait_unless_stopping(stopping, short_wait()), timeout=5)

    assert finished.is_set()
    assert not stopping.is_set()


async def test_already_stopping_returns_at_once() -> None:
    stopping = asyncio.Event()
    stopping.set()

    await asyncio.wait_for(wait_unless_stopping(stopping, asyncio.sleep(60)), timeout=1)
