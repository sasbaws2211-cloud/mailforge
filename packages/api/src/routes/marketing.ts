/**
 * Public site routes: landing, pricing, legal, signup, robots.txt, sitemap.xml.
 *
 * Registered only when the public site is switched on (LOOMAIL_PUBLIC_SITE),
 * so self-hosted installs keep their current behavior: "/" is the dashboard.
 *
 * "/" serves the landing page to visitors without a session cookie and hands
 * signed-in users straight to the dashboard (the SPA decides where to go).
 *
 * Signup (POST /signup) creates a new workspace with its owner and a trial,
 * then emails a sign-in link through the existing /auth/login path, so link
 * delivery (tenant transport, platform sender, console fallback) is identical
 * to normal login. The response never reveals whether an address already had
 * a workspace.
 *
 * Mirror side: PUBLIC (packages/api is mirrored).
 */
import type { FastifyInstance, FastifyPluginAsync, FastifyReply } from "fastify";
import { eq, sql } from "drizzle-orm";
import { managedSending, tenants, users } from "@loomail/db/schema";
import { TRIAL_PLAN_VALUE, trialEndDate, managedSendingConfigFromEnv, parseGoal, parseUsdRate } from "@loomail/core";
import type { Db } from "../plugins/db.js";
import { SESSION_COOKIE_NAME } from "./auth.js";
import { SITE_NAME, type SiteContext } from "../marketing/layout.js";
import { homePage, pricingPage, signupPage, signupSentPage } from "../marketing/pages.js";
import { privacyPage, termsPage } from "../marketing/legal.js";
import { articlePage, contentIndexPage } from "../marketing/content-pages.js";
import { contentPath, entries, getEntry } from "../marketing/content/index.js";
import {
  createLimiter,
  isPlausibleEmail,
  normalizeEmail,
  slugify,
  slugWithSuffix,
  validateSignup,
  type SignupInput,
} from "../marketing/signup-logic.js";

export interface MarketingRouteOptions {
  /** Public origin of the site, no trailing slash. */
  siteUrl: string;
}

/** Per-IP and per-email caps on signup attempts per hour. */
const IP_PER_HOUR = 6;
const EMAIL_PER_HOUR = 3;

/**
 * The currency customers are charged in when it is not US dollars, for the pricing note. Only
 * reported when billing is really on in that currency (a key and a valid rate are set), the same
 * condition under which checkout charges it.
 */
function chargeCurrencyFromEnv(): { currency: string; rate: number } | null {
  const currency = (process.env.PAYSTACK_CURRENCY?.trim() || "USD").toUpperCase();
  if (currency === "USD" || !process.env.PAYSTACK_SECRET_KEY?.trim()) return null;
  const rate = parseUsdRate(process.env.PAYSTACK_USD_RATE);
  return rate === null ? null : { currency, rate };
}

function siteContext(siteUrl: string): SiteContext {
  let host = "example.com";
  try {
    host = new URL(siteUrl).hostname;
  } catch {
    /* keep default */
  }
  const charge = chargeCurrencyFromEnv();
  return {
    siteUrl,
    supportEmail: process.env.LOOMAIL_SUPPORT_EMAIL?.trim() || `support@${host}`,
    legalName: process.env.LOOMAIL_LEGAL_NAME?.trim() || SITE_NAME,
    chargeCurrency: charge?.currency ?? null,
    usdRate: charge?.rate ?? null,
  };
}

function html(reply: FastifyReply, status: number, body: string, cache = "no-store"): FastifyReply {
  return reply.status(status).header("Content-Type", "text/html; charset=utf-8").header("Cache-Control", cache).send(body);
}

/** Whether new workspaces get Loomail Sending switched on at signup. Read per signup, so config changes apply at once. */
function autoEnableSending(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.LOOMAIL_SIGNUP_AUTO_SENDING === "false") return false;
  const cfg = managedSendingConfigFromEnv(env);
  return cfg.enabled && cfg.sharedFrom !== null;
}

