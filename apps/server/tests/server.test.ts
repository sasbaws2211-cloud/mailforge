import { describe, it, expect } from "vitest";
import { buildApp } from "@mailforge/api";

describe("@mailforge/server", () => {
  it("valid roles are defined", () => {
    const validRoles = ["all", "api", "worker", "scheduler"];
    expect(validRoles).toContain("all");
    expect(validRoles.length).toBe(4);
  });

  // Shutdown-path invariant: forceCloseConnections must be explicitly set to true.
  //
  // The shutdown sequence in apps/server/src/main.ts calls app.close() first.
  // Without forceCloseConnections: true, Fastify auto-selects 'idle' on Node 22
  // (closeIdleConnections), which only destroys idle keep-alive connections. An
  // active keep-alive connection - such as the one held by the Cloudflare Worker
  // ingress or the keep-warm cron - is not idle and would not be destroyed,
  // causing app.close() to hang until the remote end closes it (up to 60 s per
  // keep-warm interval). With forceCloseConnections: true, Fastify calls
  // server.closeAllConnections() instead, which destroys ALL connections
  // immediately. Measured result: app.close() returns in <200 ms.
  //
  // Why app.server.closeAllConnections does NOT guard this:
  // server.closeAllConnections is a Node http.Server method present since
  // Node 18.2 regardless of any Fastify option. The test stayed green even
  // with the option removed (confirmed 2026-07-29). It tests the Node version,
  // not the Fastify config.
  //
  // What does guard it: app.initialConfig.forceCloseConnections is the
  // frozen snapshot of the resolved options Fastify was built with
  // (packages/api/node_modules/fastify/fastify.js:354,
  //  packages/api/node_modules/fastify/lib/initialConfigValidation.js).
  // It is undefined when the option is absent and true when set to true.
  // If forceCloseConnections is ever removed from buildApp, this test goes red.
  it("forceCloseConnections: true is set on the Fastify instance (shutdown guard)", async () => {
    const app = await buildApp({ logger: false });
    // Cited from:
    //   packages/api/node_modules/fastify/types/instance.d.ts:586-606
    //   packages/api/node_modules/fastify/lib/initialConfigValidation.js
    //   packages/api/node_modules/fastify/fastify.js:354
    expect(app.initialConfig.forceCloseConnections).toBe(true);
    await app.close();
  });
});
