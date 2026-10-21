-- Audiences a task's Pod gets a projected ServiceAccount token for
-- (proto/vertra/kernel/v1: Task.token_audiences).
ALTER TABLE execution_tasks ADD COLUMN token_audiences text[] NOT NULL DEFAULT '{}';
