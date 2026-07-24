import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
import { tenants } from "./tenants.js";
import { users } from "./users.js";

/**
 * Magic link tokens for passwordless login.
 *
 * Security model:
 * - Raw token (32 random bytes, URL-safe base64) is sent in the magic link URL.
 * - Only the SHA-256 hash of the token is stored here (`token_hash`).
 * - A DB leak does not expose usable tokens.
 * - Single-use: verified via atomic CAS (UPDATE WHERE consumed_at IS NULL).
 * - 10-minute TTL.
 * - user_id cascades: deleting a user removes all their tokens.
 */
export const magicLinkTokens = pgTable(
  "magic_link_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("idx_magic_link_tokens_hash").on(table.tokenHash),
  ]
);
