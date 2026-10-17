import { pgTable, uuid, text, boolean, jsonb, timestamp, index } from "drizzle-orm/pg-core";
import { tenants } from "./tenants.js";

/**
 * A place other systems send data to: a URL that turns what it receives into Loomail events and traits.
 *
 * kind "generic": any JSON POST. `config` says how to read it (which field is the person, what the event is
 *                 called, which fields become traits). Authenticated by a token Loomail makes; only its hash is kept.
 * kind "stripe":  Stripe's own webhook. Authenticated by Stripe's signature, using the endpoint signing secret the
 *                 customer pastes in (kept sealed in `secret_sealed`). `config` names the metadata key that holds
 *                 the customer's own user id.
 *
 * The URL is /webhooks/in/:id. Receipts are logged in inbound_source_log.
 */
export const inboundSources = pgTable(
  "inbound_sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    name: text("name").notNull(),
    kind: text("kind").notNull(), // generic|stripe
    config: jsonb("config").notNull().default({}),
    /** Stripe signing secret, sealed (see @loomail/adapters sealWebhookSecret). Null for generic sources. */
    secretSealed: text("secret_sealed"),
    /** SHA-256 of the generic source's token, and its first characters for display. Null for Stripe sources. */
    tokenHash: text("token_hash"),
    tokenPrefix: text("token_prefix"),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastReceivedAt: timestamp("last_received_at", { withTimezone: true }),
  },
  (table) => [index("idx_inbound_sources_tenant").on(table.tenantId, table.createdAt)],
);

/**
 * One line per request a source received: what it was and what Loomail did with it. status: processed | ignored (a
 * Stripe event type Loomail does not use, or one that could not be matched to a person) | rejected (failed
 * authentication or could not be read) | error. Swept after 30 days.
 */
export const inboundSourceLog = pgTable(
  "inbound_source_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => inboundSources.id, { onDelete: "cascade" }),
    status: text("status").notNull(),
    summary: text("summary").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_inbound_source_log_source").on(table.sourceId, table.createdAt),
    index("idx_inbound_source_log_created").on(table.createdAt),
  ],
);
