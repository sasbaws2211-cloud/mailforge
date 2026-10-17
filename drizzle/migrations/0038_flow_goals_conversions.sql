CREATE TABLE "flow_conversions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"flow_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"goal_name" text NOT NULL,
	"converted_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "flows" ADD COLUMN "goal" jsonb;--> statement-breakpoint
ALTER TABLE "flow_conversions" ADD CONSTRAINT "flow_conversions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_conversions" ADD CONSTRAINT "flow_conversions_flow_id_flows_id_fk" FOREIGN KEY ("flow_id") REFERENCES "public"."flows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_conversions" ADD CONSTRAINT "flow_conversions_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_conversions" ADD CONSTRAINT "flow_conversions_membership_id_flow_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."flow_memberships"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_flow_conversions_membership" ON "flow_conversions" USING btree ("membership_id");--> statement-breakpoint
CREATE INDEX "idx_flow_conversions_flow" ON "flow_conversions" USING btree ("flow_id","converted_at");