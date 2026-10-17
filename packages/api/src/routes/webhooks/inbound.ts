/**
 * Inbound webhook endpoint: POST /webhooks/in/:sourceId
 *
 * Public, not session-authenticated: the source's own credentials decide.
 *
 *   generic source  a token Loomail made for it, sent as `Authorization: Bearer <token>`, an `X-Loomail-Token` header,
 *                   or `?token=` (for tools that cannot set headers). Only the token's SHA-256 is stored.
 *   stripe source   Stripe's `Stripe-Signature`, checked against the endpoint signing secret saved on the source.
 *
 * Every failure to authenticate (unknown source, disabled source, bad token or signature) answers the same 401 with the
 * same words, so the URL cannot be used to find out which sources exist. Past authentication the request is read
 * (the raw body is kept: Stripe signs the exact bytes), mapped (inbound/mapping.ts) and applied (inbound/process.ts),
 * and one line goes in the source's log.
 *
 * Answers: 200 when the request was handled or deliberately ignored (an event type Loomail does not use). Stripe stops
 * retrying on any 2xx, so an unusable event is acknowledged, not rejected. 400 for a body that cannot be read. 402
 * when a plan limit stopped a new contact. 429 past 600 requests a minute per source.
 *
 * Mirror side: PUBLIC (packages/api is mirrored).
 */
import type { FastifyPluginAsync } from "fastify";
import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { eq, sql } from "drizzle-orm";
import { PlanLimitError } from "@loomail/core";
import { openWebhookSecret } from "@loomail/adapters";
import { inboundSources, inboundSourceLog } from "@loomail/db/schema";
import type { Db } from "../../plugins/db.js";
import { createLimiter } from "../../marketing/signup-logic.js";
import { genericConfigSchema, mapGeneric, mapStripeEvent, stripeConfigSchema, verifyStripeSignature, type MapResult } from "../../inbound/mapping.js";
import { applyMapped } from "../../inbound/process.js";

export const INBOUND_BODY_LIMIT = 512 * 1024;
export const INBOUND_REQUESTS_PER_MINUTE = 600;
/** A source that is being hammered with bad credentials logs only this many rejections a minute. */
const REJECT_LOG_PER_MINUTE = 20;

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

const UNAUTHORIZED = { error: "Unauthorized." };

function safeEqualHex(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

const inboundWebhookRoute: FastifyPluginAsync = async (app) => {
  const rate = createLimiter({ windowMs: 60_000, max: INBOUND_REQUESTS_PER_MINUTE });
  const rejectLog = createLimiter({ windowMs: 60_000, max: REJECT_LOG_PER_MINUTE });

  // Keep the body as text: Stripe signs the exact bytes.
  app.addContentTypeParser("application/json", { parseAs: "string", bodyLimit: INBOUND_BODY_LIMIT }, (_req, body, done) => done(null, body));
  app.addContentTypeParser("text/plain", { parseAs: "string", bodyLimit: INBOUND_BODY_LIMIT }, (_req, body, done) => done(null, body));

  app.post<{ Params: { sourceId: string }; Querystring: { token?: string } }>(
    "/:sourceId",
    { bodyLimit: INBOUND_BODY_LIMIT },
    async (request, reply) => {
      if (!request.server.db) {
        reply.status(503);
        return { error: "Service unavailable." };
      }
      const db: Db = request.server.db;
      const idOk = z.string().uuid().safeParse(request.params.sourceId);
      if (!idOk.success) {
        reply.status(401);
        return UNAUTHORIZED;
      }
      const sourceId = idOk.data;

      const limit = rate.hit(sourceId);
      if (!limit.allowed) {
        reply.status(429).header("Retry-After", String(limit.retryAfterSec));
        return { error: "Too many requests." };
      }

      const source = (await db.select().from(inboundSources).where(eq(inboundSources.id, sourceId)).limit(1))[0];
      if (!source || !source.enabled) {
        reply.status(401);
        return UNAUTHORIZED;
      }

      const log = async (status: "processed" | "ignored" | "rejected" | "error", summary: string) => {
        if (status === "rejected" && !rejectLog.hit(`rej:${sourceId}`).allowed) return;
        await db.insert(inboundSourceLog).values({ tenantId: source.tenantId, sourceId, status, summary: summary.slice(0, 500) }).catch(() => {});
      };
      const rawBody = typeof request.body === "string" ? request.body : "";

      // --- Authenticate ---------------------------------------------------
      let authorised = false;
      if (source.kind === "stripe") {
        const header = request.headers["stripe-signature"];
        if (typeof header === "string" && source.secretSealed) {
          try {
            authorised = verifyStripeSignature(openWebhookSecret(source.secretSealed), header, rawBody, Math.floor(Date.now() / 1000));
          } catch {
            authorised = false;
          }
        }
      } else if (source.tokenHash) {
        const auth = request.headers.authorization;
        const bearer = typeof auth === "string" && /^Bearer\s+/i.test(auth) ? auth.replace(/^Bearer\s+/i, "").trim() : undefined;
        const headerToken = request.headers["x-loomail-token"];
        const given = bearer ?? (typeof headerToken === "string" ? headerToken : undefined) ?? request.query.token;
        authorised = typeof given === "string" && given !== "" && safeEqualHex(sha256(given), source.tokenHash);
      }
      if (!authorised) {
        await log("rejected", source.kind === "stripe" ? "Signature check failed." : "Token missing or wrong.");
        reply.status(401);
        return UNAUTHORIZED;
      }

      // --- Read -----------------------------------------------------------
      let body: unknown;
      try {
        body = JSON.parse(rawBody);
      } catch {
        await log("rejected", "The body is not valid JSON.");
        reply.status(400);
        return { error: "The body is not valid JSON." };
      }

      // --- Map ------------------------------------------------------------
      let result: MapResult;
      if (source.kind === "stripe") {
        const cfg = stripeConfigSchema.safeParse(source.config);
        result = mapStripeEvent(body, cfg.success ? cfg.data : { user_id_metadata_key: "user_id" });
      } else {
        const cfg = genericConfigSchema.safeParse(source.config);
        if (!cfg.success) {
          await log("error", "This source's settings are not valid. Open it in the dashboard and save it again.");
          reply.status(500);
          return { error: "This source is not set up correctly." };
        }
        const eventId = request.headers["x-loomail-event-id"];
        result = mapGeneric(cfg.data, body, typeof eventId === "string" && eventId !== "" ? `in:${sourceId}:${eventId.slice(0, 200)}` : undefined);
      }
      if (!result.ok) {
        await log(result.status, result.reason);
        if (result.status === "rejected") {
          reply.status(400);
          return { error: result.reason };
        }
        return { ok: true, ignored: true };
      }

      // --- Apply ----------------------------------------------------------
      try {
        const applied = await applyMapped(db, request.server.enqueue, source.tenantId, sourceId, result.mapped);
        await db.update(inboundSources).set({ lastReceivedAt: new Date() }).where(eq(inboundSources.id, sourceId));
        if (!applied.applied) {
          await log("ignored", applied.reason);
          return { ok: true, ignored: true };
        }
        await log("processed", applied.summary);
        return { ok: true };
      } catch (err) {
        if (err instanceof PlanLimitError) {
          await log("error", err.message);
          reply.status(402);
          return err.toJSON();
        }
        request.log.error({ err }, "inbound webhook failed");
        await log("error", "Something went wrong saving this request. It can be sent again.");
        reply.status(500);
        return { error: "Something went wrong. Try again." };
      }
    },
  );
};

export default inboundWebhookRoute;
