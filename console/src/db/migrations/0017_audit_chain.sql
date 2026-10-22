CREATE TABLE "audit_export" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"last_id" bigint DEFAULT 0 NOT NULL,
	"last_hash" text DEFAULT '' NOT NULL,
	"exported_at" timestamp with time zone,
	"checked_at" timestamp with time zone,
	"error" text
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "hash" text;