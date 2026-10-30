-- Stored submissions from before the rename say externalReference and
-- idempotencyKey: renamed to name and requestId, so nothing reads the old
-- names any more. A row that already has a new name keeps it.
UPDATE "submitted_executions"
SET "payload" = ("payload" - 'externalReference' - 'idempotencyKey')
  || CASE WHEN "payload" ? 'externalReference' AND NOT "payload" ? 'name'
       THEN jsonb_build_object('name', "payload" -> 'externalReference') ELSE '{}'::jsonb END
  || CASE WHEN "payload" ? 'idempotencyKey' AND NOT "payload" ? 'requestId'
       THEN jsonb_build_object('requestId', "payload" -> 'idempotencyKey') ELSE '{}'::jsonb END
WHERE jsonb_typeof("payload") = 'object'
  AND ("payload" ? 'externalReference' OR "payload" ? 'idempotencyKey');
