CREATE TABLE "api_traffic" (
	"api_id" uuid NOT NULL,
	"minute" timestamp with time zone NOT NULL,
	"team" text NOT NULL,
	"endpoint" text NOT NULL,
	"outcome" text NOT NULL,
	"count" integer NOT NULL,
	"duration_ms" bigint NOT NULL,
	CONSTRAINT "api_traffic_api_id_minute_team_endpoint_outcome_pk" PRIMARY KEY("api_id","minute","team","endpoint","outcome")
);
--> statement-breakpoint
CREATE TABLE "gateway_state" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"closed_message" text,
	"closed_by" uuid,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "api_traffic" ADD CONSTRAINT "api_traffic_api_id_apis_id_fk" FOREIGN KEY ("api_id") REFERENCES "public"."apis"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gateway_state" ADD CONSTRAINT "gateway_state_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_traffic_minute_idx" ON "api_traffic" USING btree ("minute");