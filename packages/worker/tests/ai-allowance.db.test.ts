/**
 * Integration tests for the worker side of Mailforge AI: provider resolution
 * (own key, else the operator's primary then fallback), per-call metering, the
 * monthly plan allowance, and "hold, never drop" when the allowance runs out.
 *
 * Needs a reachable Postgres via DATABASE_URL. Tenants have slugs starting
 * with "ai-w-". Shared platform_llm_configs rows are removed after each test.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { sql } from "drizzle-orm";
import { encrypt, parseEncryptionKey } from "@mailforge/adapters";
import { loadLlmCandidates } from "@mailforge/db/llm";
import { resolveTenantProvider } from "../src/provider-resolver.js";
import { aiAllowanceFor, tenantsOutOfAiAllowance } from "../src/ai-gate.js";
import { resolveEmbeddingProvider, recordEmbeddingUsage } from "../src/embedding-client.js";
import { processContentTick, processOneContentMessage } from "../src/content.js";

const TEST_DB_URL = process.env.DATABASE_URL;
if (!TEST_DB_URL) throw new Error("[ai-allowance.test] DATABASE_URL is not set.");

const KEY_B64 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const NOW = new Date();

let pool: pg.Pool;
let lockClient: pg.PoolClient | undefined;
let db: ReturnType<typeof drizzle>;
let dbAvailable = false;
let savedKey: string | undefined;

let stub: Server;
let stubUrl: string;
const revoked = new Set<string>();
const stubKeys: string[] = [];

beforeAll(async () => {
  savedKey = process.env.ENCRYPTION_KEY;
  process.env.ENCRYPTION_KEY = KEY_B64;
  stub = createServer((req, res) => {
    const key = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    req.on("data", () => undefined);
    req.on("end", () => {
      if (req.url === "/v1/chat/completions") {
        stubKeys.push(key);
        if (revoked.has(key)) {
          res.writeHead(401, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "revoked" } }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: "{}" } }], usage: { prompt_tokens: 40, completion_tokens: 10, total_tokens: 50 } }));
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
    if (process.env.CI === "true") throw new Error(`[ai-allowance.test] DATABASE_URL not reachable in CI: ${(err as Error).message}`);
    console.warn("[ai-allowance.test] DATABASE_URL not reachable - tests skipped.");
    return;
  }
  await cleanup();
});

afterEach(async () => {
  if (!dbAvailable) return;
  delete process.env.MAILFORGE_ENFORCE_PLANS;
  revoked.clear();
  stubKeys.length = 0;
  await cleanup();
});

afterAll(async () => {
  if (savedKey !== undefined) process.env.ENCRYPTION_KEY = savedKey;
  else delete process.env.ENCRYPTION_KEY;
  if (lockClient) {
    await lockClient.query("SELECT pg_advisory_unlock(7770001)");
    lockClient.release();
  }
  await pool?.end();
  await new Promise<void>((resolve) => stub.close(() => resolve()));
});

async function q<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  return (await db.execute(query)).rows as T[];
}

async function cleanup() {
  await db.execute(sql`DELETE FROM platform_llm_configs`);
  const ids = (await q<{ id: string }>(sql`SELECT id FROM tenants WHERE slug LIKE 'ai-w-%'`)).map((r) => r.id);
  for (const id of ids) {
    for (const t of ["llm_usage", "llm_configs", "lifecycle_messages", "flow_memberships", "flows", "lifecycle_transitions", "contacts"]) {
      await db.execute(sql.raw(`DELETE FROM ${t} WHERE tenant_id = '${id}'`));
    }
    await db.execute(sql`DELETE FROM tenants WHERE id = ${id}::uuid`);
  }
}

let n = 0;
async function newTenant(plan = "free"): Promise<string> {
  const slug = `ai-w-${Date.now()}-${n++}`;
  const [t] = await q<{ id: string }>(sql`INSERT INTO tenants (name, slug, plan) VALUES (${slug}, ${slug}, ${plan}) RETURNING id`);
  return t!.id;
}

const key = () => parseEncryptionKey(KEY_B64);
const envelope = (apiKey: string, model: string, extra: Record<string, unknown> = {}) =>
  encrypt(JSON.stringify({ apiKey, baseUrl: stubUrl, model, ...extra }), key());

async function setPlatform(slot: "primary" | "fallback", apiKey: string, extra: Record<string, unknown> = {}, enabled = true) {
  await db.execute(sql`
    INSERT INTO platform_llm_configs (slot, provider, config, enabled)
    VALUES (${slot}, 'custom', ${envelope(apiKey, `${slot}-model`, extra)}, ${enabled})`);
}
async function setOwn(tenantId: string, apiKey: string, extra: Record<string, unknown> = {}) {
  await db.execute(sql`INSERT INTO llm_configs (tenant_id, provider, config, is_active) VALUES (${tenantId}::uuid, 'custom', ${envelope(apiKey, "own-model", extra)}, true)`);
}
async function addUsage(tenantId: string, tokens: number, source = "platform") {
  await db.execute(sql`INSERT INTO llm_usage (tenant_id, feature, source, provider, total_tokens) VALUES (${tenantId}::uuid, 'content', ${source}, 'custom', ${tokens})`);
}
const usage = (tenantId: string) =>
  q<{ feature: string; source: string; total_tokens: number; ok: boolean; model: string | null }>(
    sql`SELECT feature, source, total_tokens, ok, model FROM llm_usage WHERE tenant_id = ${tenantId}::uuid ORDER BY created_at, id`,
  );
const complete = async (p: { complete: (o: { messages: Array<{ role: "user"; content: string }> }) => Promise<unknown> }) =>
  p.complete({ messages: [{ role: "user", content: "hi" }] });

// ---------------------------------------------------------------------------

describe("resolveTenantProvider: which key", () => {
  it("fails with the long-standing message when there is no AI at all", async () => {
    const t = await newTenant();
    const r = await resolveTenantProvider(db, t, "compile");
    expect(r).toEqual({ ok: false, reason: "No LLM configuration found. Add an LLM provider in Settings before compiling flows." });
  });

  it("uses the operator's primary when the workspace has no key of its own, and meters it", async () => {
    await setPlatform("primary", "sk-pri");
    const t = await newTenant();
    const r = await resolveTenantProvider(db, t, "compile");
    expect(r).toMatchObject({ ok: true, source: "platform" });
    if (!r.ok) return;
    await complete(r.provider);
    expect(stubKeys).toEqual(["sk-pri"]);
    expect(await usage(t)).toEqual([{ feature: "compile", source: "platform", total_tokens: 50, ok: true, model: "primary-model" }]);
  });

  it("uses the workspace's own key alone, even when the operator has providers", async () => {
    await setPlatform("primary", "sk-pri");
    await setPlatform("fallback", "sk-fb");
    const t = await newTenant();
    await setOwn(t, "sk-own");
    const r = await resolveTenantProvider(db, t, "content");
    expect(r).toMatchObject({ ok: true, source: "byok" });
    if (!r.ok) return;
    await complete(r.provider);
    expect(stubKeys).toEqual(["sk-own"]);
    expect(await usage(t)).toEqual([{ feature: "content", source: "byok", total_tokens: 50, ok: true, model: "own-model" }]);
  });

  it("fails over from a dead primary to the fallback and records both calls", async () => {
    await setPlatform("primary", "sk-pri");
    await setPlatform("fallback", "sk-fb");
    revoked.add("sk-pri");
    const t = await newTenant();
    const r = await resolveTenantProvider(db, t, "content");
    if (!r.ok) throw new Error("expected ok");
    await complete(r.provider);
    expect(stubKeys).toEqual(["sk-pri", "sk-fb"]);
    expect((await usage(t)).map((u) => [u.model, u.ok, u.total_tokens])).toEqual([
      ["primary-model", false, 0],
      ["fallback-model", true, 50],
    ]);
  });

  it("skips a switched-off primary and goes straight to the fallback", async () => {
    await setPlatform("primary", "sk-pri", {}, false);
    await setPlatform("fallback", "sk-fb");
    const t = await newTenant();
    const r = await resolveTenantProvider(db, t, "content");
    if (!r.ok) throw new Error("expected ok");
    await complete(r.provider);
    expect(stubKeys).toEqual(["sk-fb"]);
  });

  it("a broken own key is a failure with the decrypt reason, not a silent switch to the operator", async () => {
    await setPlatform("primary", "sk-pri");
    const t = await newTenant();
    await db.execute(sql`INSERT INTO llm_configs (tenant_id, provider, config, is_active) VALUES (${t}::uuid, 'custom', 'not-an-envelope', true)`);
    const r = await resolveTenantProvider(db, t, "content");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/Failed to decrypt LLM configuration/);
  });
});

describe("the monthly allowance", () => {
  it("is not applied when plans are not enforced (self-hosted)", async () => {
    await setPlatform("primary", "sk-pri");
    const t = await newTenant("free");
    await addUsage(t, 50_000_000);
    expect(await aiAllowanceFor(db, t, NOW)).toMatchObject({ limit: null });
    expect((await resolveTenantProvider(db, t, "content")).ok).toBe(true);
  });

  it("blocks Mailforge AI exactly when the plan's tokens are used up, with a retry-later code", async () => {
    process.env.MAILFORGE_ENFORCE_PLANS = "true";
    await setPlatform("primary", "sk-pri");
    const t = await newTenant("free"); // 20,000 a month
    await addUsage(t, 19_999);
    expect((await resolveTenantProvider(db, t, "content")).ok).toBe(true);
    await addUsage(t, 1);
    const r = await resolveTenantProvider(db, t, "content");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("allowance");
      expect(r.reason).toMatch(/Free plan/);
      expect(r.reason).toMatch(/own AI key/i);
    }
  });

  it("a bigger plan has a bigger allowance", async () => {
    process.env.MAILFORGE_ENFORCE_PLANS = "true";
    await setPlatform("primary", "sk-pri");
    const t = await newTenant("growth");
    await addUsage(t, 1_000_000);
    expect(await aiAllowanceFor(db, t, NOW)).toMatchObject({ limit: 1_500_000, used: 1_000_000 });
    expect((await resolveTenantProvider(db, t, "content")).ok).toBe(true);
  });

  it("a workspace on its own key is never blocked", async () => {
    process.env.MAILFORGE_ENFORCE_PLANS = "true";
    const t = await newTenant("free");
    await addUsage(t, 20_000_000);
    await setOwn(t, "sk-own");
    expect((await resolveTenantProvider(db, t, "content")).ok).toBe(true);
  });

  it("only this month's platform tokens count", async () => {
    process.env.MAILFORGE_ENFORCE_PLANS = "true";
    await setPlatform("primary", "sk-pri");
    const t = await newTenant("free");
    await db.execute(sql`INSERT INTO llm_usage (tenant_id, feature, source, provider, total_tokens, created_at) VALUES (${t}::uuid, 'content', 'platform', 'custom', 99999, now() - interval '40 days')`);
    await addUsage(t, 10, "byok");
    expect(await aiAllowanceFor(db, t, NOW)).toMatchObject({ used: 0 });
  });

  it("tenantsOutOfAiAllowance names only workspaces on Mailforge AI that have used it up", async () => {
    process.env.MAILFORGE_ENFORCE_PLANS = "true";
    await setPlatform("primary", "sk-pri");
    const spent = await newTenant("free");
    const fine = await newTenant("free");
    const own = await newTenant("free");
    await addUsage(spent, 20_000);
    await addUsage(fine, 100);
    await addUsage(own, 20_000);
    await setOwn(own, "sk-own");
    expect([...(await tenantsOutOfAiAllowance(db, [spent, fine, own], NOW))]).toEqual([spent]);
    delete process.env.MAILFORGE_ENFORCE_PLANS;
    expect((await tenantsOutOfAiAllowance(db, [spent, fine, own], NOW)).size).toBe(0);
  });
});

describe("content generation holds, never drops, when the allowance is spent", () => {
  async function pendingMessage(tenantId: string): Promise<string> {
    const [c] = await q<{ id: string }>(sql`
      INSERT INTO contacts (tenant_id, external_id, email, lifecycle_state, first_seen_at, last_seen_at)
      VALUES (${tenantId}::uuid, ${"ext-" + n++}, 'c@example.com', 'engaged', now() - interval '30 days', now() - interval '1 day') RETURNING id`);
    const [f] = await q<{ id: string }>(sql`
      INSERT INTO flows (tenant_id, name, priority, trigger_type, trigger_config, steps, status, flow_class, compiled_plan)
      VALUES (${tenantId}::uuid, 'F', 0, 'lifecycle_transition', '{"from":"engaged","to":"at_risk"}'::jsonb,
              '[{"order":1,"action_type":"nurture_value","delay":"0d"}]'::jsonb, 'paused', 'nurture',
              '{"trigger":{"type":"lifecycle_transition","condition":{"from":"engaged","to":"at_risk"}},"steps":[{"order":1,"action_type":"nurture_value","delay":"0d"}]}'::jsonb)
      RETURNING id`);
    const [m] = await q<{ id: string }>(sql`
      INSERT INTO flow_memberships (tenant_id, contact_id, flow_id, current_step, status, entered_at, completed_at, exit_reason)
      VALUES (${tenantId}::uuid, ${c!.id}::uuid, ${f!.id}::uuid, 1, 'completed', now(), now(), 'completed') RETURNING id`);
    const [msg] = await q<{ id: string }>(sql`
      INSERT INTO lifecycle_messages (tenant_id, contact_id, flow_id, membership_id, flow_step_order, status, brain_action_type)
      VALUES (${tenantId}::uuid, ${c!.id}::uuid, ${f!.id}::uuid, ${m!.id}::uuid, 1, 'pending_generation', 'nurture_value') RETURNING id`);
    return msg!.id;
  }
  const status = async (id: string) => (await q<{ status: string }>(sql`SELECT status FROM lifecycle_messages WHERE id = ${id}::uuid`))[0]!.status;

  it("a tick leaves a spent workspace's queued messages exactly as they were", async () => {
    process.env.MAILFORGE_ENFORCE_PLANS = "true";
    await setPlatform("primary", "sk-pri");
    const t = await newTenant("free");
    await addUsage(t, 20_000);
    const msg = await pendingMessage(t);
    const r = await processContentTick(db, NOW, 20, [t]);
    expect(r.claimed).toBe(0);
    expect(await status(msg)).toBe("pending_generation");
    expect(stubKeys).toHaveLength(0);
  });

  it("when the allowance runs out mid-batch the message goes back to the queue, not to 'failed'", async () => {
    process.env.MAILFORGE_ENFORCE_PLANS = "true";
    await setPlatform("primary", "sk-pri");
    const t = await newTenant("free");
    await addUsage(t, 20_000);
    const id = await pendingMessage(t);
    await db.execute(sql`UPDATE lifecycle_messages SET status = 'generating' WHERE id = ${id}::uuid`);
    const [row] = await q<{ contact_id: string; flow_id: string; membership_id: string }>(
      sql`SELECT contact_id, flow_id, membership_id FROM lifecycle_messages WHERE id = ${id}::uuid`,
    );
    const outcome = await processOneContentMessage(
      db,
      { id, tenantId: t, contactId: row!.contact_id, flowId: row!.flow_id, membershipId: row!.membership_id, flowStepOrder: 1, brainActionType: "nurture_value" },
      NOW,
    );
    expect(outcome).toBe("error");
    expect(stubKeys).toHaveLength(0);
    expect(await status(id)).toBe("pending_generation");
  });

  it("a workspace with tokens left is still processed alongside a spent one", async () => {
    process.env.MAILFORGE_ENFORCE_PLANS = "true";
    await setPlatform("primary", "sk-pri");
    const spent = await newTenant("free");
    const fine = await newTenant("free");
    await addUsage(spent, 20_000);
    const heldMsg = await pendingMessage(spent);
    await pendingMessage(fine);
    const r = await processContentTick(db, NOW, 20, [spent, fine]);
    expect(r.claimed).toBe(1);
    expect(await status(heldMsg)).toBe("pending_generation");
  });
});

describe("embeddings", () => {
  it("use the operator's provider that names an embedding model, and are recorded as platform usage", async () => {
    await setPlatform("primary", "sk-chat-only"); // no embedding model: chat only
    await setPlatform("fallback", "sk-emb", { embedding_model: "emb-small" });
    const t = await newTenant();
    const r = await resolveEmbeddingProvider(db, t);
    expect(r).toMatchObject({ ok: true, apiKey: "sk-emb", embeddingModel: "emb-small", source: "platform" });
    if (!r.ok) return;
    await recordEmbeddingUsage(db, t, r, "x".repeat(400), true);
    await recordEmbeddingUsage(db, t, r, "x".repeat(400), false);
    expect(await usage(t)).toEqual([
      { feature: "embedding", source: "platform", total_tokens: 100, ok: true, model: "emb-small" },
      { feature: "embedding", source: "platform", total_tokens: 0, ok: false, model: "emb-small" },
    ]);
  });

  it("use the workspace's own key when it has one", async () => {
    await setPlatform("primary", "sk-pri", { embedding_model: "emb-platform" });
    const t = await newTenant();
    await setOwn(t, "sk-own");
    expect(await resolveEmbeddingProvider(db, t)).toMatchObject({ ok: true, apiKey: "sk-own", source: "byok", embeddingModel: "text-embedding-3-small" });
  });

  it("fail permanently with the old message when there is no AI at all", async () => {
    const t = await newTenant();
    const r = await resolveEmbeddingProvider(db, t);
    expect(r).toMatchObject({ ok: false, permanent: true });
    if (!r.ok) expect(r.reason).toMatch(/No active LLM configuration found/);
  });
});

describe("candidate loading", () => {
  it("returns primary before fallback whatever order the rows were saved in", async () => {
    await setPlatform("fallback", "sk-fb");
    await setPlatform("primary", "sk-pri");
    const t = await newTenant();
    expect((await loadLlmCandidates(db, t)).candidates.map((c) => c.slot)).toEqual(["primary", "fallback"]);
  });
});

describe("cost recorded by the worker", () => {
  it("prices the operator's calls from the provider's configured prices, and never prices a customer's own key", async () => {
    await setPlatform("primary", "sk-pri", { input_price: 2, output_price: 10 });
    const t = await newTenant();
    const r = await resolveTenantProvider(db, t, "content");
    if (!r.ok) throw new Error("expected ok");
    await complete(r.provider); // stub answers 40 in / 10 out: 40 x $2 + 10 x $10 = 180 micro-dollars
    const own = await newTenant();
    await setOwn(own, "sk-own", { input_price: 99, output_price: 99 });
    const o = await resolveTenantProvider(db, own, "content");
    if (!o.ok) throw new Error("expected ok");
    await complete(o.provider);
    const cost = (id: string) => q<{ c: number }>(sql`SELECT sum(cost_micros)::int AS c FROM llm_usage WHERE tenant_id = ${id}::uuid`).then((r) => r[0]!.c);
    expect(await cost(t)).toBe(180);
    expect(await cost(own)).toBe(0);
  });

  it("an unpriced provider records zero cost", async () => {
    await setPlatform("primary", "sk-pri");
    const t = await newTenant();
    const r = await resolveTenantProvider(db, t, "content");
    if (!r.ok) throw new Error("expected ok");
    await complete(r.provider);
    expect((await q<{ c: number }>(sql`SELECT sum(cost_micros)::int AS c FROM llm_usage WHERE tenant_id = ${t}::uuid`))[0]!.c).toBe(0);
  });
});

describe("a hand-set allowance is what the worker enforces", () => {
  async function override(t: string, v: number | null) {
    await db.execute(sql`UPDATE tenants SET ai_allowance_override = ${v} WHERE id = ${t}::uuid`);
  }

  it("raises the cap above the plan's, lowers it below, or lifts it", async () => {
    process.env.MAILFORGE_ENFORCE_PLANS = "true";
    await setPlatform("primary", "sk-pri");
    const t = await newTenant("free"); // plan allowance 20,000
    await addUsage(t, 25_000);
    expect((await resolveTenantProvider(db, t, "content")).ok).toBe(false);
    await override(t, 100_000);
    expect(await aiAllowanceFor(db, t, NOW)).toMatchObject({ limit: 100_000, used: 25_000 });
    expect((await resolveTenantProvider(db, t, "content")).ok).toBe(true);
    await override(t, 1_000);
    expect((await resolveTenantProvider(db, t, "content")).ok).toBe(false);
    await override(t, -1);
    expect(await aiAllowanceFor(db, t, NOW)).toMatchObject({ limit: null });
    expect((await resolveTenantProvider(db, t, "content")).ok).toBe(true);
    await override(t, null);
    expect(await aiAllowanceFor(db, t, NOW)).toMatchObject({ limit: 20_000 });
  });

  it("content generation is held or released by the override", async () => {
    process.env.MAILFORGE_ENFORCE_PLANS = "true";
    await setPlatform("primary", "sk-pri");
    const t = await newTenant("free");
    await addUsage(t, 20_000);
    expect([...(await tenantsOutOfAiAllowance(db, [t], NOW))]).toEqual([t]);
    await override(t, 500_000);
    expect((await tenantsOutOfAiAllowance(db, [t], NOW)).size).toBe(0);
  });
});

describe("the operator dollar budget, as the worker sees it", () => {
  async function budget(usd: number | null) {
    await db.execute(sql`DELETE FROM platform_settings WHERE key = 'ai_budget_usd'`);
    if (usd !== null) await db.execute(sql`INSERT INTO platform_settings (key, value) VALUES ('ai_budget_usd', ${JSON.stringify({ monthly_usd: usd })}::jsonb)`);
  }
  async function spendUsd(tenantId: string, usd: number, source = "platform") {
    await db.execute(sql`INSERT INTO llm_usage (tenant_id, feature, source, provider, total_tokens, cost_micros) VALUES (${tenantId}::uuid, 'content', ${source}, 'custom', 10, ${Math.round(usd * 1_000_000)})`);
  }
  afterEach(async () => {
    await db.execute(sql`DELETE FROM platform_settings`);
  });

  it("stops resolving Mailforge AI once the month's spend reaches the budget, with a retry-later code and no money in the message", async () => {
    await setPlatform("primary", "sk-pri");
    const t = await newTenant();
    await budget(5);
    await spendUsd(t, 4.99);
    expect((await resolveTenantProvider(db, t, "content")).ok).toBe(true);
    await spendUsd(t, 0.01);
    const r = await resolveTenantProvider(db, t, "content");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("budget");
      expect(r.reason).toMatch(/own AI key/i);
      expect(r.reason).not.toMatch(/budget|\$|dollar|cost|spend/i);
    }
  });

  it("does not touch a workspace on its own key, however much the operator has spent", async () => {
    await setPlatform("primary", "sk-pri");
    const spender = await newTenant();
    const own = await newTenant();
    await setOwn(own, "sk-own");
    await budget(1);
    await spendUsd(spender, 50);
    expect((await resolveTenantProvider(db, own, "content")).ok).toBe(true);
    expect((await resolveTenantProvider(db, spender, "content")).ok).toBe(false);
  });

  it("no budget, or last month's spend, means no pause; raising it resumes", async () => {
    await setPlatform("primary", "sk-pri");
    const t = await newTenant();
    await spendUsd(t, 500);
    expect((await resolveTenantProvider(db, t, "content")).ok).toBe(true); // no budget set
    await budget(100);
    expect((await resolveTenantProvider(db, t, "content")).ok).toBe(false);
    await budget(1000);
    expect((await resolveTenantProvider(db, t, "content")).ok).toBe(true);
    await db.execute(sql`DELETE FROM llm_usage WHERE tenant_id = ${t}::uuid`);
    await db.execute(sql`INSERT INTO llm_usage (tenant_id, feature, source, provider, total_tokens, cost_micros, created_at) VALUES (${t}::uuid, 'content', 'platform', 'custom', 10, 999000000, now() - interval '40 days')`);
    await budget(5);
    expect((await resolveTenantProvider(db, t, "content")).ok).toBe(true);
  });

  it("holds every operator-provider workspace before a content tick claims anything, even with plans not enforced", async () => {
    await setPlatform("primary", "sk-pri");
    const a = await newTenant("scale");
    const b = await newTenant("free");
    const own = await newTenant();
    await setOwn(own, "sk-own");
    await budget(1);
    await spendUsd(a, 1);
    expect([...(await tenantsOutOfAiAllowance(db, [a, b, own], NOW))].sort()).toEqual([a, b].sort());
    await budget(null);
    expect((await tenantsOutOfAiAllowance(db, [a, b, own], NOW)).size).toBe(0);
  });
});
