CREATE TABLE "contact_conflicts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"field" text NOT NULL,
	"rejected_value" text NOT NULL,
	"event_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "contact_conflicts" ADD CONSTRAINT "contact_conflicts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_conflicts" ADD CONSTRAINT "contact_conflicts_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_conflicts" ADD CONSTRAINT "contact_conflicts_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_contact_conflicts_tenant" ON "contact_conflicts" USING btree ("tenant_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_contact_conflicts_contact" ON "contact_conflicts" USING btree ("contact_id");