CREATE TABLE "platform_alert_state" (
	"key" text PRIMARY KEY NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"last_sent_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "llm_usage" ADD COLUMN "cost_micros" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "ai_allowance_override" integer;