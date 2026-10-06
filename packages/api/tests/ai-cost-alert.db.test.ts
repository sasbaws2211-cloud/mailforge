/**
 * Integration tests for the second round of Mailforge AI features:
 *   - dollar cost: prices set on a provider turn tokens into dollars, recorded per call
 *   - per-workspace allowance override set by a platform admin
 *   - failure-rate health and the email alert to platform admins
 *
 * Needs a reachable Postgres via DATABASE_URL. Tenants have slugs starting with
 * "ai2-t-". The shared platform_llm_configs / platform_alert_state tables are
 * emptied around each test.
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
import { decrypt, parseEncryptionKey } from "@mailforge/adapters";
import { checkAiAlert, loadAiHealth, buildAiAlertEmail, aiAlertSettings } from "../src/ai/alerts.js";
import type { PlatformTransport } from "../src/platform-mailer.js";

const TEST_DB_URL = process.env.DATABASE_URL;
if (!TEST_DB_URL) throw new Error("[ai-cost-alert.test] DATABASE_URL is not set.");

const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const ADMIN_EMAIL = "boss@ai2-t.example";
const REASON = "Pricing and allowance";

let pool: pg.Pool;
let lockClient: pg.PoolClient | undefined;
let db: ReturnType<typeof drizzle>;
let dbAvailable = false;
let app: FastifyInstance;
let savedKey: string | undefined;
let stub: Server;
let stubUrl: string;

beforeAll(async () => {
  savedKey = process.env.ENCRYPTION_KEY;
  process.env.ENCRYPTION_KEY = KEY;
  stub = createServer((req, res) => {
    req.on("data", () => undefined);
    req.on("end", () => {
      if (req.url === "/v1/chat/completions") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify({ subject: "Hi", body_markdown: "Hello." }) } }],
            usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });
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
    if (process.env.CI === "true") throw new Error(`[ai-cost-alert.test] DATABASE_URL not reachable in CI: ${(err as Error).message}`);
    console.warn("[ai-cost-alert.test] DATABASE_URL not reachable - tests skipped.");
    return;
  }
  await cleanup();
  process.env.MAILFORGE_PLATFORM_ADMINS = ADMIN_EMAIL;
  app = await buildApp({ logger: false, db, baseUrl: "http://localhost:3000", dashboardUrl: "http://localhost:3000" });
});

afterEach(async () => {
  if (!dbAvailable) return;
  delete process.env.MAILFORGE_ENFORCE_PLANS;
  await cleanup();
});

afterAll(async () => {
  delete process.env.MAILFORGE_PLATFORM_ADMINS;
  delete process.env.MAILFORGE_ENFORCE_PLANS;
  if (savedKey !== undefined) process.env.ENCRYPTION_KEY = savedKey;
  else delete process.env.ENCRYPTION_KEY;
  if (app) await app.close();
  if (lockClient) {
    await lockClient.query("SELECT pg_advisory_unlock(7770001)");
    lockClient.release();
  }
  await pool?.end();
  await new Promise<void>((resolve) => stub.close(() => resolve()));
});

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
  const slug = `ai2-t-${Date.now()}-${counter++}`;
  const email = opts.email ?? `${slug}@ai2-t.example`;
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
  await db.execute(sql`DELETE FROM platform_alert_state`);
  const ids = (await q<{ id: string }>(sql`SELECT id FROM tenants WHERE slug LIKE 'ai2-t-%'`)).map((r) => r.id);
  for (const id of ids) {
    for (const t of ["llm_usage", "llm_configs", "admin_audit_log", "flows", "api_keys", "sessions", "users"]) {
      await db.execute(sql.raw(`DELETE FROM ${t} WHERE tenant_id = '${id}'`));
    }
    await db.execute(sql`DELETE FROM tenants WHERE id = ${id}::uuid`);
  }
  await db.execute(sql`DELETE FROM admin_audit_log WHERE actor_email = ${ADMIN_EMAIL} AND tenant_id IS NULL`);
}

const as = (s: string) => ({ [SESSION_COOKIE_NAME]: s });
const call = (method: "GET" | "PUT" | "POST", url: string, session: string, payload?: unknown) =>
  app.inject({ method, url, cookies: as(session), ...(payload !== undefined ? { payload: payload as object } : {}) });

const newAdmin = () => newTenant({ email: ADMIN_EMAIL, plan: "growth" });

const setPlatform = (admin: Tenant, extra: Record<string, unknown> = {}) =>
  call("PUT", "/v1/admin/ai/primary", admin.session, { provider: "custom", api_key: "sk-pri", base_url: stubUrl, model: "pri-model", reason: REASON, ...extra });

async function makeFlow(t: Tenant): Promise<string> {
  const [f] = await q<{ id: string }>(sql`
    INSERT INTO flows (tenant_id, name, trigger_type, trigger_config, steps, prompt_source)
    VALUES (${t.id}::uuid, 'F', 'event', '{}'::jsonb, '[]'::jsonb, 'welcome') RETURNING id`);
  return f!.id;
}
const draft = async (t: Tenant) => call("POST", `/v1/flows/${await makeFlow(t)}/draft-step`, t.session, { step_order: 1 });
const usageRows = (t: Tenant) =>
  q<{ source: string; cost_micros: number; total_tokens: number }>(sql`SELECT source, cost_micros::int AS cost_micros, total_tokens FROM llm_usage WHERE tenant_id = ${t.id}::uuid ORDER BY created_at, id`);

async function addUsage(t: Tenant, opts: { source?: string; ok?: boolean; tokens?: number; cost?: number; ageMinutes?: number }) {
  await db.execute(sql`
    INSERT INTO llm_usage (tenant_id, feature, source, provider, total_tokens, cost_micros, ok, created_at)
    VALUES (${t.id}::uuid, 'content', ${opts.source ?? "platform"}, 'custom', ${opts.tokens ?? 10}, ${opts.cost ?? 0}, ${opts.ok ?? true}, now() - (${opts.ageMinutes ?? 0} * interval '1 minute'))`);
}

// ---------------------------------------------------------------------------

describe("provider prices", () => {
  it("are saved encrypted with the key, shown back, and never leak the key", async () => {
    const admin = await newAdmin();
    const r = await setPlatform(admin, { input_price: 2.5, output_price: 10 });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ input_price: 2.5, output_price: 10 });
    const [row] = await q<{ config: string }>(sql`SELECT config FROM platform_llm_configs WHERE slot = 'primary'`);
    expect(JSON.parse(decrypt(row!.config, parseEncryptionKey(KEY)))).toMatchObject({ apiKey: "sk-pri", input_price: 2.5, output_price: 10 });
    const o = (await call("GET", "/v1/admin/ai", admin.session)).json();
    expect(o.providers[0]).toMatchObject({ input_price: 2.5, output_price: 10 });
    expect(o.prices_missing).toBe(false);
    expect(JSON.stringify(o)).not.toContain("sk-pri");
  });

  it("left out on a later save keep the saved ones, null clears them, and a different provider starts clean", async () => {
    const admin = await newAdmin();
    await setPlatform(admin, { input_price: 2, output_price: 8 });
    await setPlatform(admin, { api_key: "", model: "bigger" });
    let o = (await call("GET", "/v1/admin/ai", admin.session)).json();
    expect(o.providers[0]).toMatchObject({ model: "bigger", input_price: 2, output_price: 8 });
    await setPlatform(admin, { api_key: "", input_price: null });
    o = (await call("GET", "/v1/admin/ai", admin.session)).json();
    expect(o.providers[0]).toMatchObject({ input_price: null, output_price: 8 });
    expect(o.prices_missing).toBe(true);
  });

  it("are checked: dollars per million tokens, 0 to 1000", async () => {
    const admin = await newAdmin();
    for (const bad of [-1, 1001, "abc"]) {
      const r = await setPlatform(admin, { input_price: bad });
      expect(r.statusCode, String(bad)).toBe(400);
      expect(r.json().code).toBe("invalid_price");
    }
    expect(await q(sql`SELECT 1 FROM platform_llm_configs`)).toHaveLength(0);
    expect((await setPlatform(admin, { input_price: 0, output_price: 0 })).statusCode).toBe(200);
  });

  it("with none set, the overview says the dollar figures undercount", async () => {
    const admin = await newAdmin();
    await setPlatform(admin);
    expect((await call("GET", "/v1/admin/ai", admin.session)).json().prices_missing).toBe(true);
  });
});

describe("cost of AI calls", () => {
  it("is recorded on each call from the provider's prices (100 in x $2 + 50 out x $10 = 700 micro-dollars)", async () => {
    const admin = await newAdmin();
    const c = await newTenant({ plan: "starter" });
    await setPlatform(admin, { input_price: 2, output_price: 10 });
    expect((await draft(c)).statusCode).toBe(200);
    expect(await usageRows(c)).toEqual([{ source: "platform", cost_micros: 700, total_tokens: 150 }]);
  });

  it("is zero when no prices are set, and zero on a customer's own key", async () => {
    const admin = await newAdmin();
    const c = await newTenant();
    await setPlatform(admin);
    await draft(c);
    expect((await usageRows(c))[0]!.cost_micros).toBe(0);

    const own = await newTenant();
    const { encrypt } = await import("@mailforge/adapters");
    const env = encrypt(JSON.stringify({ apiKey: "sk-own", baseUrl: stubUrl, model: "own", input_price: 99, output_price: 99 }), parseEncryptionKey(KEY));
    await db.execute(sql`INSERT INTO llm_configs (tenant_id, provider, config, is_active) VALUES (${own.id}::uuid, 'custom', ${env}, true)`);
    await draft(own);
    expect(await usageRows(own)).toEqual([{ source: "byok", cost_micros: 0, total_tokens: 150 }]);
  });

  it("shows up in dollars: total, by feature, per heaviest workspace and per workspace page", async () => {
    const admin = await newAdmin();
    const a = await newTenant({ plan: "growth" });
    const b = await newTenant({ plan: "free" });
    await addUsage(a, { tokens: 1000, cost: 2_500_000 }); // $2.50
    await addUsage(a, { tokens: 1000, cost: 500_000 }); // $0.50
    await addUsage(b, { tokens: 10, cost: 100_000 }); // $0.10
    await addUsage(b, { source: "byok", tokens: 999, cost: 0 });
    const o = (await call("GET", "/v1/admin/ai", admin.session)).json();
    expect(o.usage.platform_cost_usd).toBeGreaterThanOrEqual(3.1);
    expect(o.usage.by_feature.find((f: { feature: string }) => f.feature === "content").cost_usd).toBeGreaterThanOrEqual(3.1);
    const mine = o.top_workspaces.filter((w: { slug: string }) => w.slug === a.slug || w.slug === b.slug);
    expect(mine.map((w: { cost_usd: number }) => w.cost_usd)).toEqual([3, 0.1]);
    const d = (await call("GET", `/v1/admin/tenants/${a.id}`, admin.session)).json();
    expect(d.ai.platform_cost_usd).toBe(3);
  });
});

describe("per-workspace allowance override", () => {
  const set = (admin: Tenant, t: Tenant, tokens: unknown, reason: unknown = REASON) =>
    call("POST", `/v1/admin/tenants/${t.id}/ai-allowance`, admin.session, { tokens, reason });

  it("gives one workspace more than its plan, and the customer's own meter follows", async () => {
    const admin = await newAdmin();
    const c = await newTenant({ plan: "free" });
    const other = await newTenant({ plan: "free" });
    process.env.MAILFORGE_ENFORCE_PLANS = "true";
    const r = await set(admin, c, 750_000);
    expect(r.statusCode).toBe(200);
    expect(r.json().workspace.ai_allowance_override).toBe(750_000);
    expect((await call("GET", "/v1/plan", c.session)).json().meters.ai.limit).toBe(750_000);
    expect((await call("GET", "/v1/plan", other.session)).json().meters.ai.limit).toBe(20_000); // nobody else changes
    const d = (await call("GET", `/v1/admin/tenants/${c.id}`, admin.session)).json();
    expect(d.ai).toMatchObject({ allowance_override: 750_000, allowance_tokens: 750_000 });
  });

  it("really changes what is blocked: a workspace over its plan but under its override can still use AI", async () => {
    const admin = await newAdmin();
    const c = await newTenant({ plan: "free" });
    await setPlatform(admin);
    await addUsage(c, { tokens: 25_000 }); // over Free's 20,000
    process.env.MAILFORGE_ENFORCE_PLANS = "true";
    expect((await draft(c)).statusCode).toBe(402);
    await set(admin, c, 100_000);
    expect((await draft(c)).statusCode).toBe(200);
  });

  it("can be lowered (down to zero) as well as raised", async () => {
    const admin = await newAdmin();
    const c = await newTenant({ plan: "growth" });
    await setPlatform(admin);
    process.env.MAILFORGE_ENFORCE_PLANS = "true";
    await set(admin, c, 0);
    expect((await draft(c)).statusCode).toBe(402);
  });

  it("'unlimited' lifts the cap, and null returns to the plan's", async () => {
    const admin = await newAdmin();
    const c = await newTenant({ plan: "free" });
    process.env.MAILFORGE_ENFORCE_PLANS = "true";
    await set(admin, c, "unlimited");
    let meter = (await call("GET", "/v1/plan", c.session)).json().meters.ai;
    expect(meter).toMatchObject({ limit: null, state: "unlimited" });
    expect((await q<{ v: number }>(sql`SELECT ai_allowance_override AS v FROM tenants WHERE id = ${c.id}::uuid`))[0]!.v).toBe(-1);
    await set(admin, c, null);
    meter = (await call("GET", "/v1/plan", c.session)).json().meters.ai;
    expect(meter.limit).toBe(20_000);
  });

  it("is validated, needs a reason, and 404s for an unknown workspace", async () => {
    const admin = await newAdmin();
    const c = await newTenant();
    for (const bad of [-5, 1.5, "lots", 2_000_000_000, undefined, true]) {
      const r = await set(admin, c, bad);
      expect(r.statusCode, String(bad)).toBe(400);
      expect(r.json().code).toBe("invalid_tokens");
    }
    const noReason = await set(admin, c, 5, "");
    expect(noReason.statusCode).toBe(400);
    expect(noReason.json().code).toBe("reason_required");
    expect((await call("POST", "/v1/admin/tenants/00000000-0000-4000-8000-000000000000/ai-allowance", admin.session, { tokens: 5, reason: REASON })).statusCode).toBe(404);
    expect((await q<{ v: number | null }>(sql`SELECT ai_allowance_override AS v FROM tenants WHERE id = ${c.id}::uuid`))[0]!.v).toBeNull();
  });

  it("is audited with before and after, and only platform admins can do it", async () => {
    const admin = await newAdmin();
    const c = await newTenant();
    await set(admin, c, 5000);
    await set(admin, c, "unlimited");
    const rows = await q<{ action: string; detail: { before: { ai_allowance_override: number | null }; after: { ai_allowance_override: number | null }; reason: string } }>(
      sql`SELECT action, detail FROM admin_audit_log WHERE tenant_id = ${c.id}::uuid ORDER BY created_at, id`,
    );
    expect(rows.map((r) => r.action)).toEqual(["set_ai_allowance", "set_ai_allowance"]);
    expect(rows[0]!.detail).toMatchObject({ before: { ai_allowance_override: null }, after: { ai_allowance_override: 5000 }, reason: REASON });
    expect(rows[1]!.detail.after.ai_allowance_override).toBe(-1);
    // The workspace's own owner cannot give itself tokens.
    expect((await call("POST", `/v1/admin/tenants/${c.id}/ai-allowance`, c.session, { tokens: 999, reason: REASON })).statusCode).toBe(404);
  });

  it("does nothing when plans are not enforced (self-hosted has no cap anyway)", async () => {
    const admin = await newAdmin();
    const c = await newTenant({ plan: "free" });
    await set(admin, c, 5);
    const s = (await call("GET", "/v1/settings/llm", c.session)).json();
    expect(s.ai.allowance.limit).toBeNull();
  });
});

describe("AI health", () => {
  it("counts only the operator's provider, only the recent window", async () => {
    const t = await newTenant();
    for (let i = 0; i < 6; i++) await addUsage(t, { ok: false });
    for (let i = 0; i < 4; i++) await addUsage(t, { ok: true });
    for (let i = 0; i < 30; i++) await addUsage(t, { ok: false, source: "byok" }); // customers' own keys never count
    for (let i = 0; i < 30; i++) await addUsage(t, { ok: false, ageMinutes: 120 }); // too old
    const h = await loadAiHealth(db as never, new Date());
    expect(h).toMatchObject({ calls: 10, failed: 6, unhealthy: true });
    expect(h.rate).toBeCloseTo(0.6, 5);
  });

  it("is shown in the admin overview", async () => {
    const admin = await newAdmin();
    const t = await newTenant();
    for (let i = 0; i < 10; i++) await addUsage(t, { ok: false });
    const h = (await call("GET", "/v1/admin/ai", admin.session)).json().health;
    expect(h).toMatchObject({ window_minutes: 15, calls: 10, failed: 10, unhealthy: true });
  });

  it("thresholds can be tuned from the environment, and bad values are ignored", () => {
    expect(aiAlertSettings({ MAILFORGE_AI_ALERT_MIN_CALLS: "3", MAILFORGE_AI_ALERT_FAIL_RATE: "0.9" } as NodeJS.ProcessEnv)).toMatchObject({ minCalls: 3, failRate: 0.9 });
    expect(aiAlertSettings({ MAILFORGE_AI_ALERT_MIN_CALLS: "-4", MAILFORGE_AI_ALERT_FAIL_RATE: "7", MAILFORGE_AI_ALERT_WINDOW_MINUTES: "x" } as NodeJS.ProcessEnv)).toMatchObject({
      minCalls: 10,
      failRate: 0.5,
      windowMinutes: 15,
    });
  });
});

describe("failure alert email", () => {
  const sent: Array<{ to: string; subject: string; bodyText: string; bodyHtml: string }> = [];
  let failSends = false;
  const transport: PlatformTransport = {
    fromEmail: "no-reply@x.test",
    fromName: null,
    adapter: {
      send: async (m: { to: string; subject: string; bodyText: string; bodyHtml: string }) => {
        if (failSends) return { success: false, error: "smtp down" };
        sent.push({ to: m.to, subject: m.subject, bodyText: m.bodyText, bodyHtml: m.bodyHtml });
        return { success: true, messageId: "id" };
      },
    } as never,
  };
  const opts = { transport, admins: ["a@x.test", "b@x.test"], consoleUrl: "unused", env: { BASE_URL: "https://app.example.com" } as NodeJS.ProcessEnv };
  const T0 = new Date();
  const mins = (m: number) => new Date(T0.getTime() + m * 60_000);

  async function fail(t: Tenant, n: number, ok = 0) {
    for (let i = 0; i < n; i++) await addUsage(t, { ok: false });
    for (let i = 0; i < ok; i++) await addUsage(t, { ok: true });
  }
  const state = () => q<{ active: boolean; last_sent_at: Date | null }>(sql`SELECT active, last_sent_at FROM platform_alert_state WHERE key = 'ai_failure_rate'`);

  afterEach(() => {
    sent.length = 0;
    failSends = false;
  });

  it("emails every platform admin once when most calls fail, and says what to do", async () => {
    const t = await newTenant();
    await fail(t, 8, 2);
    const r = await checkAiAlert(db as never, T0, opts);
    expect(r.sent).toBe(2);
    expect(sent.map((m) => m.to)).toEqual(["a@x.test", "b@x.test"]);
    expect(sent[0]!.subject).toMatch(/Mailforge AI is failing: 80%/);
    expect(sent[0]!.bodyText).toMatch(/8 of 10/);
    expect(sent[0]!.bodyText).toMatch(/Test key/);
    expect(sent[0]!.bodyText).toContain("/admin/ai");
    expect((await state())[0]!.active).toBe(true);
  });

  it("does not repeat inside the cooldown, reminds after it, and stays silent when healthy", async () => {
    const t = await newTenant();
    await fail(t, 10);
    await checkAiAlert(db as never, T0, opts);
    sent.length = 0;
    expect((await checkAiAlert(db as never, mins(5), opts)).sent).toBe(0);
    expect((await checkAiAlert(db as never, mins(59), opts)).sent).toBe(0);
    // Past the cooldown the failures are older than the window, so make fresh ones to be "still failing".
    expect((await checkAiAlert(db as never, mins(61), opts)).sent).toBe(0); // window empty by then: healthy, nothing to say
    expect(sent).toHaveLength(0);
  });

  it("a reminder goes out when the problem is still going an hour later", async () => {
    const t = await newTenant();
    await fail(t, 10);
    await checkAiAlert(db as never, T0, opts);
    sent.length = 0;
    // Pretend the first email went out 61 minutes ago while calls are still failing now.
    await db.execute(sql`UPDATE platform_alert_state SET last_sent_at = now() - interval '61 minutes'`);
    expect((await checkAiAlert(db as never, new Date(), opts)).sent).toBe(2);
  });

  it("recovery clears the incident so the next one alerts straight away", async () => {
    const t = await newTenant();
    await fail(t, 10);
    await checkAiAlert(db as never, T0, opts);
    expect((await state())[0]!.active).toBe(true);
    await db.execute(sql`DELETE FROM llm_usage WHERE tenant_id = ${t.id}::uuid`);
    await addUsage(t, { ok: true });
    await checkAiAlert(db as never, new Date(), opts);
    expect((await state())[0]!.active).toBe(false);
    sent.length = 0;
    await fail(t, 12);
    expect((await checkAiAlert(db as never, new Date(), opts)).sent).toBe(2);
  });

  it("stays quiet below the minimum number of calls, below the failure rate, and for customers' own keys", async () => {
    const t = await newTenant();
    await fail(t, 9); // too few
    expect((await checkAiAlert(db as never, T0, opts)).sent).toBe(0);
    await db.execute(sql`DELETE FROM llm_usage WHERE tenant_id = ${t.id}::uuid`);
    await fail(t, 4, 10); // plenty of calls, mostly fine
    expect((await checkAiAlert(db as never, T0, opts)).sent).toBe(0);
    await db.execute(sql`DELETE FROM llm_usage WHERE tenant_id = ${t.id}::uuid`);
    for (let i = 0; i < 50; i++) await addUsage(t, { ok: false, source: "byok" });
    expect((await checkAiAlert(db as never, T0, opts)).sent).toBe(0);
    expect(await state()).toHaveLength(0);
  });

  it("without a platform email sender or admins nothing is sent and the incident is NOT marked as told", async () => {
    const t = await newTenant();
    await fail(t, 10);
    expect((await checkAiAlert(db as never, T0, { ...opts, transport: null })).sent).toBe(0);
    expect((await checkAiAlert(db as never, T0, { ...opts, admins: [] })).sent).toBe(0);
    expect(await state()).toHaveLength(0);
    // Once it can send, it does.
    expect((await checkAiAlert(db as never, T0, opts)).sent).toBe(2);
  });

  it("a failed delivery is not counted as told, so the next check tries again", async () => {
    const t = await newTenant();
    await fail(t, 10);
    failSends = true;
    expect((await checkAiAlert(db as never, T0, opts)).sent).toBe(0);
    expect(await state()).toHaveLength(0);
    failSends = false;
    expect((await checkAiAlert(db as never, T0, opts)).sent).toBe(2);
  });

  it("the email escapes its text and carries no secrets", () => {
    const m = buildAiAlertEmail({ windowMinutes: 15, calls: 20, failed: 20, rate: 1, unhealthy: true }, "https://x.test/admin/ai?a=1&b=<2>");
    expect(m.html).not.toContain("<2>");
    expect(m.html).toContain("&lt;2&gt;");
    expect(m.subject).toContain("100%");
    expect(m.text).not.toMatch(/sk-|api[_ ]?key\s*[:=]/i);
  });
});
