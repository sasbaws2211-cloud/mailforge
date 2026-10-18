/**
 * Inbound webhook endpoint: POST /webhooks/in/:sourceId
 *
 * Public, not session-authenticated: the source's own credentials decide.
 *
 *   generic source  a token Loomail made for it, sent as `Authorization: Bearer <token>`, an `X-Loomail-Token` header,
 *                   or `?token=` (for tools that cannot set headers). Only the token's SHA-256 is stored.
 *   stripe source   Stripe's `Stripe-Signature`, checked against the endpoint signing secret saved on the source.
 *   paystack source either a token (in the address, or a header) with an optional check of Paystack's published sender
 *                   addresses, or Paystack's `x-paystack-signature` (HMAC-SHA512 made with the account's secret key).
 *   flutterwave     the secret hash Loomail made, which Flutterwave sends back unchanged in the `verif-hash` header.
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
import { genericConfigSchema, getPath, mapGeneric, mapStripeEvent, stripeConfigSchema, verifyHmacSignature, verifyStripeSignature, type MapResult } from "../../inbound/mapping.js";
import {
  PAYSTACK_IPS,
  flutterwaveConfigSchema,
  mapFlutterwaveEvent,
  mapPaystackEvent,
  paystackConfigSchema,
  verifyPaystackSignature,
} from "../../inbound/african-gateways.js";
import { applyMapped } from "../../inbound/process.js";

export const INBOUND_BODY_LIMIT = 512 * 1024;
export const INBOUND_REQUESTS_PER_MINUTE = 600;
/** A source that is being hammered with bad credentials logs only this many rejections a minute. */
const REJECT_LOG_PER_MINUTE = 20;

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

const UNAUTHORIZED = { error: "Unauthorized." };