/**
 * Create a workspace and its owner for `input`, unless the email already has
 * one. Returns true when a new workspace was created. Serialised per email with
 * an advisory lock so a double-submitted form cannot create two workspaces.
 */
async function createWorkspace(db: Db, input: SignupInput): Promise<{ created: boolean; tenantId?: string }> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${"signup:" + input.email}))`);

    const existing = await tx.select({ id: users.id }).from(users).where(eq(users.email, input.email)).limit(1);
    if (existing.length > 0) return { created: false };

    const trial = input.plan !== "free";
    let slug = slugify(input.workspace);
    for (let attempt = 0; attempt < 6; attempt++) {
      const taken = await tx.select({ id: tenants.id }).from(tenants).where(eq(tenants.slug, slug)).limit(1);
      if (taken.length === 0) break;
      slug = slugWithSuffix(input.workspace);
    }

    const [tenant] = await tx
      .insert(tenants)
      .values({
        name: input.workspace,
        slug,
        plan: trial ? TRIAL_PLAN_VALUE : "free",
        trialEndsAt: trial ? trialEndDate() : null,
        settings: { signup: { plan_interest: input.plan, ...(input.goal ? { goal: input.goal } : {}), at: new Date().toISOString() } },
      })
      .returning({ id: tenants.id });

    await tx.insert(users).values({ tenantId: tenant!.id, email: input.email, role: "owner" });

    // Loomail Sending on from the start, so the first email needs no setup of their own. Only when it
    // would really send: the operator offers it AND has a shared address (without one it would wait for a
    // verified domain and the workspace would look set up when it is not). LOOMAIL_SIGNUP_AUTO_SENDING=false opts out.
    if (autoEnableSending()) await tx.insert(managedSending).values({ tenantId: tenant!.id }).onConflictDoNothing();

    return { created: true, tenantId: tenant!.id };
  });
}

/** Send the sign-in link through the normal login path. Never throws. */
async function sendSignInLink(app: FastifyInstance, email: string): Promise<void> {
  try {
    await app.inject({
      method: "POST",
      url: "/auth/login",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ email }),
    });
  } catch (err) {
    app.log.warn({ err: err instanceof Error ? err.message : String(err) }, "signup: sign-in link request failed");
  }
}

const marketingRoutes: FastifyPluginAsync<MarketingRouteOptions> = async (app, opts) => {
  const ctx = siteContext(opts.siteUrl);
  const ipLimiter = createLimiter({ windowMs: 3_600_000, max: IP_PER_HOUR });
  const emailLimiter = createLimiter({ windowMs: 3_600_000, max: EMAIL_PER_HOUR });
  // Resending the sign-in link: one every 30 seconds and five an hour per address, and a cap per IP.
  const resendGapLimiter = createLimiter({ windowMs: 30_000, max: 1 });
  const resendHourLimiter = createLimiter({ windowMs: 3_600_000, max: 5 });
  const resendIpLimiter = createLimiter({ windowMs: 3_600_000, max: 20 });

  // Scoped form parser (HTML forms post application/x-www-form-urlencoded).
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) => {
    try {
      done(null, Object.fromEntries(new URLSearchParams(body as string)));
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  // --- Landing -----------------------------------------------------------------
  app.get("/", async (request, reply) => {
    // Signed-in users get the dashboard. The cookie is only checked for presence:
    // an expired one lands on the dashboard, which sends them to the login page.
    const hasSession = Boolean(request.headers.cookie?.includes(`${SESSION_COOKIE_NAME}=`));
    if (hasSession && typeof (reply as unknown as { sendFile?: unknown }).sendFile === "function") {
      reply.header("Cache-Control", "no-store");
      return (reply as unknown as { sendFile: (f: string) => FastifyReply }).sendFile("index.html");
    }
    // The response depends on the cookie, so caches must key on it.
    reply.header("Vary", "Cookie");
    return html(reply, 200, homePage(ctx), "public, max-age=300");
  });

  app.get("/pricing", async (_req, reply) => html(reply, 200, pricingPage(ctx), "public, max-age=300"));
  app.get("/terms", async (_req, reply) => html(reply, 200, termsPage(ctx), "public, max-age=300"));
  app.get("/privacy", async (_req, reply) => html(reply, 200, privacyPage(ctx), "public, max-age=300"));

  // --- Blog and comparison pages (marketing/content) ---------------------------
  app.get("/blog", async (_req, reply) => html(reply, 200, contentIndexPage(ctx, "blog"), "public, max-age=300"));
  app.get("/alternatives", async (_req, reply) => html(reply, 200, contentIndexPage(ctx, "alternative"), "public, max-age=300"));
  app.get<{ Params: { slug: string } }>("/blog/:slug", async (request, reply) => {
    const entry = getEntry("blog", request.params.slug);
    return entry ? html(reply, 200, articlePage(ctx, entry), "public, max-age=300") : reply.callNotFound();
  });
  app.get<{ Params: { slug: string } }>("/alternatives/:slug", async (request, reply) => {
    const entry = getEntry("alternative", request.params.slug);
    return entry ? html(reply, 200, articlePage(ctx, entry), "public, max-age=300") : reply.callNotFound();
  });

  // --- robots + sitemap --------------------------------------------------------
  app.get("/robots.txt", async (_req, reply) =>
    reply
      .header("Content-Type", "text/plain; charset=utf-8")
      .header("Cache-Control", "public, max-age=3600")
      .send(
        [
          "User-agent: *",
          "Allow: /",
          "Disallow: /v1/",
          "Disallow: /auth/",
          "Disallow: /invite/",
          "Disallow: /unsubscribe",
          `Sitemap: ${ctx.siteUrl}/sitemap.xml`,
          "",
        ].join("\n"),
      ),
  );

  // Google Search Console ownership check: the file must answer with exactly this text.
  app.get("/googlea90127fae7ed02bd.html", async (_req, reply) =>
    reply
      .header("Content-Type", "text/html; charset=utf-8")
      .header("Cache-Control", "public, max-age=3600")
      .send("google-site-verification: googlea90127fae7ed02bd.html"),
  );

  app.get("/sitemap.xml", async (_req, reply) => {
    // Fixed pages have no date (nothing tracks when their text last changed); articles carry the date they were last updated.
    const fixed: Array<[string, string | null]> = ["/", "/pricing", "/signup", "/terms", "/privacy", "/blog", "/alternatives"].map((p) => [p, null]);
    const articles: Array<[string, string | null]> = [...entries("blog"), ...entries("alternative")].map((e) => [contentPath(e), e.updated]);
    const xml =
      `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
      [...fixed, ...articles]
        .map(([p, mod]) => `  <url><loc>${ctx.siteUrl}${p === "/" ? "/" : p}</loc>${mod ? `<lastmod>${mod}</lastmod>` : ""}</url>`)
        .join("\n") +
      `\n</urlset>\n`;
    return reply.header("Content-Type", "application/xml; charset=utf-8").header("Cache-Control", "public, max-age=3600").send(xml);
  });

  // --- Signup ------------------------------------------------------------------
  app.get<{ Querystring: { plan?: string; goal?: string } }>("/signup", async (request, reply) => {
    const plan = request.query.plan === "essential"
      ? ("essential" as const)
      : undefined;
    return html(reply, 200, signupPage(ctx, { plan, goal: parseGoal(request.query.goal) }));
  });

  // Send the sign-in link again, for someone sitting on the "check your email" page. It only ever
  // goes to the address given, answers the same whether or not that address has a workspace, and
  // is rate limited per address and per IP so it cannot be used to flood anyone's inbox.
  app.post("/signup/resend", async (request, reply) => {
    const db: Db | undefined = request.server.db;
    const b = (request.body && typeof request.body === "object" ? request.body : {}) as Record<string, unknown>;
    const raw = typeof b.email === "string" ? b.email : "";
    if (!isPlausibleEmail(raw)) return html(reply, 400, signupPage(ctx, { error: "Enter a valid email address." }));
    const email = normalizeEmail(raw);
    if (!db) return html(reply, 503, signupSentPage(ctx, email, { notice: "Sign-in is temporarily unavailable. Please try again in a moment." }));

    const gap = resendGapLimiter.hit(email);
    const hour = resendHourLimiter.hit(email);
    const ip = resendIpLimiter.hit(request.ip);
    if (!gap.allowed || !hour.allowed || !ip.allowed) {
      const wait = Math.max(gap.allowed ? 0 : gap.retryAfterSec, hour.allowed ? 0 : hour.retryAfterSec, ip.allowed ? 0 : ip.retryAfterSec);
      reply.header("Retry-After", String(wait));
      const msg =
        wait <= 60
          ? `Please wait ${wait} second${wait === 1 ? "" : "s"} before asking for another link.`
          : `Too many requests. Please try again in about ${Math.ceil(wait / 60)} minutes.`;
      return html(reply, 429, signupSentPage(ctx, email, { notice: msg }));
    }

    await sendSignInLink(request.server, email);
    return html(reply, 200, signupSentPage(ctx, email, { resent: true }));
  });

  app.post("/signup", async (request, reply) => {
    const db: Db | undefined = request.server.db;
    const wantsJson = (request.headers["content-type"] ?? "").includes("application/json");
    const json = (status: number, payload: Record<string, unknown>) => reply.status(status).send(payload);

    if (!db) return wantsJson ? json(503, { error: "Service unavailable." }) : html(reply, 503, signupPage(ctx, { error: "Signup is temporarily unavailable." }));

    const parsed = validateSignup(request.body);

    if (!parsed.ok && parsed.kind === "bot") {
      // Pretend it worked; do nothing.
      return wantsJson ? json(200, { ok: true }) : html(reply, 200, signupSentPage(ctx, "your address"));
    }
    if (!parsed.ok) {
      const b = (request.body ?? {}) as Record<string, unknown>;
      return wantsJson
        ? json(400, { error: parsed.message })
        : html(
            reply,
            400,
            signupPage(ctx, {
              error: parsed.message,
              workspace: typeof b.workspace === "string" ? b.workspace : "",
              email: typeof b.email === "string" ? b.email : "",
              plan: b.plan === "essential" ? ("essential" as const) : undefined,
              goal: parseGoal(b.goal),
            }),
          );
    }

    const input = parsed.value;
    const ip = ipLimiter.hit(request.ip);
    const em = emailLimiter.hit(input.email);
    if (!ip.allowed || !em.allowed) {
      const wait = Math.max(ip.allowed ? 0 : ip.retryAfterSec, em.allowed ? 0 : em.retryAfterSec);
      const minutes = Math.max(1, Math.ceil(wait / 60));
      reply.header("Retry-After", String(wait));
      const message = `Too many attempts. Please try again in about ${minutes} minute${minutes === 1 ? "" : "s"}.`;
      return wantsJson
        ? json(429, { error: message })
        : html(reply, 429, signupPage(ctx, { error: message, workspace: input.workspace, email: input.email, plan: input.plan, goal: input.goal }));
    }

    try {
      const result = await createWorkspace(db, input);
      if (result.created) request.log.info({ tenantId: result.tenantId, plan: input.plan }, "workspace created via signup");
    } catch (err) {
      request.log.error({ err: err instanceof Error ? err.message : String(err) }, "signup: workspace creation failed");
      return wantsJson
        ? json(500, { error: "We could not create your workspace. Please try again." })
        : html(reply, 500, signupPage(ctx, { error: "We could not create your workspace. Please try again.", workspace: input.workspace, email: input.email, plan: input.plan, goal: input.goal }));
    }

    // New or existing address: same response, and a sign-in link either way.
    await sendSignInLink(request.server, input.email);

    return wantsJson ? json(200, { ok: true }) : html(reply, 200, signupSentPage(ctx, input.email));
  });
};

export default marketingRoutes;
