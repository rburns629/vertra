# SPDX-License-Identifier: MIT
"""The sleeper's decision, and what one run does with it. Kubernetes and the
database are faked here; the real scale-down is proven on kind."""

from datetime import UTC, datetime, timedelta
from typing import Any

import pytest

from app.config import Settings
from app.sleeper import __main__ as sleeper
from app.sleeper.activity import KernelActivity
from app.sleeper.decision import last_activity, should_sleep

NOW = datetime(2026, 10, 18, 12, 0, tzinfo=UTC)
TWO_HOURS = timedelta(hours=2)


class TestDecision:
    def test_latest_known_moment(self) -> None:
        assert last_activity(None, NOW - TWO_HOURS, NOW, None) == NOW
        assert last_activity(None, None) is None

    def test_sleeps_only_after_the_idle_period(self) -> None:
        assert should_sleep(now=NOW, busy=False, last=NOW - TWO_HOURS, idle_after=TWO_HOURS)
        assert not should_sleep(
            now=NOW, busy=False, last=NOW - TWO_HOURS + timedelta(seconds=1), idle_after=TWO_HOURS
        )

    def test_never_while_busy_or_without_anything_to_measure_from(self) -> None:
        assert not should_sleep(now=NOW, busy=True, last=NOW - 10 * TWO_HOURS, idle_after=TWO_HOURS)
        assert not should_sleep(now=NOW, busy=False, last=None, idle_after=TWO_HOURS)


class FakePlatform:
    """The Kubernetes side, recording what a run asks of it."""

    def __init__(self, replicas: dict[str, int], console: datetime | None = None) -> None:
        self._replicas = replicas
        self._console = console
        self.slept: tuple[dict[str, int], list[str], str] | None = None
        self.suspended: str | None = None

    def replicas(self, names: list[str]) -> dict[str, int]:
        return {name: self._replicas[name] for name in names if name in self._replicas}

    def newest_pod_start(self, selector: str) -> datetime | None:
        return NOW - 3 * TWO_HOURS

    def console_activity(self, configmap: str) -> datetime | None:
        return self._console

    def sleep(self, awake: dict[str, int], order: list[str], state_configmap: str) -> None:
        self.slept = (awake, order, state_configmap)

    def suspend(self, cronjob: str) -> None:
        self.suspended = cronjob


SETTINGS = Settings(
    sleeper_namespace="acyclix-system",
    sleeper_deployments=["api", "console", "trivy"],
    sleeper_database_deployments=["postgres"],
    sleeper_state_configmap="kernel-sleep",
    sleeper_console_activity_configmap="console-activity",
    sleeper_idle_after_seconds=7200,
    sleeper_cronjob="kernel-sleeper",
)


def run_with(
    monkeypatch: pytest.MonkeyPatch, platform: FakePlatform, kernel: KernelActivity, *, now: bool
) -> None:
    import asyncio

    monkeypatch.setattr(sleeper, "Platform", lambda *a, **k: platform)

    async def activity(_settings: Any) -> KernelActivity:
        return kernel

    monkeypatch.setattr(sleeper, "_kernel_activity", activity)
    monkeypatch.setattr(sleeper, "datetime", type("D", (), {"now": staticmethod(lambda tz: NOW)}))
    asyncio.run(sleeper.run(SETTINGS, now_mode=now))


class TestRun:
    def test_sleeps_an_idle_platform_database_last(self, monkeypatch: pytest.MonkeyPatch) -> None:
        platform = FakePlatform({"api": 2, "console": 1, "trivy": 0, "postgres": 1})
        run_with(
            monkeypatch, platform, KernelActivity(busy=False, last=NOW - 3 * TWO_HOURS), now=False
        )
        assert platform.slept == (
            {"api": 2, "console": 1, "postgres": 1},  # an idled scanner isn't woken later
            ["api", "console", "postgres"],
            "kernel-sleep",
        )
        assert platform.suspended == "kernel-sleeper"  # no Pod every few minutes while asleep

    def test_stays_up_while_the_console_is_used(self, monkeypatch: pytest.MonkeyPatch) -> None:
        platform = FakePlatform({"api": 1, "postgres": 1}, console=NOW - timedelta(minutes=5))
        run_with(monkeypatch, platform, KernelActivity(busy=False, last=None), now=False)
        assert platform.slept is None

    def test_stays_up_while_an_execution_is_unfinished(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        platform = FakePlatform({"api": 1, "postgres": 1})
        run_with(
            monkeypatch, platform, KernelActivity(busy=True, last=NOW - 3 * TWO_HOURS), now=False
        )
        assert platform.slept is None
        assert platform.suspended is None

    def test_does_nothing_when_already_asleep(self, monkeypatch: pytest.MonkeyPatch) -> None:
        platform = FakePlatform({"api": 0, "postgres": 0})
        run_with(monkeypatch, platform, KernelActivity(busy=False, last=None), now=False)
        assert platform.slept is None
        assert platform.suspended == "kernel-sleeper"

    def test_a_scheduled_sleep_ignores_recent_activity(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        platform = FakePlatform({"api": 1, "postgres": 1}, console=NOW)
        run_with(monkeypatch, platform, KernelActivity(busy=False, last=NOW), now=True)
        assert platform.slept is not None
