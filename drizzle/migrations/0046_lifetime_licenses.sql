CREATE TABLE "appsumo_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"license_key" text DEFAULT '' NOT NULL,
	"event" text DEFAULT '' NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"outcome" text DEFAULT '' NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lifetime_licenses" (
	"license_key" text PRIMARY KEY NOT NULL,
	"tier" integer DEFAULT 1 NOT NULL,
	"plan_code" text DEFAULT 'lifetime_1' NOT NULL,
	"status" text DEFAULT 'inactive' NOT NULL,
	"tenant_id" uuid,
	"prev_license_key" text,
	"last_event" text DEFAULT '' NOT NULL,
	"source" text DEFAULT 'api' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activated_at" timestamp with time zone,
	"claimed_at" timestamp with time zone,
	"deactivated_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "lifetime_licenses" ADD CONSTRAINT "lifetime_licenses_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_appsumo_events_key" ON "appsumo_events" USING btree ("license_key","received_at");--> statement-breakpoint
CREATE INDEX "idx_lifetime_licenses_tenant" ON "lifetime_licenses" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_lifetime_licenses_status" ON "lifetime_licenses" USING btree ("source","status");