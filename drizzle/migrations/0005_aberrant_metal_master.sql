CREATE TABLE "llm_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"config" text NOT NULL,
	"is_active" boolean DEFAULT true,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "flows" ADD COLUMN "compile_status" text;--> statement-breakpoint
ALTER TABLE "flows" ADD COLUMN "compile_error" text;--> statement-breakpoint
ALTER TABLE "llm_configs" ADD CONSTRAINT "llm_configs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;