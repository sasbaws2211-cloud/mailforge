import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
import { tenants } from "./tenants.js";

/**
 * A support request from a workspace to the operator of the service (the platform admins).
 *
 * The customer opens one from the dashboard; the operator reads and answers it in the admin console, and each answer is also emailed
 * to the customer. `status` is: open (waiting for the operator), answered (the operator replied last) or closed. A customer's
 * reply reopens it. The requester's email is copied in so the thread survives the person leaving the workspace.
 *
 * Erased with the workspace (it carries tenant_id, which the purge discovers on its own).
 *
 * Mirror side: PUBLIC (drizzle/ is mirrored).
 */
export const supportTickets = pgTable(
  "support_tickets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    /** Who opened it. No foreign key: the thread stays readable if the user is removed. */
    userId: uuid("user_id"),
    email: text("email").notNull(),
    subject: text("subject").notNull(),
    /** question | bug | billing | feature | other */
    category: text("category").notNull().default("question"),
    /** open | answered | closed */
    status: text("status").notNull().default("open"),
    /** The dashboard page they were on, to help the operator see what they meant. */
    pageUrl: text("page_url"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** When the last message (either side) was added: the list is ordered by it. */
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }).notNull().defaultNow(),
    /** customer | staff: who wrote last. */
    lastMessageBy: text("last_message_by").notNull().default("customer"),
    closedAt: timestamp("closed_at", { withTimezone: true }),
  },
  (t) => [index("idx_support_tickets_tenant").on(t.tenantId, t.lastMessageAt), index("idx_support_tickets_status").on(t.status, t.lastMessageAt)],
);

/** One message in a support request, from the customer or from the operator's staff. */
export const supportMessages = pgTable(
  "support_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ticketId: uuid("ticket_id")
      .notNull()
      .references(() => supportTickets.id, { onDelete: "cascade" }),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    /** customer | staff */
    author: text("author").notNull(),
    authorEmail: text("author_email").notNull(),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("idx_support_messages_ticket").on(t.ticketId, t.createdAt)],
);
