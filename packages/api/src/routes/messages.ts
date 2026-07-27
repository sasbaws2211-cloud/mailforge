/**
 * Message approval routes.
 *
 * All routes require session-cookie authentication (dashboard operator scope).
 * They are registered under the /v1 prefix inside the authenticated scope.
 *
 * Endpoints:
 *   GET   /v1/messages           list messages pending approval (cursor-paginated)
 *   POST  /v1/messages/:id/approve   advance pending_approval -> approved
 *   POST  /v1/messages/:id/reject    advance pending_approval -> rejected (terminal)
 *
 * CAS conventions: approve and reject use WHERE status = 'pending_approval'
 * to guarantee atomic state transitions. Approving an already-approved message
 * returns 200 (idempotent no-op). Rejecting a non-pending_approval message
 * returns 409 (terminal means no going back).
 *
 * Tenant isolation: messages belonging to another tenant return 404.
 *
 * Mirror side: PUBLIC (packages/api is mirrored).
 */
import type { FastifyPluginAsync } from "fastify";
import { sql } from "drizzle-orm";
import type { Db } from "../plugins/db.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default page size for GET /v1/messages list. */
const DEFAULT_PAGE_SIZE = 50;

/** Maximum page size for GET /v1/messages list. */
const MAX_PAGE_SIZE = 200;

// ---------------------------------------------------------------------------
// Cursor helpers (same convention as GET /v1/suppressions and GET /v1/kb)
// ---------------------------------------------------------------------------

interface CursorPayload {
  created_at: string;
  id: string;
}

