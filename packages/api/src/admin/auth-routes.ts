/**
 * Sign-in for the standalone admin console: an emailed link, like the customer app,
 * but for platform admins only and with nothing shared.
 *
 *   POST /admin-auth/login     { email }   always answers the same, whoever you are
 *   GET  /admin-auth/verify    ?token=     confirmation page (safe for mail scanners to open)
 *   POST /admin-auth/verify    token       consumes the link, starts a session, goes to /
 *   GET  /admin-auth/me                    who is signed in (401 if nobody)
 *   POST /admin-auth/logout
 *
 * Properties worth keeping:
 *   - the answer to "login" never reveals whether an address is an administrator
 *   - the link is single use, hashed at rest, and lives 15 minutes
 *   - opening the link (GET) changes nothing; only the button (POST) signs you in, so a
 *     mail scanner that fetches every link cannot burn it or sign anyone in
 *   - requests are rate limited per address and per client, in memory
 *   - the link is only ever printed to the server console outside production, and only
 *     when no email sender is configured
 *
 * Mirror side: PUBLIC (packages/api is mirrored).
 */
import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { and, eq, isNull, lt, gt } from "drizzle-orm";
import { wrapInShell, wrapInTextShell } from "@mailforge/core";
import { adminLoginTokens, adminSessions } from "@mailforge/db/schema";
import type { Db } from "../plugins/db.js";
import { getPlatformTransport, type PlatformTransport } from "../platform-mailer.js";
import { isPlatformAdmin } from "./platform-admins.js";

import { ADMIN_SESSION_COOKIE, startAdminSession, type AdminSession } from "./session.js";
import { mustUsePasskey, passkeyCount, type PasskeyMode } from "./passkeys.js";

export { ADMIN_SESSION_COOKIE };
export type { AdminSession };
export const LOGIN_LINK_MINUTES = 15;
/** Sign-in link requests allowed per hour, per address and per client. */
export const DEFAULT_LOGIN_LIMITS = { perEmail: 5, perIp: 20 } as const;
const WINDOW_MS = 3_600_000;

const hashToken = (raw: string) => createHash("sha256").update(raw).digest("hex");
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Count an attempt against a key; false once it is over the limit. */
function allow(buckets: Map<string, number[]>, key: string, limit: number, now: number): boolean {
  const recent = (buckets.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= limit) {
    buckets.set(key, recent);
    return false;
  }
  recent.push(now);
  buckets.set(key, recent);
  return true;
}

function buildLoginEmail(link: string): { subject: string; html: string; text: string } {
  const button = "display:inline-block;padding:12px 24px;background:#26282e;color:#f7f7f9;text-decoration:none;border-radius:6px;font-size:14px;font-weight:500;";
  const bodyHtml = [
    `<p style="margin:0 0 16px 0;">Someone asked to sign in to the Mailforge admin console with this address. Click below to continue:</p>`,
    `<p style="margin:0 0 24px 0;"><a href="${esc(link)}" style="${button}">Sign in to the admin console</a></p>`,
    `<p style="margin:0 0 8px 0;font-size:13px;color:#585d68;">Or copy this URL:<br/><span style="word-break:break-all;">${esc(link)}</span></p>`,
    `<p style="margin:0;font-size:13px;color:#585d68;">The link works once and expires in ${LOGIN_LINK_MINUTES} minutes. If this was not you, ignore this email: nothing happens unless the link is used.</p>`,
  ].join("\n");
  const bodyText = [
    "Someone asked to sign in to the Mailforge admin console with this address. Open this URL to continue:",
    "",
    link,
    "",
    `The link works once and expires in ${LOGIN_LINK_MINUTES} minutes. If this was not you, ignore this email: nothing happens unless the link is used.`,
  ].join("\n");
  return {
    subject: "Your admin console sign-in link",
    html: wrapInShell({ bodyHtml, brand: {}, tenantName: "Mailforge admin", complianceFooterHtml: "" }),
    text: wrapInTextShell({ bodyText, brand: {}, tenantName: "Mailforge admin", complianceFooterText: "" }),
  };
}

