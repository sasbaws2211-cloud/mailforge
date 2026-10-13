CREATE TABLE "addon_purchases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"checkout_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"packs" integer NOT NULL,
	"units" integer NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "addon_purchases" ADD CONSTRAINT "addon_purchases_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "addon_purchases" ADD CONSTRAINT "addon_purchases_checkout_id_billing_checkouts_id_fk" FOREIGN KEY ("checkout_id") REFERENCES "public"."billing_checkouts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_addon_purchases_checkout" ON "addon_purchases" USING btree ("checkout_id");--> statement-breakpoint
CREATE INDEX "idx_addon_purchases_tenant_period" ON "addon_purchases" USING btree ("tenant_id","period_start");