ALTER TABLE "products" ADD COLUMN "idempotent" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "max_attempts" integer DEFAULT 1 NOT NULL;