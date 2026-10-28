CREATE TABLE "resource_delete_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"resource_ids" uuid[] NOT NULL,
	"owner_team" text,
	"requested_by" uuid,
	"dependent_ids" uuid[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decision" text,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"execution_id" uuid,
	CONSTRAINT "resource_delete_requests_decision" CHECK ("resource_delete_requests"."decision" IS NULL OR "resource_delete_requests"."decision" IN ('approved', 'denied'))
);
--> statement-breakpoint
CREATE TABLE "resource_links" (
	"resource_id" uuid NOT NULL,
	"depends_on_id" uuid NOT NULL,
	"input" text NOT NULL,
	"wiring_type" text,
	CONSTRAINT "resource_links_resource_id_depends_on_id_input_pk" PRIMARY KEY("resource_id","depends_on_id","input"),
	CONSTRAINT "resource_links_not_itself" CHECK ("resource_links"."resource_id" <> "resource_links"."depends_on_id")
);
--> statement-breakpoint
ALTER TABLE "resources" ADD COLUMN "provides" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "resource_delete_requests" ADD CONSTRAINT "resource_delete_requests_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_delete_requests" ADD CONSTRAINT "resource_delete_requests_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_links" ADD CONSTRAINT "resource_links_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."resources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_links" ADD CONSTRAINT "resource_links_depends_on_id_resources_id_fk" FOREIGN KEY ("depends_on_id") REFERENCES "public"."resources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "resource_delete_requests_waiting_idx" ON "resource_delete_requests" USING btree ("created_at") WHERE "resource_delete_requests"."decision" IS NULL;--> statement-breakpoint
CREATE INDEX "resource_links_depends_on_id_idx" ON "resource_links" USING btree ("depends_on_id");--> statement-breakpoint
CREATE INDEX "resources_provides_idx" ON "resources" USING gin ("provides");