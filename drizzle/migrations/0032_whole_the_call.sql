CREATE TABLE "managed_domain_cleanup" (
	"resend_domain_id" text PRIMARY KEY NOT NULL,
	"domain" text,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text
);
--> statement-breakpoint
CREATE TABLE "managed_sending" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"domain" text,
	"resend_domain_id" text,
	"domain_status" text DEFAULT 'none' NOT NULL,
	"dns_records" jsonb,
	"from_local" text DEFAULT 'hello' NOT NULL,
	"from_name" text,
	"reply_to" text,
	"domain_added_at" timestamp with time zone,
	"domain_verified_at" timestamp with time zone,
	"domain_checked_at" timestamp with time zone,
	"paused_at" timestamp with time zone,
	"paused_reason" text,
	"paused_by" text,
	"warned_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "managed_sending" ADD CONSTRAINT "managed_sending_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_managed_sending_domain" ON "managed_sending" USING btree (lower("domain")) WHERE "managed_sending"."domain" is not null;