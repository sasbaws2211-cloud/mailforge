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
  // trigger_event_id references events.id logically but has no FK constraint.
  // Originally: audit log must survive event pruning (retention drops old partitions).
  // Additionally: events is partitioned by received_at with PK (id, received_at),
  // so a FK on event_id alone has no matching unique index. Referential integrity
  // is guaranteed by the ingest code path (evaluateAndApplyTransition writes the
  // transition row immediately after the event INSERT in the same request handler).
  triggerEventId: uuid("trigger_event_id"),
  metadata: jsonb("metadata"),
  transitionedAt: timestamp("transitioned_at", {
    withTimezone: true,
  }).notNull(),
});
