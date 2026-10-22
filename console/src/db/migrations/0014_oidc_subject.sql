ALTER TABLE "users" ADD COLUMN "oidc_subject" text;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_oidc_subject_unique" UNIQUE("oidc_subject");