CREATE TABLE "resources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product" text NOT NULL,
	"product_team" text NOT NULL,
	"type" text NOT NULL,
	"external_id" text NOT NULL,
	"name" text,
	"link" text,
	"owner_team" text,
	"owner_user_id" uuid,
	"execution_id" uuid NOT NULL,
	"task_id" text NOT NULL,
	"inputs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"outputs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"first_reported_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reported_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleting_execution_id" uuid,
	"deleting_task_id" text,
	"delete_requested_by" uuid,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "resources_product_team_type_external_id" UNIQUE("product_team","type","external_id")
);
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "cleanup" jsonb;--> statement-breakpoint
ALTER TABLE "submitted_executions" ADD COLUMN "resources_recorded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "resources" ADD CONSTRAINT "resources_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resources" ADD CONSTRAINT "resources_delete_requested_by_users_id_fk" FOREIGN KEY ("delete_requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "resources_execution_id_idx" ON "resources" USING btree ("execution_id");--> statement-breakpoint
CREATE INDEX "resources_deleting_execution_id_idx" ON "resources" USING btree ("deleting_execution_id");--> statement-breakpoint
CREATE INDEX "resources_owner_team_idx" ON "resources" USING btree ("owner_team");