/**
 * Bearer token authentication plugin for event ingestion.
 *
 * Resolves tenant from the API key in the Authorization header.
 *
 * Security model: we store only the SHA-256 hash of each key. On each request
 * we hash the incoming bearer value and look it up via DB equality. Timing
 * attacks are not a concern here because:
 * - The comparison is on hash outputs, not raw secrets.
 * - An attacker cannot control which byte of the hash differs (changing one
 *   character of the input produces an entirely unrelated SHA-256 output).
 * - Exploiting a timing side-channel on hash comparison would require finding
 *   preimages that produce hashes differing at progressively later bytes,
 *   which is computationally equivalent to brute-forcing SHA-256.
 *
 * Therefore the DB's built-in equality check on key_hash is sufficient.
 * No application-level timingSafeEqual is needed or used.
 *
 * This plugin is registered on the ingestion scope ONLY. It does NOT share
 * any auth logic with the session-cookie tenant plugin used by the dashboard.
 *
 * Mirror side: PUBLIC (packages/api is mirrored).
 */
import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { eq, isNull, and } from "drizzle-orm";
import { apiKeys } from "@claros/db/schema";
import type { Db } from "./db.js";

export interface IngestTenantContext {
  id: string;
  apiKeyId: string;
}

declare module "fastify" {
  interface FastifyRequest {
    ingestTenant: IngestTenantContext | null;
  }
}

/**
 * Hash a raw API key to its storage form (SHA-256 hex).
 * Exported for use in key generation utilities.
 */
export function hashApiKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/**
 * Register bearer-token authentication on an encapsulated Fastify scope.
 *
 * Every request in this scope must carry `Authorization: Bearer <write_key>`.
 * The key is hashed and looked up in api_keys WHERE revoked_at IS NULL.
 * On success, request.ingestTenant is set. On failure, 401 is returned.
 */
export function registerIngestAuthPlugin(app: FastifyInstance): void {
  app.decorateRequest("ingestTenant", null as IngestTenantContext | null);

  // Throttle last_used_at writes: at most once per 60 seconds per key.
  // Ingestion is the hot path - writing the same row on every request
  // produces dead-tuple accumulation for no informational gain.
  // The column answers "is this key in use," and a per-minute write
  // answers that question just as well.
  const lastWrittenAt = new Map<string, number>();
  const THROTTLE_MS = 60_000;

  app.addHook("preHandler", async (request: FastifyRequest, reply: FastifyReply) => {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      reply.status(401);
      return reply.send({ error: "Missing or invalid Authorization header." });
    }

    const rawKey = authHeader.slice(7); // Remove "Bearer "
    if (!rawKey) {
      reply.status(401);
      return reply.send({ error: "Missing or invalid Authorization header." });
    }

    const db: Db = request.server.db;
    if (!db) {
      reply.status(500);
      return reply.send({ error: "Database unavailable." });
    }

    // Hash the incoming key
    const incomingHash = hashApiKey(rawKey);

    // Look up active keys matching this hash.
    // The partial unique index (uq_api_keys_hash_active) makes this fast.
    const rows = await db
      .select({
        id: apiKeys.id,
        tenantId: apiKeys.tenantId,
      })
      .from(apiKeys)
      .where(and(eq(apiKeys.keyHash, incomingHash), isNull(apiKeys.revokedAt)))
      .limit(1);

    if (rows.length === 0) {
      reply.status(401);
      return reply.send({ error: "Invalid or revoked API key." });
    }

    const row = rows[0]!;

    request.ingestTenant = {
      id: row.tenantId,
      apiKeyId: row.id,
    };

    // Fire-and-forget: update last_used_at, throttled to once per 60s per key.
    const now = Date.now();
    const lastWrite = lastWrittenAt.get(row.id) ?? 0;
    if (now - lastWrite >= THROTTLE_MS) {
      lastWrittenAt.set(row.id, now);
      db.update(apiKeys)
        .set({ lastUsedAt: new Date(now) })
        .where(eq(apiKeys.id, row.id))
        .then(() => {})
        .catch(() => {
          // On failure, clear the cache entry so the next request retries
          lastWrittenAt.delete(row.id);
        });
    }
  });
}

/**
 * Exposed for testing only: allows tests to override the throttle interval.
 * In production this is not called.
 */
export function createIngestAuthPlugin(throttleMs: number) {
  return function registerIngestAuthPluginWithThrottle(app: FastifyInstance): void {
    app.decorateRequest("ingestTenant", null as IngestTenantContext | null);

    const lastWrittenAt = new Map<string, number>();

    app.addHook("preHandler", async (request: FastifyRequest, reply: FastifyReply) => {
      const authHeader = request.headers.authorization;
      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        reply.status(401);
        return reply.send({ error: "Missing or invalid Authorization header." });
      }

      const rawKey = authHeader.slice(7);
      if (!rawKey) {
        reply.status(401);
        return reply.send({ error: "Missing or invalid Authorization header." });
      }

      const db: Db = request.server.db;
      if (!db) {
        reply.status(500);
        return reply.send({ error: "Database unavailable." });
      }

      const incomingHash = hashApiKey(rawKey);

      const rows = await db
        .select({
          id: apiKeys.id,
          tenantId: apiKeys.tenantId,
        })
        .from(apiKeys)
        .where(and(eq(apiKeys.keyHash, incomingHash), isNull(apiKeys.revokedAt)))
        .limit(1);

      if (rows.length === 0) {
        reply.status(401);
        return reply.send({ error: "Invalid or revoked API key." });
      }

      const row = rows[0]!;

      request.ingestTenant = {
        id: row.tenantId,
        apiKeyId: row.id,
      };

      const now = Date.now();
      const lastWrite = lastWrittenAt.get(row.id) ?? 0;
      if (now - lastWrite >= throttleMs) {
        lastWrittenAt.set(row.id, now);
        db.update(apiKeys)
          .set({ lastUsedAt: new Date(now) })
          .where(eq(apiKeys.id, row.id))
          .then(() => {})
          .catch(() => {
            lastWrittenAt.delete(row.id);
          });
      }
    });
  };
}
