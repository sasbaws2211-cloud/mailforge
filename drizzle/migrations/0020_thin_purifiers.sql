CREATE TABLE "message_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"provider_event_id" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "message_events" ADD CONSTRAINT "message_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_events" ADD CONSTRAINT "message_events_message_id_lifecycle_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."lifecycle_messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_message_events_message" ON "message_events" USING btree ("message_id","occurred_at");--> statement-breakpoint
CREATE INDEX "idx_message_events_tenant_type_day" ON "message_events" USING btree ("tenant_id","event_type","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_message_events_provider_dedup" ON "message_events" USING btree ("tenant_id","provider_event_id") WHERE provider_event_id IS NOT NULL;