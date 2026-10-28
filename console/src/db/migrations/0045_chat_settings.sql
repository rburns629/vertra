CREATE TABLE "chat_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"provider" text NOT NULL,
	"model" text DEFAULT '' NOT NULL,
	"endpoint" text DEFAULT '' NOT NULL,
	"vertex_project" text DEFAULT '' NOT NULL,
	"vertex_location" text DEFAULT '' NOT NULL,
	"api_key_encrypted" text,
	"effort" text DEFAULT '' NOT NULL,
	"max_steps" integer,
	"context_tokens" integer,
	"max_tokens" integer,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_settings_one_row" CHECK ("chat_settings"."id" = 1)
);
--> statement-breakpoint
ALTER TABLE "chat_settings" ADD CONSTRAINT "chat_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;