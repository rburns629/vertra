# SPDX-License-Identifier: MIT
"""Event-type vocabulary for the execution_events log.

Recording an event is a persistence concern (see
``app.persistence.repositories.record_event``); this module only names
*what* significant things can happen, so scheduler code doesn't scatter
string literals that are easy to typo and hard to grep for.
"""

from enum import StrEnum


class EventType(StrEnum):
    EXECUTION_CREATED = "EXECUTION_CREATED"
    EXECUTION_STARTED = "EXECUTION_STARTED"
    EXECUTION_SUCCEEDED = "EXECUTION_SUCCEEDED"
    EXECUTION_FAILED = "EXECUTION_FAILED"
    EXECUTION_CANCELLED = "EXECUTION_CANCELLED"
    EXECUTION_RESUMED = "EXECUTION_RESUMED"
    TASK_CLAIMED = "TASK_CLAIMED"
    TASK_STARTED = "TASK_STARTED"
    TASK_SUCCEEDED = "TASK_SUCCEEDED"
    TASK_FAILED = "TASK_FAILED"
    TASK_CANCELLED = "TASK_CANCELLED"
    TASK_RETRIED = "TASK_RETRIED"
    # Starting the attempt raised (an API timeout, say); the same attempt is
    # tried again later, adopting whatever that start left.
    TASK_DISPATCH_RETRY = "TASK_DISPATCH_RETRY"
