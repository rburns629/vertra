# SPDX-License-Identifier: MIT
"""HTTP routes for submitting, inspecting, cancelling, and retrying executions."""

import uuid
from typing import Annotated, Any

from fastapi import APIRouter, Body, Depends, HTTPException, Query, Response, status
from fastapi.exceptions import RequestValidationError
from pydantic import ValidationError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.auth import require_caller
from app.api.dependencies import get_db_session
from app.config import Settings, get_settings
from app.contracts.execution import (
    ExecutionDetailResponse,
    ExecutionEventPage,
    ExecutionEventResponse,
    ExecutionLogsResponse,
    ExecutionStateResponse,
    ExecutionStatesRequest,
    ExecutionStatesResponse,
    ExecutionSubmission,
    ExecutionSubmissionResponse,
    TaskLogsResponse,
    TaskStatusResponse,
)
from app.domain.errors import DAGValidationError, ValidationIssue
from app.persistence.repositories import get_execution_by_id, get_execution_states
from app.services.execution_service import (
    CancelOutcome,
    RetryOutcome,
    cancel_execution,
    get_execution_detail,
    get_execution_events,
    get_execution_logs,
    retry_task,
    submit_execution,
)

# Only an allowed caller (the console) may use any of these (app/api/auth.py).
router = APIRouter(
    prefix="/v1/executions", tags=["executions"], dependencies=[Depends(require_caller)]
)


def _parse_submission(body: dict[str, Any]) -> ExecutionSubmission:
    """The submission, read by its documented (camelCase) field names only.

    The console authorizes what it reads under those names (serviceAccount,
    secretRefs, ...) and forwards the body unchanged. If the Python names
    (service_account, secret_refs) were accepted here too, a body could say
    one thing to the console and another to the kernel. Unknown fields are
    refused, so a Python name is a 422.
    """
    try:
        return ExecutionSubmission.model_validate(body, by_alias=True, by_name=False)
    except ValidationError as error:
        raise RequestValidationError(error.errors(include_url=False), body=body) from error


@router.post(
    "",
    status_code=status.HTTP_201_CREATED,
    response_model=ExecutionSubmissionResponse,
    openapi_extra={
        "requestBody": {
            "required": True,
            "content": {
                "application/json": {"schema": ExecutionSubmission.model_json_schema(by_alias=True)}
            },
        }
    },
)
async def create_execution(
    body: Annotated[dict[str, Any], Body()],
    response: Response,
    session: AsyncSession = Depends(get_db_session),
    settings: Settings = Depends(get_settings),
) -> ExecutionSubmissionResponse:
    """Validate and persist a new execution, or return the existing one if
    ``requestId`` was already used — 201 for a new execution, 200 for a replay.
    """
    submission = _parse_submission(body)
    try:
        result = await submit_execution(
            session, submission, max_tasks=settings.max_tasks_per_execution
        )
    except DAGValidationError as error:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=_issues_detail(error.issues),
        ) from error

    if result.created:
        response.headers["Location"] = f"/v1/executions/{result.execution_id}"
    else:
        response.status_code = status.HTTP_200_OK

    return ExecutionSubmissionResponse(executionId=result.execution_id, state=result.state)


@router.post("/states", response_model=ExecutionStatesResponse)
async def read_execution_states(
    body: ExecutionStatesRequest, session: AsyncSession = Depends(get_db_session)
) -> ExecutionStatesResponse:
    """Many executions' states in one call. Registered before ``/{execution_id}``:
    FastAPI matches routes in order, and "states" isn't a uuid."""
    executions = await get_execution_states(session, body.ids)
    return ExecutionStatesResponse(
        states=[
            ExecutionStateResponse(executionId=execution.id, state=execution.state)
            for execution in executions
        ]
    )


