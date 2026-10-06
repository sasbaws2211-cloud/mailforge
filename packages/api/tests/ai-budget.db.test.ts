/**
 * Integration tests for the monthly dollar budget on Mailforge AI: setting it in
 * the admin console, pausing Mailforge AI when it is used up (own-key workspaces
 * carry on), and the two alert emails (80 percent, and used up).
 *
 * Needs a reachable Postgres via DATABASE_URL. Tenants have slugs starting with
 * "ai3-t-". The shared platform tables are emptied around each test, and the
 * file holds the same advisory lock as the other AI test files.
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
import { encrypt, parseEncryptionKey } from "@mailforge/adapters";
import { AI_BUDGET_PAUSED_KEY, buildAiBudgetEmail, buildAiResumedEmail, checkAiBudgetAlert } from "../src/ai/alerts.js";
import type { PlatformTransport } from "../src/platform-mailer.js";

const TEST_DB_URL = process.env.DATABASE_URL;
if (!TEST_DB_URL) throw new Error("[ai-budget.test] DATABASE_URL is not set.");

const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const ADMIN_EMAIL = "boss@ai3-t.example";
const REASON = "Capping AI spend";

let pool: pg.Pool;
let lockClient: pg.PoolClient | undefined;
let db: ReturnType<typeof drizzle>;
let dbAvailable = false;
let app: FastifyInstance;
let savedKey: string | undefined;
let stub: Server;
let stubUrl: string;
let stubCalls = 0;
const enqueued: unknown[] = [];

beforeAll(async () => {
  savedKey = process.env.ENCRYPTION_KEY;
  process.env.ENCRYPTION_KEY = KEY;
  stub = createServer((req, res) => {
    req.on("data", () => undefined);
    req.on("end", () => {
      if (req.url === "/v1/chat/completions") {
        stubCalls++;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ subject: "Hi", body_markdown: "Hello." }) } }], usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } }));
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
    lockClient = await pool.connect();
    await lockClient.query("SELECT pg_advisory_lock(7770001)");
  } catch (err) {
    if (process.env.CI === "true") throw new Error(`[ai-budget.test] DATABASE_URL not reachable in CI: ${(err as Error).message}`);
    console.warn("[ai-budget.test] DATABASE_URL not reachable - tests skipped.");
    return;
  }
  await cleanup();
  process.env.MAILFORGE_PLATFORM_ADMINS = ADMIN_EMAIL;
  app = await buildApp({
    logger: false,
    db,
    baseUrl: "http://localhost:3000",
    dashboardUrl: "http://localhost:3000",
    enqueue: async (_q, d) => {
      enqueued.push(d);
      return "job";
    },
  });
});

afterEach(async () => {
  if (!dbAvailable) return;
  delete process.env.MAILFORGE_ENFORCE_PLANS;
  stubCalls = 0;
  enqueued.length = 0;
  await cleanup();
});

afterAll(async () => {
  delete process.env.MAILFORGE_PLATFORM_ADMINS;
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
}

async function q<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  return (await db.execute(query)).rows as T[];
}

let counter = 0;
async function newTenant(opts: { plan?: string; email?: string } = {}): Promise<Tenant> {
  const slug = `ai3-t-${Date.now()}-${counter++}`;
  const email = opts.email ?? `${slug}@ai3-t.example`;
  const [t] = await q<{ id: string }>(sql`INSERT INTO tenants (name, slug, plan) VALUES (${slug}, ${slug}, ${opts.plan ?? "free"}) RETURNING id`);
  const id = t!.id;
  const [u] = await q<{ id: string }>(sql`INSERT INTO users (tenant_id, email, role) VALUES (${id}::uuid, ${email}, 'owner') RETURNING id`);
  const [s] = await q<{ id: string }>(sql`INSERT INTO sessions (tenant_id, user_id, expires_at) VALUES (${id}::uuid, ${u!.id}::uuid, now() + interval '1 day') RETURNING id`);
  const key = `mf_live_${randomBytes(24).toString("base64url")}`;
  await db.execute(sql`INSERT INTO api_keys (tenant_id, key_hash, prefix, label) VALUES (${id}::uuid, ${createHash("sha256").update(key).digest("hex")}, ${key.slice(0, 8)}, 'ai test')`);
  return { id, slug, session: s!.id };
}

async function cleanup(): Promise<void> {
  await db.execute(sql`DELETE FROM platform_llm_configs`);
  await db.execute(sql`DELETE FROM platform_alert_state`);
  await db.execute(sql`DELETE FROM platform_settings`);
  const ids = (await q<{ id: string }>(sql`SELECT id FROM tenants WHERE slug LIKE 'ai3-t-%'`)).map((r) => r.id);
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
const setBudget = (admin: Tenant, monthly_usd: unknown, reason: unknown = REASON) => call("PUT", "/v1/admin/ai/budget", admin.session, { monthly_usd, reason });
const setPlatform = (admin: Tenant) =>
  call("PUT", "/v1/admin/ai/primary", admin.session, { provider: "custom", api_key: "sk-pri", base_url: stubUrl, model: "m", reason: REASON });

async function makeFlow(t: Tenant): Promise<string> {
  const [f] = await q<{ id: string }>(sql`INSERT INTO flows (tenant_id, name, trigger_type, trigger_config, steps, prompt_source) VALUES (${t.id}::uuid, 'F', 'event', '{}'::jsonb, '[]'::jsonb, 'welcome') RETURNING id`);
  return f!.id;
}
const draft = async (t: Tenant) => call("POST", `/v1/flows/${await makeFlow(t)}/draft-step`, t.session, { step_order: 1 });
const compile = async (t: Tenant) => call("POST", `/v1/flows/${await makeFlow(t)}/compile`, t.session);

/** Spend `usd` on the operator provider this month (one usage row). */
async function spend(t: Tenant, usd: number, opts: { source?: string; ageDays?: number } = {}) {
  await db.execute(sql`
    INSERT INTO llm_usage (tenant_id, feature, source, provider, total_tokens, cost_micros, created_at)
    VALUES (${t.id}::uuid, 'content', ${opts.source ?? "platform"}, 'custom', 10, ${Math.round(usd * 1_000_000)}, now() - (${opts.ageDays ?? 0} * interval '1 day'))`);
}
async function giveOwnKey(t: Tenant) {
  const env = encrypt(JSON.stringify({ apiKey: "sk-own", baseUrl: stubUrl, model: "own" }), parseEncryptionKey(KEY));
  await db.execute(sql`INSERT INTO llm_configs (tenant_id, provider, config, is_active) VALUES (${t.id}::uuid, 'custom', ${env}, true)`);
}

