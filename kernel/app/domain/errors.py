# SPDX-License-Identifier: MIT
"""Domain-level error and validation-issue types.

These carry no HTTP or persistence concerns; the API layer is responsible
for translating them into a response shape.
"""

from dataclasses import dataclass
from enum import StrEnum


class KernelError(Exception):
    """Base class for all execution-kernel domain errors."""


class ValidationIssueCode(StrEnum):
    EMPTY_DAG = "EMPTY_DAG"
    MAX_TASK_COUNT_EXCEEDED = "MAX_TASK_COUNT_EXCEEDED"
    DUPLICATE_TASK_ID = "DUPLICATE_TASK_ID"
    UNKNOWN_DEPENDENCY = "UNKNOWN_DEPENDENCY"
    SELF_DEPENDENCY = "SELF_DEPENDENCY"
    DUPLICATE_DEPENDENCY = "DUPLICATE_DEPENDENCY"
    CYCLE_DETECTED = "CYCLE_DETECTED"
    UNKNOWN_INPUT_REFERENCE_TASK = "UNKNOWN_INPUT_REFERENCE_TASK"
    NON_UPSTREAM_INPUT_REFERENCE = "NON_UPSTREAM_INPUT_REFERENCE"
    INPUT_CONTAINS_CREDENTIAL = "INPUT_CONTAINS_CREDENTIAL"


@dataclass(frozen=True, slots=True)
class ValidationIssue:
    code: ValidationIssueCode
    message: str
    task_id: str | None = None


class DAGValidationError(KernelError):
    """Raised by ``app.domain.dag_validation.validate_dag`` with every issue found.

    All issues are collected before raising (rather than failing fast) so a
    caller — e.g. the API layer — can report a complete list of problems in
    one round trip instead of one validation error per resubmission.
    """

    def __init__(self, issues: list[ValidationIssue]) -> None:
        self.issues = issues
        summary = "; ".join(issue.message for issue in issues)
        super().__init__(f"DAG validation failed with {len(issues)} issue(s): {summary}")


class DispatchRejectedError(KernelError):
    """Raised by an executor when the cluster refuses to create a task's workload.

    A 403 from the Kubernetes API on create means a policy said no, either
    the dispatch admission policy (the task names a namespace that isn't a
    team namespace, see helm/charts/execution-kernel/templates/dispatch-policy.yaml)
    or RBAC. Retrying the same task can't change that answer, so it's a
    distinct type rather than a generic start failure. ``message`` is the
    API server's own explanation, not the client library's dump of it.
    ``code`` is ``IMAGE_NOT_ALLOWED`` when the image policy
    (helm/charts/execution-kernel/templates/image-policy.yaml) refused the task's
    image, ``IDENTITY_NOT_ALLOWED`` when the identity policy
    (identity-policy.yaml) refused its ServiceAccount or Secrets,
    ``IMAGE_NOT_SIGNED`` when signature verification did (the chart's
    imageSignature), ``IMAGE_SCAN_FAILED`` when the image's digest failed its
    security scan and ``IMAGE_NOT_PINNED`` when it isn't pinned by digest
    (scan-policy.yaml), ``DISPATCH_REJECTED`` for anything else.
    """

    def __init__(self, message: str, code: str = "DISPATCH_REJECTED") -> None:
        self.message = message
        self.code = code
        super().__init__(message)


class MissingOutputError(KernelError):
    """Raised when a task's resolved inputs reference an output an upstream task never produced.

    DAG validation already guarantees ``from_task`` is a declared dependency;
    this covers the case where that dependency ran but didn't actually emit
    the output the reference names (or a caller resolves inputs before the
    dependency has produced any outputs at all).
    """

    def __init__(self, task_id: str, output_name: str) -> None:
        self.task_id = task_id
        self.output_name = output_name
        super().__init__(f"Task '{task_id}' did not produce output '{output_name}'.")
