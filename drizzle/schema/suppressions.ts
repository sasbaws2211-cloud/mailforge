import { pgTable, uuid, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { tenants } from "./tenants.js";

export const suppressions = pgTable(
  "suppressions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    email: text("email").notNull(),
    reason: text("reason").notNull(), // unsubscribe|hard_bounce|complaint|manual|imported
    source: text("source"), // one_click|page|webhook|admin|csv_import
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_suppressions_tenant_email").on(table.tenantId, table.email),
  ]
);
