CREATE TABLE "flow_webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"flow_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"step_order" integer NOT NULL,
	"url" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone NOT NULL,
	"last_status_code" integer,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "webhook_secrets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"secret_sealed" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rotated_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "flow_webhook_deliveries" ADD CONSTRAINT "flow_webhook_deliveries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_webhook_deliveries" ADD CONSTRAINT "flow_webhook_deliveries_flow_id_flows_id_fk" FOREIGN KEY ("flow_id") REFERENCES "public"."flows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_webhook_deliveries" ADD CONSTRAINT "flow_webhook_deliveries_membership_id_flow_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."flow_memberships"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_webhook_deliveries" ADD CONSTRAINT "flow_webhook_deliveries_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_secrets" ADD CONSTRAINT "webhook_secrets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_flow_webhook_deliveries_membership_step" ON "flow_webhook_deliveries" USING btree ("membership_id","step_order");--> statement-breakpoint
CREATE INDEX "idx_flow_webhook_deliveries_due" ON "flow_webhook_deliveries" USING btree ("next_attempt_at") WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX "idx_flow_webhook_deliveries_flow" ON "flow_webhook_deliveries" USING btree ("flow_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_webhook_secrets_tenant" ON "webhook_secrets" USING btree ("tenant_id");