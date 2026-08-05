ALTER TABLE "api_keys" ADD COLUMN "kind" text DEFAULT 'secret' NOT NULL;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "allowed_origins" jsonb;--> statement-breakpoint
CREATE INDEX "idx_contacts_tenant_created" ON "contacts" USING btree ("tenant_id","created_at","id");--> statement-breakpoint
CREATE INDEX "idx_kb_entries_tenant_created" ON "kb_entries" USING btree ("tenant_id","created_at","id");--> statement-breakpoint
CREATE INDEX "idx_messages_tenant_sent" ON "lifecycle_messages" USING btree ("tenant_id","sent_at") WHERE sent_at IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_transitions_contact" ON "lifecycle_transitions" USING btree ("contact_id","transitioned_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_transitions_tenant_time" ON "lifecycle_transitions" USING btree ("tenant_id","transitioned_at");