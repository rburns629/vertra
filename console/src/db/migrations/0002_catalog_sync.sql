CREATE TABLE "catalog_sync" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"digest" text,
	"commit" text,
	"repository" text,
	"applied_at" timestamp with time zone,
	"problems" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"checked_at" timestamp with time zone,
	"error" text
);
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "from_catalog" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "from_catalog" boolean DEFAULT false NOT NULL;