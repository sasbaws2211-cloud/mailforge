import { pgTable, uuid, text, integer, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { tenants } from "./tenants.js";
import { flows } from "./flows.js";
import { flowMemberships } from "./flow-memberships.js";
import { contacts } from "./contacts.js";

/**
 * One call a webhook step has to make for one person. Written by the engine when a contact reaches a webhook step
 * (one row per membership per step, safe to write twice) and worked off by the worker's delivery job, which sends it,
 * records the answer and retries failures on a schedule. `url` is copied from the plan at that moment, so editing the
 * flow later never redirects a call already queued.
 *
 * status: pending (waiting for its time) | succeeded | failed (gave up, or the flow was archived).
 * Rows are swept after WEBHOOK_DELIVERY_RETENTION_DAYS.
 */
export const flowWebhookDeliveries = pgTable(
  "flow_webhook_deliveries",
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
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id),
    stepOrder: integer("step_order").notNull(),
    url: text("url").notNull(),
    status: text("status").notNull().default("pending"), // pending|succeeded|failed
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull(),
    lastStatusCode: integer("last_status_code"),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("uq_flow_webhook_deliveries_membership_step").on(table.membershipId, table.stepOrder),
    // The delivery job's scan: what is due, oldest first.
    index("idx_flow_webhook_deliveries_due")
      .on(table.nextAttemptAt)
      .where(sql`status = 'pending'`),
    index("idx_flow_webhook_deliveries_flow").on(table.flowId, table.createdAt),
  ],
);

/**
 * The secret a workspace's webhook calls are signed with (one per workspace, shared by all its flows). Stored sealed:
 * encrypted with ENCRYPTION_KEY when the install has one, otherwise kept as `plain:<hex>`. Never exported.
 */
export const webhookSecrets = pgTable(
  "webhook_secrets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    secretSealed: text("secret_sealed").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    rotatedAt: timestamp("rotated_at", { withTimezone: true }),
  },
  (table) => [uniqueIndex("uq_webhook_secrets_tenant").on(table.tenantId)],
);
