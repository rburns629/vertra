ALTER TABLE "products" ADD COLUMN "share_with" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "deprecated" text;