-- Approvals: a step that needs one waits in AWAITING_APPROVAL until a
-- maintainer of its team decides (proto/vertra/kernel/v1: DecideApproval).
-- The console decides which steps need one and who may decide; the kernel
-- holds them, records the decision and expires what nobody decided.
ALTER TABLE execution_tasks
  ADD COLUMN approval_required boolean NOT NULL DEFAULT false,
  -- Set once approved; kept across retries, so an approved step isn't asked again.
  ADD COLUMN approved_by text,
  ADD COLUMN approved_at timestamptz;
