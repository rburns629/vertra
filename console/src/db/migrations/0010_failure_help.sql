ALTER TABLE "products" ADD COLUMN "error_help" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "contact" text;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "help_chat" text;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "help_url" text;