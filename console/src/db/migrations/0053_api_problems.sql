CREATE TABLE "api_problems" (
	"api_id" uuid PRIMARY KEY NOT NULL,
	"problem" text NOT NULL,
	"found_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "api_problems" ADD CONSTRAINT "api_problems_api_id_apis_id_fk" FOREIGN KEY ("api_id") REFERENCES "public"."apis"("id") ON DELETE cascade ON UPDATE no action;