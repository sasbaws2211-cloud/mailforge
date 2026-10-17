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
    // The node (email step or branch) the contact is at. A node's `order` is its id in the plan.
    currentStep: integer("current_step").notNull().default(1),
    // When the contact arrived at current_step. Delays in a version 2 (branching) plan count from here.
    // Null until the first move, and always null for straight-line plans, which count from the
    // previous email instead (so nothing about existing flows changes).
    stepEnteredAt: timestamp("step_entered_at", { withTimezone: true }),
    status: text("status").default("active").notNull(), // active|completed|exited|paused
    enteredAt: timestamp("entered_at", { withTimezone: true }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    exitedAt: timestamp("exited_at", { withTimezone: true }),
    exitReason: text("exit_reason"), // completed|condition_met|admin|priority_override
    // [impl] task 12d: records last-observed condition evaluation error.
    // Non-null means the scan could not interpret a condition on the current step
    // or plan-level exit. The membership stays active but unadvanced until the
    // flow is recompiled with a valid condition vocabulary. Self-clears when the
    // condition becomes parseable on a subsequent scan pass.
    conditionError: text("condition_error"),
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
