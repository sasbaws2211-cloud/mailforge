CREATE TABLE "deleted_workspaces" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"owner_email_hash" text,
	"plan" text,
	"created_at" timestamp with time zone,
	"requested_at" timestamp with time zone,
	"deleted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"how" text NOT NULL,
	"row_counts" jsonb
);
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "deletion_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "deletion_scheduled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "deletion_requested_by" text;