/**
 * Integration tests for the platform AI provider ("Mailforge AI") and how it
 * layers with a customer's own key:
 *
 *   - the admin console sets, changes, switches off, tests and removes the
 *     operator's providers; the key is encrypted and never comes back out
 *   - a workspace with no key of its own uses the operator's provider; with a
 *     key of its own it uses that and nothing else
 *   - Mailforge AI is metered per call and capped per plan per month
 *     (only when plan enforcement is on); a workspace on its own key is not capped
 *   - the customer sees where their AI comes from, and can remove their key
 *
 * Needs a reachable Postgres via DATABASE_URL. Tenants here have slugs starting
 * with "ai-t-". The shared platform_llm_configs table is emptied around each
 * test so other files never see a platform provider for long.
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import { SESSION_COOKIE_NAME } from "../src/routes/auth.js";
import { decrypt, encrypt, parseEncryptionKey } from "@mailforge/adapters";
import { purgeWorkspace } from "@mailforge/db/purge";
import { loadLlmCandidates } from "@mailforge/db/llm";

const TEST_DB_URL = process.env.DATABASE_URL;
if (!TEST_DB_URL) throw new Error("[ai-provider.test] DATABASE_URL is not set.");

const TEST_ENCRYPTION_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const ADMIN_EMAIL = "boss@ai-t.example";
const REASON = "Setting up Mailforge AI for launch";

let pool: pg.Pool;
let lockClient: pg.PoolClient | undefined;
let db: ReturnType<typeof drizzle>;
let dbAvailable = false;
let app: FastifyInstance;
let savedEncryptionKey: string | undefined;
const enqueued: Array<{ queue: string; data: Record<string, unknown> }> = [];

// --- stub OpenAI-compatible provider ---------------------------------------
let stub: Server;
let stubUrl: string;
/** Keys the stub currently rejects with 401, to simulate a revoked key. */
const revoked = new Set<string>();
const stubCalls: Array<{ key: string }> = [];

