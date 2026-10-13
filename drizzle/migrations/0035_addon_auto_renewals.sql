CREATE TABLE "addon_auto_renewals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"packs" integer NOT NULL,
	"authorization_enc" text NOT NULL,
	"payer_email" text NOT NULL,
	"card_brand" text,
	"card_last4" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_period" timestamp with time zone NOT NULL,
	"fail_count" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "billing_checkouts" ADD COLUMN "repeat_monthly" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "addon_auto_renewals" ADD CONSTRAINT "addon_auto_renewals_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_addon_auto_renewals_tenant_kind" ON "addon_auto_renewals" USING btree ("tenant_id","kind");