/**
 * Fastify app factory.
 *
 * Builds and returns a configured Fastify instance. Called by apps/server
 * when the role includes API (role=all or role=api). Not called when the
 * process runs as a pure worker or scheduler.
 *
 * Plugin registration order:
 *   1. Cookie parser (required for session handling)
 *   2. Database decoration (app.db)
 *   3. Tenant resolution (request.tenant via session cookie)
 *   4. Public routes (health, auth - no auth required)
 *   5. Authenticated scope /v1 (all routes that require a resolved tenant)
 *   6. Ingestion scope /v1 (API key auth)
 *   7. Static serving + SPA fallback (LAST; only when opts.serveDashboard is true)
 *
 * Mirror side: PUBLIC (packages/api is mirrored).
 */
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance, FastifyServerOptions } from "fastify";

import { registerDbPlugin, type Db } from "./plugins/db.js";
import { registerTenantPlugin } from "./plugins/tenant.js";
import { registerRoleEnforcement } from "./plugins/role-enforcement.js";
import { registerIngestAuthPlugin } from "./plugins/ingest-auth.js";
import { registerIngestCorsPlugin } from "./plugins/ingest-cors.js";
import healthRoute from "./routes/health.js";
import versionRoute from "./routes/version.js";
import diagnosticsRoute from "./routes/diagnostics.js";
import authRoutes from "./routes/auth.js";
import inviteRoutes from "./routes/invite.js";
import ingestRoutes from "./routes/ingest.js";
import flowsRoutes from "./routes/flows.js";
import contactsRoutes from "./routes/contacts.js";
import analyticsRoutes from "./routes/analytics.js";
import kbRoutes from "./routes/kb.js";
import suppressionRoutes from "./routes/suppressions.js";
import templatesRoutes from "./routes/templates.js";
import messagesRoutes from "./routes/messages.js";
import unsubscribeRoutes from "./routes/unsubscribe.js";
import marketingRoutes from "./routes/marketing.js";
import planRoutes from "./routes/plan.js";
import onboardingRoutes from "./routes/onboarding.js";
import billingRoutes from "./routes/billing.js";
import adminRoutes from "./routes/admin.js";
import accountRoutes from "./routes/account.js";
import type { PlatformTransport } from "./platform-mailer.js";
import billingPublicRoutes from "./routes/billing-public.js";
import { resolveBillingRuntime, type BillingRuntime } from "./billing/config.js";
import ingestionRoutes from "./routes/ingestion.js";
import resendWebhookRoute from "./routes/webhooks/resend.js";
import resendPlatformWebhookRoute from "./routes/webhooks/resend-platform.js";
import sendingRoutes from "./routes/sending.js";
import settingsRoutes from "./routes/settings.js";
import libraryRoutes from "./routes/library.js";
import emailTemplatesRoutes from "./routes/email-templates.js";
import eventsRoutes from "./routes/events.js";
import sentLogRoutes from "./routes/sent-log.js";
import teamRoutes from "./routes/team.js";
import profileRoutes from "./routes/profile.js";

/**
 * Top-level path prefixes that are owned by API routes.
 * The SPA fallback must never intercept these paths and serve index.html.
 * A GET to /v1/unknown should return a normal 404, not the SPA shell.
 * Derived from the route registrations below; update when new prefixes are added.
 */
export const API_PATH_PREFIXES = [
  "/health",
  "/version",
  "/auth",
  "/invite",
  "/unsubscribe",
  "/webhooks",
  "/v1",
] as const;

