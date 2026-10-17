import { pgTable, uuid, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { tenants } from "./tenants.js";
import { contacts } from "./contacts.js";
import { flows } from "./flows.js";
import { flowMemberships } from "./flow-memberships.js";

/**
 * One row when a contact reaches a flow's goal after entering it. The unique key is the membership, so a
 * conversion is never counted twice however many scans see it. `goal_name` is the goal as it was named at the
 * time, so renaming the goal later does not rewrite history.
 */
export const flowConversions = pgTable(
  "flow_conversions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    flowId: uuid("flow_id")
      .notNull()
      .references(() => flows.id),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id),
    membershipId: uuid("membership_id")
      .notNull()
      .references(() => flowMemberships.id),
    goalName: text("goal_name").notNull(),
    convertedAt: timestamp("converted_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("uq_flow_conversions_membership").on(table.membershipId),
    index("idx_flow_conversions_flow").on(table.flowId, table.convertedAt),
  ],
);
