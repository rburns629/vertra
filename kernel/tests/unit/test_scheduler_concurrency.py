# SPDX-License-Identifier: MIT
"""How a scheduling pass overlaps its executor calls (app.scheduler.service._gather_bounded)."""

import asyncio
from functools import partial

from app.scheduler.service import _gather_bounded


async def test_calls_overlap_up_to_the_limit_and_results_keep_their_order() -> None:
    in_flight = 0
    most_in_flight = 0

    async def call(value: int) -> int:
        nonlocal in_flight, most_in_flight
        in_flight += 1
        most_in_flight = max(most_in_flight, in_flight)
        await asyncio.sleep(0.01)
        in_flight -= 1
        return value

    results = await _gather_bounded([partial(call, v) for v in range(10)], limit=4)

    assert results == list(range(10))
    assert most_in_flight == 4


async def test_a_failing_call_yields_its_exception_without_stopping_the_rest() -> None:
    async def ok() -> str:
        return "ok"

    async def boom() -> str:
        raise RuntimeError("boom")

    results = await _gather_bounded([ok, boom, ok], limit=2)

    assert results[0] == "ok" and results[2] == "ok"
    assert isinstance(results[1], RuntimeError)
