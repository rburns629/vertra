# SPDX-License-Identifier: MIT
"""SQLAlchemy ORM models for the six execution-kernel tables.

State columns use ``native_enum=False`` (a plain VARCHAR with a CHECK
constraint) rather than a Postgres ``ENUM`` type, so adding a new state
later is an ordinary migration instead of ``ALTER TYPE ... ADD VALUE``
(which historically couldn't run inside a transaction and complicates
rollbacks).
"""

import uuid
from datetime import datetime
from enum import StrEnum
from typing import Any

from sqlalchemy import (
    BigInteger,
    DateTime,
    Enum,
    ForeignKey,
    Index,
    Integer,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.domain.states import ExecutionState, TaskState
from app.persistence.database import Base


def _enum_column(enum_cls: type[StrEnum], *, length: int = 20) -> Enum:
    return Enum(
        enum_cls,
        native_enum=False,
        length=length,
        validate_strings=True,
        values_callable=lambda cls: [member.value for member in cls],
    )


class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )


class Execution(TimestampMixin, Base):
    """One execution submission: an execution-request-shaped, already-validated DAG."""

    __tablename__ = "executions"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    external_reference: Mapped[str] = mapped_column(Text, nullable=False)
    idempotency_key: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    state: Mapped[ExecutionState] = mapped_column(
        _enum_column(ExecutionState), nullable=False, default=ExecutionState.PENDING
    )

    tasks: Mapped[list["ExecutionTask"]] = relationship(
        back_populates="execution", cascade="all, delete-orphan"
    )
    events: Mapped[list["ExecutionEvent"]] = relationship(
        back_populates="execution", cascade="all, delete-orphan"
    )


class ExecutionTask(TimestampMixin, Base):
    """One task within an execution's DAG, including its current claim/lease state."""

    __tablename__ = "execution_tasks"
    __table_args__ = (
        UniqueConstraint(
            "execution_id", "task_key", name="uq_execution_tasks_execution_id_task_key"
        ),
        Index("ix_execution_tasks_state_available_at", "state", "available_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    execution_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("executions.id", ondelete="CASCADE"), nullable=False, index=True
    )
    task_key: Mapped[str] = mapped_column(Text, nullable=False)
    image: Mapped[str] = mapped_column(Text, nullable=False)
    action: Mapped[str] = mapped_column(Text, nullable=False)
    # See TaskDefinition (app/contracts/task.py) for what these drive at
    # dispatch time — persisted here so a scheduler restart, or a poll
    # against a task claimed in an earlier tick, doesn't need the original
    # submission payload to know which namespace/ServiceAccount a RUNNING
    # task's Job actually lives under.
    team: Mapped[str] = mapped_column(Text, nullable=False)
    service_account: Mapped[str] = mapped_column(Text, nullable=False)
    # Kubernetes Secret names to mount into this task's Pod -- see
    # TaskDefinition (app/contracts/task.py) for the authorization story.
    secret_refs: Mapped[list[str]] = mapped_column(
        ARRAY(Text), nullable=False, default=list, server_default="{}"
    )
    # The task's own Pod size, as submitted (TaskResources, by alias), or
    # null for the deployment's defaults.
    resources: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)
    state: Mapped[TaskState] = mapped_column(
        _enum_column(TaskState), nullable=False, default=TaskState.BLOCKED
    )

    original_inputs: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, default=dict)
    resolved_inputs: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)

    timeout_seconds: Mapped[int] = mapped_column(Integer, nullable=False)
    max_attempts: Mapped[int] = mapped_column(Integer, nullable=False)
    attempt_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    # Starts of the current attempt that raised in a row (an API timeout, a
    # lost response). Each one retries the same attempt, so the same Job name,
    # adopting whatever the failed start left; past the scheduler's limit the
    # attempt fails. Back to 0 once a start succeeds.
    dispatch_failures: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0"
    )

    lease_owner: Mapped[str | None] = mapped_column(Text, nullable=True)
    lease_expires_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    available_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    executor_handle: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)
    failure: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)

    execution: Mapped["Execution"] = relationship(back_populates="tasks")
    attempts: Mapped[list["TaskAttempt"]] = relationship(
        back_populates="task", cascade="all, delete-orphan"
    )
    output: Mapped["TaskOutput | None"] = relationship(
        back_populates="task", cascade="all, delete-orphan", uselist=False
    )
    log: Mapped["TaskLog | None"] = relationship(
        back_populates="task", cascade="all, delete-orphan", uselist=False
    )


