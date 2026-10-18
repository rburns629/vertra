# SPDX-License-Identifier: MIT
"""When KubernetesExecutor can skip reading a running step's Job, given its watch.

No cluster: the executor takes its API clients as arguments, and the watch is
replaced by a stub, so these pin down the decision itself. The watch threads'
real behaviour needs a cluster (see the kind-based integration tests).
"""

import asyncio
from types import SimpleNamespace
from typing import Any

import pytest

from app.executors.base import ExecutorRunState
from app.executors.kubernetes import KubernetesExecutor, _job_name_of, _JobWatch

HANDLE = {"namespace": "team-a", "jobName": "ek-step-1"}


class _CountingBatchApi:
    """Answers every Job status read with a running Job, and counts the reads."""

    def __init__(self, *, ready: int = 1) -> None:
        self.reads = 0
        self._ready = ready

    def read_namespaced_job_status(self, name: str, namespace: str, **_: object) -> SimpleNamespace:
        self.reads += 1
        return SimpleNamespace(status=SimpleNamespace(succeeded=0, failed=0, ready=self._ready))


class _StubCoreApi:
    def list_namespaced_pod(
        self, namespace: str, label_selector: str, **_: object
    ) -> SimpleNamespace:
        return SimpleNamespace(items=[])


class _StubWatch:
    def __init__(self, *, healthy: bool = True) -> None:
        self.healthy = healthy
        self.changed: set[str] = set()

    def take_changed(self, job_name: str) -> bool:
        if job_name in self.changed:
            self.changed.discard(job_name)
            return True
        return False


def _executor(batch: _CountingBatchApi, watch: _StubWatch | None) -> KubernetesExecutor:
    executor = KubernetesExecutor(batch_api=batch, core_api=_StubCoreApi(), watch_resync_seconds=30)
    executor._watch = watch  # type: ignore[assignment]
    return executor


async def test_an_unchanged_running_step_isnt_read_again() -> None:
    batch = _CountingBatchApi()
    executor = _executor(batch, _StubWatch())
    first = await executor.get_status(HANDLE)
    second = await executor.get_status(HANDLE)
    assert first.state is second.state is ExecutorRunState.RUNNING
    assert batch.reads == 1


async def test_a_watched_change_forces_a_read() -> None:
    batch = _CountingBatchApi()
    watch = _StubWatch()
    executor = _executor(batch, watch)
    await executor.get_status(HANDLE)
    watch.changed.add(HANDLE["jobName"])
    await executor.get_status(HANDLE)
    assert batch.reads == 2


async def test_without_a_healthy_watch_every_status_is_read() -> None:
    batch = _CountingBatchApi()
    executor = _executor(batch, _StubWatch(healthy=False))
    await executor.get_status(HANDLE)
    await executor.get_status(HANDLE)
    assert batch.reads == 2


async def test_without_any_watch_every_status_is_read() -> None:
    batch = _CountingBatchApi()
    executor = _executor(batch, None)
    await executor.get_status(HANDLE)
    await executor.get_status(HANDLE)
    assert batch.reads == 2


async def test_the_resync_interval_forces_a_read(monkeypatch: pytest.MonkeyPatch) -> None:
    batch = _CountingBatchApi()
    executor = _executor(batch, _StubWatch())
    clock = [1000.0]
    monkeypatch.setattr("app.executors.kubernetes.time.monotonic", lambda: clock[0])
    await executor.get_status(HANDLE)
    clock[0] += 31
    await executor.get_status(HANDLE)
    assert batch.reads == 2


async def test_a_step_whose_pod_isnt_ready_is_always_read() -> None:
    """It may be stuck pulling its image, which the grace period catches by
    reading, not by an event."""
    batch = _CountingBatchApi(ready=0)
    executor = _executor(batch, _StubWatch())
    await executor.get_status(HANDLE)
    await executor.get_status(HANDLE)
    assert batch.reads == 2


async def test_the_watch_wakes_a_waiting_scheduler() -> None:
    sources = SimpleNamespace(
        list_job_for_all_namespaces=lambda **_: None, list_pod_for_all_namespaces=lambda **_: None
    )
    watch = _JobWatch(sources, sources, asyncio.get_running_loop())
    waiting = asyncio.create_task(watch.wait(timeout=5))
    await asyncio.sleep(0)
    watch.mark_changed("ek-step-1")
    await asyncio.wait_for(waiting, timeout=1)
    assert watch.take_changed("ek-step-1")
    assert not watch.take_changed("ek-step-1")


def _meta(**fields: Any) -> SimpleNamespace:
    return SimpleNamespace(metadata=SimpleNamespace(**fields))


def test_a_pod_event_is_traced_to_its_job() -> None:
    assert _job_name_of("jobs", _meta(name="ek-a", labels={})) == "ek-a"
    assert _job_name_of("pods", _meta(name="ek-a-x1", labels={"job-name": "ek-a"})) == "ek-a"
    assert (
        _job_name_of("pods", _meta(name="p", labels={"batch.kubernetes.io/job-name": "ek-b"}))
        == "ek-b"
    )
    assert _job_name_of("pods", _meta(name="p", labels=None)) is None
