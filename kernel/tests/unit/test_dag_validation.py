# SPDX-License-Identifier: MIT
"""Unit tests for app.domain.dag_validation — pure DAG validation, no I/O."""

from typing import Any

import pytest

from app.contracts.task import TaskDefinition
from app.domain.dag_validation import validate_dag
from app.domain.errors import DAGValidationError, ValidationIssueCode


def make_task(
    task_id: str,
    depends_on: list[str] | None = None,
    inputs: dict[str, Any] | None = None,
) -> TaskDefinition:
    return TaskDefinition(
        id=task_id,
        image=f"{task_id}:local",
        action="create",
        dependsOn=depends_on or [],
        inputs=inputs or {},
        team="test-team",
        serviceAccount="default",
    )


def ref(from_task: str, output: str) -> dict[str, str]:
    return {"$fromTask": from_task, "$output": output}


def issue_codes(error: DAGValidationError) -> set[ValidationIssueCode]:
    return {issue.code for issue in error.issues}


class TestHappyPath:
    def test_two_task_chain_resolves_in_order(self) -> None:
        tasks = [
            make_task("create-project"),
            make_task(
                "deploy-application",
                depends_on=["create-project"],
                inputs={"projectId": ref("create-project", "projectId")},
            ),
        ]
        assert validate_dag(tasks) == ["create-project", "deploy-application"]

    def test_independent_tasks_preserve_submission_order(self) -> None:
        tasks = [make_task("a"), make_task("b"), make_task("c")]
        assert validate_dag(tasks) == ["a", "b", "c"]

    def test_diamond_dependency_is_deterministic(self) -> None:
        # b and c are both only dependent on a and mutually independent;
        # submission order (b before c) must break the tie every time.
        tasks = [
            make_task("a"),
            make_task("b", depends_on=["a"]),
            make_task("c", depends_on=["a"]),
            make_task("d", depends_on=["b", "c"]),
        ]
        assert validate_dag(tasks) == ["a", "b", "c", "d"]

    def test_reordered_submission_changes_tie_break_but_stays_valid(self) -> None:
        tasks = [
            make_task("a"),
            make_task("c", depends_on=["a"]),
            make_task("b", depends_on=["a"]),
            make_task("d", depends_on=["b", "c"]),
        ]
        assert validate_dag(tasks) == ["a", "c", "b", "d"]

    def test_nested_input_reference_is_valid(self) -> None:
        tasks = [
            make_task("create-project"),
            make_task(
                "deploy-application",
                depends_on=["create-project"],
                inputs={"config": {"nested": [ref("create-project", "projectId")]}},
            ),
        ]
        order = validate_dag(tasks)
        assert order == ["create-project", "deploy-application"]

    def test_literal_inputs_alongside_references_are_untouched(self) -> None:
        tasks = [
            make_task("create-project"),
            make_task(
                "deploy-application",
                depends_on=["create-project"],
                inputs={
                    "projectId": ref("create-project", "projectId"),
                    "replicas": 3,
                    "tags": ["blue", "green"],
                },
            ),
        ]
        assert validate_dag(tasks) == ["create-project", "deploy-application"]


class TestEmptyAndSize:
    def test_empty_dag_is_rejected(self) -> None:
        with pytest.raises(DAGValidationError) as exc_info:
            validate_dag([])
        assert issue_codes(exc_info.value) == {ValidationIssueCode.EMPTY_DAG}

    def test_max_task_count_is_enforced(self) -> None:
        tasks = [make_task(f"t{i}") for i in range(3)]
        with pytest.raises(DAGValidationError) as exc_info:
            validate_dag(tasks, max_tasks=2)
        assert ValidationIssueCode.MAX_TASK_COUNT_EXCEEDED in issue_codes(exc_info.value)

    def test_task_count_at_the_limit_is_allowed(self) -> None:
        tasks = [make_task(f"t{i}") for i in range(2)]
        assert validate_dag(tasks, max_tasks=2) == ["t0", "t1"]


