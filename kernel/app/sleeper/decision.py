# SPDX-License-Identifier: MIT
"""When to sleep: pure, so every case is a unit test."""

from datetime import datetime, timedelta


def last_activity(*moments: datetime | None) -> datetime | None:
    """The latest of the moments known (None when none is)."""
    known = [moment for moment in moments if moment is not None]
    return max(known) if known else None


def should_sleep(
    *, now: datetime, busy: bool, last: datetime | None, idle_after: timedelta
) -> bool:
    """Sleep only with nothing unfinished and nothing for ``idle_after``.

    With no activity known at all (no execution ever, no console use, no
    kernel-api start time) there's nothing to measure from: stay awake
    rather than guess.
    """
    if busy or last is None:
        return False
    return now - last >= idle_after
