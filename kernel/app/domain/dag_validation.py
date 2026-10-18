# SPDX-License-Identifier: MIT
"""Validation of a resolved DAG prior to persistence.

These checks operate purely on submitted task definitions and touch neither
the database nor any executor. They exist so a structurally invalid DAG is
rejected before any execution or task row is created.

Two independent things are validated:

1. The dependency graph itself: unique ids, no self- or repeated dependencies, no
   references to unknown tasks, no cycles.
2. Input references (``$fromTask`` / ``$output``) within task inputs: each
   must point at a task that is *declared as a direct dependency* of the
   referencing task. A reference to a task that exists elsewhere in the DAG
   but isn't in ``dependsOn`` is rejected — a task may only read the output
   of a task it has actually waited for.
"""

from collections.abc import Sequence

from app.contracts.task import InputReference, TaskDefinition, try_parse_input_reference
from app.domain.credentials import find_credential
from app.domain.errors import DAGValidationError, ValidationIssue, ValidationIssueCode

DEFAULT_MAX_TASKS = 500


def validate_dag(
    tasks: Sequence[TaskDefinition],
    *,
    max_tasks: int = DEFAULT_MAX_TASKS,
) -> list[str]:
    """Validate a submitted task list and return a deterministic topological order.

    Raises ``DAGValidationError`` carrying every issue found (not just the
    first). Later checks that depend on a well-formed graph (cycle detection,
    input-reference scoping) are skipped once a structural issue makes the
    graph itself ambiguous, so as not to raise misleading follow-on errors.
    """
    issues: list[ValidationIssue] = []

    if not tasks:
        raise DAGValidationError(
            [
                ValidationIssue(
                    ValidationIssueCode.EMPTY_DAG,
                    "An execution must contain at least one task.",
                )
            ]
        )

    if len(tasks) > max_tasks:
        issues.append(
            ValidationIssue(
                ValidationIssueCode.MAX_TASK_COUNT_EXCEEDED,
                f"Execution contains {len(tasks)} tasks, exceeding the maximum of {max_tasks}.",
            )
        )

    duplicates = _find_duplicate_ids(tasks)
    for task_id in duplicates:
        issues.append(
            ValidationIssue(
                ValidationIssueCode.DUPLICATE_TASK_ID,
                f"Task id '{task_id}' is defined more than once.",
                task_id,
            )
        )

    if issues:
        # A duplicate id (or an oversized task list) makes id -> task lookups
        # ambiguous or pointless; every check below assumes neither is true.
        raise DAGValidationError(issues)

    known_ids = {task.id for task in tasks}
    dependency_issues = _validate_dependencies(tasks, known_ids)
    issues.extend(dependency_issues)

    if dependency_issues:
        # Cycle detection assumes every dependsOn edge points at a real,
        # distinct task; skip it rather than report a misleading cycle.
        raise DAGValidationError(issues)

    issues.extend(_validate_input_references(tasks, known_ids))
    # Inputs are stored and readable by anyone who can read the execution;
    # a step's credentials reach it as mounted secrets (secretRefs) instead.
    for task in tasks:
        credential = find_credential(task.inputs)
        if credential:
            issues.append(
                ValidationIssue(
                    ValidationIssueCode.INPUT_CONTAINS_CREDENTIAL,
                    f"Task '{task.id}' has an input that looks like a credential ({credential}). "
                    "Register it as a team secret and list it in secretRefs instead.",
                    task.id,
                )
            )

    try:
        order = topological_sort(tasks)
    except DAGValidationError as cycle_error:
        raise DAGValidationError(issues + cycle_error.issues) from None

    if issues:
        raise DAGValidationError(issues)

    return order