class TaskDependency(Base):
    """A directed edge: `task_id` depends on `depends_on_task_id`.

    Normalized (rather than a JSON array on ExecutionTask) so dependency
    resolution — "have all of this task's dependencies succeeded?" — is a
    plain join instead of scanning JSON.
    """

    __tablename__ = "task_dependencies"
    __table_args__ = (Index("ix_task_dependencies_depends_on_task_id", "depends_on_task_id"),)

    task_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("execution_tasks.id", ondelete="CASCADE"), primary_key=True
    )
    depends_on_task_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("execution_tasks.id", ondelete="CASCADE"), primary_key=True
    )


class TaskAttempt(Base):
    """The retry history for a task. `ExecutionTask.attempt_count` is the live counter."""

    __tablename__ = "task_attempts"
    __table_args__ = (
        UniqueConstraint(
            "task_id", "attempt_number", name="uq_task_attempts_task_id_attempt_number"
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    task_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("execution_tasks.id", ondelete="CASCADE"), nullable=False, index=True
    )
    attempt_number: Mapped[int] = mapped_column(Integer, nullable=False)
    executor_handle: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    failure: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)

    task: Mapped["ExecutionTask"] = relationship(back_populates="attempts")


class TaskOutput(Base):
    """A task's persisted outputs. One row per task — a retry simply overwrites it.

    Only a succeeded attempt's outputs are ever meaningful to downstream
    tasks, so this is keyed by task, not by attempt.
    """

    __tablename__ = "task_outputs"

    task_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("execution_tasks.id", ondelete="CASCADE"), primary_key=True
    )
    outputs: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    task: Mapped["ExecutionTask"] = relationship(back_populates="output")


class TaskLog(Base):
    """A task's captured container output (stdout/stderr, combined -- see
    KubernetesExecutor._read_logs). One row per task, overwritten on each
    attempt's completion, same reasoning as TaskOutput: only the current
    attempt's log is what a debugging view should reflect.

    This exists specifically because the underlying evidence disappears
    fast otherwise: the scheduler deletes a task's Job/Pod immediately on
    completion (see KubernetesExecutor.get_status), and even the executor's
    own in-memory cache of a just-finished task's logs is lost the moment
    the scheduler process restarts. Persisting here is what makes "view
    this task's real output" still work an hour, a day, or a scheduler
    restart later -- not just while the original Pod happens to still be
    alive.
    """

    __tablename__ = "task_logs"

    task_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("execution_tasks.id", ondelete="CASCADE"), primary_key=True
    )
    lines: Mapped[list[str]] = mapped_column(ARRAY(Text), nullable=False, default=list)
    # When these lines were captured: refreshed while the task runs (the
    # scheduler's log_refresh), and once more when it ends.
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    task: Mapped["ExecutionTask"] = relationship(back_populates="log")


class ExecutionEvent(Base):
    """An append-only, strictly-ordered log of everything that happened to an execution."""

    __tablename__ = "execution_events"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    execution_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("executions.id", ondelete="CASCADE"), nullable=False, index=True
    )
    task_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("execution_tasks.id", ondelete="CASCADE"), nullable=True
    )
    event_type: Mapped[str] = mapped_column(Text, nullable=False)
    payload: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    execution: Mapped["Execution"] = relationship(back_populates="events")
