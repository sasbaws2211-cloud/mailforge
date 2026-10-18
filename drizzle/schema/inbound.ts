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
 * kind "warehouse": no address. Loomail reads rows from the customer's Postgres, Snowflake or BigQuery on a schedule
 *                 (see packages/api/src/warehouse). `config` holds the connection details and the mapping; the
 *                 credential (password, private key, service-account key) is sealed JSON in `secret_sealed`.
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
    kind: text("kind").notNull(), // generic|stripe|paystack|flutterwave|warehouse
    config: jsonb("config").notNull().default({}),
    /** Stripe signing secret, sealed (see @loomail/adapters sealWebhookSecret). Null for generic sources. */
    secretSealed: text("secret_sealed"),
    /** SHA-256 of the generic source's token, and its first characters for display. Null for Stripe sources. */
    tokenHash: text("token_hash"),
    tokenPrefix: text("token_prefix"),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastReceivedAt: timestamp("last_received_at", { withTimezone: true }),
    // Warehouse sources only (kind "warehouse"): Loomail pulls from the warehouse on a schedule.
    /** Position reached so far, as text; the next run asks for rows at or after it. Null: nothing synced yet. */
    syncCursor: text("sync_cursor"),
    /** Fingerprint of the rows read at exactly the saved position, so the next run can tell they have not changed. */
    syncBoundary: text("sync_boundary"),
    /** When the next run is due. Null: never run. */
    nextSyncAt: timestamp("next_sync_at", { withTimezone: true }),
    /** A run in progress holds this until it ends; a crashed run's hold expires on its own. */
    syncLeaseUntil: timestamp("sync_lease_until", { withTimezone: true }),
    lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
    /** ok | error | running, with a short note for the dashboard. */
    lastSyncStatus: text("last_sync_status"),
    lastSyncNote: text("last_sync_note"),
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
