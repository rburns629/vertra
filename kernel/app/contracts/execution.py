# SPDX-License-Identifier: MIT
"""Pydantic contracts for submitting and reporting on an execution."""

import uuid
from datetime import datetime
from typing import Any

from pydantic import AliasChoices, BaseModel, ConfigDict, Field

from app.contracts.task import TaskDefinition
from app.domain.states import ExecutionState, TaskState


class ExecutionSubmission(BaseModel):
    """The body of ``POST /v1/executions``.

    This model only enforces structural/type correctness. Task-graph
    validity (unique ids, cycles, reference scoping) is a separate concern
    checked by ``app.domain.dag_validation.validate_dag``, so it can be
    unit-tested and reused independently of HTTP parsing.

    ``name`` labels the run for people and may repeat. ``requestId`` makes a
    resubmission safe: a second submission with the same one returns the
    run it already started instead of starting another, so a caller that
    retries after a timeout sends the same ``requestId`` again. Optional:
    without it every submission is a new run.

    The old names ``externalReference`` and ``idempotencyKey`` are still
    accepted, so stored DAGs (the console's Rerun) and older callers keep
    working; they're to be dropped later (TODO.md).
    """

    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    external_reference: str = Field(
        validation_alias=AliasChoices("name", "externalReference"),
        serialization_alias="name",
        min_length=1,
    )
    idempotency_key: str = Field(
        default_factory=lambda: str(uuid.uuid4()),
        validation_alias=AliasChoices("requestId", "idempotencyKey"),
        serialization_alias="requestId",
        min_length=1,
    )
    tasks: list[TaskDefinition] = Field(default_factory=list)


class ExecutionSubmissionResponse(BaseModel):
    """The response returned immediately from ``POST /v1/executions``.

    The API does not wait for tasks to run; it persists the execution and
    returns as soon as that's durable.
    """

    model_config = ConfigDict(populate_by_name=True)

    execution_id: uuid.UUID = Field(alias="executionId")
    state: ExecutionState


class TaskStatusResponse(BaseModel):
    """One task's current status, as reported by ``GET /v1/executions/{id}``."""

    model_config = ConfigDict(populate_by_name=True)

    task_id: str = Field(alias="taskId")
    state: TaskState
    attempt_count: int = Field(alias="attemptCount")
    outputs: dict[str, Any] | None = None
    failure: dict[str, Any] | None = None
    depends_on: list[str] = Field(default_factory=list, alias="dependsOn")
    started_at: datetime | None = Field(default=None, alias="startedAt")
    completed_at: datetime | None = Field(default=None, alias="completedAt")


class ExecutionDetailResponse(BaseModel):
    """The body of ``GET /v1/executions/{execution_id}``."""

    model_config = ConfigDict(populate_by_name=True)

    execution_id: uuid.UUID = Field(alias="executionId")
    external_reference: str = Field(alias="name")
    state: ExecutionState
    tasks: list[TaskStatusResponse]


class ExecutionEventResponse(BaseModel):
    """One row of ``GET /v1/executions/{execution_id}/events``.

    ``taskId`` carries the task's *key* (``"create-project"``), not its
    internal database id -- despite the field name, kept as ``taskId`` on
    the wire (not renamed to ``taskKey``) because every other place a task
    is identified in this API (``TaskStatusResponse.taskId``,
    ``TaskLogsResponse.taskId``, a submitted payload's own ``id``) already
    uses that same human key under that same name; a caller correlating an
    event to a task elsewhere in the API needs this to match, not the
    row's own opaque primary key.
    """

    model_config = ConfigDict(populate_by_name=True)

    id: int
    event_type: str = Field(alias="eventType")
    task_id: str | None = Field(default=None, alias="taskId")
    payload: dict[str, Any]
    created_at: datetime = Field(alias="createdAt")


class ExecutionStateResponse(BaseModel):
    """One row of ``GET /v1/executions/states``."""

    model_config = ConfigDict(populate_by_name=True)

    execution_id: uuid.UUID = Field(alias="executionId")
    state: ExecutionState


# Per POST /v1/executions/states call; the console asks in batches.
MAX_STATES_PER_REQUEST = 1000


class ExecutionStatesRequest(BaseModel):
    """The body of ``POST /v1/executions/states``: a body, not a query string,
    so the list's length isn't bounded by the server's URL limit (about
    1,700 ids, measured on kind)."""

    model_config = ConfigDict(extra="forbid")

    ids: list[uuid.UUID] = Field(max_length=MAX_STATES_PER_REQUEST)


class ExecutionStatesResponse(BaseModel):
    """The body of ``POST /v1/executions/states`` -- a bulk, list-friendly
    alternative to fetching each execution's full detail one at a time just
    to read its ``state`` (e.g. for a dashboard or list view showing many
    executions at once). Silently omits any id that doesn't exist or that
    the caller didn't ask for -- this endpoint doesn't 404, it just answers
    for whichever of the requested ids are real."""

    model_config = ConfigDict(populate_by_name=True)

    states: list[ExecutionStateResponse]


class ExecutionEventPage(BaseModel):
    """The body of ``GET /v1/executions/{execution_id}/events``.

    Cursor-paginated rather than offset-paginated: events are an append-only
    log ordered by ``id``, so ``after`` (an event id) is both a stable
    cursor — unaffected by new events being inserted concurrently — and a
    plain indexed ``WHERE id > :after`` lookup, not an ``OFFSET`` scan.
    ``nextCursor`` is ``null`` once a page comes back shorter than the
    requested limit, meaning there's nothing newer to fetch yet.
    """

    model_config = ConfigDict(populate_by_name=True)

    events: list[ExecutionEventResponse]
    next_cursor: int | None = Field(default=None, alias="nextCursor")


class TaskLogsResponse(BaseModel):
    """One task's captured container output, as reported by
    ``GET /v1/executions/{id}/logs``. ``lines`` is `[]` (not missing) for a
    task that hasn't produced any output yet, or ran but printed nothing --
    genuinely different from "no log entry exists at all" is not a
    distinction this endpoint needs to make."""

    model_config = ConfigDict(populate_by_name=True)

    task_id: str = Field(alias="taskId")
    lines: list[str] = Field(default_factory=list)


class ExecutionLogsResponse(BaseModel):
    """The body of ``GET /v1/executions/{execution_id}/logs`` — every task's
    logs in one call, not one call per task, same reasoning as
    ExecutionStatesResponse: a caller that wants "all of this execution's
    output aggregated" shouldn't need N round trips to build it."""

    model_config = ConfigDict(populate_by_name=True)

    tasks: list[TaskLogsResponse]
