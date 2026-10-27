CREATE TABLE "team_callbacks" (
	"team_id" uuid PRIMARY KEY NOT NULL,
	"url_encrypted" text NOT NULL,
	"host" text NOT NULL,
	"secret_encrypted" text NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_sent_at" timestamp with time zone,
	"last_error" text
);
--> statement-breakpoint
ALTER TABLE "callback_deliveries" ALTER COLUMN "bot_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "callback_deliveries" ADD COLUMN "team_id" uuid;--> statement-breakpoint
ALTER TABLE "team_callbacks" ADD CONSTRAINT "team_callbacks_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_callbacks" ADD CONSTRAINT "team_callbacks_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "callback_deliveries" ADD CONSTRAINT "callback_deliveries_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "callback_deliveries" ADD CONSTRAINT "callback_deliveries_one_destination" CHECK (("callback_deliveries"."bot_id" is null) <> ("callback_deliveries"."team_id" is null));