beforeAll(async () => {
  savedEncryptionKey = process.env.ENCRYPTION_KEY;
  process.env.ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;

  stub = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      const key = (req.headers.authorization ?? "").replace(/^Bearer /, "");
      req.on("data", () => undefined);
      req.on("end", () => {
        stubCalls.push({ key });
        if (key.startsWith("sk-bad") || revoked.has(key)) {
          res.writeHead(401, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "Incorrect API key provided" } }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify({ subject: "Hello from AI", body_markdown: "Welcome aboard." }) } }],
            usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
          }),
        );
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
  stubUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}/v1`;

  pool = new pg.Pool({ connectionString: TEST_DB_URL, connectionTimeoutMillis: 3000 });
  try {
    await pool.query("SELECT 1");
    db = drizzle(pool);
    dbAvailable = true;
    // These files share global tables (platform_llm_configs, platform_alert_state), so only one runs at a time.
    lockClient = await pool.connect();
    await lockClient.query("SELECT pg_advisory_lock(7770001)");
  } catch (err) {
    if (process.env.CI === "true") throw new Error(`[ai-provider.test] DATABASE_URL not reachable in CI: ${(err as Error).message}`);
    console.warn("[ai-provider.test] DATABASE_URL not reachable - tests skipped.");
    return;
  }
  await cleanup();
  process.env.MAILFORGE_PLATFORM_ADMINS = ADMIN_EMAIL;
  app = await buildApp({
    logger: false,
    db,
    baseUrl: "http://localhost:3000",
    dashboardUrl: "http://localhost:3000",
    enqueue: async (queue, data) => {
      enqueued.push({ queue, data });
      return "job";
    },
  });
});

afterEach(async () => {
  if (!dbAvailable) return;
  delete process.env.MAILFORGE_ENFORCE_PLANS;
  revoked.clear();
  stubCalls.length = 0;
  enqueued.length = 0;
  await cleanup();
});

afterAll(async () => {
  delete process.env.MAILFORGE_PLATFORM_ADMINS;
  delete process.env.MAILFORGE_ENFORCE_PLANS;
  if (savedEncryptionKey !== undefined) process.env.ENCRYPTION_KEY = savedEncryptionKey;
  else delete process.env.ENCRYPTION_KEY;
  if (app) await app.close();
  if (lockClient) {
    await lockClient.query("SELECT pg_advisory_unlock(7770001)");
    lockClient.release();
  }
  await pool?.end();
  await new Promise<void>((resolve) => stub.close(() => resolve()));
});

// --- helpers ----------------------------------------------------------------
interface Tenant {
  id: string;
  slug: string;
  session: string;
  memberSession: string;
}

async function q<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  return (await db.execute(query)).rows as T[];
}

let counter = 0;
async function newTenant(opts: { plan?: string; email?: string } = {}): Promise<Tenant> {
  const slug = `ai-t-${Date.now()}-${counter++}`;
  const email = opts.email ?? `${slug}@ai-t.example`;
  const [t] = await q<{ id: string }>(sql`INSERT INTO tenants (name, slug, plan) VALUES (${slug}, ${slug}, ${opts.plan ?? "free"}) RETURNING id`);
  const id = t!.id;
  const [u] = await q<{ id: string }>(sql`INSERT INTO users (tenant_id, email, role) VALUES (${id}::uuid, ${email}, 'owner') RETURNING id`);
  const [m] = await q<{ id: string }>(sql`INSERT INTO users (tenant_id, email, role) VALUES (${id}::uuid, ${"m-" + email}, 'member') RETURNING id`);
  const [s] = await q<{ id: string }>(sql`INSERT INTO sessions (tenant_id, user_id, expires_at) VALUES (${id}::uuid, ${u!.id}::uuid, now() + interval '1 day') RETURNING id`);
  const [ms] = await q<{ id: string }>(sql`INSERT INTO sessions (tenant_id, user_id, expires_at) VALUES (${id}::uuid, ${m!.id}::uuid, now() + interval '1 day') RETURNING id`);
  const key = `mf_live_${randomBytes(24).toString("base64url")}`;
  await db.execute(sql`INSERT INTO api_keys (tenant_id, key_hash, prefix, label) VALUES (${id}::uuid, ${createHash("sha256").update(key).digest("hex")}, ${key.slice(0, 8)}, 'ai test')`);
  return { id, slug, session: s!.id, memberSession: ms!.id };
}

async function cleanup(): Promise<void> {
  await db.execute(sql`DELETE FROM platform_llm_configs`);
  const ids = (await q<{ id: string }>(sql`SELECT id FROM tenants WHERE slug LIKE 'ai-t-%'`)).map((r) => r.id);
  for (const id of ids) {
    for (const t of ["llm_usage", "llm_configs", "admin_audit_log", "flows", "api_keys", "sessions", "users"]) {
      await db.execute(sql.raw(`DELETE FROM ${t} WHERE tenant_id = '${id}'`));
    }
    await db.execute(sql`DELETE FROM tenants WHERE id = ${id}::uuid`);
  }
  await db.execute(sql`DELETE FROM admin_audit_log WHERE actor_email = ${ADMIN_EMAIL} AND tenant_id IS NULL`);
}

const as = (s: string) => ({ [SESSION_COOKIE_NAME]: s });
const call = (method: "GET" | "PUT" | "POST" | "DELETE", url: string, session: string, payload?: unknown) =>
  app.inject({ method, url, cookies: as(session), ...(payload !== undefined ? { payload: payload as object } : {}) });

async function newAdmin(): Promise<Tenant> {
  return newTenant({ email: ADMIN_EMAIL, plan: "growth" });
}

/** Save an operator provider through the real admin route. */
async function setPlatform(admin: Tenant, slot: "primary" | "fallback", apiKey: string, extra: Record<string, unknown> = {}) {
  return call("PUT", `/v1/admin/ai/${slot}`, admin.session, {
    provider: "custom",
    api_key: apiKey,
    base_url: stubUrl,
    model: `${slot}-model`,
    reason: REASON,
    ...extra,
  });
}

/** Give a workspace its own key straight in the table (the way the settings route stores it). */
async function giveOwnKey(t: Tenant, apiKey: string) {
  const envelope = encrypt(JSON.stringify({ apiKey, baseUrl: stubUrl, model: "own-model" }), parseEncryptionKey(TEST_ENCRYPTION_KEY));
  await db.execute(sql`INSERT INTO llm_configs (tenant_id, provider, config, is_active) VALUES (${t.id}::uuid, 'custom', ${envelope}, true)`);
}

async function addUsage(t: Tenant, source: "platform" | "byok", tokens: number, ok = true) {
  await db.execute(sql`
    INSERT INTO llm_usage (tenant_id, feature, source, provider, model, total_tokens, prompt_tokens, ok)
    VALUES (${t.id}::uuid, 'content', ${source}, 'custom', 'm', ${tokens}, ${tokens}, ${ok})`);
}

async function makeFlow(t: Tenant): Promise<string> {
  const [f] = await q<{ id: string }>(sql`
    INSERT INTO flows (tenant_id, name, trigger_type, trigger_config, steps, prompt_source)
    VALUES (${t.id}::uuid, 'F', 'event', '{}'::jsonb, '[]'::jsonb, 'welcome new users') RETURNING id`);
  return f!.id;
}

const usageRows = (t: Tenant) =>
  q<{ feature: string; source: string; total_tokens: number; ok: boolean; model: string | null }>(
    sql`SELECT feature, source, total_tokens, ok, model FROM llm_usage WHERE tenant_id = ${t.id}::uuid ORDER BY created_at, id`,
  );

// ---------------------------------------------------------------------------

describe("admin console: who may use it", () => {
  it("answers 404 to anyone who is not a platform admin, for every AI route", async () => {
    const customer = await newTenant();
    for (const [method, url] of [
      ["GET", "/v1/admin/ai"],
      ["PUT", "/v1/admin/ai/primary"],
      ["POST", "/v1/admin/ai/primary/enabled"],
      ["POST", "/v1/admin/ai/primary/test"],
      ["POST", "/v1/admin/ai/primary/remove"],
    ] as const) {
      const r = await call(method, url, customer.session, {});
      expect(r.statusCode, `${method} ${url}`).toBe(404);
    }
    expect((await app.inject({ method: "GET", url: "/v1/admin/ai" })).statusCode).toBeGreaterThanOrEqual(401);
  });
});

describe("admin console: setting the operator's provider", () => {
  it("starts empty and unavailable", async () => {
    const admin = await newAdmin();
    const r = await call("GET", "/v1/admin/ai", admin.session);
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.available).toBe(false);
    expect(body.providers).toEqual([{ slot: "primary", configured: false }, { slot: "fallback", configured: false }]);
    expect(body.usage.platform_tokens).toBe(0);
  });

  it("saves a verified key encrypted, never returns it, and keeps it out of the audit log", async () => {
    const admin = await newAdmin();
    const key = "sk-live_platform_secret_12345";
    const r = await setPlatform(admin, "primary", key);
    expect(r.statusCode).toBe(200);
    expect(JSON.stringify(r.json())).not.toContain(key);

    const [row] = await q<{ config: string; provider: string; enabled: boolean; updated_by: string }>(
      sql`SELECT config, provider, enabled, updated_by FROM platform_llm_configs WHERE slot = 'primary'`,
    );
    expect(row!.config).not.toContain(key); // encrypted at rest
    expect(JSON.parse(decrypt(row!.config, parseEncryptionKey(TEST_ENCRYPTION_KEY)))).toMatchObject({ apiKey: key, baseUrl: stubUrl, model: "primary-model" });
    expect(row!.enabled).toBe(true);
    expect(row!.updated_by).toBe(ADMIN_EMAIL);

    const overview = await call("GET", "/v1/admin/ai", admin.session);
    expect(overview.json().available).toBe(true);
    expect(overview.json().providers[0]).toMatchObject({ slot: "primary", configured: true, enabled: true, model: "primary-model", readable: true });
    expect(overview.body).not.toContain(key);

    const [audit] = await q<{ action: string; detail: Record<string, unknown> }>(
      sql`SELECT action, detail FROM admin_audit_log WHERE actor_email = ${ADMIN_EMAIL} AND tenant_id IS NULL ORDER BY created_at DESC LIMIT 1`,
    );
    expect(audit!.action).toBe("ai_provider_set");
    expect(audit!.detail).toMatchObject({ slot: "primary", provider: "custom", reason: REASON });
    expect(JSON.stringify(audit!.detail)).not.toContain(key);
  });

  it("refuses a rejected key, saves nothing, and says what the provider said", async () => {
    const admin = await newAdmin();
    const r = await setPlatform(admin, "primary", "sk-bad-key");
    expect(r.statusCode).toBe(422);
    expect(r.json().code).toBe("verification_failed");
    expect(r.json().error).toMatch(/Nothing was saved/);
    expect(await q(sql`SELECT 1 FROM platform_llm_configs`)).toHaveLength(0);
    expect(await q(sql`SELECT 1 FROM admin_audit_log WHERE actor_email = ${ADMIN_EMAIL} AND tenant_id IS NULL`)).toHaveLength(0);
  });

  it("validates the slot, the provider and the reason", async () => {
    const admin = await newAdmin();
    expect((await setPlatform(admin, "third" as "primary", "sk-x")).statusCode).toBe(400);
    expect((await setPlatform(admin, "primary", "sk-x", { provider: "nope" })).statusCode).toBe(400);
    const noReason = await setPlatform(admin, "primary", "sk-x", { reason: "" });
    expect(noReason.statusCode).toBe(400);
    expect(noReason.json().code).toBe("reason_required");
    expect((await setPlatform(admin, "primary", "sk-x", { reason: "x".repeat(301) })).statusCode).toBe(400);
    expect(await q(sql`SELECT 1 FROM platform_llm_configs`)).toHaveLength(0);
  });

  it("a blank key keeps the saved one for the same provider, but is refused for a different provider", async () => {
    const admin = await newAdmin();
    await setPlatform(admin, "primary", "sk-keep-me");
    stubCalls.length = 0;
    const same = await setPlatform(admin, "primary", "", { model: "bigger-model" });
    expect(same.statusCode).toBe(200);
    expect(stubCalls.at(-1)!.key).toBe("sk-keep-me");
    const [row] = await q<{ config: string }>(sql`SELECT config FROM platform_llm_configs WHERE slot = 'primary'`);
    expect(JSON.parse(decrypt(row!.config, parseEncryptionKey(TEST_ENCRYPTION_KEY)))).toMatchObject({ apiKey: "sk-keep-me", model: "bigger-model" });
    const [audit] = await q<{ action: string }>(sql`SELECT action FROM admin_audit_log WHERE actor_email = ${ADMIN_EMAIL} AND tenant_id IS NULL ORDER BY created_at DESC LIMIT 1`);
    expect(audit!.action).toBe("ai_provider_change");

    // Switching provider needs a fresh key: openai has no keyless mode.
    const other = await call("PUT", "/v1/admin/ai/primary", admin.session, { provider: "openai", api_key: "", reason: REASON });
    expect(other.statusCode).toBe(400);
    expect(other.json().error).toMatch(/API key is required/);
  });

  it("the kill switch skips a slot without losing its key, and turning it back on restores it", async () => {
    const admin = await newAdmin();
    const customer = await newTenant();
    await setPlatform(admin, "primary", "sk-primary");
    expect((await loadLlmCandidates(db, customer.id)).source).toBe("platform");

    const off = await call("POST", "/v1/admin/ai/primary/enabled", admin.session, { enabled: false, reason: "provider incident" });
    expect(off.statusCode).toBe(200);
    expect((await loadLlmCandidates(db, customer.id)).source).toBe("none");
    expect((await call("GET", "/v1/admin/ai", admin.session)).json().available).toBe(false);
    expect((await call("GET", "/v1/admin/ai", admin.session)).json().providers[0]).toMatchObject({ configured: true, enabled: false });

    await call("POST", "/v1/admin/ai/primary/enabled", admin.session, { enabled: true, reason: "incident over" });
    expect((await loadLlmCandidates(db, customer.id)).source).toBe("platform");

    const actions = (await q<{ action: string }>(sql`SELECT action FROM admin_audit_log WHERE actor_email = ${ADMIN_EMAIL} AND tenant_id IS NULL ORDER BY created_at, id`)).map((r) => r.action);
    expect(actions).toEqual(["ai_provider_set", "ai_provider_disable", "ai_provider_enable"]);
  });

  it("kill switch input is validated and an empty slot is a 404", async () => {
    const admin = await newAdmin();
    expect((await call("POST", "/v1/admin/ai/primary/enabled", admin.session, { enabled: "no", reason: REASON })).statusCode).toBe(400);
    expect((await call("POST", "/v1/admin/ai/primary/enabled", admin.session, { enabled: false })).statusCode).toBe(400);
    expect((await call("POST", "/v1/admin/ai/primary/enabled", admin.session, { enabled: false, reason: REASON })).statusCode).toBe(404);
    expect((await call("POST", "/v1/admin/ai/primary/remove", admin.session, { reason: REASON })).statusCode).toBe(404);
    expect((await call("POST", "/v1/admin/ai/primary/test", admin.session)).statusCode).toBe(404);
  });

  it("tests the saved key with a real call, and reports a key that stopped working", async () => {
    const admin = await newAdmin();
    await setPlatform(admin, "primary", "sk-testable");
    expect((await call("POST", "/v1/admin/ai/primary/test", admin.session)).json()).toEqual({ ok: true });
    revoked.add("sk-testable");
    const bad = (await call("POST", "/v1/admin/ai/primary/test", admin.session)).json();
    expect(bad).toMatchObject({ ok: false, kind: "http", status: 401 });
  });

  it("removes a slot and its key, with an audit row", async () => {
    const admin = await newAdmin();
    await setPlatform(admin, "fallback", "sk-fallback");
    const r = await call("POST", "/v1/admin/ai/fallback/remove", admin.session, { reason: "switching vendor" });
    expect(r.statusCode).toBe(200);
    expect(await q(sql`SELECT 1 FROM platform_llm_configs`)).toHaveLength(0);
    const [audit] = await q<{ action: string; detail: { reason: string } }>(sql`SELECT action, detail FROM admin_audit_log WHERE actor_email = ${ADMIN_EMAIL} AND tenant_id IS NULL ORDER BY created_at DESC LIMIT 1`);
    expect(audit).toMatchObject({ action: "ai_provider_remove", detail: { reason: "switching vendor" } });
  });
});

describe("which AI serves a workspace", () => {
  it("none -> platform (primary first, fallback second) -> own key wins over both", async () => {
    const admin = await newAdmin();
    const customer = await newTenant();
    expect((await loadLlmCandidates(db, customer.id)).source).toBe("none");

    await setPlatform(admin, "fallback", "sk-fb");
    await setPlatform(admin, "primary", "sk-pri");
    const platform = await loadLlmCandidates(db, customer.id);
    expect(platform.source).toBe("platform");
    expect(platform.candidates.map((c) => c.slot)).toEqual(["primary", "fallback"]);

    await giveOwnKey(customer, "sk-own");
    const own = await loadLlmCandidates(db, customer.id);
    expect(own.source).toBe("byok");
    expect(own.candidates).toHaveLength(1);
    expect(own.candidates[0]!.slot).toBeNull();
  });

  it("one workspace's own key never affects another", async () => {
    const admin = await newAdmin();
    const a = await newTenant();
    const b = await newTenant();
    await setPlatform(admin, "primary", "sk-pri");
    await giveOwnKey(a, "sk-a");
    expect((await loadLlmCandidates(db, a.id)).source).toBe("byok");
    expect((await loadLlmCandidates(db, b.id)).source).toBe("platform");
  });
});

describe("the customer's view: GET /v1/settings/llm", () => {
  it("says none, then platform, then byok as things are set up", async () => {
    const admin = await newAdmin();
    const c = await newTenant({ plan: "starter" });
    let r = (await call("GET", "/v1/settings/llm", c.session)).json();
    expect(r.llm).toBeNull();
    expect(r.ai.source).toBe("none");

    await setPlatform(admin, "primary", "sk-pri");
    r = (await call("GET", "/v1/settings/llm", c.session)).json();
    expect(r.llm).toBeNull();
    expect(r.ai).toMatchObject({ source: "platform", name: "Mailforge AI" });
    // The real vendor, model and key are never shown to customers.
    expect(JSON.stringify(r)).not.toMatch(/primary-model|sk-pri|127\.0\.0\.1/);

    await giveOwnKey(c, "sk-own");
    r = (await call("GET", "/v1/settings/llm", c.session)).json();
    expect(r.llm).not.toBeNull();
    expect(r.ai.source).toBe("byok");
  });

  it("shows the plan allowance and what has been used, when plans are enforced", async () => {
    const admin = await newAdmin();
    const c = await newTenant({ plan: "starter" });
    await setPlatform(admin, "primary", "sk-pri");
    await addUsage(c, "platform", 1234);
    process.env.MAILFORGE_ENFORCE_PLANS = "true";
    const r = (await call("GET", "/v1/settings/llm", c.session)).json();
    expect(r.ai.allowance).toMatchObject({ plan: "Starter", limit: 300_000, used: 1234, spent: false });
    expect(typeof r.ai.allowance.resets_at).toBe("string");
  });

  it("no cap when plans are not enforced (self-hosted)", async () => {
    const admin = await newAdmin();
    const c = await newTenant({ plan: "free" });
    await setPlatform(admin, "primary", "sk-pri");
    await addUsage(c, "platform", 99_999_999);
    const r = (await call("GET", "/v1/settings/llm", c.session)).json();
    expect(r.ai.allowance).toMatchObject({ limit: null, spent: false });
  });
});

describe("DELETE /v1/settings/llm: remove my own key", () => {
  it("returns the workspace to Mailforge AI", async () => {
    const admin = await newAdmin();
    const c = await newTenant();
    await setPlatform(admin, "primary", "sk-pri");
    await giveOwnKey(c, "sk-own");
    const r = await call("DELETE", "/v1/settings/llm", c.session);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ ok: true, removed: 1, ai: { source: "platform" } });
    expect((await call("GET", "/v1/settings/llm", c.session)).json().llm).toBeNull();
  });

  it("is idempotent, owner-only, and touches nobody else", async () => {
    const a = await newTenant();
    const b = await newTenant();
    await giveOwnKey(b, "sk-b");
    expect((await call("DELETE", "/v1/settings/llm", a.session)).json()).toMatchObject({ ok: true, removed: 0 });
    expect((await call("DELETE", "/v1/settings/llm", a.memberSession)).statusCode).toBe(403);
    expect((await loadLlmCandidates(db, b.id)).source).toBe("byok");
  });
});

describe("the plan meter", () => {
  it("reports Mailforge AI tokens against the plan, and each plan's allowance in the catalogue", async () => {
    const c = await newTenant({ plan: "growth" });
    await addUsage(c, "platform", 400_000);
    await addUsage(c, "byok", 5_000_000); // their own key: not counted
    process.env.MAILFORGE_ENFORCE_PLANS = "true";
    const r = (await call("GET", "/v1/plan", c.session)).json();
    expect(r.meters.ai).toMatchObject({ used: 400_000, limit: 1_500_000, state: "ok" });
    expect(r.plans.map((p: { limits: { ai_tokens_per_month: number } }) => p.limits.ai_tokens_per_month)).toEqual([20_000, 300_000, 1_500_000, 8_000_000]);
  });

  it("counts only the current calendar month", async () => {
    const c = await newTenant({ plan: "starter" });
    await db.execute(sql`INSERT INTO llm_usage (tenant_id, feature, source, provider, total_tokens, created_at) VALUES (${c.id}::uuid, 'content', 'platform', 'custom', 250000, now() - interval '40 days')`);
    await addUsage(c, "platform", 1000);
    process.env.MAILFORGE_ENFORCE_PLANS = "true";
    expect((await call("GET", "/v1/plan", c.session)).json().meters.ai.used).toBe(1000);
  });
});

describe("compile: AI must be available", () => {
  it("is refused with the old message when there is no AI at all", async () => {
    const c = await newTenant();
    const f = await makeFlow(c);
    const r = await call("POST", `/v1/flows/${f}/compile`, c.session);
    expect(r.statusCode).toBe(422);
    expect(r.json().error).toMatch(/No LLM configuration found/);
    expect(enqueued).toHaveLength(0);
  });

  it("goes ahead on Mailforge AI while the allowance lasts", async () => {
    const admin = await newAdmin();
    const c = await newTenant({ plan: "free" });
    await setPlatform(admin, "primary", "sk-pri");
    await addUsage(c, "platform", 19_999);
    process.env.MAILFORGE_ENFORCE_PLANS = "true";
    const f = await makeFlow(c);
    const r = await call("POST", `/v1/flows/${f}/compile`, c.session);
    expect(r.statusCode).toBe(202);
    expect(enqueued).toHaveLength(1);
  });

  it("is refused with 402 once the month's allowance is spent, naming both ways out", async () => {
    const admin = await newAdmin();
    const c = await newTenant({ plan: "free" });
    await setPlatform(admin, "primary", "sk-pri");
    await addUsage(c, "platform", 20_000);
    process.env.MAILFORGE_ENFORCE_PLANS = "true";
    const f = await makeFlow(c);
    const r = await call("POST", `/v1/flows/${f}/compile`, c.session);
    expect(r.statusCode).toBe(402);
    expect(r.json().code).toBe("ai_allowance");
    expect(r.json().error).toMatch(/upgrade your plan or add your own AI key/i);
    expect(enqueued).toHaveLength(0);
  });

  it("a workspace on its own key is never capped, however much it used on the platform before", async () => {
    const c = await newTenant({ plan: "free" });
    await addUsage(c, "platform", 5_000_000);
    await giveOwnKey(c, "sk-own");
    process.env.MAILFORGE_ENFORCE_PLANS = "true";
    const f = await makeFlow(c);
    expect((await call("POST", `/v1/flows/${f}/compile`, c.session)).statusCode).toBe(202);
  });
});

describe("AI draft: served, metered and tagged", () => {
  const draft = (t: Tenant, flowId: string) => call("POST", `/v1/flows/${flowId}/draft-step`, t.session, { step_order: 1 });

  it("on Mailforge AI: uses the operator's key and records platform usage", async () => {
    const admin = await newAdmin();
    const c = await newTenant({ plan: "starter" });
    await setPlatform(admin, "primary", "sk-pri");
    stubCalls.length = 0;
    const r = await draft(c, await makeFlow(c));
    expect(r.statusCode).toBe(200);
    expect(r.json().subject).toBe("Hello from AI");
    expect(stubCalls.map((s) => s.key)).toEqual(["sk-pri"]);
    expect(await usageRows(c)).toEqual([{ feature: "ai_draft", source: "platform", total_tokens: 150, ok: true, model: "primary-model" }]);
  });

  it("on its own key: uses that key, never the operator's, and records byok usage", async () => {
    const admin = await newAdmin();
    const c = await newTenant();
    await setPlatform(admin, "primary", "sk-pri");
    await giveOwnKey(c, "sk-own");
    stubCalls.length = 0;
    const r = await draft(c, await makeFlow(c));
    expect(r.statusCode).toBe(200);
    expect(stubCalls.map((s) => s.key)).toEqual(["sk-own"]);
    expect((await usageRows(c))[0]).toMatchObject({ source: "byok", feature: "ai_draft" });
  });

  it("a broken own key is reported as such, not silently replaced by the operator's provider", async () => {
    const admin = await newAdmin();
    const c = await newTenant();
    await setPlatform(admin, "primary", "sk-pri");
    await giveOwnKey(c, "sk-own");
    revoked.add("sk-own");
    stubCalls.length = 0;
    const r = await draft(c, await makeFlow(c));
    expect(r.statusCode).toBe(502);
    expect(stubCalls.map((s) => s.key)).toEqual(["sk-own"]);
    expect((await usageRows(c))[0]).toMatchObject({ source: "byok", ok: false, total_tokens: 0 });
  });

  it("fails over from a dead primary to the fallback, and bills the call to whoever answered", async () => {
    const admin = await newAdmin();
    const c = await newTenant();
    await setPlatform(admin, "primary", "sk-pri");
    await setPlatform(admin, "fallback", "sk-fb");
    revoked.add("sk-pri");
    stubCalls.length = 0;
    const r = await draft(c, await makeFlow(c));
    expect(r.statusCode).toBe(200);
    expect(stubCalls.map((s) => s.key)).toEqual(["sk-pri", "sk-fb"]);
    const rows = await usageRows(c);
    expect(rows).toEqual([
      { feature: "ai_draft", source: "platform", total_tokens: 0, ok: false, model: "primary-model" },
      { feature: "ai_draft", source: "platform", total_tokens: 150, ok: true, model: "fallback-model" },
    ]);
  });

  it("refuses with 402 when the allowance is spent, and makes no call to the provider", async () => {
    const admin = await newAdmin();
    const c = await newTenant({ plan: "free" });
    await setPlatform(admin, "primary", "sk-pri");
    await addUsage(c, "platform", 20_000);
    process.env.MAILFORGE_ENFORCE_PLANS = "true";
    stubCalls.length = 0;
    const r = await draft(c, await makeFlow(c));
    expect(r.statusCode).toBe(402);
    expect(r.json().code).toBe("ai_allowance");
    expect(stubCalls).toHaveLength(0);
  });

  it("with no AI anywhere: 422 and no call", async () => {
    const c = await newTenant();
    stubCalls.length = 0;
    expect((await draft(c, await makeFlow(c))).statusCode).toBe(422);
    expect(stubCalls).toHaveLength(0);
  });
});

describe("admin console: usage views", () => {
  it("totals the month, splits by feature, ranks workspaces and separates customers' own keys", async () => {
    const admin = await newAdmin();
    const heavy = await newTenant({ plan: "growth" });
    const light = await newTenant({ plan: "free" });
    await addUsage(heavy, "platform", 9000);
    await addUsage(heavy, "platform", 1000, false);
    await addUsage(light, "platform", 500);
    await addUsage(light, "byok", 7777);
    const r = (await call("GET", "/v1/admin/ai", admin.session)).json();
    expect(r.usage.platform_tokens).toBeGreaterThanOrEqual(10_500);
    expect(r.usage.byok_tokens).toBeGreaterThanOrEqual(7777);
    expect(r.usage.platform_failed_calls).toBeGreaterThanOrEqual(1);
    expect(r.usage.by_feature.find((f: { feature: string }) => f.feature === "content")).toBeTruthy();
    const mine = r.top_workspaces.filter((w: { slug: string }) => w.slug === heavy.slug || w.slug === light.slug);
    expect(mine.map((w: { slug: string }) => w.slug)).toEqual([heavy.slug, light.slug]);
    expect(mine[0]).toMatchObject({ tokens: 10_000, calls: 2, failed_calls: 1, plan: "growth" });
    expect(mine[1]).toMatchObject({ tokens: 500, calls: 1 });
  });

  it("each workspace's detail shows its AI source, usage and allowance", async () => {
    const admin = await newAdmin();
    const c = await newTenant({ plan: "starter" });
    await addUsage(c, "platform", 4000);
    let d = (await call("GET", `/v1/admin/tenants/${c.id}`, admin.session)).json();
    expect(d.ai).toMatchObject({ source: "platform", platform_tokens_this_month: 4000, calls_this_month: 1, allowance_tokens: 300_000 });
    await giveOwnKey(c, "sk-own");
    d = (await call("GET", `/v1/admin/tenants/${c.id}`, admin.session)).json();
    expect(d.ai.source).toBe("byok");
  });
});

describe("data handling", () => {
  it("usage rows are erased with the workspace", async () => {
    const c = await newTenant();
    await addUsage(c, "platform", 10);
    await addUsage(c, "byok", 20);
    await purgeWorkspace(db as never, c.id, "admin_immediate");
    expect(await q(sql`SELECT 1 FROM llm_usage WHERE tenant_id = ${c.id}::uuid`)).toHaveLength(0);
  });

  it("the platform's own provider rows are not tenant data and survive a workspace erase", async () => {
    const admin = await newAdmin();
    const c = await newTenant();
    await setPlatform(admin, "primary", "sk-pri");
    await purgeWorkspace(db as never, c.id, "admin_immediate");
    expect(await q(sql`SELECT 1 FROM platform_llm_configs`)).toHaveLength(1);
  });
});
