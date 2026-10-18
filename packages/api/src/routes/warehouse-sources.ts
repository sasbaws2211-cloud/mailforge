/**
 * Warehouse sources: Loomail reads rows from the customer's Postgres, Snowflake or BigQuery on a schedule and records
 * them as traits and events (see warehouse/sync.ts). They live in the same table as the webhook sources
 * (`inbound_sources`, kind "warehouse"), but have their own routes because they have a credential, a schedule and a
 * position instead of an address and a token.
 *
 *   GET    /v1/warehouse-sources              list (never returns the credential)
 *   POST   /v1/warehouse-sources              create { name, config, secret }
 *   PATCH  /v1/warehouse-sources/:id          rename, enable/disable, change settings, replace the credential,
 *                                             or { reset_cursor: true } to read everything again
 *   DELETE /v1/warehouse-sources/:id          delete it and its log
 *   POST   /v1/warehouse-sources/:id/sync     run now, wait for the result
 *   POST   /v1/warehouse-sources/test         try a query for a few rows: { config, secret } or { id, config? }
 *   GET    /v1/warehouse-sources/:id/log      what it did lately, newest first (last 50)
 *
 * Reading is open to any member; anything that stores or uses a credential is owner-only.
 *
 * Mirror side: PUBLIC (packages/api is mirrored).
 */
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { and, desc, eq, sql } from "drizzle-orm";
import { resolveWarehouseHost, sealWebhookSecret, warehouseHostPolicyFromEnv, WAREHOUSE_HOST_NOT_ALLOWED } from "@loomail/adapters";
import { inboundSources, inboundSourceLog } from "@loomail/db/schema";
import type { Db } from "../plugins/db.js";
import { createLimiter } from "../marketing/signup-logic.js";
import { MAX_WAREHOUSE_SOURCES, postgresSecretPatchSchema, warehouseConfigSchema, warehouseSecretSchema, type WarehouseConfig, type WarehouseSecret } from "../warehouse/config.js";
import { previewQuery } from "../warehouse/preview.js";
import { readSecret, syncSource, type ClientFactory } from "../warehouse/sync.js";

export interface WarehouseRouteOptions {
  /** Tests only: replaces the real warehouse clients. */
  clientFor?: ClientFactory;
  /** Tests only: raise the per-workspace limits on "test query" and "sync now" (10 and 6 a minute). */
  limitsPerMinute?: { test?: number; sync?: number };
}

const issues = (error: z.ZodError, prefix = "") => error.issues.map((i) => ({ path: [prefix, i.path.join(".")].filter(Boolean).join("."), message: i.message }));

function view(r: typeof inboundSources.$inferSelect) {
  return {
    id: r.id,
    name: r.name,
    kind: r.kind,
    enabled: r.enabled,
    config: r.config,
    has_credential: r.secretSealed !== null,
    created_at: r.createdAt.toISOString(),
    last_received_at: r.lastReceivedAt ? r.lastReceivedAt.toISOString() : null,
    sync: {
      cursor: r.syncCursor,
      next_at: r.nextSyncAt ? r.nextSyncAt.toISOString() : null,
      last_at: r.lastSyncAt ? r.lastSyncAt.toISOString() : null,
      status: r.lastSyncStatus,
      note: r.lastSyncNote,
      running: r.syncLeaseUntil !== null && r.syncLeaseUntil.getTime() > Date.now(),
    },
  };
}

const createSchema = z.object({ name: z.string().trim().min(1).max(100), config: z.unknown(), secret: z.unknown() }).strict();
const patchSchema = z
  .object({ name: z.string().trim().min(1).max(100).optional(), enabled: z.boolean().optional(), config: z.unknown().optional(), secret: z.unknown().optional(), reset_cursor: z.boolean().optional() })
  .strict();
const testSchema = z.object({ id: z.string().uuid().optional(), config: z.unknown().optional(), secret: z.unknown().optional() }).strict();

function parseSecret(warehouse: WarehouseConfig["warehouse"], raw: unknown): { ok: true; secret: WarehouseSecret } | { ok: false; issues: Array<{ path: string; message: string }> } {
  const r = warehouseSecretSchema[warehouse].safeParse(raw);
  return r.success ? { ok: true, secret: r.data as WarehouseSecret } : { ok: false, issues: issues(r.error, "secret") };
}

