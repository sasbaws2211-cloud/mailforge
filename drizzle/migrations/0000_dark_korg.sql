-- Enable pgvector extension (required for kb_entries.embedding column)
CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"email" text,
	"name" text,
	"company" text,
	"properties" jsonb,
	"lifecycle_state" text NOT NULL,
	"engagement_depth" text,
	"payment_status" text DEFAULT 'free',
	"first_seen_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"activated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"type" text NOT NULL,
	"event_name" text,
	"properties" jsonb,
	"context" jsonb,
	"timestamp" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "flow_memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"flow_id" uuid NOT NULL,
	"current_step" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"entered_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"exited_at" timestamp with time zone,
	"exit_reason" text
);
--> statement-breakpoint
CREATE TABLE "flows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"priority" integer DEFAULT 0,
	"trigger_type" text NOT NULL,
	"trigger_config" jsonb NOT NULL,
	"steps" jsonb NOT NULL,
	"source" text DEFAULT 'manual',
	"status" text DEFAULT 'draft',
	"approval_mode" text DEFAULT 'require',
	"flow_class" text DEFAULT 'nurture' NOT NULL,
	"reentry_policy" text DEFAULT 'cooldown' NOT NULL,
	"reentry_cooldown_days" integer DEFAULT 30,
	"prompt_source" text,
	"compiled_plan" jsonb,
	"compiled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "kb_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"content_type" text DEFAULT 'markdown',
	"source" text DEFAULT 'manual',
	"source_url" text,
	"tags" text[],
	"embedding" vector(1536),
	"is_active" boolean DEFAULT true,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "lifecycle_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"flow_id" uuid NOT NULL,
	"flow_step_order" integer,
	"status" text NOT NULL,
	"feedback" text,
	"subject" text,
	"body_html" text,
	"body_text" text,
	"brain_reasoning" text,
	"brain_action_type" text,
	"scheduled_send_at" timestamp with time zone,
	"approved_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"retry_count" integer DEFAULT 0,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "lifecycle_transitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"from_state" text NOT NULL,
	"to_state" text NOT NULL,
	"trigger_event_id" uuid,
	"metadata" jsonb,
	"transitioned_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "suppressions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"email" text NOT NULL,
	"reason" text NOT NULL,
	"source" text,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"subject" text NOT NULL,
	"body_html" text NOT NULL,
	"body_text" text,
	"variables" text[],
	"category" text,
	"is_active" boolean DEFAULT true,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"plan" text DEFAULT 'free',
	"settings" jsonb,
	"business_model" text,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "tenants_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "transport_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"config" jsonb NOT NULL,
	"is_active" boolean DEFAULT true,
	"dkim_verified" boolean DEFAULT false,
	"from_email" text NOT NULL,
	"from_name" text,
	"daily_limit" integer,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"role" text DEFAULT 'member' NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_memberships" ADD CONSTRAINT "flow_memberships_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_memberships" ADD CONSTRAINT "flow_memberships_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_memberships" ADD CONSTRAINT "flow_memberships_flow_id_flows_id_fk" FOREIGN KEY ("flow_id") REFERENCES "public"."flows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flows" ADD CONSTRAINT "flows_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_entries" ADD CONSTRAINT "kb_entries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lifecycle_messages" ADD CONSTRAINT "lifecycle_messages_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lifecycle_messages" ADD CONSTRAINT "lifecycle_messages_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lifecycle_messages" ADD CONSTRAINT "lifecycle_messages_flow_id_flows_id_fk" FOREIGN KEY ("flow_id") REFERENCES "public"."flows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lifecycle_transitions" ADD CONSTRAINT "lifecycle_transitions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lifecycle_transitions" ADD CONSTRAINT "lifecycle_transitions_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppressions" ADD CONSTRAINT "suppressions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transport_configs" ADD CONSTRAINT "transport_configs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_contacts_tenant_external_id" ON "contacts" USING btree ("tenant_id","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_contacts_tenant_email" ON "contacts" USING btree ("tenant_id","email") WHERE email IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_contacts_tenant_state" ON "contacts" USING btree ("tenant_id","lifecycle_state");--> statement-breakpoint
CREATE INDEX "idx_contacts_last_seen" ON "contacts" USING btree ("tenant_id","last_seen_at");--> statement-breakpoint
CREATE INDEX "idx_events_contact_time" ON "events" USING btree ("contact_id","timestamp" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_events_tenant_name" ON "events" USING btree ("tenant_id","event_name","timestamp" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "uq_flow_membership_active" ON "flow_memberships" USING btree ("contact_id","flow_id") WHERE status = 'active';--> statement-breakpoint
CREATE INDEX "idx_flow_members_contact" ON "flow_memberships" USING btree ("contact_id","status");--> statement-breakpoint
CREATE INDEX "idx_flow_members_flow" ON "flow_memberships" USING btree ("flow_id","status","current_step");--> statement-breakpoint
CREATE INDEX "idx_kb_embedding" ON "kb_entries" USING ivfflat ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "idx_messages_drain" ON "lifecycle_messages" USING btree ("tenant_id","status","scheduled_send_at") WHERE status IN ('approved', 'sending');--> statement-breakpoint
CREATE INDEX "idx_messages_contact" ON "lifecycle_messages" USING btree ("contact_id","status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "uq_suppressions_tenant_email" ON "suppressions" USING btree ("tenant_id","email");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_templates_tenant_slug" ON "templates" USING btree ("tenant_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_users_tenant_email" ON "users" USING btree ("tenant_id","email");