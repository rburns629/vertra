-- At most so many of a product's steps claimed or running at once
-- (proto/vertra/kernel/v1: Task.product_cap): the product the console names,
-- and its cap. NULL scope: no cap.
ALTER TABLE execution_tasks
  ADD COLUMN cap_scope text,
  ADD COLUMN cap_limit integer NOT NULL DEFAULT 0;
CREATE INDEX execution_tasks_active_cap_scope ON execution_tasks (cap_scope)
  WHERE cap_scope IS NOT NULL AND state IN ('CLAIMED', 'RUNNING');