type Issue = { path: string; message: string };

/** Where our server connects, checked against the private-address guard: the SSH server when there is a tunnel, else the database. */
async function hostProblem(config: WarehouseConfig): Promise<Issue | null> {
  if (config.warehouse !== "postgres") return null;
  const policy = warehouseHostPolicyFromEnv();
  if (config.ssh_tunnel) {
    // The database address is resolved by the SSH server, on the customer's network: it is meant to be private.
    const t = await resolveWarehouseHost(config.ssh_tunnel.host, policy);
    return t.ok ? null : { path: "config.ssh_tunnel.host", message: t.error };
  }
  const t = await resolveWarehouseHost(config.host, policy);
  return t.ok ? null : { path: "config.host", message: t.error };
}

/**
 * The credential to store or use. A new source (or a test with nothing saved) needs all of it. When editing a Postgres
 * source, what is given is merged over what is saved, so changing the password does not lose the SSH key and the other
 * way round; other warehouses take the new credential whole. An SSH key is required exactly when the settings use a tunnel,
 * and dropped when they do not.
 */
function resolveSecret(config: WarehouseConfig, given: unknown, saved: WarehouseSecret | null): { ok: true; secret: WarehouseSecret } | { ok: false; issues: Issue[] } {
  if (config.warehouse !== "postgres") {
    if (given === undefined) return saved ? { ok: true, secret: saved } : { ok: false, issues: [{ path: "secret", message: "Give the credential." }] };
    return parseSecret(config.warehouse, given);
  }
  let merged: Record<string, unknown> = {};
  if (given !== undefined) {
    const r = (saved ? postgresSecretPatchSchema : warehouseSecretSchema.postgres).safeParse(given);
    if (!r.success) return { ok: false, issues: issues(r.error, "secret") };
    merged = { ...(saved ?? {}), ...r.data };
  } else if (saved) {
    merged = { ...saved };
  }
  if (!config.ssh_tunnel) {
    delete merged.ssh_private_key;
    delete merged.ssh_passphrase;
  } else if (typeof merged.ssh_private_key !== "string") {
    return { ok: false, issues: [{ path: "secret.ssh_private_key", message: "The SSH tunnel needs its private key." }] };
  }
  if (typeof merged.password !== "string" || merged.password === "") return { ok: false, issues: [{ path: "secret.password", message: "Enter the database password." }] };
  return { ok: true, secret: merged as WarehouseSecret };
}

/** A warehouse credential is only ever stored encrypted. */
const NEEDS_KEY = { error: "ENCRYPTION_KEY is not set on this install, so a warehouse credential cannot be stored safely. Set ENCRYPTION_KEY and try again." };

