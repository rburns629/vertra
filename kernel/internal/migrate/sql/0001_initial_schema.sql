-- SPDX-License-Identifier: MIT
-- Every table at the first public release: what Alembic's 0001 created, so
-- an install migrated by Alembic is already here (see migrate.go).

CREATE TABLE executions (
    id uuid NOT NULL PRIMARY KEY,
    external_reference text NOT NULL,
    idempotency_key text NOT NULL UNIQUE,
    state varchar(20) NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE execution_tasks (
    id uuid NOT NULL PRIMARY KEY,
    execution_id uuid NOT NULL REFERENCES executions (id) ON DELETE CASCADE,
    task_key text NOT NULL,
    image text NOT NULL,
    action text NOT NULL,
    team text NOT NULL,
    service_account text NOT NULL,
    secret_refs text[] NOT NULL DEFAULT '{}',
    resources jsonb,
    state varchar(20) NOT NULL,
    original_inputs jsonb NOT NULL,
    resolved_inputs jsonb,
    timeout_seconds integer NOT NULL,
    max_attempts integer NOT NULL,
    attempt_count integer NOT NULL,
    dispatch_failures integer NOT NULL DEFAULT 0,
    lease_owner text,
    lease_expires_at timestamptz,
    available_at timestamptz NOT NULL DEFAULT now(),
    executor_handle jsonb,
    failure jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_execution_tasks_execution_id_task_key UNIQUE (execution_id, task_key)
);
CREATE INDEX ix_execution_tasks_execution_id ON execution_tasks (execution_id);
CREATE INDEX ix_execution_tasks_state_available_at ON execution_tasks (state, available_at);

CREATE TABLE execution_events (
    id bigserial NOT NULL PRIMARY KEY,
    execution_id uuid NOT NULL REFERENCES executions (id) ON DELETE CASCADE,
    task_id uuid REFERENCES execution_tasks (id) ON DELETE CASCADE,
    event_type text NOT NULL,
    payload jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_execution_events_execution_id ON execution_events (execution_id);

CREATE TABLE task_attempts (
    id uuid NOT NULL PRIMARY KEY,
    task_id uuid NOT NULL REFERENCES execution_tasks (id) ON DELETE CASCADE,
    attempt_number integer NOT NULL,
    executor_handle jsonb,
    started_at timestamptz,
    completed_at timestamptz,
    failure jsonb,
    CONSTRAINT uq_task_attempts_task_id_attempt_number UNIQUE (task_id, attempt_number)
);
CREATE INDEX ix_task_attempts_task_id ON task_attempts (task_id);

CREATE TABLE task_dependencies (
    task_id uuid NOT NULL REFERENCES execution_tasks (id) ON DELETE CASCADE,
    depends_on_task_id uuid NOT NULL REFERENCES execution_tasks (id) ON DELETE CASCADE,
    PRIMARY KEY (task_id, depends_on_task_id)
);
CREATE INDEX ix_task_dependencies_depends_on_task_id ON task_dependencies (depends_on_task_id);

CREATE TABLE task_logs (
    task_id uuid NOT NULL PRIMARY KEY REFERENCES execution_tasks (id) ON DELETE CASCADE,
    lines text[] NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE task_outputs (
    task_id uuid NOT NULL PRIMARY KEY REFERENCES execution_tasks (id) ON DELETE CASCADE,
    outputs jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
