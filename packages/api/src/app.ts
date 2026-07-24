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
 *
 * Mirror side: PUBLIC (packages/api is mirrored).
 */
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import type { FastifyInstance, FastifyServerOptions } from "fastify";

import { registerDbPlugin, type Db } from "./plugins/db.js";
import { registerTenantPlugin } from "./plugins/tenant.js";
import healthRoute from "./routes/health.js";
import authRoutes from "./routes/auth.js";

export interface BuildAppOptions {
  /**
   * The process role: "all" | "api" | "worker" | "scheduler".
   * Supplied by apps/server from the --role argv flag.
   * Reported in /health. Defaults to "all".
   */
  role?: string;
  /**
   * The Claros edition: "community" | "cloud".
   * Supplied by apps/server from CLAROS_EDITION env.
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
   * Base URL for link generation (magic link, unsubscribe, etc.).
   * No trailing slash. Defaults to http://localhost:{PORT}.
   */
  baseUrl?: string;
}

export async function buildApp(opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  const role = opts.role ?? "all";
  const edition = opts.edition ?? "community";
  const port = process.env.PORT ?? "3000";
  const baseUrl = opts.baseUrl ?? process.env.BASE_URL ?? `http://localhost:${port}`;

  const logger =
    opts.logger !== undefined
      ? opts.logger
      : process.env.NODE_ENV === "test"
        ? false
        : { level: process.env.LOG_LEVEL ?? "info" };

  const app = Fastify({ logger });

  // --- Infrastructure plugins ------------------------------------------------

  // Cookie parser - required for session handling
  await app.register(cookie);

  // Database client decoration (app.db)
  if (opts.db) {
    registerDbPlugin(app, opts.db);
  }

  // Tenant resolution. Validates session cookie, resolves request.tenant.
  // Must be registered on root instance, before any routes.
  registerTenantPlugin(app);

  // --- Public routes ---------------------------------------------------------

  // /health: always registered, no auth required. Compose smoke-test target.
  await app.register(healthRoute, { role, edition });

  // /auth/*: magic link login, verify, logout, me. No auth required for login/verify.
  if (opts.db) {
    await app.register(authRoutes, { prefix: "/auth", baseUrl });
  }

  // --- Authenticated scope ---------------------------------------------------
  // All routes that require a resolved tenant go here, under the /v1 prefix.
  // A preHandler rejects requests where request.tenant is null (returning 401).
  //
  // Route registrations are added as tasks are implemented:
  //   v1.register(eventsRoutes,    { prefix: "/events" });     // task 7
  //   v1.register(contactsRoutes,  { prefix: "/contacts" });   // task 8+
  //   v1.register(flowsRoutes,     { prefix: "/flows" });       // task 10
  //   v1.register(messagesRoutes,  { prefix: "/messages" });
  //   v1.register(kbRoutes,        { prefix: "/kb" });          // task 21
  //   v1.register(templatesRoutes, { prefix: "/templates" });
  //   v1.register(analyticsRoutes, { prefix: "/analytics" });
  //   v1.register(settingsRoutes,  { prefix: "/settings" });
  await app.register(
    async (v1) => {
      // Enforce authentication: reject requests without a resolved tenant.
      v1.addHook("preHandler", async (request, reply) => {
        if (request.tenant === null) {
          reply.status(401);
          reply.send({ error: "Authentication required." });
        }
      });
    },
    { prefix: "/v1" },
  );

  return app;
}