const warehouseSourcesRoutes: FastifyPluginAsync<WarehouseRouteOptions> = async (app, opts) => {
  const testLimit = createLimiter({ windowMs: 60_000, max: opts.limitsPerMinute?.test ?? 10 });
  const syncLimit = createLimiter({ windowMs: 60_000, max: opts.limitsPerMinute?.sync ?? 6 });

  const own = async (db: Db, tenantId: string, id: string) => {
    if (!z.string().uuid().safeParse(id).success) return undefined;
    return (await db.select().from(inboundSources).where(and(eq(inboundSources.id, id), eq(inboundSources.tenantId, tenantId), eq(inboundSources.kind, "warehouse"))).limit(1))[0];
  };

  app.get("/", { config: { minRole: "member" } }, async (request) => {
    const db: Db = request.server.db;
    const rows = await db.select().from(inboundSources).where(and(eq(inboundSources.tenantId, request.tenant!.id), eq(inboundSources.kind, "warehouse"))).orderBy(desc(inboundSources.createdAt));
    return { sources: rows.map(view) };
  });

  app.post<{ Body: unknown }>("/", { config: { minRole: "owner" } }, async (request, reply) => {
    const db: Db = request.server.db;
    const tenantId = request.tenant!.id;
    if (!process.env.ENCRYPTION_KEY) {
      reply.status(503);
      return NEEDS_KEY;
    }
    const body = createSchema.safeParse(request.body);
    if (!body.success) {
      reply.status(400);
      return { error: "Validation failed", issues: issues(body.error) };
    }
    const config = warehouseConfigSchema.safeParse(body.data.config);
    if (!config.success) {
      reply.status(400);
      return { error: "Validation failed", issues: issues(config.error, "config") };
    }
    const secret = resolveSecret(config.data, body.data.secret, null);
    if (!secret.ok) {
      reply.status(400);
      return { error: "Validation failed", issues: secret.issues };
    }
    const problem = await hostProblem(config.data);
    if (problem) {
      reply.status(400);
      return { error: "Validation failed", issues: [problem] };
    }
    const count = (await db.select({ n: sql<number>`count(*)::int` }).from(inboundSources).where(and(eq(inboundSources.tenantId, tenantId), eq(inboundSources.kind, "warehouse"))))[0]!.n;
    if (count >= MAX_WAREHOUSE_SOURCES) {
      reply.status(409);
      return { error: `A workspace can have at most ${MAX_WAREHOUSE_SOURCES} warehouse sources.` };
    }
    const [row] = await db
      .insert(inboundSources)
      .values({ tenantId, name: body.data.name, kind: "warehouse", config: config.data, secretSealed: sealWebhookSecret(JSON.stringify(secret.secret)) })
      .returning();
    reply.status(201);
    return { source: view(row!) };
  });

  app.patch<{ Params: { id: string }; Body: unknown }>("/:id", { config: { minRole: "owner" } }, async (request, reply) => {
    const db: Db = request.server.db;
    const existing = await own(db, request.tenant!.id, request.params.id);
    if (!existing) {
      reply.status(404);
      return { error: "Source not found." };
    }
    const body = patchSchema.safeParse(request.body);
    if (!body.success) {
      reply.status(400);
      return { error: "Validation failed", issues: issues(body.error) };
    }
    const set: Partial<typeof inboundSources.$inferInsert> = {};
    if (body.data.name !== undefined) set.name = body.data.name;
    if (body.data.enabled !== undefined) set.enabled = body.data.enabled;
    if (body.data.reset_cursor) {
      set.syncCursor = null;
      set.syncBoundary = null;
      set.nextSyncAt = null;
    }
    const old = warehouseConfigSchema.safeParse(existing.config);
    if (body.data.config !== undefined) {
      const config = warehouseConfigSchema.safeParse(body.data.config);
      if (!config.success) {
        reply.status(400);
        return { error: "Validation failed", issues: issues(config.error, "config") };
      }
      if (old.success && old.data.warehouse !== config.data.warehouse) {
        reply.status(400);
        return { error: "Validation failed", issues: [{ path: "config.warehouse", message: "A source cannot change warehouse. Add a new source instead." }] };
      }
      const problem = await hostProblem(config.data);
      if (problem) {
        reply.status(400);
        return { error: "Validation failed", issues: [problem] };
      }
      set.config = config.data;
      // A new position column or type makes the saved position meaningless; start again from the beginning.
      if (old.success && (old.data.cursor_column !== config.data.cursor_column || old.data.cursor_type !== config.data.cursor_type)) {
        set.syncCursor = null;
        set.syncBoundary = null;
        set.nextSyncAt = null;
      }
    }
    // A credential is rewritten when one is given, and for Postgres also when the settings change (turning a tunnel on needs
    // its key; turning it off drops the key).
    const finalConfig = (set.config as WarehouseConfig | undefined) ?? (old.success ? old.data : undefined);
    const settingsChanged = set.config !== undefined && finalConfig?.warehouse === "postgres";
    if (body.data.secret !== undefined || settingsChanged) {
      if (!process.env.ENCRYPTION_KEY) {
        reply.status(503);
        return NEEDS_KEY;
      }
      if (!finalConfig) {
        reply.status(400);
        return { error: "Validation failed", issues: [{ path: "secret", message: "Save valid settings first." }] };
      }
      let saved: WarehouseSecret | null = null;
      try {
        saved = existing.secretSealed ? readSecret(existing) : null;
      } catch {
        saved = null;
      }
      const secret = resolveSecret(finalConfig, body.data.secret, saved);
      if (!secret.ok) {
        reply.status(400);
        return { error: "Validation failed", issues: secret.issues };
      }
      set.secretSealed = sealWebhookSecret(JSON.stringify(secret.secret));
    }
    if (Object.keys(set).length === 0) return { source: view(existing) };
    const [row] = await db.update(inboundSources).set(set).where(eq(inboundSources.id, existing.id)).returning();
    return { source: view(row!) };
  });

  app.delete<{ Params: { id: string } }>("/:id", { config: { minRole: "owner" } }, async (request, reply) => {
    const db: Db = request.server.db;
    const existing = await own(db, request.tenant!.id, request.params.id);
    if (!existing) {
      reply.status(404);
      return { error: "Source not found." };
    }
    await db.delete(inboundSources).where(eq(inboundSources.id, existing.id));
    return { deleted: true };
  });

  app.post<{ Params: { id: string } }>("/:id/sync", { config: { minRole: "owner" } }, async (request, reply) => {
    const db: Db = request.server.db;
    const existing = await own(db, request.tenant!.id, request.params.id);
    if (!existing) {
      reply.status(404);
      return { error: "Source not found." };
    }
    const limit = syncLimit.hit(`${request.tenant!.id}`);
    if (!limit.allowed) {
      reply.status(429).header("Retry-After", String(limit.retryAfterSec));
      return { error: "Slow down: wait a moment before syncing again." };
    }
    const outcome = await syncSource(db, existing.id, { enqueue: request.server.enqueue, ...(opts.clientFor ? { clientFor: opts.clientFor } : {}), log: request.log }, true);
    if (!outcome) {
      reply.status(409);
      return { error: "A sync is already running for this source." };
    }
    const row = await own(db, request.tenant!.id, existing.id);
    return { outcome, source: view(row!) };
  });

  app.post<{ Body: unknown }>("/test", { config: { minRole: "owner" } }, async (request, reply) => {
    const db: Db = request.server.db;
    const tenantId = request.tenant!.id;
    const limit = testLimit.hit(tenantId);
    if (!limit.allowed) {
      reply.status(429).header("Retry-After", String(limit.retryAfterSec));
      return { error: "Too many tests. Wait a moment." };
    }
    const body = testSchema.safeParse(request.body);
    if (!body.success) {
      reply.status(400);
      return { error: "Validation failed", issues: issues(body.error) };
    }
    const saved = body.data.id ? await own(db, tenantId, body.data.id) : undefined;
    if (body.data.id && !saved) {
      reply.status(404);
      return { error: "Source not found." };
    }
    const config = warehouseConfigSchema.safeParse(body.data.config ?? saved?.config);
    if (!config.success) {
      reply.status(400);
      return { error: "Validation failed", issues: issues(config.error, "config") };
    }
    let savedSecret: WarehouseSecret | null = null;
    if (saved) {
      try {
        savedSecret = readSecret(saved);
      } catch {
        savedSecret = null;
      }
    }
    if (body.data.secret === undefined && !savedSecret) {
      reply.status(400);
      return { error: "Validation failed", issues: [{ path: "secret", message: "Give the credential to test with." }] };
    }
    const resolved = resolveSecret(config.data, body.data.secret, savedSecret);
    if (!resolved.ok) {
      reply.status(400);
      return { error: "Validation failed", issues: resolved.issues };
    }
    const secret = resolved.secret;
    const problem = await hostProblem(config.data);
    if (problem) {
      reply.status(400);
      return { error: "Validation failed", issues: [problem] };
    }
    return previewQuery(config.data, secret, opts.clientFor);
  });

  app.get<{ Params: { id: string } }>("/:id/log", { config: { minRole: "member" } }, async (request, reply) => {
    const db: Db = request.server.db;
    const existing = await own(db, request.tenant!.id, request.params.id);
    if (!existing) {
      reply.status(404);
      return { error: "Source not found." };
    }
    const rows = await db
      .select({ id: inboundSourceLog.id, status: inboundSourceLog.status, summary: inboundSourceLog.summary, created_at: inboundSourceLog.createdAt })
      .from(inboundSourceLog)
      .where(eq(inboundSourceLog.sourceId, existing.id))
      .orderBy(desc(inboundSourceLog.createdAt), desc(inboundSourceLog.id))
      .limit(50);
    return { log: rows.map((r) => ({ ...r, created_at: r.created_at.toISOString() })) };
  });
};

export default warehouseSourcesRoutes;
export { WAREHOUSE_HOST_NOT_ALLOWED };
