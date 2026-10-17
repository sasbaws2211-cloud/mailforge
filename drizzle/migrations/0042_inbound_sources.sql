CREATE TABLE "inbound_source_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"status" text NOT NULL,
	"summary" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inbound_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"secret_sealed" text,
	"token_hash" text,
	"token_prefix" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_received_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "inbound_source_log" ADD CONSTRAINT "inbound_source_log_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_source_log" ADD CONSTRAINT "inbound_source_log_source_id_inbound_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."inbound_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_sources" ADD CONSTRAINT "inbound_sources_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_inbound_source_log_source" ON "inbound_source_log" USING btree ("source_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_inbound_source_log_created" ON "inbound_source_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_inbound_sources_tenant" ON "inbound_sources" USING btree ("tenant_id","created_at");