// ---------------------------------------------------------------------------

describe("setting the budget (admin console)", () => {
  it("is saved, shown with spend and state, audited with before and after", async () => {
    const admin = await newAdmin();
    const c = await newTenant();
    expect((await call("GET", "/v1/admin/ai", admin.session)).json().budget).toMatchObject({ monthly_usd: null, state: "none" });
    expect((await setBudget(admin, 50)).json()).toEqual({ ok: true, monthly_usd: 50 });
    await spend(c, 41);
    const b = (await call("GET", "/v1/admin/ai", admin.session)).json().budget;
    expect(b).toMatchObject({ monthly_usd: 50, state: "near" });
    expect(b.spent_usd).toBeGreaterThanOrEqual(41);
    await setBudget(admin, 80);
    await setBudget(admin, null);
    const rows = await q<{ action: string; detail: { before: { monthly_usd: number | null }; after: { monthly_usd: number | null }; reason: string } }>(
      sql`SELECT action, detail FROM admin_audit_log WHERE actor_email = ${ADMIN_EMAIL} AND tenant_id IS NULL ORDER BY created_at, id`,
    );
    expect(rows.map((r) => r.action)).toEqual(["ai_budget_set", "ai_budget_set", "ai_budget_clear"]);
    expect(rows[1]!.detail).toMatchObject({ before: { monthly_usd: 50 }, after: { monthly_usd: 80 }, reason: REASON });
    expect((await call("GET", "/v1/admin/ai", admin.session)).json().budget.monthly_usd).toBeNull();
  });

  it("is validated, needs a reason, and only platform admins may set it", async () => {
    const admin = await newAdmin();
    const customer = await newTenant();
    for (const bad of [0, -5, "50", 20_000_000, undefined, true]) {
      const r = await setBudget(admin, bad);
      expect(r.statusCode, String(bad)).toBe(400);
      expect(r.json().code).toBe("invalid_budget");
    }
    const noReason = await setBudget(admin, 10, "");
    expect(noReason.statusCode).toBe(400);
    expect(noReason.json().code).toBe("reason_required");
    expect((await setBudget(customer, 10)).statusCode).toBe(404);
    expect(await q(sql`SELECT 1 FROM platform_settings`)).toHaveLength(0);
  });
});

