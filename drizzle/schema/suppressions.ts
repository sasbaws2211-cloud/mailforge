import { pgTable, uuid, text, timestamp } from "drizzle-orm/pg-core";
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
  // NOTE: The unique constraint on (tenant_id, lower(email)) is a functional
  // unique index created by migration 0013. Drizzle-kit cannot represent
  // expression indexes natively; the index is managed outside the schema DSL.
  // Do NOT add a uniqueIndex() here - it would create a second (wrong) index.
  () => []
);
