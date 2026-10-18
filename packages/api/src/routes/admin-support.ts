/**
 * Platform admin: support requests from every workspace.
 *
 *   GET  /v1/admin/support?status=open|answered|closed|all&q&limit&offset   the queue, with a count of each status
 *   GET  /v1/admin/support/:id                                              one request with its thread and its workspace
 *   POST /v1/admin/support/:id/reply          answer (optionally closing it); the answer is also emailed to the requester
 *   POST /v1/admin/support/:id/status         close or reopen without a message
 *
 * Registered inside the admin plugin, so the same gate applies: only platform admins get in, everyone else sees a plain 404
 * (or 401 on the standalone console). Every answer and status change is recorded in admin_audit_log in the same transaction;
 * the text of an answer is not copied there (the thread keeps it), only that it happened and whether it closed the request.
 *
 * Mirror side: PUBLIC (packages/api is mirrored).
 */
import type { FastifyPluginAsync } from "fastify";
import { and, desc, asc, eq, ilike, or, sql } from "drizzle-orm";
import { adminAuditLog, supportMessages, supportTickets, tenants } from "@loomail/db/schema";
import type { Db } from "../plugins/db.js";
import type { PlatformTransport } from "../platform-mailer.js";
import { MAX_MESSAGES_PER_TICKET, TICKET_STATUSES, adminReplySchema, isUuid, statusSchema, type TicketStatus } from "../support/logic.js";
import { sendReplyToCustomer } from "../support/mail.js";

export interface AdminSupportOptions {
  dashboardUrl: string;
  noticeTransports?: PlatformTransport[];
}

const like = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

