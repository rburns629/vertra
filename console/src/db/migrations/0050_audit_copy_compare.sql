ALTER TABLE "audit_export" ADD COLUMN "compared_through" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_export" ADD COLUMN "compared_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "audit_export" ADD COLUMN "differs_at" bigint;--> statement-breakpoint
ALTER TABLE "audit_export" ADD COLUMN "compare_problem" text;