# SPDX-License-Identifier: MIT
"""A task's Pod size: validation, defaults, and what reaches the Pod spec."""

from typing import Any

import pytest
from pydantic import ValidationError

from app.contracts.task import TaskDefinition, TaskResources
from app.executors.base import ResolvedTask
from app.executors.kubernetes import KubernetesExecutor


def _task(resources: TaskResources | None) -> ResolvedTask:
    return ResolvedTask(
        execution_id="00000000-0000-0000-0000-000000000001",
        task_key="step",
        image="hello:1",
        action="greet",
        attempt=1,
        timeout_seconds=60,
        team="team-a",
        service_account="default",
        resources=resources,
    )


def _requirements(executor: KubernetesExecutor, task: ResolvedTask) -> Any:
    return executor._resource_requirements(task)


def _executor(default: TaskResources | None = None) -> KubernetesExecutor:
    return KubernetesExecutor(batch_api=object(), core_api=object(), default_resources=default)


def test_a_task_definition_accepts_kubernetes_quantities() -> None:
    task = TaskDefinition.model_validate(
        {
            "id": "t", "image": "i", "action": "a", "team": "t", "serviceAccount": "default",
            "resources": {"cpu": "250m", "memory": "512Mi", "memoryLimit": "1Gi"},
        }
    )
    assert task.resources == TaskResources(cpu="250m", memory="512Mi", memoryLimit="1Gi")


@pytest.mark.parametrize("bad", ["lots", "512 MiB", "-1", "1Gb", ""])
def test_anything_else_is_refused(bad: str) -> None:
    with pytest.raises(ValidationError):
        TaskResources(memory=bad)


def test_requests_come_from_the_task_with_memory_capped_at_its_request() -> None:
    requirements = _requirements(_executor(), _task(TaskResources(cpu="50m", memory="64Mi")))
    assert requirements.requests == {"cpu": "50m", "memory": "64Mi"}
    assert requirements.limits == {"memory": "64Mi"}


def test_cpu_is_never_limited_so_a_step_can_use_spare_cpu() -> None:
    requirements = _requirements(_executor(), _task(TaskResources(cpu="1")))
    assert requirements.requests == {"cpu": "1"}
    assert requirements.limits is None


def test_an_explicit_memory_limit_lets_memory_burst_above_the_request() -> None:
    requirements = _requirements(
        _executor(), _task(TaskResources(memory="256Mi", memoryLimit="1Gi"))
    )
    assert requirements.limits == {"memory": "1Gi"}


def test_the_deployment_default_fills_what_the_task_leaves_out() -> None:
    executor = _executor(TaskResources(cpu="100m", memory="256Mi"))
    requirements = _requirements(executor, _task(TaskResources(cpu="2")))
    assert requirements.requests == {"cpu": "2", "memory": "256Mi"}


def test_with_no_size_anywhere_the_pod_requests_nothing() -> None:
    assert _requirements(_executor(), _task(None)) is None
