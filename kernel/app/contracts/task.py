# SPDX-License-Identifier: MIT
"""Pydantic contracts describing a task as submitted in an execution request."""

from typing import Any

from pydantic import BaseModel, ConfigDict, Field, ValidationError


class InputReference(BaseModel):
    """A reference to an upstream task's output, resolved by the scheduler before a task runs.

    Serialized as ``{"$fromTask": "task-id", "$output": "output-name"}``.
    """

    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    from_task: str = Field(alias="$fromTask", min_length=1)
    output: str = Field(alias="$output", min_length=1)


def try_parse_input_reference(value: object) -> InputReference | None:
    """Return an ``InputReference`` if ``value`` is shaped like a reference marker, else ``None``.

    Inputs are stored as plain JSON (``dict[str, Any]``) so they round-trip cleanly
    through JSONB. This is the single place that recognizes the reference shape
    within that JSON; both DAG validation and later input resolution use it instead
    of duplicating the shape check.
    """
    if not isinstance(value, dict) or set(value.keys()) != {"$fromTask", "$output"}:
        return None
    try:
        return InputReference.model_validate(value)
    except ValidationError:
        return None


# A Kubernetes resource quantity: "250m" or "0.5" CPU, "512Mi" or "1G" memory.
_QUANTITY = r"^[0-9]+(\.[0-9]+)?(m|k|Ki|M|Mi|G|Gi|T|Ti)?$"


class TaskResources(BaseModel):
    """CPU and memory for a task's Pod, as Kubernetes quantities.

    ``cpu`` and ``memory`` are what the Pod requests: what the cluster
    reserves for it, and what pay-per-Pod clusters such as GKE Autopilot
    bill. CPU has no limit, so a step can use spare CPU on its node. Memory
    is capped at ``memoryLimit``, or at ``memory`` when that's absent, so a
    step that leaks is stopped instead of starving its neighbours.
    """

    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    cpu: str | None = Field(default=None, pattern=_QUANTITY)
    memory: str | None = Field(default=None, pattern=_QUANTITY)
    memory_limit: str | None = Field(default=None, alias="memoryLimit", pattern=_QUANTITY)

    def over(self, defaults: "TaskResources | None") -> "TaskResources":
        """These resources, with any field left unset taken from ``defaults``."""
        if defaults is None:
            return self
        return TaskResources(
            cpu=self.cpu or defaults.cpu,
            memory=self.memory or defaults.memory,
            memoryLimit=self.memory_limit or defaults.memory_limit,
        )


class TaskDefinition(BaseModel):
    """A single task within a resolved DAG, as submitted by the upstream planner.

    ``inputs`` may contain literal JSON values and/or nested reference markers
    (see ``try_parse_input_reference``). This model does not attempt to distinguish
    them structurally, so arbitrary JSON round-trips intact.
    """

    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    id: str = Field(min_length=1)
    image: str = Field(min_length=1)
    action: str = Field(min_length=1)
    depends_on: list[str] = Field(default_factory=list, alias="dependsOn")
    inputs: dict[str, Any] = Field(default_factory=dict)
    timeout_seconds: int = Field(default=300, gt=0, alias="timeoutSeconds")
    max_attempts: int = Field(default=1, ge=1, alias="maxAttempts")
    # Which platform team owns this step, and which ServiceAccount its Pod
    # runs as — opaque identifiers to the kernel (it doesn't know or care
    # what either means), but load-bearing for KubernetesExecutor: `team`
    # becomes the dispatch namespace and `service_account` becomes the
    # Pod's serviceAccountName: the identity a cloud binding attaches to.
    # Which secrets and identity a step may have is decided by the console
    # and the identity policy (docs/security-model.md), never here.
    team: str = Field(min_length=1)
    service_account: str = Field(min_length=1, alias="serviceAccount")
    # Names of Kubernetes Secrets to mount into this task's Pod (see
    # KubernetesExecutor._create_job) -- opaque to the kernel like everything
    # else here. Whether a given name is actually *granted* to this task's
    # team is not the kernel's question to answer (it has no notion of
    # "team" beyond a dispatch namespace) -- console/'s routes/executions.ts
    # checks that against secret_grants before ever forwarding here, the
    # same place it already checks team membership.
    secret_refs: list[str] = Field(default_factory=list, alias="secretRefs")
    # The Pod's size (see TaskResources). Absent fields come from the
    # deployment's TASK_DEFAULT_RESOURCES; absent there too, the Pod
    # requests nothing and the cluster's own defaults apply.
    resources: TaskResources | None = None


class ProductRequest(BaseModel):
    """The ``request.json`` payload written to ``/platform/input/request.json``.

    By the time this is built, every ``InputReference`` in the task's declared
    inputs has already been resolved to a literal value.
    """

    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    execution_id: str = Field(alias="executionId")
    task_id: str = Field(alias="taskId")
    action: str = Field(min_length=1)
    attempt: int = Field(ge=1)
    inputs: dict[str, Any] = Field(default_factory=dict)
