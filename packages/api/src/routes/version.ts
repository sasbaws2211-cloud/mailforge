/**
 * Build provenance route.
 *
 * GET /version - unauthenticated, no database access.
 *
 * Returns the commit SHA the image was built from, the edition, and the image
 * build timestamp. The SHA is injected at image build time via:
 *
 *   docker build --build-arg COMMIT_SHA=<sha> ...
 *
 * which sets MAILFORGE_COMMIT_SHA in the runner stage ENV. A locally built image
 * without the argument returns "unknown" for commit - this is intentional and
 * never crashes or blocks startup.
 *
 * What is NOT included: hostnames, full env values, secrets, credentials, or
 * any fingerprint. This endpoint is public and must be safe to expose.
 *
 * Mirror side: PUBLIC (packages/api is mirrored).
 */
import type { FastifyPluginAsync } from "fastify";

interface VersionRouteOptions {
  edition: string;
}

const versionRoute: FastifyPluginAsync<VersionRouteOptions> = async (app, opts) => {
  const { edition } = opts;

  app.get(
    "/version",
    {
      schema: {
        response: {
          200: {
            type: "object",
            properties: {
              commit:  { type: "string" },
              edition: { type: "string" },
              builtAt: { type: ["string", "null"] },
            },
          },
        },
      },
    },
    async () => ({
      commit:  process.env.MAILFORGE_COMMIT_SHA ?? "unknown",
      edition,
      builtAt: process.env.MAILFORGE_BUILT_AT ?? null,
    }),
  );
};

export default versionRoute;