export interface BuildAppOptions {
  /**
   * The process role: "all" | "api" | "worker" | "scheduler".
   * Supplied by apps/server from the --role argv flag.
   * Reported in /health. Defaults to "all".
   */
  role?: string;
  /**
   * The Mailforge edition: "community" | "cloud".
   * Supplied by apps/server from MAILFORGE_EDITION env.
   * Reported in /health. Defaults to "community".
   */
  edition?: string;
  /** Fastify logger config. Defaults to structured in production, disabled in test. */
  logger?: FastifyServerOptions["logger"];
  /**
   * Drizzle database client. Created by apps/server and passed here.
   * Required for auth, tenant resolution, and all data routes.
   * In tests, this can be a mock or an in-memory DB.
   */
  db?: Db;
  /**
   * Base URL of the API server for link generation (magic link verify URL,
   * unsubscribe headers). No trailing slash. Defaults to http://localhost:{PORT}.
   * Do not use for dashboard redirects - use dashboardUrl for that.
   */
  baseUrl?: string;
  /**
   * Base URL of the dashboard SPA. Used by /auth/verify to redirect the browser
   * after login. No trailing slash. Defaults to baseUrl when absent.
   */
  dashboardUrl?: string;
  /**
   * Job enqueue function. Injected by apps/server when pg-boss is available.
   * Signature matches PgBoss.send() for the subset we need: queue name, data, options.
   * API routes use this to enqueue background jobs (e.g. flow compilation).
   * When absent (tests without pg-boss), routes that require enqueue return 503.
   */
  enqueue?: (queue: string, data: Record<string, unknown>, opts?: Record<string, unknown>) => Promise<string | null>;
  /**
   * When true, register @fastify/static to serve the dashboard SPA from dist/
   * and add a SPA catch-all fallback for unknown paths.
   *
   * Used in both self-host and Cloud (Slice 2 deliberate reversal: the
   * container serves the SPA in Cloud via app.mailforge.org passthrough).
   * Defaults to true for community edition, false for cloud edition (the
   * cloud default becomes relevant only once brain-cloud ships; until then
   * the container always runs community). Defaults to false in BuildAppOptions
   * to preserve existing test behaviour that does not set serveDashboard.
   *
   * If set to true but the dist directory cannot be found, a startup warning
   * is logged and static serving is skipped rather than crashing.
   */
  serveDashboard?: boolean;
  /**
   * Explicit path to the dashboard dist directory. When absent the app
   * resolves it relative to this file's own location, which works both from
   * compiled output (dist/app.js) and under tsx --watch (src/app.ts).
   * Can also be set via MAILFORGE_DASHBOARD_DIST env var.
   */
  dashboardDist?: string;
  /**
   * When true, serve the public marketing site (landing, pricing, legal) and
   * self-serve signup, and show the landing page at "/" to visitors who are not
   * signed in. Off by default so self-hosted installs keep "/" as the dashboard.
   * Set from MAILFORGE_PUBLIC_SITE by apps/server.
   */
  publicSite?: boolean;
  /**
   * Billing (Flutterwave). By default read from FLUTTERWAVE_SECRET_KEY and
   * FLUTTERWAVE_WEBHOOK_HASH; billing is on only when both are set. Tests pass a
   * client pointing at a fake provider here instead.
   */
  billing?: Partial<BillingRuntime>;
  /**
   * Whether the platform admin console is part of this app (default true). Set to false
   * when the console runs as its own deployment (see buildAdminApp): this app then
   * registers no /v1/admin routes and never tells the dashboard its user is an admin.
   */
  adminEmbedded?: boolean;
  /**
   * Senders for account notices such as "your workspace is scheduled for deletion".
   * Normally absent: the workspace's own transport, then the platform sender, are used.
   * Tests pass a recording adapter here.
   */
  noticeTransports?: PlatformTransport[];
  /**
   * One-time claim token for first-account creation. When non-null, the
   * /claim route is registered and accepts this token to create the first
   * owner. Generated by apps/server on each boot when zero users exist.
   * Set to null after consumption (single-use).
   */
  claimToken?: string | null;
}

