/**
 * The platform admin console as its own deployment.
 *
 * A second Fastify app, started on its own port (and so, behind a reverse proxy,
 * its own hostname such as admin.example.com). It shares the database with the
 * customer app and nothing else:
 *
 *   - its own sign-in: an emailed link, available only to addresses listed in
 *     MAILFORGE_PLATFORM_ADMINS (see admin/auth-routes.ts). Admins are people, not
 *     members of any workspace, so they need no workspace account.
 *   - its own session cookie (a different name from the customer app, so the two
 *     can never be mistaken for each other even on the same host name).
 *   - the admin API (/v1/admin/*) authenticated by that session only.
 *   - its own page (admin.html) and nothing of the customer dashboard.
 *
 * When this runs, the customer app is started with adminEmbedded: false, so it no
 * longer serves /v1/admin at all and never tells its users they are admins. A
 * customer's session cookie does nothing here, and an admin session does nothing
 * there.
 *
 * Defences specific to a cookie-authenticated admin surface:
 *   - the session cookie is HttpOnly and SameSite=Lax (and Secure over https)
 *   - state-changing requests carrying an Origin other than this console's are refused
 *   - the page cannot be framed, is not indexed, and API responses are never cached
 *   - an admin removed from the list loses access on their next request
 *
 * Mirror side: PUBLIC (packages/api is mirrored).
 */
import { trustProxyFromEnv } from "../trust-proxy.js";
import { installDbErrorHandler } from "../db-errors.js";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import type { FastifyInstance, FastifyServerOptions } from "fastify";
import { eq } from "drizzle-orm";
import { adminSessions } from "@mailforge/db/schema";
import { registerDbPlugin, type Db } from "../plugins/db.js";
import type { PlatformTransport } from "../platform-mailer.js";
import { resolveBillingRuntime, type BillingRuntime } from "../billing/config.js";
import adminRoutes from "../routes/admin.js";
import { registerSpaServing } from "../app.js";
import { registerAdminAuthRoutes } from "./auth-routes.js";
import { ADMIN_SESSION_COOKIE, type AdminSession, type SignInMethod } from "./session.js";
import { passkeyModeFromEnv, registerAdminPasskeyRoutes, type PasskeyMode } from "./passkeys.js";
import { isPlatformAdmin } from "./platform-admins.js";

declare module "fastify" {
  interface FastifyRequest {
    /** The signed-in admin console session, or null. */
    adminSession: AdminSession | null;
  }
}

export interface AdminAppOptions {
  db: Db;
  /** Public URL of this console, no trailing slash. Used in sign-in links and the Origin check. */
  adminUrl: string;
  /** Public URL of the customer app, for links back and for owner emails. */
  customerUrl?: string;
  billing?: Partial<BillingRuntime>;
  /** Senders for the owner notices admin actions send (tests pass a recording adapter). */
  noticeTransports?: PlatformTransport[];
  /** Senders for the admin sign-in link. Defaults to the platform sender. */
  loginTransports?: PlatformTransport[];
  logger?: FastifyServerOptions["logger"];
  /** Sign-in link requests allowed per hour. Defaults to 5 per address and 20 per client. */
  loginLimits?: { perEmail: number; perIp: number };
  /**
   * Passkeys: off | optional | enforced. Defaults to MAILFORGE_ADMIN_PASSKEYS, then optional.
   * rpId is the site name passkeys are bound to (default: the host of adminUrl); changing it
   * later invalidates every registered passkey.
   */
  passkeys?: { mode?: PasskeyMode; rpId?: string };
  /** Serve the admin page. Off in most tests. */
  serveDashboard?: boolean;
  dashboardDist?: string;
}

/** Paths owned by this app's API. The page fallback must never answer them. */
const ADMIN_API_PREFIXES = ["/health", "/admin-auth", "/v1"] as const;

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url.replace(/\/+$/, "");
  }
}

