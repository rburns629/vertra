# SPDX-License-Identifier: MIT
"""Resolves ``$fromTask``/``$output`` markers in a task's inputs into literal values.

This is the mechanism that actually moves a value from one task to
another — DAG validation only checked that a reference was *legal*; this is
what makes it real. Two layers:

- ``resolve_inputs`` is pure: given a task's original inputs and a mapping
  of upstream ``task_key -> outputs``, it returns the same shape with every
  reference marker replaced by the literal value it points to. No I/O,
  fully unit-testable.
- ``resolve_task_inputs`` is the thin database-aware wrapper the scheduler
  calls: it fetches the persisted outputs of a task's direct dependencies
  and applies ``resolve_inputs``.
"""

from collections.abc import Mapping
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.contracts.task import try_parse_input_reference
from app.domain.errors import MissingOutputError
from app.persistence.models import ExecutionTask, TaskDependency, TaskOutput


def resolve_inputs(
    inputs: Mapping[str, Any], outputs_by_task_key: Mapping[str, Mapping[str, Any]]
) -> dict[str, Any]:
    """Recursively replace every reference marker in ``inputs`` with a literal value.

    Raises ``MissingOutputError`` if a reference points at a task with no
    entry in ``outputs_by_task_key``, or whose outputs don't contain the
    named key.
    """
    return {key: _resolve_value(value, outputs_by_task_key) for key, value in inputs.items()}


def _resolve_value(value: object, outputs_by_task_key: Mapping[str, Mapping[str, Any]]) -> Any:
    reference = try_parse_input_reference(value)
    if reference is not None:
        upstream_outputs = outputs_by_task_key.get(reference.from_task, {})
        if reference.output not in upstream_outputs:
            raise MissingOutputError(reference.from_task, reference.output)
        return upstream_outputs[reference.output]
    if isinstance(value, dict):
        return {
            key: _resolve_value(nested, outputs_by_task_key) for key, nested in value.items()
        }
    if isinstance(value, list):
        return [_resolve_value(nested, outputs_by_task_key) for nested in value]
    return value


async def resolve_task_inputs(session: AsyncSession, task: ExecutionTask) -> dict[str, Any]:
    """Resolve ``task.original_inputs`` against its direct dependencies' persisted outputs.

    Returns the resolved dict; does not write it to ``task.resolved_inputs``
    — the caller (the scheduler) decides when that happens, once resolution
    succeeds and immediately before dispatch.
    """
    result = await session.execute(
        select(ExecutionTask.task_key, TaskOutput.outputs)
        .join(TaskDependency, TaskDependency.depends_on_task_id == ExecutionTask.id)
        .join(TaskOutput, TaskOutput.task_id == ExecutionTask.id)
        .where(TaskDependency.task_id == task.id)
    )
    outputs_by_task_key: dict[str, Mapping[str, Any]] = {
        row.task_key: row.outputs for row in result.all()
    }

    return resolve_inputs(task.original_inputs, outputs_by_task_key)
