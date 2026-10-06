/**
 * Account routes for the workspace owner: take your data with you, or erase it.
 *
 *   GET    /v1/account/export     download everything as JSON (owner)
 *   GET    /v1/account/deletion   is deletion scheduled, and when (any member)
 *   POST   /v1/account/deletion   { confirm: <workspace slug> } schedule deletion (owner)
 *   DELETE /v1/account/deletion   cancel a scheduled deletion (owner)
 *
 * These stay available while a deletion is pending (everything else in /v1 is
 * switched off), so the owner can still export their data or change their mind.
 *
 * Mirror side: PUBLIC (packages/api is mirrored).
 */
import { Readable } from "node:stream";
import type { FastifyPluginAsync } from "fastify";
import { eq } from "drizzle-orm";
import { tenants } from "@mailforge/db/schema";
import type { Db } from "../plugins/db.js";
import type { BillingRuntime } from "../billing/config.js";
import { BillingError } from "../billing/service.js";
import { openWorkspaceExport } from "../account/export.js";
import { notifyDeletionCancelled, notifyDeletionScheduled } from "../account/notify.js";
import type { PlatformTransport } from "../platform-mailer.js";
import { cancelDeletion, deletionGraceDays, deletionStatus, scheduleDeletion } from "../account/deletion.js";

/** Exports are heavy; allow a handful an hour per workspace. In memory, per process. */
const EXPORT_LIMIT = 5;
const EXPORT_WINDOW_MS = 3_600_000;
const exportTimes = new Map<string, number[]>();

export function exportAllowed(tenantId: string, now: number = Date.now()): boolean {
  const recent = (exportTimes.get(tenantId) ?? []).filter((t) => now - t < EXPORT_WINDOW_MS);
  if (recent.length >= EXPORT_LIMIT) {
    exportTimes.set(tenantId, recent);
    return false;
  }
  recent.push(now);
  exportTimes.set(tenantId, recent);
  return true;
}

/** Test hook: forget the rate limit state. */
export function resetExportLimit(): void {
  exportTimes.clear();
}

const accountRoutes: FastifyPluginAsync<{ billing?: BillingRuntime; dashboardUrl: string; noticeTransports?: PlatformTransport[] }> = async (app, opts) => {
  app.get("/export", { config: { minRole: "owner" } }, async (request, reply) => {
    const db: Db = request.server.db;
    const tenantId = request.tenant!.id;
    if (!exportAllowed(tenantId)) {
      return reply.status(429).send({ error: "You have exported several times in the last hour. Try again later.", code: "export_rate_limited" });
    }
    const exp = await openWorkspaceExport(db, tenantId);
    if (!exp) return reply.status(404).send({ error: "Workspace not found." });
    reply
      .header("Content-Type", "application/json; charset=utf-8")
      .header("Content-Disposition", `attachment; filename="${exp.filename}"`)
      .header("Cache-Control", "no-store");
    return reply.send(Readable.from(exp.chunks));
  });

  app.get("/deletion", { config: { minRole: "member" } }, async (request) => {
    const db: Db = request.server.db;
    const tenantId = request.tenant!.id;
    const [status, [t]] = await Promise.all([
      deletionStatus(db, tenantId),
      db.select({ name: tenants.name, slug: tenants.slug }).from(tenants).where(eq(tenants.id, tenantId)).limit(1),
    ]);
    return {
      scheduled: status.scheduled,
      requested_at: status.requestedAt?.toISOString() ?? null,
      scheduled_at: status.scheduledAt?.toISOString() ?? null,
      requested_by: status.requestedBy,
      grace_days: deletionGraceDays(),
      workspace: { name: t?.name ?? "", slug: t?.slug ?? "" },
    };
  });

  app.post<{ Body: { confirm?: unknown } }>("/deletion", { config: { minRole: "owner" } }, async (request, reply) => {
    const db: Db = request.server.db;
    const tenantId = request.tenant!.id;
    const [t] = await db.select({ slug: tenants.slug }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
    if (!t) return reply.status(404).send({ error: "Workspace not found." });
    const confirm = typeof request.body?.confirm === "string" ? request.body.confirm.trim() : "";
    if (confirm !== t.slug) {
      return reply.status(400).send({ error: "Type the workspace name exactly as shown to confirm.", code: "confirmation_mismatch" });
    }
    try {
      const scheduledAt = await scheduleDeletion(db, opts.billing, { tenantId, requestedBy: request.tenant!.userEmail });
      if (!scheduledAt) return reply.status(409).send({ error: "Deletion is already scheduled.", code: "already_scheduled" });
      await notifyDeletionScheduled(db, {
        tenantId,
        scheduledAt,
        requestedBy: request.tenant!.userEmail,
        byAdmin: false,
        dashboardUrl: opts.dashboardUrl,
        log: request.log,
        transports: opts.noticeTransports,
      });
      return { ok: true, scheduled_at: scheduledAt.toISOString() };
    } catch (err) {
      if (err instanceof BillingError) {
        return reply.status(502).send({ error: `We could not cancel your subscription, so nothing was scheduled: ${err.message}`, code: err.code });
      }
      throw err;
    }
  });

  app.delete("/deletion", { config: { minRole: "owner" } }, async (request, reply) => {
    const cancelled = await cancelDeletion(request.server.db as Db, request.tenant!.id);
    if (!cancelled) return reply.status(409).send({ error: "No deletion is scheduled.", code: "not_scheduled" });
    await notifyDeletionCancelled(request.server.db as Db, {
      tenantId: request.tenant!.id,
      requestedBy: request.tenant!.userEmail,
      byAdmin: false,
      dashboardUrl: opts.dashboardUrl,
      log: request.log,
      transports: opts.noticeTransports,
    });
    return { ok: true };
  });
};

export default accountRoutes;
