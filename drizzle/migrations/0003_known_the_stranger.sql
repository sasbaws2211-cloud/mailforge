CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"key_hash" text NOT NULL,
	"prefix" text NOT NULL,
	"label" text,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now(),
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_api_keys_hash_active" ON "api_keys" USING btree ("key_hash") WHERE revoked_at IS NULL;--> statement-breakpoint
CREATE INDEX "idx_api_keys_tenant" ON "api_keys" USING btree ("tenant_id");