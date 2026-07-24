import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { tenants } from "./tenants.js";
import { contacts } from "./contacts.js";
import { flows } from "./flows.js";

export const lifecycleMessages = pgTable(
  "lifecycle_messages",
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
    flowStepOrder: integer("flow_step_order"),
    status: text("status").notNull(), // pending_generation|generating|awaiting_content|pending_approval|approved|sending|sent|failed
    feedback: text("feedback"), // opened|clicked|bounced|complained (advance-only)
    subject: text("subject"),
    bodyHtml: text("body_html"),
    bodyText: text("body_text"),
    brainReasoning: text("brain_reasoning"), // why Brain chose this action
    brainActionType: text("brain_action_type"), // from catalog
    scheduledSendAt: timestamp("scheduled_send_at", { withTimezone: true }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    retryCount: integer("retry_count").default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    // Drain worker query: only approved/sending messages matter
    index("idx_messages_drain")
      .on(table.tenantId, table.status, table.scheduledSendAt)
      .where(sql`status IN ('approved', 'sending')`),
    index("idx_messages_contact").on(
      table.contactId,
      table.status,
      table.createdAt.desc()
    ),
  ]
);
