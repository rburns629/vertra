-- One step per key at a time (proto/vertra/kernel/v1: Task.concurrency_key):
-- the scope and input names the console sends, and the key the scheduler
-- worked out from the resolved inputs when it claimed the step. NULL key:
-- not held by anything.
ALTER TABLE execution_tasks
  ADD COLUMN concurrency_scope text,
  ADD COLUMN concurrency_inputs text[] NOT NULL DEFAULT '{}',
  ADD COLUMN concurrency_key text;
CREATE INDEX execution_tasks_active_concurrency_key ON execution_tasks (concurrency_key)
  WHERE concurrency_key IS NOT NULL AND state IN ('CLAIMED', 'RUNNING');
