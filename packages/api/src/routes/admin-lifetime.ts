/**
 * Platform admin: AppSumo lifetime deals.
 *
 *   GET  /v1/admin/lifetime                  mode, licences sold and left, codes, which settings are present, recent
 *                                            licences and webhooks
 *   PUT  /v1/admin/lifetime/settings         { mode?, cap?, reason }   the billing mode and the number of licences to sell
 *   POST /v1/admin/lifetime/codes            { count, tier?, reason }  make new unused codes for the CSV given to AppSumo
 *   GET  /v1/admin/lifetime/codes.csv        the CSV AppSumo asks for (?all=true for every code ever made)
 *   POST /v1/admin/lifetime/codes/refund     { code, reason }          void a code Loomail generated
 *
 * Licences that AppSumo reports by webhook are never created, upgraded or refunded here: AppSumo forbids
 * editing them by hand, so only the webhook changes them. The one thing an operator can refund is a code
 * Loomail generated itself, which is ours.
 *
 * Registered inside the admin plugin, so the same gate and audit log apply.
 *
 * Mirror side: PUBLIC (packages/api is mirrored).
 */
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { desc } from "drizzle-orm";
import { adminAuditLog, appsumoEvents } from "@loomail/db/schema";
import type { Db } from "../plugins/db.js";
import {
  BILLING_MODES,
  LifetimeError,
  appsumoStatus,
  codesCsv,
  codesSummary,
  deactivateLicense,
  findLicense,
  generateCodes,
  getMode,
  recentLicenses,
  setCap,
  setMode,
  spots,
} from "../appsumo/lifetime.js";

const MAX_REASON = 300;

function cleanReason(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 && t.length <= MAX_REASON ? t : null;
}

const needReason = (reply: FastifyReply) =>
  reply.status(400).send({ error: `Give a reason (up to ${MAX_REASON} characters). It is kept in the audit log.`, code: "reason_required" });

const routes: FastifyPluginAsync = async (app) => {
  async function audit(db: Db, request: FastifyRequest, action: string, detail: Record<string, unknown>) {
    await db.insert(adminAuditLog).values({
      actorUserId: request.platformAdmin!.id,
      actorEmail: request.platformAdmin!.email,
      action,
      tenantId: null,
      detail,
    });
  }

  app.get("/lifetime", { config: { minRole: "member" } }, async (request) => {
    const db = request.server.db as Db;
    const [mode, sp, codes, licenses, events] = await Promise.all([
      getMode(db),
      spots(db),
      codesSummary(db),
      recentLicenses(db, 50),
      db.select().from(appsumoEvents).orderBy(desc(appsumoEvents.receivedAt)).limit(20),
    ]);
    return {
      mode,
      modes: BILLING_MODES,
      spots: sp,
      codes,
      appsumo: appsumoStatus(),
      webhook_path: "/webhooks/appsumo",
      callback_path: "/appsumo/callback",
      redeem_path: "/redeem",
      licenses,
      events: events.map((e) => ({ event: e.event, license: e.licenseKey ? `${e.licenseKey.slice(0, 8)}…` : "", outcome: e.outcome, at: e.receivedAt.toISOString() })),
    };
  });

  app.put<{ Body: { mode?: unknown; cap?: unknown; reason?: unknown } }>("/lifetime/settings", { config: { minRole: "member" } }, async (request, reply) => {
    const db = request.server.db as Db;
    const reason = cleanReason(request.body?.reason);
    if (!reason) return needReason(reply);
    const by = request.platformAdmin!.email;
    const before = { mode: await getMode(db), cap: (await spots(db)).cap };
    const after = { ...before };
    try {
      if (request.body?.mode !== undefined) after.mode = await setMode(db, String(request.body.mode), by);
    } catch (err) {
      if (err instanceof LifetimeError) return reply.status(err.httpStatus).send({ error: err.message, code: "invalid_mode" });
      throw err;
    }
    if (request.body?.cap !== undefined) {
      const n = Number(request.body.cap);
      if (!Number.isFinite(n) || n < 0) return reply.status(400).send({ error: "The number of licences must be 0 or more.", code: "invalid_cap" });
      after.cap = await setCap(db, n, by);
    }
    await audit(db, request, "lifetime_settings", { reason, before, after });
    return { ok: true, mode: after.mode, spots: await spots(db) };
  });

  app.post<{ Body: { count?: unknown; tier?: unknown; reason?: unknown } }>("/lifetime/codes", { config: { minRole: "member" } }, async (request, reply) => {
    const db = request.server.db as Db;
    const reason = cleanReason(request.body?.reason);
    if (!reason) return needReason(reply);
    const count = Number(request.body?.count);
    if (!Number.isInteger(count) || count < 1 || count > 10_000) {
      return reply.status(400).send({ error: "Make between 1 and 10,000 codes at a time.", code: "invalid_count" });
    }
    const tier = request.body?.tier === undefined ? 1 : Number(request.body.tier);
    const made = await generateCodes(db, count, tier);
    await audit(db, request, "lifetime_codes_generated", { reason, made: made.length, tier });
    return { made: made.length, codes: await codesSummary(db) };
  });

  app.get<{ Querystring: { all?: string } }>("/lifetime/codes.csv", { config: { minRole: "member" } }, async (request, reply) => {
    const db = request.server.db as Db;
    const all = request.query.all === "true";
    const csv = await codesCsv(db, !all);
    return reply
      .header("Content-Type", "text/csv; charset=utf-8")
      .header("Content-Disposition", `attachment; filename="${all ? "loomail-codes-all.csv" : "loomail-codes-unused.csv"}"`)
      .header("Cache-Control", "no-store")
      .send(csv);
  });

  app.post<{ Body: { code?: unknown; reason?: unknown } }>("/lifetime/codes/refund", { config: { minRole: "member" } }, async (request, reply) => {
    const db = request.server.db as Db;
    const reason = cleanReason(request.body?.reason);
    if (!reason) return needReason(reply);
    const code = typeof request.body?.code === "string" ? request.body.code.trim() : "";
    const row = code ? await findLicense(db, code) : null;
    if (!row) return reply.status(404).send({ error: "No such code.", code: "code_not_found" });
    if (row.source !== "code") {
      return reply.status(409).send({
        error: "That licence came from AppSumo, which reports refunds itself. It is deactivated automatically when AppSumo sends the refund.",
        code: "appsumo_licence",
      });
    }
    const result = await deactivateLicense(db, row.licenseKey, "admin refund");
    await audit(db, request, "lifetime_code_refunded", { reason, code: row.licenseKey, result });
    return { ok: true, result, codes: await codesSummary(db) };
  });
};

export default routes;
