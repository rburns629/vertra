-- The capacity a task's product asks for (proto/vertra/kernel/v1:
-- Task.capacity): spot or onDemand, each a placement the install sets. NULL:
-- the install's own.
ALTER TABLE execution_tasks ADD COLUMN capacity text;
