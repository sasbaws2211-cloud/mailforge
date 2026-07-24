import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { tenants } from "./tenants.js";
import { contacts } from "./contacts.js";
import { flows } from "./flows.js";

export const flowMemberships = pgTable(
  "flow_memberships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id),
    flowId: uuid("flow_id")
      .notNull()
      .references(() => flows.id),
    currentStep: integer("current_step").notNull().default(1),
    status: text("status").default("active").notNull(), // active|completed|exited|paused
    enteredAt: timestamp("entered_at", { withTimezone: true }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    exitedAt: timestamp("exited_at", { withTimezone: true }),
    exitReason: text("exit_reason"), // completed|condition_met|admin|priority_override
  },
  (table) => [
    // [v2] Only ONE ACTIVE membership per flow per contact
    uniqueIndex("uq_flow_membership_active")
      .on(table.contactId, table.flowId)
      .where(sql`status = 'active'`),
    index("idx_flow_members_contact").on(table.contactId, table.status),
    index("idx_flow_members_flow").on(
      table.flowId,
      table.status,
      table.currentStep
    ),
  ]
);
