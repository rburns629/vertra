# SPDX-License-Identifier: MIT
"""Deployment-wide placement of step Pods (Spot capacity and the like).

The Job is built with stub API clients, then serialized the way the
Kubernetes client serializes a request body, to check what the API server
would receive.
"""

from types import SimpleNamespace
from typing import Any

import pytest
from kubernetes import client
from pydantic import ValidationError

from app.config import Settings
from app.executors.base import ResolvedTask
from app.executors.kubernetes import KubernetesExecutor

SPOT_TOLERATION = {
    "key": "kubernetes.azure.com/scalesetpriority",
    "operator": "Equal",
    "value": "spot",
    "effect": "NoSchedule",
}
PREFER_SPOT = {
    "nodeAffinity": {
        "preferredDuringSchedulingIgnoredDuringExecution": [
            {
                "weight": 100,
                "preference": {
                    "matchExpressions": [
                        {"key": "cloud.google.com/gke-spot", "operator": "In", "values": ["true"]}
                    ]
                },
            }
        ]
    }
}


class _CapturingBatchApi:
    def __init__(self) -> None:
        self.jobs: list[Any] = []

    def create_namespaced_job(self, namespace: str, body: Any, **_: object) -> SimpleNamespace:
        self.jobs.append(body)
        return SimpleNamespace(metadata=SimpleNamespace(uid="uid-1"))


class _AcceptingCoreApi:
    def create_namespaced_config_map(self, namespace: str, body: object, **_: object) -> None:
        return None


def _task() -> ResolvedTask:
    return ResolvedTask(
        execution_id="00000000-0000-0000-0000-000000000001",
        task_key="step", image="hello:1", action="greet", attempt=1,
        timeout_seconds=60, team="team-a", service_account="default",
    )


async def _pod_spec(executor: KubernetesExecutor, batch: _CapturingBatchApi) -> dict[str, Any]:
    await executor.start(_task())
    serialized: dict[str, Any] = client.ApiClient().sanitize_for_serialization(batch.jobs[0])
    spec: dict[str, Any] = serialized["spec"]["template"]["spec"]
    return spec


async def test_placement_reaches_every_step_pod_as_written() -> None:
    batch = _CapturingBatchApi()
    executor = KubernetesExecutor(
        batch_api=batch,
        core_api=_AcceptingCoreApi(),
        node_selector={"karpenter.sh/capacity-type": "spot"},
        tolerations=[SPOT_TOLERATION],
        affinity=PREFER_SPOT,
    )
    spec = await _pod_spec(executor, batch)
    assert spec["nodeSelector"] == {"karpenter.sh/capacity-type": "spot"}
    assert spec["tolerations"] == [SPOT_TOLERATION]
    assert spec["affinity"] == PREFER_SPOT


async def test_without_placement_the_pod_spec_says_nothing_about_it() -> None:
    batch = _CapturingBatchApi()
    spec = await _pod_spec(KubernetesExecutor(batch_api=batch, core_api=_AcceptingCoreApi()), batch)
    assert "nodeSelector" not in spec
    assert "tolerations" not in spec
    assert "affinity" not in spec


def test_settings_read_placement_from_json(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TASK_NODE_SELECTOR", '{"cloud.google.com/gke-spot": "true"}')
    monkeypatch.setenv(
        "TASK_TOLERATIONS",
        '[{"key": "spot", "operator": "Exists", "effect": "NoSchedule", "tolerationSeconds": 30}]',
    )
    settings = Settings()
    assert settings.task_node_selector == {"cloud.google.com/gke-spot": "true"}
    dumped = [t.model_dump(by_alias=True, exclude_none=True) for t in settings.task_tolerations]
    assert dumped == [
        {"key": "spot", "operator": "Exists", "effect": "NoSchedule", "tolerationSeconds": 30}
    ]


def test_a_misspelt_toleration_stops_the_scheduler_at_startup(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("TASK_TOLERATIONS", '[{"key": "spot", "efect": "NoSchedule"}]')
    with pytest.raises(ValidationError):
        Settings()
