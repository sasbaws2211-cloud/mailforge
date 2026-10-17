import { pgTable, uuid, text, timestamp, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { tenants } from "./tenants.js";
import { contacts } from "./contacts.js";

/**
 * What a visitor did before anyone knew who they were: track calls that carry an `anonymousId` and no `userId`.
 * Kept apart from `events` on purpose: an anonymous visitor is not a contact, `events` is partitioned and every
 * query on it assumes a contact, and this table is short-lived. Rows are replayed onto the contact when an identify
 * call names the same `anonymousId` (see mergeAnonymousEvents in routes/ingest.ts) and are swept after
 * ANONYMOUS_EVENT_RETENTION_DAYS if nobody ever identifies.
 */
export const anonymousEvents = pgTable(
  "anonymous_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    anonymousId: text("anonymous_id").notNull(),
    eventName: text("event_name").notNull(),
    properties: jsonb("properties"),
    context: jsonb("context"),
    messageId: text("message_id"), // client dedup key, same meaning as on events
    timestamp: timestamp("timestamp", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_anonymous_events_visitor").on(table.tenantId, table.anonymousId, table.timestamp),
    index("idx_anonymous_events_received").on(table.receivedAt),
    uniqueIndex("uq_anonymous_events_message")
      .on(table.tenantId, table.anonymousId, table.messageId)
      .where(sql`message_id IS NOT NULL`),
  ],
);

/**
 * Which contact an anonymous id turned out to be. Written when an identify call carries both ids. From then on,
 * anonymous track calls with that id go straight to the contact instead of waiting. If the same browser later
 * identifies as someone else, the alias moves to them: events from then on belong to the latest person.
 */
export const anonymousAliases = pgTable(
  "anonymous_aliases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    anonymousId: text("anonymous_id").notNull(),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_anonymous_aliases_visitor").on(table.tenantId, table.anonymousId),
    index("idx_anonymous_aliases_created").on(table.createdAt),
  ],
);
