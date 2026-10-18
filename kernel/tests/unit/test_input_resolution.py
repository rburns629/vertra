# SPDX-License-Identifier: MIT
"""Unit tests for app.scheduler.input_resolution.resolve_inputs — pure, no I/O."""

import pytest

from app.domain.errors import MissingOutputError
from app.scheduler.input_resolution import resolve_inputs


def ref(from_task: str, output: str) -> dict[str, str]:
    return {"$fromTask": from_task, "$output": output}


class TestResolveInputs:
    def test_literal_values_pass_through_unchanged(self) -> None:
        inputs = {"projectName": "demo-project", "replicas": 3, "tags": ["blue", "green"]}
        assert resolve_inputs(inputs, {}) == inputs

    def test_top_level_reference_is_substituted(self) -> None:
        inputs = {"projectId": ref("create-project", "projectId")}
        outputs = {"create-project": {"projectId": "demo-project-123"}}
        assert resolve_inputs(inputs, outputs) == {"projectId": "demo-project-123"}

    def test_reference_nested_in_dict_is_substituted(self) -> None:
        inputs = {"config": {"project": ref("create-project", "projectId")}}
        outputs = {"create-project": {"projectId": "demo-project-123"}}
        assert resolve_inputs(inputs, outputs) == {"config": {"project": "demo-project-123"}}

    def test_reference_nested_in_list_is_substituted(self) -> None:
        inputs = {"ids": [ref("create-project", "projectId"), "literal-id"]}
        outputs = {"create-project": {"projectId": "demo-project-123"}}
        assert resolve_inputs(inputs, outputs) == {"ids": ["demo-project-123", "literal-id"]}

    def test_multiple_references_are_all_substituted(self) -> None:
        inputs = {
            "projectId": ref("create-project", "projectId"),
            "region": ref("create-project", "region"),
        }
        outputs = {"create-project": {"projectId": "demo-project-123", "region": "us-east-1"}}
        assert resolve_inputs(inputs, outputs) == {
            "projectId": "demo-project-123",
            "region": "us-east-1",
        }

    def test_reference_to_missing_output_key_raises(self) -> None:
        inputs = {"projectId": ref("create-project", "projectId")}
        outputs = {"create-project": {"unrelatedOutput": "x"}}
        with pytest.raises(MissingOutputError) as exc_info:
            resolve_inputs(inputs, outputs)
        assert exc_info.value.task_id == "create-project"
        assert exc_info.value.output_name == "projectId"

    def test_reference_to_task_with_no_outputs_at_all_raises(self) -> None:
        inputs = {"projectId": ref("create-project", "projectId")}
        with pytest.raises(MissingOutputError) as exc_info:
            resolve_inputs(inputs, {})
        assert exc_info.value.task_id == "create-project"
        assert exc_info.value.output_name == "projectId"

    def test_empty_inputs_resolve_to_empty(self) -> None:
        assert resolve_inputs({}, {}) == {}
