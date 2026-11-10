/**
 * Redeeming a lifetime licence from inside the dashboard (Settings, Plan).
 *
 *   POST /v1/lifetime/redeem   { license_key?: string }
 *
 * Owners only. With no key given it uses the code the buyer left waiting in this browser (see
 * appsumo/pending.ts), so someone who came from AppSumo only has to press one button after signing up.
 * A second code stacks on the same workspace, up to the top tier.
 *
 * Mirror side: PUBLIC (packages/api is mirrored).
 */
import type { FastifyPluginAsync } from "fastify";
import type { Db } from "../plugins/db.js";
import { createLimiter } from "../marketing/signup-logic.js";
import { LifetimeError, claimLicense } from "../appsumo/lifetime.js";
import { clearPending, readPending } from "../appsumo/pending.js";

const lifetimeRoutes: FastifyPluginAsync = async (app) => {
  // Codes are long and random; this only stops someone trying them in bulk.
  const attempts = createLimiter({ windowMs: 3_600_000, max: 30 });

  app.post<{ Body: { license_key?: unknown } | undefined }>("/redeem", { config: { minRole: "owner" } }, async (request, reply) => {
    const tenantId = request.tenant!.id;
    const typed = typeof request.body?.license_key === "string" ? request.body.license_key.trim() : "";
    const key = typed || readPending(request);
    if (!key) return reply.status(400).send({ error: "Paste your AppSumo code.", code: "code_required" });
    if (!attempts.hit(tenantId).allowed) {
      return reply.status(429).send({ error: "Too many attempts. Please try again in a while.", code: "rate_limited" });
    }
    try {
      const out = await claimLicense(request.server.db as Db, tenantId, key);
      clearPending(reply);
      return { ok: true, ...out };
    } catch (err) {
      if (err instanceof LifetimeError) return reply.status(err.httpStatus).send({ error: err.message, code: "redeem_failed" });
      throw err;
    }
  });
};

export default lifetimeRoutes;
