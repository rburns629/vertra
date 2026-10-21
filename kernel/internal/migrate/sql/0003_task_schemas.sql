-- The product's input and output schemas a task's values are checked
-- against (proto/vertra/kernel/v1: Task.input_schema, Task.output_schema);
-- NULL: not checked.
ALTER TABLE execution_tasks ADD COLUMN input_schema jsonb, ADD COLUMN output_schema jsonb;
