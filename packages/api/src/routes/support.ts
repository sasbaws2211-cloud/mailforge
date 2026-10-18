/**
 * Support requests from a workspace to the operator of the service.
 *
 *   POST /v1/support/tickets               open a request (subject, message, a category and the page they were on)
 *   GET  /v1/support/tickets               this workspace's requests, newest activity first
 *   GET  /v1/support/tickets/:id           one request with its messages
 *   POST /v1/support/tickets/:id/reply     add a message (a closed request is reopened)
 *   POST /v1/support/tickets/:id/close     the customer marks it resolved
 *
 * Anyone signed in to the workspace can use it, including a suspended workspace or one waiting for deletion (see app.ts): those
 * are exactly the times a customer needs to ask. A request belongs to the workspace, so teammates see each other's. The operator
 * answers in the admin console (routes/admin-support.ts); every answer is also emailed to whoever opened the request.
 *
 * Abuse limits: a few new requests per person per hour, a cap on requests waiting for an answer, a cap on a thread's length, and
 * text length limits. Everything is stored as plain text and shown as plain text.
 *
 * Mirror side: PUBLIC (packages/api is mirrored).
 */
import type { FastifyPluginAsync } from "fastify";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { supportMessages, supportTickets, tenants } from "@loomail/db/schema";
import type { Db } from "../plugins/db.js";
import { createLimiter } from "../marketing/signup-logic.js";
import type { PlatformTransport } from "../platform-mailer.js";
import { MAX_ACTIVE_PER_WORKSPACE, MAX_MESSAGES_PER_TICKET, NEW_TICKETS_PER_HOUR, REPLIES_PER_HOUR, cleanPagePath, isUuid, newTicketSchema, replySchema } from "../support/logic.js";
import { sendNewTicketNotice } from "../support/mail.js";

export interface SupportRouteOptions {
  dashboardUrl: string;
  /** Tests pass a recording sender; otherwise the platform sender is used. */
  noticeTransports?: PlatformTransport[];
}

const HOUR = 3_600_000;

type Ticket = typeof supportTickets.$inferSelect;
const view = (t: Ticket) => ({
  id: t.id,
  subject: t.subject,
  category: t.category,
  status: t.status,
  page_url: t.pageUrl,
  requester: t.email,
  created_at: t.createdAt.toISOString(),
  last_message_at: t.lastMessageAt.toISOString(),
  last_message_by: t.lastMessageBy,
  closed_at: t.closedAt ? t.closedAt.toISOString() : null,
});