describe("when the budget is used up", () => {
  it("Mailforge AI pauses: drafting and compiling answer 503 with a message that mentions no money, and the provider is not called", async () => {
    const admin = await newAdmin();
    const c = await newTenant();
    await setPlatform(admin);
    await setBudget(admin, 5);
    await spend(c, 5);
    stubCalls = 0;
    const d = await draft(c);
    expect(d.statusCode).toBe(503);
    expect(d.json().code).toBe("ai_unavailable");
    expect(d.json().error).toMatch(/own AI key/i);
    expect(d.json().error).not.toMatch(/budget|\$|dollar|cost|spend/i);
    const k = await compile(c);
    expect(k.statusCode).toBe(503);
    expect(k.json().code).toBe("ai_unavailable");
    expect(stubCalls).toBe(0);
    expect(enqueued).toHaveLength(0);
    expect((await call("GET", "/v1/settings/llm", c.session)).json().ai.unavailable).toBe(true);
  });

  it("just below the budget everything still works; the call that crosses it is the last", async () => {
    const admin = await newAdmin();
    const c = await newTenant();
    await setPlatform(admin);
    await setBudget(admin, 5);
    await spend(c, 4.99);
    expect((await draft(c)).statusCode).toBe(200);
    expect((await call("GET", "/v1/settings/llm", c.session)).json().ai.unavailable).toBe(false);
    await spend(c, 0.01);
    expect((await draft(c)).statusCode).toBe(503);
  });

  it("workspaces on their own key carry on untouched", async () => {
    const admin = await newAdmin();
    const own = await newTenant();
    const spender = await newTenant();
    await setPlatform(admin);
    await setBudget(admin, 1);
    await spend(spender, 2);
    await giveOwnKey(own);
    expect((await draft(own)).statusCode).toBe(200);
    expect((await call("GET", "/v1/settings/llm", own.session)).json().ai.unavailable).toBe(false);
    expect((await draft(spender)).statusCode).toBe(503);
  });

  it("raising or removing the budget resumes it at once, and a customer adding a key escapes the pause", async () => {
    const admin = await newAdmin();
    const c = await newTenant();
    await setPlatform(admin);
    await setBudget(admin, 5);
    await spend(c, 5);
    expect((await draft(c)).statusCode).toBe(503);
    await setBudget(admin, 20);
    expect((await draft(c)).statusCode).toBe(200);
    await setBudget(admin, 1);
    expect((await draft(c)).statusCode).toBe(503);
    await giveOwnKey(c);
    expect((await draft(c)).statusCode).toBe(200);
    await db.execute(sql`DELETE FROM llm_configs WHERE tenant_id = ${c.id}::uuid`);
    await setBudget(admin, null);
    expect((await draft(c)).statusCode).toBe(200);
  });

  it("only this calendar month's spend counts, and only the operator provider", async () => {
    const admin = await newAdmin();
    const c = await newTenant();
    await setPlatform(admin);
    await setBudget(admin, 5);
    await spend(c, 100, { ageDays: 40 }); // last month
    await spend(c, 100, { source: "byok" }); // a customer's own key is not the operator's cost
    expect((await draft(c)).statusCode).toBe(200);
  });

  it("is independent of plan enforcement and of the per-workspace allowance", async () => {
    const admin = await newAdmin();
    const c = await newTenant({ plan: "scale" });
    await setPlatform(admin);
    await setBudget(admin, 1);
    await spend(c, 1);
    await db.execute(sql`UPDATE tenants SET ai_allowance_override = -1 WHERE id = ${c.id}::uuid`); // "no cap" does not beat the budget
    expect((await draft(c)).statusCode).toBe(503);
    process.env.MAILFORGE_ENFORCE_PLANS = "true";
    expect((await draft(c)).statusCode).toBe(503);
  });
});

