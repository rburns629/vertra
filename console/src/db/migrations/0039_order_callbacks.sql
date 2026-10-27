CREATE TABLE "bot_callbacks" (
	"bot_id" uuid PRIMARY KEY NOT NULL,
	"url_encrypted" text NOT NULL,
	"host" text NOT NULL,
	"secret_encrypted" text NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_sent_at" timestamp with time zone,
	"last_error" text
);
--> statement-breakpoint
CREATE TABLE "callback_deliveries" (
	"key" text PRIMARY KEY NOT NULL,
	"bot_id" uuid NOT NULL,
	"body" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bot_callbacks" ADD CONSTRAINT "bot_callbacks_bot_id_users_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_callbacks" ADD CONSTRAINT "bot_callbacks_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "callback_deliveries" ADD CONSTRAINT "callback_deliveries_bot_id_users_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;