function confirmPage(email: string, token: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><meta name="robots" content="noindex" />
<title>Sign in to the admin console</title>
<style>
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; background: #f7f7f9; color: #26282e; font-family: system-ui, sans-serif; }
  main { width: 100%; max-width: 360px; padding: 24px; text-align: center; }
  h1 { font-size: 20px; font-weight: 600; margin: 16px 0 8px; }
  p { font-size: 14px; line-height: 1.6; color: #585d68; margin: 0 0 24px; }
  p strong { color: #26282e; font-weight: 500; }
  button { width: 100%; height: 40px; border: 0; border-radius: 6px; background: #26282e; color: #f7f7f9; font-size: 14px; font-weight: 500; cursor: pointer; }
</style></head>
<body><main>
  <h1>Admin console</h1>
  <p>You are signing in as <strong>${esc(email)}</strong>.</p>
  <form method="post" action="/admin-auth/verify">
    <input type="hidden" name="token" value="${esc(token)}" />
    <button type="submit">Sign in</button>
  </form>
</main></body></html>`;
}

export async function registerAdminAuthRoutes(
  app: FastifyInstance,
  opts: { db: Db; adminUrl: string; secureCookies: boolean; loginTransports?: PlatformTransport[]; loginLimits?: { perEmail: number; perIp: number }; customerUrl?: string; passkeyMode: PasskeyMode },
): Promise<void> {
  const { db, adminUrl } = opts;
  const limits = opts.loginLimits ?? DEFAULT_LOGIN_LIMITS;
  const emailBuckets = new Map<string, number[]>();
  const ipBuckets = new Map<string, number[]>();

  // The confirmation button is a plain HTML form.
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) => {
    const parsed: Record<string, string> = {};
    if (typeof body === "string") {
      for (const pair of body.split("&")) {
        const i = pair.indexOf("=");
        if (i === -1) continue;
        try {
          parsed[decodeURIComponent(pair.slice(0, i).replace(/\+/g, " "))] = decodeURIComponent(pair.slice(i + 1).replace(/\+/g, " "));
        } catch {
          /* ignore a malformed pair */
        }
      }
    }
    done(null, parsed);
  });

  const GENERIC = { message: "If that address belongs to an administrator, a sign-in link has been sent." };

  app.post<{ Body: { email?: unknown } }>("/admin-auth/login", async (request, reply) => {
    const raw = request.body?.email;
    if (typeof raw !== "string" || raw.length === 0 || raw.length > 254) {
      return reply.status(400).send({ error: "Enter your email address." });
    }
    const email = raw.trim().toLowerCase();
    const now = Date.now();
    // Counted for every address, administrator or not, so the limits tell an attacker nothing.
    if (!allow(ipBuckets, request.ip, limits.perIp, now) || !allow(emailBuckets, email, limits.perEmail, now)) {
      return reply.status(429).send({ error: "Too many attempts. Try again later." });
    }
    if (!isPlatformAdmin(email)) return GENERIC;
    // With passkeys enforced, an administrator who has one signs in with it. No link is sent, and the
    // answer is the same as for anyone else, so this reveals nothing to someone probing addresses.
    if (await mustUsePasskey(db, opts.passkeyMode, email)) return GENERIC;

    const token = randomBytes(32).toString("base64url");
    await db.insert(adminLoginTokens).values({
      email,
      tokenHash: hashToken(token),
      expiresAt: new Date(now + LOGIN_LINK_MINUTES * 60_000),
    });
    // Housekeeping: old tokens and sessions are of no use to anyone.
    await db.delete(adminLoginTokens).where(lt(adminLoginTokens.expiresAt, new Date(now - 86_400_000)));
    await db.delete(adminSessions).where(lt(adminSessions.expiresAt, new Date(now - 86_400_000)));

    const link = `${adminUrl}/admin-auth/verify?token=${token}`;
    const mail = buildLoginEmail(link);
    const senders = opts.loginTransports ?? [getPlatformTransport()].filter((t): t is PlatformTransport => t !== null);

    let sent = false;
    for (const sender of senders) {
      try {
        const r = await sender.adapter.send({
          to: email,
          from: sender.fromEmail,
          fromName: sender.fromName ?? undefined,
          subject: mail.subject,
          bodyHtml: mail.html,
          bodyText: mail.text,
          headers: {},
          messageId: `admin-login-${hashToken(token).slice(0, 24)}`,
        });
        if (r.success) {
          sent = true;
          break;
        }
        request.log.warn({ error: r.error }, "Admin sign-in link send failed");
      } catch (err) {
        request.log.warn({ error: err instanceof Error ? err.message : String(err) }, "Admin sign-in link send threw");
      }
    }
    if (!sent) {
      if (process.env.NODE_ENV !== undefined && process.env.NODE_ENV !== "production") {
        // Development only, and only because nothing could send it.
        console.log(`\n=== ADMIN CONSOLE SIGN-IN LINK for ${email} ===\n${link}\n(expires in ${LOGIN_LINK_MINUTES} minutes)\n`);
      } else {
        request.log.error({ email }, "Cannot send the admin sign-in link: no email sender is configured");
      }
    }
    return GENERIC;
  });

  app.get<{ Querystring: { token?: string } }>("/admin-auth/verify", async (request, reply) => {
    const fail = () => reply.redirect("/login?error=invalid_link", 302);
    const token = request.query.token;
    if (!token) return fail();
    const [row] = await db
      .select({ email: adminLoginTokens.email })
      .from(adminLoginTokens)
      .where(and(eq(adminLoginTokens.tokenHash, hashToken(token)), isNull(adminLoginTokens.consumedAt), gt(adminLoginTokens.expiresAt, new Date())))
      .limit(1);
    if (!row || !isPlatformAdmin(row.email)) return fail();
    if (await mustUsePasskey(db, opts.passkeyMode, row.email)) return reply.redirect("/login?error=passkey_required", 302);
    reply.header("Content-Type", "text/html; charset=utf-8");
    return reply.send(confirmPage(row.email, token));
  });

  app.post<{ Body: { token?: string } }>("/admin-auth/verify", async (request, reply) => {
    const fail = () => reply.redirect("/login?error=invalid_link", 302);
    const token = request.body?.token;
    if (typeof token !== "string" || token.length === 0) return fail();
    // Consume atomically: of two simultaneous clicks, one wins.
    const consumed = await db
      .update(adminLoginTokens)
      .set({ consumedAt: new Date() })
      .where(and(eq(adminLoginTokens.tokenHash, hashToken(token)), isNull(adminLoginTokens.consumedAt), gt(adminLoginTokens.expiresAt, new Date())))
      .returning({ email: adminLoginTokens.email });
    const email = consumed[0]?.email;
    if (!email || !isPlatformAdmin(email)) return fail();
    // A link issued before this administrator enrolled a passkey must not get around the policy.
    if (await mustUsePasskey(db, opts.passkeyMode, email)) return reply.redirect("/login?error=passkey_required", 302);

    await startAdminSession(db, reply, { email, method: "email", secureCookies: opts.secureCookies });
    return reply.redirect("/", 302);
  });

  app.get("/admin-auth/me", async (request, reply) => {
    if (!request.adminSession) return reply.status(401).send({ error: "Not authenticated." });
    // customer_url lets the page offer a link back to the customer app.
    return {
      email: request.adminSession.email,
      customer_url: opts.customerUrl || null,
      method: request.adminSession.method,
      passkey_mode: opts.passkeyMode,
      passkey_count: opts.passkeyMode === "off" ? 0 : await passkeyCount(db, request.adminSession.email),
    };
  });

  app.post("/admin-auth/logout", async (request, reply) => {
    if (request.adminSession) await db.delete(adminSessions).where(eq(adminSessions.id, request.adminSession.id));
    reply.clearCookie(ADMIN_SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });
}
