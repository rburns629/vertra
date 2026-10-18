# SPDX-License-Identifier: MIT
"""How long a failed task waits before its next attempt (domain/states.py)."""

from datetime import timedelta

from app.domain.states import RetryBackoff


def test_doubles_from_the_base_after_each_failure() -> None:
    backoff = RetryBackoff(base_seconds=5, max_seconds=300)
    assert [backoff.delay(n).total_seconds() for n in (1, 2, 3, 4)] == [5, 10, 20, 40]


def test_never_exceeds_the_maximum() -> None:
    assert RetryBackoff(base_seconds=5, max_seconds=300).delay(20) == timedelta(seconds=300)


def test_zero_means_retry_at_once() -> None:
    assert RetryBackoff(base_seconds=0, max_seconds=0).delay(3) == timedelta(0)
