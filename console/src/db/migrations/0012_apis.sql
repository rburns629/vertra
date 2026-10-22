CREATE TABLE "apis" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"name" text NOT NULL,
	"display_name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"openapi" jsonb NOT NULL,
	"backend_url" text NOT NULL,
	"backend_auth" jsonb,
	"service_account" text NOT NULL,
	"share_with" text[] DEFAULT '{}'::text[] NOT NULL,
	"hidden" boolean DEFAULT false NOT NULL,
	"deprecated" text,
	"internet" boolean DEFAULT false NOT NULL,
	"per_minute" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"timeout_seconds" integer DEFAULT 30 NOT NULL,
	"max_request_bytes" integer DEFAULT 1048576 NOT NULL,
	"source_path" text,
	"paused_message" text,
	"paused_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "apis_team_id_name_unique" UNIQUE("team_id","name")
);
--> statement-breakpoint
ALTER TABLE "apis" ADD CONSTRAINT "apis_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apis" ADD CONSTRAINT "apis_paused_by_users_id_fk" FOREIGN KEY ("paused_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;