CREATE TABLE "anonymous_aliases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"anonymous_id" text NOT NULL,
	"contact_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "anonymous_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"anonymous_id" text NOT NULL,
	"event_name" text NOT NULL,
	"properties" jsonb,
	"context" jsonb,
	"message_id" text,
	"timestamp" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "anonymous_aliases" ADD CONSTRAINT "anonymous_aliases_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "anonymous_aliases" ADD CONSTRAINT "anonymous_aliases_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "anonymous_events" ADD CONSTRAINT "anonymous_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_anonymous_aliases_visitor" ON "anonymous_aliases" USING btree ("tenant_id","anonymous_id");--> statement-breakpoint
CREATE INDEX "idx_anonymous_aliases_created" ON "anonymous_aliases" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_anonymous_events_visitor" ON "anonymous_events" USING btree ("tenant_id","anonymous_id","timestamp");--> statement-breakpoint
CREATE INDEX "idx_anonymous_events_received" ON "anonymous_events" USING btree ("received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_anonymous_events_message" ON "anonymous_events" USING btree ("tenant_id","anonymous_id","message_id") WHERE message_id IS NOT NULL;