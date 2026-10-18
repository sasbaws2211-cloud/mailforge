ALTER TABLE "tenants" ADD COLUMN "warehouse_access" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
-- Workspaces that already have a warehouse source keep working.
UPDATE "tenants" SET "warehouse_access" = true WHERE "id" IN (SELECT "tenant_id" FROM "inbound_sources" WHERE "kind" = 'warehouse');