export async function buildAdminApp(opts: AdminAppOptions): Promise<FastifyInstance> {
  const adminUrl = opts.adminUrl.replace(/\/+$/, "");
  const adminOrigin = originOf(adminUrl);
  const secureCookies = adminUrl.startsWith("https://");

  const logger =
    opts.logger !== undefined ? opts.logger : process.env.NODE_ENV === "test" ? false : { level: process.env.LOG_LEVEL ?? "info" };
  const app = Fastify({ logger, forceCloseConnections: true, trustProxy: trustProxyFromEnv(process.env.MAILFORGE_TRUST_PROXY) });

  await app.register(cookie);
  installDbErrorHandler(app);
  registerDbPlugin(app, opts.db);
  app.decorateRequest("adminSession", null);

  // ---- headers on everything ---------------------------------------------------
  app.addHook("onSend", async (request, reply) => {
    reply.header("X-Frame-Options", "DENY");
    reply.header("Content-Security-Policy", "frame-ancestors 'none'");
    reply.header("X-Content-Type-Options", "nosniff");
    // Not "no-referrer": with that policy browsers label even this page's own form posts with
    // "Origin: null", which the Origin check below would (rightly) refuse, locking everyone out.
    // "same-origin" sends nothing to other sites and still lets our own requests identify themselves.
    reply.header("Referrer-Policy", "same-origin");
    reply.header("X-Robots-Tag", "noindex, nofollow");
    const p = request.url.split("?")[0] ?? "";
    if (p.startsWith("/v1") || p.startsWith("/admin-auth")) reply.header("Cache-Control", "no-store");
  });

  // ---- cross-origin writes are refused ------------------------------------------
  // SameSite=Lax already stops a hostile site from sending the cookie on a POST. This is the
  // second lock: a browser always labels a write with its Origin, and it must be ours.
  app.addHook("onRequest", async (request, reply) => {
    const m = request.method.toUpperCase();
    if (m === "GET" || m === "HEAD" || m === "OPTIONS") return;
    const origin = request.headers.origin;
    if (origin !== undefined && origin !== adminOrigin) {
      reply.status(403).send({ error: "Cross-origin request refused." });
    }
  });

  // ---- session ------------------------------------------------------------------
  app.addHook("preHandler", async (request, reply) => {
    const id = request.cookies?.[ADMIN_SESSION_COOKIE];
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return;
    const [s] = await opts.db.select().from(adminSessions).where(eq(adminSessions.id, id)).limit(1);
    if (!s) return;
    if (s.expiresAt.getTime() <= Date.now() || !isPlatformAdmin(s.email)) {
      // Expired, or the person has been taken off the admin list since signing in.
      await opts.db.delete(adminSessions).where(eq(adminSessions.id, id));
      reply.clearCookie(ADMIN_SESSION_COOKIE, { path: "/" });
      return;
    }
    request.adminSession = { id: s.id, email: s.email, method: (s.method === "passkey" ? "passkey" : "email") as SignInMethod };
  });

  app.get("/health", async () => ({ ok: true, service: "mailforge-admin" }));

  const passkeyMode = opts.passkeys?.mode ?? passkeyModeFromEnv(process.env.MAILFORGE_ADMIN_PASSKEYS);
  const rpId = opts.passkeys?.rpId || process.env.MAILFORGE_ADMIN_RP_ID || new URL(adminUrl).hostname;

  await registerAdminAuthRoutes(app, { db: opts.db, adminUrl, secureCookies, loginTransports: opts.loginTransports, loginLimits: opts.loginLimits, customerUrl: opts.customerUrl, passkeyMode });
  await registerAdminPasskeyRoutes(app, { db: opts.db, adminOrigin, rpId, mode: passkeyMode, secureCookies });

  await app.register(adminRoutes, {
    prefix: "/v1/admin",
    billing: resolveBillingRuntime(opts.billing),
    dashboardUrl: opts.customerUrl ?? "",
    noticeTransports: opts.noticeTransports,
    denyStatus: 401,
    resolveActor: (request) => (request.adminSession ? { email: request.adminSession.email, id: null } : null),
  });

  if (opts.serveDashboard) {
    await registerSpaServing(app, { dashboardDist: opts.dashboardDist }, { indexFile: "admin.html", apiPrefixes: ADMIN_API_PREFIXES });
  }

  return app;
}
