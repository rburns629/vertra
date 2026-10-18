# SPDX-License-Identifier: MIT
"""Unit tests for app.domain.states — initial-state and retry-decision rules."""

from app.domain.states import TaskState, initial_task_state, should_retry


def test_task_with_no_dependencies_starts_ready() -> None:
    assert initial_task_state([]) is TaskState.READY


def test_task_with_dependencies_starts_blocked() -> None:
    assert initial_task_state(["create-project"]) is TaskState.BLOCKED


class TestShouldRetry:
    def test_retryable_failure_with_attempts_remaining_retries(self) -> None:
        assert should_retry(attempt_count=1, max_attempts=2, retryable=True) is True

    def test_retryable_failure_with_no_attempts_remaining_does_not_retry(self) -> None:
        assert should_retry(attempt_count=2, max_attempts=2, retryable=True) is False

    def test_non_retryable_failure_never_retries_even_with_attempts_remaining(self) -> None:
        assert should_retry(attempt_count=1, max_attempts=5, retryable=False) is False

    def test_attempt_count_exceeding_max_does_not_retry(self) -> None:
        assert should_retry(attempt_count=3, max_attempts=2, retryable=True) is False
