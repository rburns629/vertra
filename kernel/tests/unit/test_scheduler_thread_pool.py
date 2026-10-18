# SPDX-License-Identifier: MIT
"""The scheduler's thread pool lets its configured number of executor calls overlap.

Kubernetes calls run through asyncio.to_thread. Python's default pool is
"CPUs + 4" (the node's CPUs), which silently capped how many overlapped.
"""

import asyncio
import threading
import time

from app.scheduler.__main__ import thread_pool_for


def test_the_pool_has_room_for_every_concurrent_call_plus_spares() -> None:
    assert thread_pool_for(16)._max_workers == 20


async def test_that_many_blocking_calls_really_run_at_once() -> None:
    # Above Python's default pool on any machine (at most 32 threads), so this
    # only passes because the pool is sized from the setting.
    concurrency = 36
    asyncio.get_running_loop().set_default_executor(thread_pool_for(concurrency))
    lock = threading.Lock()
    in_flight = 0
    most_in_flight = 0

    def blocking_call() -> None:
        nonlocal in_flight, most_in_flight
        with lock:
            in_flight += 1
            most_in_flight = max(most_in_flight, in_flight)
        time.sleep(0.05)
        with lock:
            in_flight -= 1

    await asyncio.gather(*(asyncio.to_thread(blocking_call) for _ in range(concurrency)))

    assert most_in_flight == concurrency
