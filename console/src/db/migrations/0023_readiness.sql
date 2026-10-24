CREATE TABLE "product_readiness" (
	"product" text PRIMARY KEY NOT NULL,
	"product_team" text NOT NULL,
	"image" text NOT NULL,
	"state" text NOT NULL,
	"execution_id" uuid,
	"principal" text,
	"missing" text[] DEFAULT '{}'::text[] NOT NULL,
	"detail" text,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"checked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "check" text;