export async function buildApp(opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  const role = opts.role ?? "all";
  const edition = opts.edition ?? "community";
  const port = process.env.PORT ?? "3000";
  const baseUrl = opts.baseUrl ?? process.env.BASE_URL ?? `http://localhost:${port}`;
  const dashboardUrl = opts.dashboardUrl ?? process.env.DASHBOARD_URL ?? baseUrl;

  const logger =
    opts.logger !== undefined
      ? opts.logger
      : process.env.NODE_ENV === "test"
        ? false
        : { level: process.env.LOG_LEVEL ?? "info" };

  const app = Fastify({
    logger,
    // Destroy keep-alive connections immediately when app.close() is called.
    //
    // Without this, any open keep-alive connection (for example the one held by
    // the Cloudflare Worker ingress, or the keep-warm cron ping) prevents
    // app.close() from resolving until the remote end closes it. The keep-warm
    // cron fires every 60 s and the Worker proxy maintains a persistent
    // connection, so without forceCloseConnections the app.close() call in the
    // shutdown sequence would hang for up to 60 s on every deploy.
    //
    // With forceCloseConnections: true, Fastify 4 calls
    // server.closeAllConnections() (Node 18.2+, available on Node 22 which this
    // project targets). This is cited from:
    //   packages/api/node_modules/fastify/fastify.js:455
    //   packages/api/node_modules/fastify/package.json ("version": "4.29.1")
    // The default (when omitted) auto-selects 'idle' if available, which closes
    // only idle keep-alive connections and would still hang on an active one.
    // 'true' (closeAllConnections) is the correct choice here.
    forceCloseConnections: true,
  });

  // --- Infrastructure plugins ------------------------------------------------

  // Cookie parser - required for session handling
  await app.register(cookie);

  // Database client decoration (app.db)
  if (opts.db) {
    registerDbPlugin(app, opts.db);
  }

  // Job enqueue function decoration (app.enqueue)
  if (opts.enqueue) {
    app.decorate("enqueue", opts.enqueue);
  }

  // Tenant resolution. Validates session cookie, resolves request.tenant.
  // Must be registered on root instance, before any routes.
  registerTenantPlugin(app);

  // --- Public routes ---------------------------------------------------------

  // /health: always registered, no auth required. Compose smoke-test target.
  await app.register(healthRoute, { role, edition });

  // /version: always registered, no auth required, no DB access.
  // Returns build provenance: commit SHA (from MAILFORGE_COMMIT_SHA env), edition,
  // and image build timestamp (from MAILFORGE_BUILT_AT env). Used by `mailforge doctor`
  // to compare local HEAD against the running container without SSH access.
  await app.register(versionRoute, { edition });

  // /auth/*: magic link login, verify, logout, me. No auth required for login/verify.
  if (opts.db) {
    await app.register(authRoutes, { prefix: "/auth", baseUrl, dashboardUrl, adminEmbedded: opts.adminEmbedded !== false });
  }

  // /claim: first-account creation. Only active when claimToken is provided
  // (i.e., when zero users exist on this boot).
  if (opts.db && opts.claimToken != null) {
    let activeClaimToken: string | null = opts.claimToken;
    await app.register(
      (await import("./routes/claim.js")).default,
      {
        prefix: "/claim",
        getClaimToken: () => activeClaimToken,
        consumeClaimToken: () => { activeClaimToken = null; },
        dashboardUrl,
      },
    );
  }

  // /unsubscribe/*: public one-click (RFC 8058) + browser unsubscribe page.
  // No authentication. Token carries tenant + contact by ID; email resolved server-side.
  if (opts.db) {
    await app.register(unsubscribeRoutes, { prefix: "/unsubscribe" });
  }

  // /invite/*: public invite acceptance flow (interstitial + accept).
  // No authentication - the invitee is not yet a user.
  if (opts.db) {
    await app.register(inviteRoutes, { prefix: "/invite", dashboardUrl });
  }

  // Public marketing site + self-serve signup: landing at "/", /pricing, /terms,
  // /privacy, /signup, robots.txt, sitemap.xml. Opt-in (MAILFORGE_PUBLIC_SITE).
  // Registered before static serving so "/" is answered here, not by the SPA.
  if (opts.publicSite) {
    await app.register(marketingRoutes, { siteUrl: baseUrl });
  }

  // Billing (Flutterwave): the public webhook and the post-payment return page. Only
  // registered when billing is configured; with it off there is nothing to receive.
  const billingRuntime = resolveBillingRuntime(opts.billing);
  if (opts.db && billingRuntime.enabled) {
    await app.register(billingPublicRoutes, { runtime: billingRuntime, dashboardUrl });
  }

  // /webhooks/resend/:tenantId: Resend provider webhook (bounces, opens, clicks, complaints).
  // Public, unauthenticated by session. Signature-verified via Svix/HMAC using
  // the per-tenant webhook secret stored in transport_configs. The tenant UUID
  // in the path is used to load the correct secret before the body is verified.
  if (opts.db) {
    await app.register(resendWebhookRoute, { prefix: "/webhooks/resend" });
    // Managed sending: one webhook for the operator's own Resend account (one signing secret).
    await app.register(resendPlatformWebhookRoute, { prefix: "/webhooks/resend-platform" });
  }

  // --- Authenticated scope (dashboard) ----------------------------------------
  // All routes that require a resolved tenant go here, under the /v1 prefix.
  // A preHandler rejects requests where request.tenant is null (returning 401).
  // This scope uses SESSION COOKIE authentication only.
  //
  // Route registrations are added as tasks are implemented:
  //   v1.register(contactsRoutes,  { prefix: "/contacts" });   // contacts ✓
  //   v1.register(flowsRoutes,     { prefix: "/flows" });       // task 10 ✓
  //   v1.register(kbRoutes,        { prefix: "/kb" });          // task 21 ✓
  //   v1.register(messagesRoutes,  { prefix: "/messages" });    // task 40 (partial) ✓
  //   v1.register(templatesRoutes, { prefix: "/templates" });   // task 25 ✓
  //   v1.register(analyticsRoutes, { prefix: "/analytics" }); // analytics ✓
  await app.register(
    async (v1) => {
      // Enforce authentication: reject requests without a resolved tenant.
      v1.addHook("preHandler", async (request, reply) => {
        if (request.tenant === null) {
          reply.status(401);
          reply.send({ error: "Authentication required." });
          return;
        }
        // A suspended workspace is switched off. Platform admins keep access to
        // /v1/admin so they can still reach the console from a suspended account.
        if (request.tenant.suspended && !request.url.startsWith("/v1/admin")) {
          reply.status(403);
          reply.send({ error: "This workspace has been suspended.", code: "workspace_suspended" });
          return;
        }
        // Scheduled for deletion: only the account pages (export, cancel) and the admin console work.
        if (request.tenant.pendingDeletion && !request.url.startsWith("/v1/admin") && !request.url.startsWith("/v1/account")) {
          reply.status(403);
          reply.send({ error: "This workspace is scheduled for deletion.", code: "workspace_pending_deletion" });
        }
      });

      // Role enforcement: every route must declare config.minRole.
      // Boot fails if any route omits it. Request-time check returns 403
      // when the user's role does not meet the route's declared minimum.
      registerRoleEnforcement(v1);

      // task 10: flow CRUD (dashboard operators only)
      if (opts.db) {
        await v1.register(flowsRoutes, { prefix: "/flows" });
      }

      // contacts: People list, person detail, merged timeline
      if (opts.db) {
        await v1.register(contactsRoutes, { prefix: "/contacts" });
      }

      // plan: workspace plan, trial status and usage against limits
      if (opts.db) {
        await v1.register(planRoutes, { prefix: "/plan", billing: billingRuntime });
      }

      // onboarding: where the workspace stands on the way to its first delivered email
      if (opts.db) {
        await v1.register(onboardingRoutes, { prefix: "/onboarding" });
      }

      // billing: start a payment, cancel a subscription (owners only; 503 when billing is off)
      if (opts.db) {
        await v1.register(billingRoutes, {
          prefix: "/billing",
          runtime: billingRuntime,
          returnUrl: `${baseUrl}/billing/return`,
        });
      }

      // account: export your data, schedule or cancel deletion (owners)
      if (opts.db) {
        await v1.register(accountRoutes, { prefix: "/account", billing: billingRuntime, dashboardUrl, noticeTransports: opts.noticeTransports });
      }

      // admin: platform operator console (404 for everyone not in MAILFORGE_PLATFORM_ADMINS)
      if (opts.db && opts.adminEmbedded !== false) {
        await v1.register(adminRoutes, { prefix: "/admin", billing: billingRuntime, dashboardUrl, noticeTransports: opts.noticeTransports });
      }

      // analytics: lifecycle distribution/movement + sending performance
      if (opts.db) {
        await v1.register(analyticsRoutes, { prefix: "/analytics" });
      }

      // task 21: knowledge base CRUD (dashboard operators only)
      if (opts.db) {
        await v1.register(kbRoutes, { prefix: "/kb" });
      }

      // task 24: suppression list import + list (dashboard operators only)
      if (opts.db) {
        await v1.register(suppressionRoutes, { prefix: "/suppressions" });
      }

      // task 25: business model templates (dashboard operators only)
      if (opts.db) {
        await v1.register(templatesRoutes, { prefix: "/templates" });
      }

      // task 40 (partial): message approval/rejection (dashboard operators only)
      if (opts.db) {
        await v1.register(messagesRoutes, { prefix: "/messages" });
      }

      // settings: transport configuration and tenant settings
      if (opts.db) {
        await v1.register(settingsRoutes, { prefix: "/settings" });
      }

      // sending: managed sending through the operator's Resend account (domain setup, sender details)
      if (opts.db) {
        await v1.register(sendingRoutes, { prefix: "/sending" });
      }

      // ingestion: API key management + first-event status for the
      // Integrate screen (dashboard operators only)
      if (opts.db) {
        await v1.register(ingestionRoutes, { prefix: "/ingestion" });
      }

      // library: install pre-built flows and templates (no LLM required)
      if (opts.db) {
        await v1.register(libraryRoutes, { prefix: "/library" });
      }

      // email-templates: CRUD for email content templates (operator editing)
      if (opts.db) {
        await v1.register(emailTemplatesRoutes, { prefix: "/email-templates" });
      }

      // events: distinct event names for the flow editor autosuggest
      if (opts.db) {
        await v1.register(eventsRoutes, { prefix: "/events" });
      }

      // sent-log: sent-mail log for operators (what went out, to whom, when)
      if (opts.db) {
        await v1.register(sentLogRoutes, { prefix: "/sent-log" });
      }

      // team: invite, list, remove members, change roles (owner-only)
      if (opts.db) {
        await v1.register(teamRoutes, { prefix: "/team" });
      }

      // profile: view/edit own profile, email change
      if (opts.db) {
        await v1.register(profileRoutes, { prefix: "/profile" });
      }

      // /v1/diagnostics: authenticated env fingerprint check for `mailforge doctor`.
      // Session-cookie auth only (same preHandler as all /v1 routes).
      // Returns commit SHA, edition, and key fingerprints from the running container.
      // Never returns secret values.
      await v1.register(diagnosticsRoute, { prefix: "/diagnostics" });
    },
    { prefix: "/v1" },
  );

  // --- Ingestion scope (API key auth) ------------------------------------------
  // POST /v1/track and POST /v1/identify use BEARER TOKEN authentication,
  // completely separate from the session-cookie dashboard scope above.
  // A request carrying only a session cookie cannot reach these routes (the
  // ingest auth plugin rejects it). A request carrying only a bearer key
  // cannot reach the dashboard routes (the dashboard preHandler rejects it).
  // The CORS plugin in this scope emits Access-Control headers ONLY for
  // ingestion routes and never allows credentials (no cookies involved).
  if (opts.db) {
    await app.register(
      async (ingest) => {
        registerIngestCorsPlugin(ingest);
        registerIngestAuthPlugin(ingest);
        await ingest.register(ingestRoutes);
      },
      { prefix: "/v1" },
    );
  }

  // --- Static serving + SPA fallback (LAST) ------------------------------------
  // Registered when opts.serveDashboard is true. In Cloud, app.mailforge.org
  // passthrough routing forwards SPA requests to the container, so the container
  // serves assets just as in self-host mode (Slice 2 deliberate reversal).
  // Must come after all API routes to avoid shadowing them.
  if (opts.serveDashboard) {
    await registerSpaServing(app, opts);
  }

  return app;
}