const supportRoutes: FastifyPluginAsync<SupportRouteOptions> = async (app, opts) => {
  const newLimit = createLimiter({ windowMs: HOUR, max: NEW_TICKETS_PER_HOUR });
  const replyLimit = createLimiter({ windowMs: HOUR, max: REPLIES_PER_HOUR });

  const own = async (db: Db, tenantId: string, id: string) => {
    if (!isUuid(id)) return undefined;
    return (await db.select().from(supportTickets).where(and(eq(supportTickets.id, id), eq(supportTickets.tenantId, tenantId))).limit(1))[0];
  };

  app.get("/tickets", { config: { minRole: "member" } }, async (request) => {
    const db: Db = request.server.db;
    const rows = await db.select().from(supportTickets).where(eq(supportTickets.tenantId, request.tenant!.id)).orderBy(desc(supportTickets.lastMessageAt)).limit(100);
    return { tickets: rows.map(view) };
  });

  app.post<{ Body: unknown }>("/tickets", { config: { minRole: "member" } }, async (request, reply) => {
    const db: Db = request.server.db;
    const tenant = request.tenant!;
    const parsed = newTicketSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: "Validation failed", issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) };
    }
    const limit = newLimit.hit(`new:${tenant.userId}`);
    if (!limit.allowed) {
      reply.status(429).header("Retry-After", String(limit.retryAfterSec));
      return { error: "You have sent several requests recently. Please wait a little before sending another, or reply on one you already have." };
    }
    const waiting = (
      await db
        .select({ n: sql<number>`count(*)::int` })
        .from(supportTickets)
        .where(and(eq(supportTickets.tenantId, tenant.id), inArray(supportTickets.status, ["open", "answered"])))
    )[0]!.n;
    if (waiting >= MAX_ACTIVE_PER_WORKSPACE) {
      reply.status(409);
      return { error: `This workspace already has ${MAX_ACTIVE_PER_WORKSPACE} requests waiting. Add to one of those, or close the ones that are resolved.` };
    }

    const { subject, message, category } = parsed.data;
    const pagePath = cleanPagePath(parsed.data.page_url);
    const ticket = await db.transaction(async (tx) => {
      const [t] = await tx
        .insert(supportTickets)
        .values({ tenantId: tenant.id, userId: tenant.userId, email: tenant.userEmail, subject, category, pageUrl: pagePath })
        .returning();
      await tx.insert(supportMessages).values({ ticketId: t!.id, tenantId: tenant.id, author: "customer", authorEmail: tenant.userEmail, body: message });
      return t!;
    });

    // Tell the operator. The request is already saved, so a missing or failing sender costs a notice, not the message.
    const [ws] = await db.select({ name: tenants.name }).from(tenants).where(eq(tenants.id, tenant.id)).limit(1);
    void sendNewTicketNotice(
      { transports: opts.noticeTransports, log: request.log },
      {
        ticketId: ticket.id,
        subject,
        category,
        message,
        requesterEmail: tenant.userEmail,
        workspaceName: ws?.name ?? tenant.slug,
        pagePath,
        // Where the operator answers: the standalone console when there is one (LOOMAIL_ADMIN_URL), else the console inside this app.
        consoleUrl: `${(process.env.LOOMAIL_ADMIN_URL || opts.dashboardUrl).replace(/\/+$/, "")}/admin/support/${ticket.id}`,
      },
    ).catch(() => {});

    reply.status(201);
    return { ticket: view(ticket) };
  });

  app.get<{ Params: { id: string } }>("/tickets/:id", { config: { minRole: "member" } }, async (request, reply) => {
    const db: Db = request.server.db;
    const ticket = await own(db, request.tenant!.id, request.params.id);
    if (!ticket) {
      reply.status(404);
      return { error: "Request not found." };
    }
    const messages = await db.select().from(supportMessages).where(eq(supportMessages.ticketId, ticket.id)).orderBy(supportMessages.createdAt, supportMessages.id);
    return {
      ticket: view(ticket),
      // The operator's staff are shown as "support", never by email.
      messages: messages.map((m) => ({ id: m.id, author: m.author, author_email: m.author === "customer" ? m.authorEmail : null, body: m.body, created_at: m.createdAt.toISOString() })),
    };
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/tickets/:id/reply", { config: { minRole: "member" } }, async (request, reply) => {
    const db: Db = request.server.db;
    const tenant = request.tenant!;
    const ticket = await own(db, tenant.id, request.params.id);
    if (!ticket) {
      reply.status(404);
      return { error: "Request not found." };
    }
    const parsed = replySchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: "Validation failed", issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) };
    }
    const limit = replyLimit.hit(`reply:${tenant.userId}`);
    if (!limit.allowed) {
      reply.status(429).header("Retry-After", String(limit.retryAfterSec));
      return { error: "You are sending messages quickly. Please wait a little." };
    }
    const count = (await db.select({ n: sql<number>`count(*)::int` }).from(supportMessages).where(eq(supportMessages.ticketId, ticket.id)))[0]!.n;
    if (count >= MAX_MESSAGES_PER_TICKET) {
      reply.status(409);
      return { error: "This conversation is very long. Please open a new request." };
    }
    const now = new Date();
    const updated = await db.transaction(async (tx) => {
      await tx.insert(supportMessages).values({ ticketId: ticket.id, tenantId: tenant.id, author: "customer", authorEmail: tenant.userEmail, body: parsed.data.message });
      // A customer's message always puts the request back in the operator's queue.
      const [t] = await tx
        .update(supportTickets)
        .set({ status: "open", closedAt: null, lastMessageAt: now, lastMessageBy: "customer" })
        .where(eq(supportTickets.id, ticket.id))
        .returning();
      return t!;
    });
    return { ticket: view(updated) };
  });

  app.post<{ Params: { id: string } }>("/tickets/:id/close", { config: { minRole: "member" } }, async (request, reply) => {
    const db: Db = request.server.db;
    const ticket = await own(db, request.tenant!.id, request.params.id);
    if (!ticket) {
      reply.status(404);
      return { error: "Request not found." };
    }
    if (ticket.status === "closed") return { ticket: view(ticket) };
    const [t] = await db.update(supportTickets).set({ status: "closed", closedAt: new Date() }).where(eq(supportTickets.id, ticket.id)).returning();
    return { ticket: view(t!) };
  });
};

export default supportRoutes;
