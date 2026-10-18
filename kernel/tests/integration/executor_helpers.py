# SPDX-License-Identifier: MIT
"""Shared helpers for real-executor integration tests (Docker and Kubernetes alike)."""

import asyncio
import time

from app.executors.base import ExecutionHandle, ExecutionStatus, Executor, ExecutorRunState


async def wait_for_terminal(
    executor: Executor, handle: ExecutionHandle, *, timeout: float = 15.0
) -> ExecutionStatus:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        status = await executor.get_status(handle)
        if status.state is not ExecutorRunState.RUNNING:
            return status
        await asyncio.sleep(0.2)
    raise AssertionError(f"execution did not reach a terminal state within {timeout}s")
