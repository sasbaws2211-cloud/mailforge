/**
 * AppSumo public endpoints (no Loomail login needed; the caller's own credentials decide).
 *
 *   POST /webhooks/appsumo   AppSumo's signed events: purchase, activate, upgrade, downgrade, deactivate.
 *                            Signed with HMAC-SHA256 of `timestamp + body` under APPSUMO_API_KEY.
 *   GET  /appsumo/callback   where AppSumo sends a buyer after they press "Activate": ?code=... is exchanged
 *                            (OAuth) for their licence key, which is claimed at once for a signed-in owner or
 *                            kept for an hour so the Plan page can finish after they sign up.
 *   GET  /redeem             the page given to AppSumo: a box for the code (or ?code=... from a link).
 *   POST /redeem             the same box submitted without JavaScript.
 *
 * AppSumo pings the callback with no code to check it is alive: that answers 200. A webhook is answered 200
 * once it is verified, even for an event we ignore, so AppSumo stops retrying it.
 *
 * Mirror side: PUBLIC (packages/api is mirrored).
 */
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { sql } from "drizzle-orm";
import type { Db } from "../plugins/db.js";
import { SESSION_COOKIE_NAME } from "./auth.js";
import { createLimiter } from "../marketing/signup-logic.js";
import { SITE_NAME, type SiteContext } from "../marketing/layout.js";
import { redeemPage } from "../marketing/pages.js";
import { LifetimeError, claimLicense, findLicense, handleEvent, verifyWebhook } from "../appsumo/lifetime.js";
import { rememberPending } from "../appsumo/pending.js";

const TOKEN_URL = "https://appsumo.com/openid/token/";
const LICENSE_URL = "https://appsumo.com/openid/license_key/";

export interface AppsumoRouteOptions {
  /** Public origin of the site, no trailing slash. */
  siteUrl: string;
  /** Where the dashboard lives, for the redirect after a claim. */
  dashboardUrl: string;
  /** Test seam: replaces the network calls to AppSumo's OAuth endpoints. */
  exchange?: (code: string) => Promise<string>;
}

/** The signed-in owner of a workspace, from the session cookie, or null. */
export async function sessionOwner(db: Db, request: FastifyRequest): Promise<{ tenantId: string; userId: string; email: string } | null> {
  const id = (request.cookies as Record<string, string | undefined> | undefined)?.[SESSION_COOKIE_NAME];
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return null;
  const r = await db.execute<{ tenant_id: string; user_id: string; email: string; role: string }>(sql`
    SELECT s.tenant_id, s.user_id, u.email, u.role
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.id = ${id}::uuid AND s.expires_at > now() AND u.deactivated_at IS NULL LIMIT 1`);
  const row = r.rows[0];
  return row && row.role === "owner" ? { tenantId: row.tenant_id, userId: row.user_id, email: row.email } : null;
}

/** OAuth code -> access token -> licence key. */
async function exchangeWithAppSumo(code: string): Promise<string> {
  try {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: (process.env.APPSUMO_CLIENT_ID ?? "").trim(),
      client_secret: (process.env.APPSUMO_CLIENT_SECRET ?? "").trim(),
      redirect_uri: (process.env.APPSUMO_REDIRECT_URL ?? "").trim(),
    });
    const t = await fetch(TOKEN_URL, { method: "POST", body, signal: AbortSignal.timeout(20_000) });
    if (!t.ok) throw new Error(`token ${t.status}`);
    const token = ((await t.json()) as { access_token?: string }).access_token;
    const r = await fetch(`${LICENSE_URL}?access_token=${encodeURIComponent(token ?? "")}`, { signal: AbortSignal.timeout(20_000) });
    if (!r.ok) throw new Error(`licence ${r.status}`);
    const lic = ((await r.json()) as { license_key?: string }).license_key;
    if (!lic) throw new Error("no licence key");
    return String(lic);
  } catch {
    throw new LifetimeError(502, "Could not confirm your AppSumo licence. Paste the key under Settings, Plan instead.");
  }
}

/** The host of the site address, or "localhost" when the address is not a full URL (a relative one in a test, say). */
function hostOf(siteUrl: string): string {
  try {
    return new URL(siteUrl).hostname;
  } catch {
    return "localhost";
  }
}