describe("budget alert emails", () => {
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
  const opts = { transport, admins: ["a@x.test", "b@x.test"], env: { BASE_URL: "https://app.example.com" } as NodeJS.ProcessEnv };
  const NOW = new Date();
  const alertKeys = () => q<{ key: string }>(sql`SELECT key FROM platform_alert_state WHERE key LIKE 'ai_budget_near:%' OR key LIKE 'ai_budget_reached:%' ORDER BY key`).then((r) => r.map((x) => x.key));

  afterEach(() => {
    sent.length = 0;
    failSends = false;
  });

  it("stays silent with no budget, and while spend is under 80 percent", async () => {
    const c = await newTenant();
    await spend(c, 1000);
    expect((await checkAiBudgetAlert(db as never, NOW, opts)).sent).toBe(0); // no budget set
    await db.execute(sql`INSERT INTO platform_settings (key, value) VALUES ('ai_budget_usd', '{"monthly_usd": 100}'::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
    await db.execute(sql`DELETE FROM llm_usage WHERE tenant_id = ${c.id}::uuid`);
    await spend(c, 79.99);
    expect(await checkAiBudgetAlert(db as never, NOW, opts)).toMatchObject({ state: "ok", sent: 0 });
    expect(sent).toHaveLength(0);
  });

  it("warns every platform admin once at 80 percent, and not again", async () => {
    const admin = await newAdmin();
    const c = await newTenant();
    await setBudget(admin, 100);
    await spend(c, 82);
    const r = await checkAiBudgetAlert(db as never, NOW, opts);
    expect(r).toMatchObject({ state: "near", sent: 2 });
    expect(sent.map((m) => m.to)).toEqual(["a@x.test", "b@x.test"]);
    expect(sent[0]!.subject).toMatch(/82% of your \$100\.00 monthly budget/);
    expect(sent[0]!.bodyText).toMatch(/pauses for every workspace/i);
    expect(sent[0]!.bodyText).toContain("https://app.example.com/admin/ai");
    sent.length = 0;
    expect((await checkAiBudgetAlert(db as never, NOW, opts)).sent).toBe(0);
    expect((await checkAiBudgetAlert(db as never, new Date(NOW.getTime() + 3_600_000), opts)).sent).toBe(0);
  });

  it("says Mailforge AI is paused when the budget is reached, once, and that also retires the 80 percent warning", async () => {
    const admin = await newAdmin();
    const c = await newTenant();
    await setBudget(admin, 100);
    await spend(c, 100);
    expect(await checkAiBudgetAlert(db as never, NOW, opts)).toMatchObject({ state: "reached", sent: 2 });
    expect(sent[0]!.subject).toMatch(/Mailforge AI is paused/);
    expect(sent[0]!.bodyText).toMatch(/Nothing is lost/);
    expect(sent[0]!.bodyText).toMatch(/not affected/);
    sent.length = 0;
    expect((await checkAiBudgetAlert(db as never, NOW, opts)).sent).toBe(0);
    expect((await alertKeys()).some((k) => k.startsWith("ai_budget_near:"))).toBe(true); // no stale 80% mail afterwards
  });

  it("each threshold fires in order across a month: 80 percent, then used up", async () => {
    const admin = await newAdmin();
    const c = await newTenant();
    await setBudget(admin, 100);
    await spend(c, 85);
    await checkAiBudgetAlert(db as never, NOW, opts);
    await spend(c, 20);
    await checkAiBudgetAlert(db as never, NOW, opts);
    expect(sent.filter((m) => m.to === "a@x.test").map((m) => (m.subject.includes("paused") ? "reached" : "near"))).toEqual(["near", "reached"]);
  });

  it("raising the budget re-arms the alerts for the new amount", async () => {
    const admin = await newAdmin();
    const c = await newTenant();
    await setBudget(admin, 100);
    await spend(c, 100);
    await checkAiBudgetAlert(db as never, NOW, opts);
    sent.length = 0;
    await setBudget(admin, 200); // spent $100 of $200: 50 percent: no threshold, but the pause is over
    expect(await checkAiBudgetAlert(db as never, NOW, opts)).toMatchObject({ state: "ok", resumed: true, sent: 2 });
    expect(sent.map((m) => m.subject)).toEqual(["Mailforge AI is back on", "Mailforge AI is back on"]);
    sent.length = 0;
    await spend(c, 65); // $165 of $200: 82 percent
    expect(await checkAiBudgetAlert(db as never, NOW, opts)).toMatchObject({ state: "near", sent: 2 });
  });

  it("a new month starts fresh", async () => {
    const admin = await newAdmin();
    const c = await newTenant();
    await setBudget(admin, 100);
    await spend(c, 100);
    await checkAiBudgetAlert(db as never, NOW, opts);
    sent.length = 0;
    const nextMonth = new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth() + 1, 5));
    expect(await checkAiBudgetAlert(db as never, nextMonth, opts)).toMatchObject({ state: "ok", resumed: true }); // nothing spent yet in that month
    expect(sent).toHaveLength(2);
    expect(sent[0]!.bodyText).toMatch(/new month has begun/i);
  });

  it("with no email sender or no admins nothing is sent and it is NOT marked as told; a failed delivery is retried", async () => {
    const admin = await newAdmin();
    const c = await newTenant();
    await setBudget(admin, 100);
    await spend(c, 100);
    expect((await checkAiBudgetAlert(db as never, NOW, { ...opts, transport: null })).sent).toBe(0);
    expect((await checkAiBudgetAlert(db as never, NOW, { ...opts, admins: [] })).sent).toBe(0);
    failSends = true;
    expect((await checkAiBudgetAlert(db as never, NOW, opts)).sent).toBe(0);
    expect(await alertKeys()).toHaveLength(0);
    failSends = false;
    expect((await checkAiBudgetAlert(db as never, NOW, opts)).sent).toBe(2);
  });

  it("the email text is escaped and shows the dollars the way a person reads them", () => {
    const m = buildAiBudgetEmail("reached", 1234.5, 1300.123, "https://x.test/admin/ai?a=1&b=<2>", "November 1");
    expect(m.subject).toBe("Mailforge AI is paused: your $1,234.50 monthly budget is used up");
    expect(m.text).toContain("$1,300.12");
    expect(m.html).toContain("&lt;2&gt;");
    expect(m.html).not.toContain("<2>");
  });
});

describe("the Mailforge AI is back on email", () => {
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
  const opts = { transport, admins: ["a@x.test", "b@x.test"], env: { BASE_URL: "https://app.example.com" } as NodeJS.ProcessEnv };
  const NOW = new Date();
  const check = (o = opts, at = NOW) => checkAiBudgetAlert(db as never, at, o);
  const paused = () => q<{ active: boolean }>(sql`SELECT active FROM platform_alert_state WHERE key = ${AI_BUDGET_PAUSED_KEY}`).then((r) => r[0]?.active ?? null);
  const backOn = () => sent.filter((m) => m.subject === "Mailforge AI is back on");

  afterEach(() => {
    sent.length = 0;
    failSends = false;
  });

  /** A workspace that has spent exactly its budget, with the pause already seen by a check. */
  async function pausedAt(budget: number) {
    const admin = await newAdmin();
    const c = await newTenant();
    await setBudget(admin, budget);
    await spend(c, budget);
    await check();
    sent.length = 0;
    return { admin, c };
  }

  it("goes to every platform admin, once, when the budget is raised: what happened, the figures, and that nothing needs doing", async () => {
    const { admin } = await pausedAt(100);
    expect(await paused()).toBe(true);
    await setBudget(admin, 300);
    expect(await check()).toMatchObject({ resumed: true, sent: 2 });
    expect(backOn().map((m) => m.to)).toEqual(["a@x.test", "b@x.test"]);
    expect(backOn()[0]!.bodyText).toMatch(/raised to \$300\.00 \(\$100\.00 spent so far\)/);
    expect(backOn()[0]!.bodyText).toMatch(/nothing needs doing/i);
    expect(backOn()[0]!.bodyText).toContain("https://app.example.com/admin/ai");
    expect(await paused()).toBe(false);
    sent.length = 0;
    expect(await check()).toMatchObject({ resumed: false, sent: 0 });
    expect(sent).toHaveLength(0);
  });

  it("says the budget was removed when it is removed", async () => {
    const { admin } = await pausedAt(100);
    await setBudget(admin, null);
    expect(await check()).toMatchObject({ state: "none", resumed: true, sent: 2 });
    expect(backOn()[0]!.bodyText).toMatch(/budget was removed/i);
  });

  it("says a new month began when the month rolls over", async () => {
    await pausedAt(100);
    const nextMonth = new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth() + 1, 3));
    expect(await check(opts, nextMonth)).toMatchObject({ resumed: true });
    expect(backOn()[0]!.bodyText).toMatch(/new month has begun/i);
  });

  it("remembers when the pause began, and does not rewrite it on every check while still paused", async () => {
    await pausedAt(100);
    const began = new Date((await q<{ t: Date | string }>(sql`SELECT last_sent_at AS t FROM platform_alert_state WHERE key = ${AI_BUDGET_PAUSED_KEY}`))[0]!.t).getTime();
    await check(opts, new Date(NOW.getTime() + 10 * 60_000));
    await check(opts, new Date(NOW.getTime() + 20 * 60_000));
    const after = new Date((await q<{ t: Date | string }>(sql`SELECT last_sent_at AS t FROM platform_alert_state WHERE key = ${AI_BUDGET_PAUSED_KEY}`))[0]!.t).getTime();
    expect(after).toBe(began);
  });

  it("is never sent when there was no pause (including a budget raised after only the 80 percent warning)", async () => {
    const admin = await newAdmin();
    const c = await newTenant();
    await setBudget(admin, 100);
    await spend(c, 85);
    await check();
    await setBudget(admin, 500);
    await check();
    await setBudget(admin, null);
    await check();
    expect(backOn()).toHaveLength(0);
    expect(await paused()).toBeNull();
  });

  it("each pause gets its own: pause, resume, pause again, resume again", async () => {
    const { admin, c } = await pausedAt(100);
    await setBudget(admin, 200);
    await check(); // back on (1)
    await spend(c, 100); // $200 of $200: paused again
    expect(await check()).toMatchObject({ state: "reached" });
    expect(await paused()).toBe(true);
    await setBudget(admin, 400);
    await check(); // back on (2)
    expect(backOn()).toHaveLength(4); // two pauses, two admins each
  });

  it("a flap inside one check interval sends nothing: still paused, so no email either way", async () => {
    const { admin } = await pausedAt(100);
    await setBudget(admin, 500);
    await setBudget(admin, 100); // back to the old, used-up budget before any check ran
    expect(await check()).toMatchObject({ state: "reached", sent: 0, resumed: false });
    expect(sent).toHaveLength(0);
    expect(await paused()).toBe(true);
  });

  it("is not marked as sent when it could not be: no sender, no admins, or a failed delivery is retried at the next check", async () => {
    const { admin } = await pausedAt(100);
    await setBudget(admin, 300);
    expect((await check({ ...opts, transport: null })).resumed).toBe(false);
    expect((await check({ ...opts, admins: [] })).resumed).toBe(false);
    failSends = true;
    expect((await check()).resumed).toBe(false);
    expect(await paused()).toBe(true);
    failSends = false;
    expect(await check()).toMatchObject({ resumed: true, sent: 2 });
  });

  it("still goes out when the pause itself could not be emailed about (the pause was recorded anyway)", async () => {
    const admin = await newAdmin();
    const c = await newTenant();
    await setBudget(admin, 100);
    await spend(c, 100);
    await check({ ...opts, transport: null }); // paused, but nobody could be told
    expect(await paused()).toBe(true);
    await setBudget(admin, 300);
    expect((await check()).resumed).toBe(true);
    expect(backOn()).toHaveLength(2);
  });

  it("can be followed straight away by the 80 percent warning for the new budget, as two separate emails", async () => {
    const { admin } = await pausedAt(100);
    await setBudget(admin, 120); // $100 of $120 is 83 percent
    const r = await check();
    expect(r).toMatchObject({ state: "near", resumed: true, sent: 4 });
    expect(sent.map((m) => m.subject).filter((v, i, a) => a.indexOf(v) === i)).toEqual(["Mailforge AI is back on", expect.stringMatching(/83% of your \$120\.00/)]);
  });

  it("the email text is escaped and carries no secrets", () => {
    const m = buildAiResumedEmail("raised", 1234.5, 99.999, "https://x.test/admin/ai?a=1&b=<2>");
    expect(m.subject).toBe("Mailforge AI is back on");
    expect(m.text).toContain("$1,234.50");
    expect(m.html).toContain("&lt;2&gt;");
    expect(m.html).not.toContain("<2>");
    expect(m.text).not.toMatch(/sk-|api[_ ]?key\s*[:=]/i);
  });
});