class TestStructuralErrors:
    def test_duplicate_task_id_is_rejected(self) -> None:
        tasks = [make_task("a"), make_task("a")]
        with pytest.raises(DAGValidationError) as exc_info:
            validate_dag(tasks)
        assert ValidationIssueCode.DUPLICATE_TASK_ID in issue_codes(exc_info.value)

    def test_unknown_dependency_is_rejected(self) -> None:
        tasks = [make_task("a", depends_on=["does-not-exist"])]
        with pytest.raises(DAGValidationError) as exc_info:
            validate_dag(tasks)
        assert ValidationIssueCode.UNKNOWN_DEPENDENCY in issue_codes(exc_info.value)

    def test_self_dependency_is_rejected(self) -> None:
        tasks = [make_task("a", depends_on=["a"])]
        with pytest.raises(DAGValidationError) as exc_info:
            validate_dag(tasks)
        assert ValidationIssueCode.SELF_DEPENDENCY in issue_codes(exc_info.value)

    def test_a_dependency_listed_twice_is_rejected(self) -> None:
        tasks = [make_task("a"), make_task("b", depends_on=["a", "a"])]
        with pytest.raises(DAGValidationError) as exc_info:
            validate_dag(tasks)
        assert issue_codes(exc_info.value) == {ValidationIssueCode.DUPLICATE_DEPENDENCY}

    def test_direct_cycle_is_detected(self) -> None:
        tasks = [make_task("a", depends_on=["b"]), make_task("b", depends_on=["a"])]
        with pytest.raises(DAGValidationError) as exc_info:
            validate_dag(tasks)
        assert ValidationIssueCode.CYCLE_DETECTED in issue_codes(exc_info.value)

    def test_indirect_cycle_is_detected(self) -> None:
        tasks = [
            make_task("a", depends_on=["c"]),
            make_task("b", depends_on=["a"]),
            make_task("c", depends_on=["b"]),
        ]
        with pytest.raises(DAGValidationError) as exc_info:
            validate_dag(tasks)
        assert ValidationIssueCode.CYCLE_DETECTED in issue_codes(exc_info.value)

    def test_cycle_with_a_healthy_branch_still_reports_the_cycle(self) -> None:
        tasks = [
            make_task("healthy"),
            make_task("a", depends_on=["b"]),
            make_task("b", depends_on=["a"]),
        ]
        with pytest.raises(DAGValidationError) as exc_info:
            validate_dag(tasks)
        assert ValidationIssueCode.CYCLE_DETECTED in issue_codes(exc_info.value)

    def test_multiple_issues_are_reported_together(self) -> None:
        tasks = [
            make_task("a", depends_on=["a"]),
            make_task("b", depends_on=["missing"]),
        ]
        with pytest.raises(DAGValidationError) as exc_info:
            validate_dag(tasks)
        codes = issue_codes(exc_info.value)
        assert ValidationIssueCode.SELF_DEPENDENCY in codes
        assert ValidationIssueCode.UNKNOWN_DEPENDENCY in codes


class TestInputReferenceValidation:
    def test_reference_to_unknown_task_is_rejected(self) -> None:
        tasks = [
            make_task("a"),
            make_task("b", depends_on=["a"], inputs={"x": ref("ghost", "y")}),
        ]
        with pytest.raises(DAGValidationError) as exc_info:
            validate_dag(tasks)
        assert ValidationIssueCode.UNKNOWN_INPUT_REFERENCE_TASK in issue_codes(exc_info.value)

    def test_reference_to_non_upstream_task_is_rejected(self) -> None:
        # "b" exists in the DAG, but "c" never declared it in dependsOn.
        tasks = [
            make_task("a"),
            make_task("b"),
            make_task("c", depends_on=["a"], inputs={"x": ref("b", "y")}),
        ]
        with pytest.raises(DAGValidationError) as exc_info:
            validate_dag(tasks)
        assert ValidationIssueCode.NON_UPSTREAM_INPUT_REFERENCE in issue_codes(exc_info.value)

    def test_reference_to_self_is_rejected_as_non_upstream(self) -> None:
        tasks = [make_task("a", inputs={"x": ref("a", "y")})]
        with pytest.raises(DAGValidationError) as exc_info:
            validate_dag(tasks)
        assert ValidationIssueCode.NON_UPSTREAM_INPUT_REFERENCE in issue_codes(exc_info.value)

    def test_reference_to_a_direct_dependency_is_valid(self) -> None:
        tasks = [
            make_task("a"),
            make_task("b", depends_on=["a"], inputs={"x": ref("a", "y")}),
        ]
        assert validate_dag(tasks) == ["a", "b"]