function encodeCursor(createdAt: Date | string | null | undefined, id: string): string {
  const ts = createdAt instanceof Date
    ? createdAt.toISOString()
    : (createdAt ?? new Date(0).toISOString());
  const payload: CursorPayload = { created_at: ts, id };
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

function decodeCursor(cursor: string): CursorPayload | null {
  try {
    const json = Buffer.from(cursor, "base64url").toString("utf8");
    const parsed = JSON.parse(json) as unknown;
    if (
      typeof parsed !== "object" || parsed === null ||
      typeof (parsed as Record<string, unknown>).created_at !== "string" ||
      typeof (parsed as Record<string, unknown>).id !== "string"
    ) return null;
    return parsed as CursorPayload;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Route plugin
// ---------------------------------------------------------------------------

const messagesRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /v1/messages
   *
   * List messages at pending_approval for the tenant, cursor-paginated.
   * Optionally filter by ?status= (default: pending_approval).
   *
   * Query params:
   *   ?limit=<n>       default 50, max 200
   *   ?after=<cursor>  opaque cursor from previous page's next_cursor
   *   ?status=<status> filter by message status (default: pending_approval)
   *
   * Response: { messages: [...], next_cursor: string | null }
   */
  app.get<{
    Querystring: { limit?: string; after?: string; status?: string };
  }>("/", async (request) => {
    const db: Db = request.server.db;
    const tenantId = request.tenant!.id;

    const rawLimit = parseInt(request.query.limit ?? "", 10);
    const limit = isNaN(rawLimit) || rawLimit < 1
      ? DEFAULT_PAGE_SIZE
      : Math.min(rawLimit, MAX_PAGE_SIZE);
    const fetchLimit = limit + 1;

    const statusFilter = request.query.status ?? "pending_approval";

    let cursor: CursorPayload | null = null;
    if (request.query.after) {
      cursor = decodeCursor(request.query.after);
    }

    let rows: {
      id: string;
      tenant_id: string;
      contact_id: string;
      flow_id: string;
      flow_step_order: number | null;
      status: string;
      subject: string | null;
      body_html: string | null;
      body_text: string | null;
      brain_reasoning: string | null;
      brain_action_type: string | null;
      created_at: string | Date | null;
      updated_at: string | Date | null;
    }[];

    if (cursor) {
      const result = await db.execute<typeof rows[number]>(sql`
        SELECT id, tenant_id, contact_id, flow_id, flow_step_order,
               status, subject, body_html, body_text,
               brain_reasoning, brain_action_type, created_at, updated_at
        FROM lifecycle_messages
        WHERE tenant_id = ${tenantId}
          AND status = ${statusFilter}
          AND ROW(created_at, id) > ROW(${cursor.created_at}::timestamptz, ${cursor.id}::uuid)
        ORDER BY created_at ASC, id ASC
        LIMIT ${fetchLimit}
      `);
      rows = result.rows;
    } else {
      const result = await db.execute<typeof rows[number]>(sql`
        SELECT id, tenant_id, contact_id, flow_id, flow_step_order,
               status, subject, body_html, body_text,
               brain_reasoning, brain_action_type, created_at, updated_at
        FROM lifecycle_messages
        WHERE tenant_id = ${tenantId}
          AND status = ${statusFilter}
        ORDER BY created_at ASC, id ASC
        LIMIT ${fetchLimit}
      `);
      rows = result.rows;
    }

    const hasNextPage = rows.length > limit;
    const pageRows = hasNextPage ? rows.slice(0, limit) : rows;

    const lastRow = pageRows[pageRows.length - 1];
    const nextCursor = hasNextPage && lastRow
      ? encodeCursor(lastRow.created_at, lastRow.id)
      : null;

    return {
      messages: pageRows.map((r) => ({
        id: r.id,
        tenant_id: r.tenant_id,
        contact_id: r.contact_id,
        flow_id: r.flow_id,
        flow_step_order: r.flow_step_order,
        status: r.status,
        subject: r.subject,
        body_html: r.body_html,
        body_text: r.body_text,
        brain_reasoning: r.brain_reasoning,
        brain_action_type: r.brain_action_type,
        created_at: r.created_at,
        updated_at: r.updated_at,
      })),
      next_cursor: nextCursor,
    };
  });

  /**
   * POST /v1/messages/:id/approve
   *
   * Advance a message from pending_approval to approved.
   * Uses CAS: WHERE status = 'pending_approval'.
   *
   * Idempotent: if the message is already approved, returns 200 (no-op).
   * If the message does not exist or belongs to another tenant: 404.
   * If the message is in a different non-approved status: 409 Conflict.
   */
  app.post<{
    Params: { id: string };
  }>("/:id/approve", async (request, reply) => {
    const db: Db = request.server.db;
    const tenantId = request.tenant!.id;
    const messageId = request.params.id;

    // Validate UUID format to avoid Postgres errors
    if (!isUuid(messageId)) {
      reply.status(404);
      return { error: "Message not found." };
    }

    const now = new Date();

    // Attempt CAS: pending_approval -> approved
    const casResult = await db.execute<{ id: string }>(sql`
      UPDATE lifecycle_messages
      SET status = 'approved', approved_at = ${now}, updated_at = ${now}
      WHERE id = ${messageId}
        AND tenant_id = ${tenantId}
        AND status = 'pending_approval'
      RETURNING id
    `);

    if (casResult.rows.length > 0) {
      // Transition succeeded
      return { message: "Message approved.", id: messageId, status: "approved" };
    }

    // CAS did not match. Determine why: not found, wrong tenant, or different status.
    const existing = await db.execute<{ id: string; status: string }>(sql`
      SELECT id, status FROM lifecycle_messages
      WHERE id = ${messageId} AND tenant_id = ${tenantId}
    `);

    if (existing.rows.length === 0) {
      reply.status(404);
      return { error: "Message not found." };
    }

    const currentStatus = existing.rows[0]!.status;

    // Idempotent: already approved is a no-op
    if (currentStatus === "approved") {
      return { message: "Message already approved.", id: messageId, status: "approved" };
    }

    // Any other status: conflict (e.g., already sent, rejected, etc.)
    reply.status(409);
    return {
      error: `Cannot approve message in status '${currentStatus}'.`,
      id: messageId,
      status: currentStatus,
    };
  });

  /**
   * POST /v1/messages/:id/reject
   *
   * Reject a message (terminal). Only from pending_approval.
   * Uses CAS: WHERE status = 'pending_approval'.
   *
   * If the message is already rejected: 200 (idempotent no-op).
   * If the message does not exist or belongs to another tenant: 404.
   * If the message is in any other status: 409 Conflict.
   */
  app.post<{
    Params: { id: string };
  }>("/:id/reject", async (request, reply) => {
    const db: Db = request.server.db;
    const tenantId = request.tenant!.id;
    const messageId = request.params.id;

    if (!isUuid(messageId)) {
      reply.status(404);
      return { error: "Message not found." };
    }

    const now = new Date();

    // Attempt CAS: pending_approval -> rejected
    const casResult = await db.execute<{ id: string }>(sql`
      UPDATE lifecycle_messages
      SET status = 'rejected', updated_at = ${now}
      WHERE id = ${messageId}
        AND tenant_id = ${tenantId}
        AND status = 'pending_approval'
      RETURNING id
    `);

    if (casResult.rows.length > 0) {
      return { message: "Message rejected.", id: messageId, status: "rejected" };
    }

    // Determine cause of CAS failure
    const existing = await db.execute<{ id: string; status: string }>(sql`
      SELECT id, status FROM lifecycle_messages
      WHERE id = ${messageId} AND tenant_id = ${tenantId}
    `);

    if (existing.rows.length === 0) {
      reply.status(404);
      return { error: "Message not found." };
    }

    const currentStatus = existing.rows[0]!.status;

    // Idempotent: already rejected is a no-op
    if (currentStatus === "rejected") {
      return { message: "Message already rejected.", id: messageId, status: "rejected" };
    }

    // Any other status: conflict
    reply.status(409);
    return {
      error: `Cannot reject message in status '${currentStatus}'.`,
      id: messageId,
      status: currentStatus,
    };
  });
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

export default messagesRoutes;