const adminSupportRoutes: FastifyPluginAsync<AdminSupportOptions> = async (app, opts) => {
  app.get<{ Querystring: { status?: string; q?: string; limit?: string; offset?: string } }>("/support", { config: { minRole: "member" } }, async (request) => {
    const db: Db = request.server.db;
    const status = request.query.status ?? "open";
    const q = (request.query.q ?? "").trim().slice(0, 100);
    const limit = Math.min(100, Math.max(1, Number(request.query.limit) || 50));
    const offset = Math.max(0, Number(request.query.offset) || 0);

    const filters = [
      ...(TICKET_STATUSES.includes(status as TicketStatus) ? [eq(supportTickets.status, status)] : []),
      ...(q ? [or(ilike(supportTickets.subject, like(q)), ilike(supportTickets.email, like(q)), ilike(tenants.name, like(q)))!] : []),
    ];
    const rows = await db
      .select({ t: supportTickets, workspaceName: tenants.name, workspaceSlug: tenants.slug, plan: tenants.plan })
      .from(supportTickets)
      .innerJoin(tenants, eq(tenants.id, supportTickets.tenantId))
      .where(filters.length ? and(...filters) : undefined)
      // What is waiting longest comes first; answered and closed ones, newest first.
      .orderBy(status === "open" ? asc(supportTickets.lastMessageAt) : desc(supportTickets.lastMessageAt))
      .limit(limit)
      .offset(offset);
    const counts = await db.execute<{ status: string; n: number }>(sql`SELECT status, count(*)::int AS n FROM support_tickets GROUP BY status`);
    const byStatus = { open: 0, answered: 0, closed: 0 } as Record<string, number>;
    for (const r of counts.rows) byStatus[r.status] = Number(r.n);
    return {
      counts: byStatus,
      tickets: rows.map((r) => ({
        id: r.t.id,
        subject: r.t.subject,
        category: r.t.category,
        status: r.t.status,
        requester: r.t.email,
        workspace: { id: r.t.tenantId, name: r.workspaceName, slug: r.workspaceSlug, plan: r.plan },
        created_at: r.t.createdAt.toISOString(),
        last_message_at: r.t.lastMessageAt.toISOString(),
        last_message_by: r.t.lastMessageBy,
      })),
    };
  });

  const load = async (db: Db, id: string) => {
    if (!isUuid(id)) return undefined;
    return (
      await db
        .select({ t: supportTickets, workspaceName: tenants.name, workspaceSlug: tenants.slug, plan: tenants.plan })
        .from(supportTickets)
        .innerJoin(tenants, eq(tenants.id, supportTickets.tenantId))
        .where(eq(supportTickets.id, id))
        .limit(1)
    )[0];
  };

  app.get<{ Params: { id: string } }>("/support/:id", { config: { minRole: "member" } }, async (request, reply) => {
    const db: Db = request.server.db;
    const row = await load(db, request.params.id);
    if (!row) {
      reply.status(404);
      return { error: "Request not found." };
    }
    const messages = await db.select().from(supportMessages).where(eq(supportMessages.ticketId, row.t.id)).orderBy(supportMessages.createdAt, supportMessages.id);
    return {
      ticket: {
        id: row.t.id,
        subject: row.t.subject,
        category: row.t.category,
        status: row.t.status,
        page_url: row.t.pageUrl,
        requester: row.t.email,
        created_at: row.t.createdAt.toISOString(),
        last_message_at: row.t.lastMessageAt.toISOString(),
        last_message_by: row.t.lastMessageBy,
        closed_at: row.t.closedAt ? row.t.closedAt.toISOString() : null,
      },
      workspace: { id: row.t.tenantId, name: row.workspaceName, slug: row.workspaceSlug, plan: row.plan },
      messages: messages.map((m) => ({ id: m.id, author: m.author, author_email: m.authorEmail, body: m.body, created_at: m.createdAt.toISOString() })),
    };
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/support/:id/reply", { config: { minRole: "member" } }, async (request, reply) => {
    const db: Db = request.server.db;
    const actor = request.platformAdmin!;
    const row = await load(db, request.params.id);
    if (!row) {
      reply.status(404);
      return { error: "Request not found." };
    }
    const parsed = adminReplySchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: "Validation failed", issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) };
    }
    const count = (await db.select({ n: sql<number>`count(*)::int` }).from(supportMessages).where(eq(supportMessages.ticketId, row.t.id)))[0]!.n;
    if (count >= MAX_MESSAGES_PER_TICKET) {
      reply.status(409);
      return { error: "This conversation has reached its length limit." };
    }
    const close = parsed.data.close === true;
    const now = new Date();
    const saved = await db.transaction(async (tx) => {
      const [m] = await tx.insert(supportMessages).values({ ticketId: row.t.id, tenantId: row.t.tenantId, author: "staff", authorEmail: actor.email, body: parsed.data.message }).returning();
      await tx
        .update(supportTickets)
        .set({ status: close ? "closed" : "answered", closedAt: close ? now : null, lastMessageAt: now, lastMessageBy: "staff" })
        .where(eq(supportTickets.id, row.t.id));
      await tx.insert(adminAuditLog).values({
        actorUserId: actor.id,
        actorEmail: actor.email,
        action: "support_reply",
        tenantId: row.t.tenantId,
        detail: { ticket_id: row.t.id, closed: close, reason: "Answered a support request" },
      });
      return m!;
    });

    const emailed = await sendReplyToCustomer(
      { transports: opts.noticeTransports, log: request.log },
      {
        ticketId: row.t.id,
        messageId: saved.id,
        subject: row.t.subject,
        to: row.t.email,
        reply: parsed.data.message,
        closed: close,
        threadUrl: `${opts.dashboardUrl.replace(/\/+$/, "")}/support/${row.t.id}`,
      },
    ).catch(() => false);
    return { ok: true, status: close ? "closed" : "answered", emailed };
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/support/:id/status", { config: { minRole: "member" } }, async (request, reply) => {
    const db: Db = request.server.db;
    const actor = request.platformAdmin!;
    const row = await load(db, request.params.id);
    if (!row) {
      reply.status(404);
      return { error: "Request not found." };
    }
    const parsed = statusSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: "Validation failed", issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) };
    }
    const closing = parsed.data.status === "closed";
    await db.transaction(async (tx) => {
      await tx.update(supportTickets).set({ status: parsed.data.status, closedAt: closing ? new Date() : null }).where(eq(supportTickets.id, row.t.id));
      await tx.insert(adminAuditLog).values({
        actorUserId: actor.id,
        actorEmail: actor.email,
        action: closing ? "support_close" : "support_reopen",
        tenantId: row.t.tenantId,
        detail: { ticket_id: row.t.id, reason: closing ? "Closed a support request" : "Reopened a support request" },
      });
    });
    return { ok: true, status: parsed.data.status };
  });
};

export default adminSupportRoutes;
