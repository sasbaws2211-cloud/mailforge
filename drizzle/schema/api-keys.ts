/**
 * API keys for event ingestion authentication.
 *
 * Each tenant gets one or more write keys. Incoming track/identify requests
 * carry `Authorization: Bearer <write_key>`. We store only the SHA-256 hash;
 * the raw key is shown once at creation and never stored.
 *
 * The `prefix` column (first 8 chars of the raw key) enables masked display
 * in the dashboard without exposing the full key.
 *
 * [impl] Added in task 7 (event ingestion API) - not in the original spec's
 * section 8, but required by Appendix C's authentication contract.
 *
 * Mirror side: PUBLIC (drizzle/ is mirrored).
 */
import {
  pgTable,
  uuid,
  text,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { tenants } from "./tenants.js";

export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    keyHash: text("key_hash").notNull(), // SHA-256 hex of the raw key
    prefix: text("prefix").notNull(), // first 8 chars for masked display
    label: text("label"), // human-friendly name ("Production backend")
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }), // null = active
  },
  (table) => [
    // Every ingestion request looks up by key_hash WHERE revoked_at IS NULL.
    // Partial index keeps the lookup fast and skips revoked rows.
    uniqueIndex("uq_api_keys_hash_active")
      .on(table.keyHash)
      .where(sql`revoked_at IS NULL`),
    // Dashboard listing: all keys for a tenant (active and revoked)
    index("idx_api_keys_tenant").on(table.tenantId),
  ],
);
