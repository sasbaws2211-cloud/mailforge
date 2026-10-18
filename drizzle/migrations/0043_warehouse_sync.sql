ALTER TABLE "inbound_sources" ADD COLUMN "sync_cursor" text;--> statement-breakpoint
ALTER TABLE "inbound_sources" ADD COLUMN "sync_boundary" text;--> statement-breakpoint
ALTER TABLE "inbound_sources" ADD COLUMN "next_sync_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "inbound_sources" ADD COLUMN "sync_lease_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "inbound_sources" ADD COLUMN "last_sync_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "inbound_sources" ADD COLUMN "last_sync_status" text;--> statement-breakpoint
ALTER TABLE "inbound_sources" ADD COLUMN "last_sync_note" text;