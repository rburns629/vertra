-- Who asked for each attempt and what acted in it (proto/vertra/kernel/v1:
-- TaskStatus.attempts). requested_by is the console's opaque name for a
-- person or bot ("user:<id>"); the kernel never resolves it.
ALTER TABLE executions ADD COLUMN requested_by text;
-- Set by a retry for the task's next attempt, cleared when it's claimed.
ALTER TABLE execution_tasks ADD COLUMN next_attempt_requested_by text;
ALTER TABLE task_attempts
  ADD COLUMN requested_by text,
  -- submitted, retried (by a person or bot), or automatic_retry.
  ADD COLUMN trigger text,
  -- <team>/<serviceAccount>: the identity the attempt ran as.
  ADD COLUMN acted_as text,
  ADD COLUMN image text;