/**
 * Register @fastify/static and the SPA index.html fallback.
 *
 * Separated into its own function to keep buildApp readable and to allow
 * testing the fallback logic in isolation.
 *
 * Path resolution strategy:
 *   1. opts.dashboardDist if provided
 *   2. MAILFORGE_DASHBOARD_DIST env var if set
 *   3. Resolved relative to this file: works under tsx --watch (src/)
 *      and from compiled output (dist/) because both are one level below
 *      packages/api/ and apps/dashboard/dist is always at a fixed
 *      path relative to the monorepo root.
 *
 * If the resolved path does not exist on disk, logs a warning and returns
 * without registering anything. This prevents a crash when starting the
 * server before running `pnpm --filter @mailforge/dashboard build`.
 */
export async function registerSpaServing(
  app: FastifyInstance,
  opts: Pick<BuildAppOptions, "dashboardDist" | "publicSite">,
  /** The standalone admin console serves admin.html and has its own API prefixes. */
  extra: { indexFile?: string; apiPrefixes?: readonly string[] } = {},
): Promise<void> {
  const indexFile = extra.indexFile ?? "index.html";
  const apiPrefixes = extra.apiPrefixes ?? API_PATH_PREFIXES;
  // Resolve the dist directory and record how it was resolved so the
  // warning message is immediately actionable without log archaeology.
  const { distPath, mechanism } = resolvedDashboardDist(opts);

  if (!existsSync(distPath)) {
    app.log.warn(
      `[dashboard] serveDashboard=true but dist directory not found. ` +
      `mechanism=${mechanism} tried=${distPath} -- ` +
      "If mechanism=auto, verify WORKDIR is the monorepo root or set MAILFORGE_DASHBOARD_DIST explicitly. " +
      "Run `pnpm --filter @mailforge/dashboard build` to create the dist directory. " +
      "Static serving and SPA fallback are disabled until the path exists.",
    );
    return;
  }

  // Serve hashed assets under /assets with a long immutable max-age.
  // Assets emitted by Vite contain a content hash in the filename so stale
  // cache entries are automatically busted on each deploy.
  await app.register(fastifyStatic, {
    root: distPath,
    prefix: "/",
    // With the public site on, "/" is answered by the marketing route (landing,
    // or index.html for signed-in users), so static must not claim it.
    index: extra.indexFile ?? (opts.publicSite ? false : undefined),
    // decorateReply defaults to true; reply.sendFile() is used by the
    // SPA fallback below. Do not set decorateReply: false.
    setHeaders(res, filePath) {
      if (filePath.includes(`${path.sep}assets${path.sep}`)) {
        // Hashed filenames - safe to cache for a year.
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      } else {
        // index.html and other root files - must not be cached.
        res.setHeader("Cache-Control", "no-store");
      }
    },
  });

  // SPA fallback: serve index.html for any GET or HEAD request whose path
  // does not begin with an API prefix. Any other method (POST, PUT, etc.)
  // and any API-prefixed path fall through to Fastify's normal 404.
  app.setNotFoundHandler((request, reply) => {
    const method = request.method.toUpperCase();

    // Only GET and HEAD receive the SPA fallback.
    if (method !== "GET" && method !== "HEAD") {
      reply.status(404).send({ error: "Not Found" });
      return;
    }

    const pathname = request.url.split("?")[0] ?? "/";

    // Paths beginning with an API prefix must not serve index.html.
    // An unknown /v1/whatever should return a normal 404, not the SPA.
    const isApiPath = apiPrefixes.some(
      (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
    );
    if (isApiPath) {
      reply.status(404).send({ error: "Not Found" });
      return;
    }

    // Serve index.html for all other GET/HEAD paths (SPA client-side routing).
    // Set no-store before sendFile so the header is included in the response.
    reply.header("Cache-Control", "no-store");
    reply.sendFile(indexFile);
  });
}

/**
 * Resolve the absolute path to apps/dashboard/dist and the mechanism used.
 * Logic described in registerSpaServing above.
 *
 * Returns an object so callers can include the mechanism in log messages
 * without re-deriving it.
 */
export function resolvedDashboardDist(opts: Pick<BuildAppOptions, "dashboardDist">): { distPath: string; mechanism: "opts" | "env" | "auto" } {
  if (opts.dashboardDist) return { distPath: opts.dashboardDist, mechanism: "opts" };
  if (process.env.MAILFORGE_DASHBOARD_DIST) return { distPath: process.env.MAILFORGE_DASHBOARD_DIST, mechanism: "env" };

  // Auto: resolve relative to this file. The layout is fixed:
  //   packages/api/src/app.ts  (tsx)   -> dirname = packages/api/src
  //   packages/api/dist/app.js (tsc)   -> dirname = packages/api/dist
  // Three ".." from dirname reaches the monorepo root in both cases:
  //   packages/api/src  -> .. -> packages/api -> .. -> packages -> .. -> <root>
  //   packages/api/dist -> .. -> packages/api -> .. -> packages -> .. -> <root>
  // apps/dashboard/dist is then a fixed path from that root.
  const __filename = fileURLToPath(import.meta.url);
  const monoRoot = path.resolve(path.dirname(__filename), "../../..");
  return { distPath: path.join(monoRoot, "apps", "dashboard", "dist"), mechanism: "auto" };
}
