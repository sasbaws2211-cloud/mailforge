CREATE TABLE "flow_split_choices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"flow_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"node_order" integer NOT NULL,
	"version" text NOT NULL,
	"chosen_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "flow_split_choices" ADD CONSTRAINT "flow_split_choices_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_split_choices" ADD CONSTRAINT "flow_split_choices_flow_id_flows_id_fk" FOREIGN KEY ("flow_id") REFERENCES "public"."flows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_split_choices" ADD CONSTRAINT "flow_split_choices_membership_id_flow_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."flow_memberships"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_flow_split_choices_membership_node" ON "flow_split_choices" USING btree ("membership_id","node_order");--> statement-breakpoint
CREATE INDEX "idx_flow_split_choices_flow" ON "flow_split_choices" USING btree ("flow_id","node_order","chosen_at");