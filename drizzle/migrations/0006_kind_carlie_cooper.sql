CREATE TABLE "scan_checkpoints" (
	"scan_phase" text NOT NULL,
	"tenant_id" uuid NOT NULL,
	"last_id" uuid NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"discard_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "scan_checkpoints_scan_phase_tenant_id_pk" PRIMARY KEY("scan_phase","tenant_id")
);
--> statement-breakpoint
ALTER TABLE "lifecycle_messages" ADD COLUMN "membership_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "scan_checkpoints" ADD CONSTRAINT "scan_checkpoints_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lifecycle_messages" ADD CONSTRAINT "lifecycle_messages_membership_id_flow_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."flow_memberships"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_messages_membership_step" ON "lifecycle_messages" USING btree ("membership_id","flow_step_order");