import { pgTable, uuid, text, timestamp, jsonb } from "drizzle-orm/pg-core";
import { tenants } from "./tenants.js";
import { contacts } from "./contacts.js";

export const lifecycleTransitions = pgTable("lifecycle_transitions", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id),
  contactId: uuid("contact_id")
    .notNull()
    .references(() => contacts.id),
  fromState: text("from_state").notNull(),
  toState: text("to_state").notNull(),
  triggerEventId: uuid("trigger_event_id"), // no FK: audit log must survive event pruning
  metadata: jsonb("metadata"),
  transitionedAt: timestamp("transitioned_at", {
    withTimezone: true,
  }).notNull(),
});
