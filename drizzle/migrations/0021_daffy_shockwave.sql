CREATE TABLE "retention_grid_snapshots" (
	"tenant_id" uuid NOT NULL,
	"snapshot_date" date NOT NULL,
	"tenure_bucket" text NOT NULL,
	"recency_bucket" text NOT NULL,
	"contact_count" integer NOT NULL,
	"paying_count" integer NOT NULL,
	CONSTRAINT "retention_grid_snapshots_tenant_id_snapshot_date_tenure_bucket_recency_bucket_pk" PRIMARY KEY("tenant_id","snapshot_date","tenure_bucket","recency_bucket")
);
--> statement-breakpoint
ALTER TABLE "retention_grid_snapshots" ADD CONSTRAINT "retention_grid_snapshots_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;