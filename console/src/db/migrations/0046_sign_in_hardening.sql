CREATE TABLE "rate_limit_windows" (
	"key" text PRIMARY KEY NOT NULL,
	"count" integer NOT NULL,
	"resets_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "revoked_sessions" (
	"sid" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sign_in_failures" (
	"email" text PRIMARY KEY NOT NULL,
	"failures" integer NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"next_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "api_tokens" ADD COLUMN "expires_at" timestamp with time zone;