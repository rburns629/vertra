ALTER TABLE "users" ALTER COLUMN "email_kinds" SET DEFAULT '{run_failed,approval_waiting,product_not_ready,catalog_failing,step_refused,platform_alert}'::text[];--> statement-breakpoint
-- The new kinds are nobody's choice yet: everyone gets them by email, as a new account does.
UPDATE "users" SET "email_kinds" = array(SELECT DISTINCT unnest("email_kinds" || '{step_refused,platform_alert}'::text[]));
