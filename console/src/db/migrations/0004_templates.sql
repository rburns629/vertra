CREATE TABLE "templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"name" text NOT NULL,
	"display_name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"parameters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"steps" jsonb NOT NULL,
	"share_with" text[] DEFAULT '{}'::text[] NOT NULL,
	"deprecated" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "templates_team_id_name_unique" UNIQUE("team_id","name")
);
--> statement-breakpoint
ALTER TABLE "submitted_executions" ADD COLUMN "template" text;--> statement-breakpoint
ALTER TABLE "submitted_executions" ADD COLUMN "template_parameters" jsonb;--> statement-breakpoint
ALTER TABLE "submitted_executions" ADD COLUMN "on_behalf_of" text;--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;