/** A form-encoded body as a flat object. A key sent more than once becomes a list. Values stay text. */
export function formToObject(raw: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of new URLSearchParams(raw)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
    const had = Object.prototype.hasOwnProperty.call(out, key) ? out[key]! : undefined;
    out[key] = had === undefined ? value : Array.isArray(had) ? [...had, value] : [had, value];
  }
  return out;
}

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
  // Some tools (Zapier's default "Form" payload, plain HTML forms) post key=value pairs instead of JSON.
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string", bodyLimit: INBOUND_BODY_LIMIT }, (_req, body, done) => done(null, body));

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
      let failure = "Token missing or wrong.";
      const tokenGiven = (): string | undefined => {
        const auth = request.headers.authorization;
        const bearer = typeof auth === "string" && /^Bearer\s+/i.test(auth) ? auth.replace(/^Bearer\s+/i, "").trim() : undefined;
        const headerToken = request.headers["x-loomail-token"];
        return bearer ?? (typeof headerToken === "string" ? headerToken : undefined) ?? request.query.token;
      };
      const tokenOk = (given: string | undefined) => typeof given === "string" && given !== "" && !!source.tokenHash && safeEqualHex(sha256(given), source.tokenHash);
      if (source.kind === "paystack") {
        const cfg = paystackConfigSchema.safeParse(source.config);
        const c = cfg.success ? cfg.data : paystackConfigSchema.parse({});
        const from = request.ip.replace(/^::ffff:/, "");
        if (c.require_paystack_ip && !(PAYSTACK_IPS as readonly string[]).includes(from)) {
          failure = "The call did not come from a Paystack address.";
        } else if (c.verification === "signature") {
          failure = "Signature check failed.";
          const header = request.headers["x-paystack-signature"];
          if (typeof header === "string" && source.secretSealed) {
            try {
              authorised = verifyPaystackSignature(openWebhookSecret(source.secretSealed), header, rawBody);
            } catch {
              authorised = false;
            }
          }
        } else {
          authorised = tokenOk(tokenGiven());
        }
      } else if (source.kind === "flutterwave") {
        const header = request.headers["verif-hash"];
        authorised = tokenOk(typeof header === "string" ? header : undefined);
        failure = "The verif-hash header is missing or wrong.";
      } else if (source.kind === "stripe") {
        failure = "Signature check failed.";
        const header = request.headers["stripe-signature"];
        if (typeof header === "string" && source.secretSealed) {
          try {
            authorised = verifyStripeSignature(openWebhookSecret(source.secretSealed), header, rawBody, Math.floor(Date.now() / 1000));
          } catch {
            authorised = false;
          }
        }
      } else {
        // A generic source is checked by its token, or, when it was made that way, by the sender's own HMAC signature.
        const generic = source.kind === "generic" ? genericConfigSchema.safeParse(source.config) : null;
        if (generic?.success && generic.data.verification === "signature") {
          failure = "Signature check failed.";
          const header = request.headers[(generic.data.signature_header ?? "").toLowerCase()];
          if (typeof header === "string" && source.secretSealed) {
            try {
              authorised = verifyHmacSignature(openWebhookSecret(source.secretSealed), rawBody, header, { encoding: generic.data.signature_encoding, prefix: generic.data.signature_prefix });
            } catch {
              authorised = false;
            }
          }
        } else {
          authorised = tokenOk(tokenGiven());
        }
      }
      if (!authorised) {
        await log("rejected", failure);
        reply.status(401);
        return UNAUTHORIZED;
      }

      // --- Read -----------------------------------------------------------
      let body: unknown;
      const isForm = String(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/x-www-form-urlencoded");
      if (isForm && source.kind === "generic") {
        body = formToObject(rawBody);
      } else {
        try {
          body = JSON.parse(rawBody);
        } catch {
          const why = isForm ? "This source reads JSON. Send the body as JSON (in Zapier, set Payload Type to JSON)." : "The body is not valid JSON.";
          await log("rejected", why);
          reply.status(400);
          return { error: why };
        }
      }

      // --- Map ------------------------------------------------------------
      let result: MapResult;
      const fingerprint = sha256(rawBody).slice(0, 16);
      const nowSeconds = Math.floor(Date.now() / 1000);
      if (source.kind === "stripe") {
        const cfg = stripeConfigSchema.safeParse(source.config);
        result = mapStripeEvent(body, cfg.success ? cfg.data : { user_id_metadata_key: "user_id" });
      } else if (source.kind === "paystack") {
        const cfg = paystackConfigSchema.safeParse(source.config);
        result = mapPaystackEvent(body, cfg.success ? cfg.data : paystackConfigSchema.parse({}), fingerprint, nowSeconds);
      } else if (source.kind === "flutterwave") {
        const cfg = flutterwaveConfigSchema.safeParse(source.config);
        result = mapFlutterwaveEvent(body, cfg.success ? cfg.data : flutterwaveConfigSchema.parse({}), nowSeconds);
      } else {
        const cfg = genericConfigSchema.safeParse(source.config);
        if (!cfg.success) {
          await log("error", "This source's settings are not valid. Open it in the dashboard and save it again.");
          reply.status(500);
          return { error: "This source is not set up correctly." };
        }
        // The id that makes a repeat harmless: the header if the sender set one, else the one in the payload.
        const header = request.headers["x-loomail-event-id"];
        const inBody = cfg.data.event_id_path ? getPath(body, cfg.data.event_id_path) : undefined;
        const bodyId = typeof inBody === "string" && inBody.trim() !== "" ? inBody.trim() : typeof inBody === "number" && Number.isFinite(inBody) ? String(inBody) : undefined;
        const named = cfg.data.event_id_header ? request.headers[cfg.data.event_id_header.toLowerCase()] : undefined;
        const headerNamed = typeof named === "string" && named.trim() !== "" ? named.trim() : undefined;
        const ownId = typeof header === "string" && header !== "";
        const eventId = ownId ? (header as string) : (headerNamed ?? bodyId);
        const nameHeader = cfg.data.event_name_header ? request.headers[cfg.data.event_name_header.toLowerCase()] : undefined;
        result = mapGeneric(cfg.data, body, eventId ? `in:${sourceId}:${eventId.slice(0, 200)}` : undefined, { eventNameFromHeader: typeof nameHeader === "string" ? nameHeader : undefined, idFromSettings: !ownId });
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