const routes: FastifyPluginAsync<AppsumoRouteOptions> = async (app, opts) => {
  const ctx: SiteContext = {
    siteUrl: opts.siteUrl,
    supportEmail: (process.env.LOOMAIL_SUPPORT_EMAIL ?? "").trim() || `support@${hostOf(opts.siteUrl)}`,
    legalName: (process.env.LOOMAIL_LEGAL_NAME ?? "").trim() || SITE_NAME,
  };
  const exchange = opts.exchange ?? exchangeWithAppSumo;
  const attempts = createLimiter({ windowMs: 3_600_000, max: 30 });
  const secure = opts.siteUrl.startsWith("https://");
  const html = (reply: FastifyReply, status: number, body: string) =>
    reply.status(status).header("Content-Type", "text/html; charset=utf-8").header("Cache-Control", "no-store").header("X-Robots-Tag", "noindex, nofollow").send(body);

  // The signature covers the exact bytes AppSumo sent: keep the body as a string and parse it after it is checked.
  // Scoped to this plugin, and the form parser below keeps HTML forms working here too.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => done(null, body));
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) => {
    try {
      done(null, Object.fromEntries(new URLSearchParams(String(body))));
    } catch (err) {
      done(err as Error);
    }
  });

  app.post("/webhooks/appsumo", async (request, reply) => {
    const key = (process.env.APPSUMO_API_KEY ?? "").trim();
    if (!key) return reply.status(503).send({ error: "AppSumo is not configured." });
    const raw = typeof request.body === "string" ? request.body : "";
    const ts = String(request.headers["x-appsumo-timestamp"] ?? "");
    const sig = String(request.headers["x-appsumo-signature"] ?? "");
    if (!verifyWebhook(key, ts, sig, raw)) return reply.status(401).send({ error: "Bad signature." });
    let payload: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(raw || "{}");
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      payload = parsed as Record<string, unknown>;
    } catch {
      return reply.status(400).send({ error: "Body is not JSON." });
    }
    const outcome = await handleEvent(request.server.db as Db, payload, { warn: (m) => request.log.warn(m) });
    request.log.info({ event: payload.event, license: String(payload.license_key ?? "").slice(0, 8), outcome }, "appsumo webhook");
    return { event: payload.event ?? null, success: true };
  });

  // The buyer lands here after activating on AppSumo.
  app.get<{ Querystring: { code?: string } }>("/appsumo/callback", async (request, reply) => {
    const code = (request.query.code ?? "").trim();
    if (!code) return { ok: true }; // AppSumo pings the URL with no code to check it is alive
    const db = request.server.db as Db;
    let license: string;
    try {
      license = await exchange(code);
    } catch (err) {
      const status = err instanceof LifetimeError ? err.httpStatus : 502;
      return html(reply, status, redeemPage(ctx, { error: err instanceof Error ? err.message : "Could not confirm your AppSumo licence." }));
    }
    const owner = await sessionOwner(db, request);
    if (owner) {
      try {
        await claimLicense(db, owner.tenantId, license);
        return reply.redirect("/settings/plan?lifetime=claimed", 303);
      } catch {
        /* fall through: keep it for the Plan page, which says why it could not be claimed */
      }
    }
    rememberPending(reply, license, secure);
    return reply.redirect(owner ? "/settings/plan" : "/signup?code=waiting", 303);
  });

  app.get<{ Querystring: { code?: string; err?: string } }>("/redeem", async (request, reply) => {
    const code = (request.query.code ?? "").trim();
    if (!code) return html(reply, 200, redeemPage(ctx, { error: request.query.err }));
    return handleRedeem(request, reply, code);
  });

  app.post("/redeem", async (request, reply) => {
    const b = (request.body && typeof request.body === "object" ? request.body : {}) as Record<string, unknown>;
    const code = typeof b.code === "string" ? b.code.trim() : "";
    if (!code) return html(reply, 400, redeemPage(ctx, { error: "Enter your code." }));
    return handleRedeem(request, reply, code);
  });

  /** Claim straight away for a signed-in owner; otherwise keep the code and send the buyer to sign up. */
  async function handleRedeem(request: FastifyRequest, reply: FastifyReply, code: string) {
    if (!attempts.hit(request.ip).allowed) return html(reply, 429, redeemPage(ctx, { error: "Too many attempts. Please try again in a while.", code }));
    const db = request.server.db as Db;
    const row = await findLicense(db, code);
    if (!row) return html(reply, 404, redeemPage(ctx, { error: "We do not recognise that code. Check it for typos.", code }));
    const owner = await sessionOwner(db, request);
    if (owner) {
      try {
        await claimLicense(db, owner.tenantId, row.licenseKey);
        return reply.redirect("/settings/plan?lifetime=claimed", 303);
      } catch (err) {
        return html(reply, err instanceof LifetimeError ? err.httpStatus : 400, redeemPage(ctx, { error: err instanceof Error ? err.message : "That did not work.", code }));
      }
    }
    if (row.status === "deactivated" || row.status === "superseded") {
      return html(reply, 400, redeemPage(ctx, { error: "That code is no longer active.", code }));
    }
    if (!rememberPending(reply, row.licenseKey, secure)) {
      return html(reply, 200, redeemPage(ctx, { error: "Create an account or sign in first, then paste your code under Settings, Plan.", code }));
    }
    return reply.redirect("/signup?code=waiting", 303);
  }
};

export default routes;