def topological_sort(tasks: Sequence[TaskDefinition]) -> list[str]:
    """Deterministically order tasks so every dependency precedes its dependents.

    Ties are broken by submission order (the order ``tasks`` was given in),
    so the same DAG always sorts the same way. Raises
    ``DAGValidationError(CYCLE_DETECTED)`` if the graph is not a DAG.
    """
    order_index = {task.id: index for index, task in enumerate(tasks)}
    in_degree = {task.id: 0 for task in tasks}
    dependents: dict[str, list[str]] = {task.id: [] for task in tasks}

    for task in tasks:
        for dep in task.depends_on:
            in_degree[task.id] += 1
            dependents[dep].append(task.id)

    ready = sorted(
        (task_id for task_id, degree in in_degree.items() if degree == 0),
        key=lambda task_id: order_index[task_id],
    )

    result: list[str] = []
    while ready:
        current = ready.pop(0)
        result.append(current)
        newly_ready = []
        for dependent_id in dependents[current]:
            in_degree[dependent_id] -= 1
            if in_degree[dependent_id] == 0:
                newly_ready.append(dependent_id)
        if newly_ready:
            ready.extend(newly_ready)
            ready.sort(key=lambda task_id: order_index[task_id])

    if len(result) != len(tasks):
        remaining = sorted(set(in_degree) - set(result))
        raise DAGValidationError(
            [
                ValidationIssue(
                    ValidationIssueCode.CYCLE_DETECTED,
                    f"Cycle detected involving task(s): {', '.join(remaining)}.",
                    task_id,
                )
                for task_id in remaining
            ]
        )

    return result


def _find_duplicate_ids(tasks: Sequence[TaskDefinition]) -> list[str]:
    seen: set[str] = set()
    duplicates: set[str] = set()
    for task in tasks:
        if task.id in seen:
            duplicates.add(task.id)
        seen.add(task.id)
    return sorted(duplicates)


def _validate_dependencies(
    tasks: Sequence[TaskDefinition], known_ids: set[str]
) -> list[ValidationIssue]:
    issues: list[ValidationIssue] = []
    for task in tasks:
        repeated = sorted({dep for dep in task.depends_on if task.depends_on.count(dep) > 1})
        for dep in repeated:
            issues.append(
                ValidationIssue(
                    ValidationIssueCode.DUPLICATE_DEPENDENCY,
                    f"Task '{task.id}' lists '{dep}' in dependsOn more than once.",
                    task.id,
                )
            )
        for dep in task.depends_on:
            if dep == task.id:
                issues.append(
                    ValidationIssue(
                        ValidationIssueCode.SELF_DEPENDENCY,
                        f"Task '{task.id}' cannot depend on itself.",
                        task.id,
                    )
                )
            elif dep not in known_ids:
                issues.append(
                    ValidationIssue(
                        ValidationIssueCode.UNKNOWN_DEPENDENCY,
                        f"Task '{task.id}' depends on unknown task '{dep}'.",
                        task.id,
                    )
                )
    return issues


def _validate_input_references(
    tasks: Sequence[TaskDefinition], known_ids: set[str]
) -> list[ValidationIssue]:
    issues: list[ValidationIssue] = []
    for task in tasks:
        depends_on = set(task.depends_on)
        for reference in _find_input_references(task.inputs):
            if reference.from_task not in known_ids:
                issues.append(
                    ValidationIssue(
                        ValidationIssueCode.UNKNOWN_INPUT_REFERENCE_TASK,
                        (
                            f"Task '{task.id}' references output of "
                            f"unknown task '{reference.from_task}'."
                        ),
                        task.id,
                    )
                )
            elif reference.from_task not in depends_on:
                issues.append(
                    ValidationIssue(
                        ValidationIssueCode.NON_UPSTREAM_INPUT_REFERENCE,
                        (
                            f"Task '{task.id}' references output of task '{reference.from_task}', "
                            "which is not declared in its dependsOn list."
                        ),
                        task.id,
                    )
                )
    return issues


def _find_input_references(value: object) -> list[InputReference]:
    """Recursively collect every ``$fromTask``/``$output`` reference within a task's inputs."""
    found: list[InputReference] = []
    reference = try_parse_input_reference(value)
    if reference is not None:
        found.append(reference)
    elif isinstance(value, dict):
        for nested in value.values():
            found.extend(_find_input_references(nested))
    elif isinstance(value, list):
        for nested in value:
            found.extend(_find_input_references(nested))
    return found
