import { pgTable, uuid, text, integer, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { tenants } from "./tenants.js";
import { flows } from "./flows.js";
import { flowMemberships } from "./flow-memberships.js";

/**
 * Which version of a random split (A/B test or holdout) a person was sent down. One row per membership per split,
 * written before the person moves on and safe to write twice, so results never miss anyone. `node_order` is the
 * split's number in the flow's plan. Version is "a" (the `then` path) or "b" (the `else` path).
 */
export const flowSplitChoices = pgTable(
  "flow_split_choices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    flowId: uuid("flow_id")
      .notNull()
      .references(() => flows.id),
    membershipId: uuid("membership_id")
      .notNull()
      .references(() => flowMemberships.id),
    nodeOrder: integer("node_order").notNull(),
    version: text("version").notNull(), // a|b
    chosenAt: timestamp("chosen_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("uq_flow_split_choices_membership_node").on(table.membershipId, table.nodeOrder),
    index("idx_flow_split_choices_flow").on(table.flowId, table.nodeOrder, table.chosenAt),
  ],
);
