import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { tenants } from "./tenants.js";

export const contacts = pgTable(
  "contacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    externalId: text("external_id").notNull(), // tenant's user ID
    email: text("email"), // [v2] NULLABLE: identify may arrive before email is known
    name: text("name"),
    company: text("company"),
    properties: jsonb("properties"), // arbitrary attributes from track/identify
    lifecycleState: text("lifecycle_state").notNull(), // signed_up|activated|engaged|at_risk|dormant|churned|resurrected
    engagementDepth: text("engagement_depth"), // power|regular|casual|minimal
    paymentStatus: text("payment_status").default("free"), // free|trial|paid|past_due|cancelled
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_contacts_tenant_external_id").on(
      table.tenantId,
      table.externalId
    ),
    // [v2] email uniqueness via partial index (email is nullable)
    uniqueIndex("uq_contacts_tenant_email")
      .on(table.tenantId, table.email)
      .where(sql`email IS NOT NULL`),
    index("idx_contacts_tenant_state").on(table.tenantId, table.lifecycleState),
    index("idx_contacts_last_seen").on(table.tenantId, table.lastSeenAt),
  ]
);