@router.get("/{execution_id}", response_model=ExecutionDetailResponse)
async def read_execution(
    execution_id: uuid.UUID, session: AsyncSession = Depends(get_db_session)
) -> ExecutionDetailResponse:
    detail = await get_execution_detail(session, execution_id)
    if detail is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Execution not found.")

    return ExecutionDetailResponse(
        executionId=detail.execution_id,
        name=detail.external_reference,
        state=detail.state,
        tasks=[
            TaskStatusResponse(
                taskId=task.task_id,
                state=task.state,
                attemptCount=task.attempt_count,
                outputs=task.outputs,
                failure=task.failure,
                dependsOn=task.depends_on,
                startedAt=task.started_at,
                completedAt=task.completed_at,
            )
            for task in detail.tasks
        ],
    )


@router.get("/{execution_id}/logs", response_model=ExecutionLogsResponse)
async def read_execution_logs(
    execution_id: uuid.UUID, session: AsyncSession = Depends(get_db_session)
) -> ExecutionLogsResponse:
    """Every task's captured container output for this execution, in one
    call -- see ExecutionLogsResponse's own docstring for why this isn't
    split into one call per task."""
    logs = await get_execution_logs(session, execution_id)
    if logs is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Execution not found.")

    return ExecutionLogsResponse(
        tasks=[
            TaskLogsResponse(taskId=task.task_id, lines=task.lines) for task in logs.tasks
        ],
    )


@router.get("/{execution_id}/events", response_model=ExecutionEventPage)
async def read_execution_events(
    execution_id: uuid.UUID,
    session: AsyncSession = Depends(get_db_session),
    after: int | None = Query(default=None, ge=1, description="Return events with id > after."),
    limit: int = Query(default=100, ge=1, le=1000),
) -> ExecutionEventPage:
    events = await get_execution_events(session, execution_id, after=after, limit=limit)
    if events is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Execution not found.")

    # A full page means there may be more; a short page means we've caught
    # up to the end of the log — that's the signal a caller polling this
    # endpoint (e.g. to tail a running execution) uses to know when to stop.
    next_cursor = events[-1].id if len(events) == limit else None
    return ExecutionEventPage(
        events=[
            ExecutionEventResponse(
                id=event.id,
                eventType=event.event_type,
                taskId=event.task_key,
                payload=event.payload,
                createdAt=event.created_at,
            )
            for event in events
        ],
        nextCursor=next_cursor,
    )


@router.post("/{execution_id}/cancel", response_model=ExecutionSubmissionResponse)
async def cancel_execution_route(
    execution_id: uuid.UUID, session: AsyncSession = Depends(get_db_session)
) -> ExecutionSubmissionResponse:
    """Idempotent: cancelling an already-cancelled execution returns 200, not an error."""
    outcome = await cancel_execution(session, execution_id)

    if outcome is CancelOutcome.EXECUTION_NOT_FOUND:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Execution not found.")
    if outcome is CancelOutcome.EXECUTION_ALREADY_TERMINAL:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Execution has already finished and cannot be cancelled.",
        )

    execution = await get_execution_by_id(session, execution_id)
    assert execution is not None
    return ExecutionSubmissionResponse(executionId=execution_id, state=execution.state)


@router.post("/{execution_id}/tasks/{task_id}/retry", response_model=ExecutionSubmissionResponse)
async def retry_task_route(
    execution_id: uuid.UUID, task_id: str, session: AsyncSession = Depends(get_db_session)
) -> ExecutionSubmissionResponse:
    outcome = await retry_task(session, execution_id, task_id)

    if outcome in (RetryOutcome.EXECUTION_NOT_FOUND, RetryOutcome.TASK_NOT_FOUND):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found.")
    if outcome is RetryOutcome.TASK_NOT_FAILED:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="Only a FAILED task can be retried."
        )

    execution = await get_execution_by_id(session, execution_id)
    assert execution is not None
    return ExecutionSubmissionResponse(executionId=execution_id, state=execution.state)


def _issues_detail(issues: list[ValidationIssue]) -> list[dict[str, Any]]:
    return [
        {"code": issue.code.value, "message": issue.message, "taskId": issue.task_id}
        for issue in issues
    ]
