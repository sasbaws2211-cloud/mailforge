import { pgTable, uuid, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { tenants } from "./tenants.js";
import { contacts } from "./contacts.js";

export const events = pgTable(
  "events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id),
    type: text("type").notNull(), // track|identify|page|group
    eventName: text("event_name"), // e.g., "project_created"
    properties: jsonb("properties"),
    context: jsonb("context"), // device, ip, etc.
    timestamp: timestamp("timestamp", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("idx_events_contact_time").on(table.contactId, table.timestamp.desc()),
    index("idx_events_tenant_name").on(
      table.tenantId,
      table.eventName,
      table.timestamp.desc()
    ),
  ]
);
