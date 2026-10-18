# SPDX-License-Identifier: MIT
"""Pydantic contracts for the result a product container writes to ``result.json``."""

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class StructuredError(BaseModel):
    """Machine-readable failure information from a product container or the executor itself."""

    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    code: str = Field(min_length=1)
    message: str = Field(min_length=1)
    retryable: bool = False


class TaskResult(BaseModel):
    """The contents of ``/platform/output/result.json`` produced by a product container.

    Also used internally to represent the outcome the executor derives when
    no result file is present (e.g. a nonzero exit with no ``result.json``),
    in which case ``error`` is synthesized from captured stderr.
    """

    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    status: Literal["succeeded", "failed"]
    outputs: dict[str, Any] = Field(default_factory=dict)
    error: StructuredError | None = None

    @model_validator(mode="after")
    def _check_error_consistency(self) -> "TaskResult":
        if self.status == "failed" and self.error is None:
            raise ValueError("A failed task result must include a structured error.")
        if self.status == "succeeded" and self.error is not None:
            raise ValueError("A succeeded task result must not include an error.")
        return self
