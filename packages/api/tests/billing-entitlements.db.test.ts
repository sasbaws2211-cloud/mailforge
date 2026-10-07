/**
 * A paid plan follows its paid-through date: inside the paid period or the grace period
 * the paid limits apply, past grace the workspace is Free, and a plan granted by hand
 * (no date) never lapses. Runs against a real database; no payment provider is involved.
 *
 * Needs a reachable Postgres via DATABASE_URL, like the other *.db tests.
 * Every tenant created here has a slug starting with "bill-".
 */
import { createHash, randomBytes } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { BILLING_GRACE_DAYS } from "@mailforge/core";
import { buildApp } from "../src/index.js";
import { SESSION_COOKIE_NAME } from "../src/routes/auth.js";

const TEST_DB_URL = process.env.DATABASE_URL;
if (!TEST_DB_URL) throw new Error("[billing-entitlements.test] DATABASE_URL is not set.");

const DAY = 86_400_000;

let pool: pg.Pool;
let db: ReturnType<typeof drizzle>;
let dbAvailable = false;
let app: FastifyInstance;

interface Tenant {
  id: string;
  session: string;
}

async function q<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  return (await db.execute(query)).rows as T[];
}

let counter = 0;
async function newTenant(plan = "free", opts: { paidThrough?: Date | null; contacts?: number } = {}): Promise<Tenant> {
  const slug = `bill-ent-${Date.now()}-${counter++}`;
  const [t] = await q<{ id: string }>(
    sql`INSERT INTO tenants (name, slug, plan, plan_paid_through) VALUES (${"Acme " + slug}, ${slug}, ${plan}, ${opts.paidThrough ?? null}) RETURNING id`,
  );
  const id = t!.id;
  const [u] = await q<{ id: string }>(sql`INSERT INTO users (tenant_id, email, role) VALUES (${id}::uuid, ${slug + "@bill.example"}, 'owner') RETURNING id`);
  const [s] = await q<{ id: string }>(
    sql`INSERT INTO sessions (tenant_id, user_id, expires_at) VALUES (${id}::uuid, ${u!.id}::uuid, now() + interval '1 day') RETURNING id`,
  );
  if (opts.contacts) {
    await db.execute(sql`
      INSERT INTO contacts (tenant_id, external_id, lifecycle_state, first_seen_at, last_seen_at)
      SELECT ${id}::uuid, 'seed-' || g, 'signed_up', now(), now() FROM generate_series(1, ${opts.contacts}) g`);
  }
  return { id, session: s!.id };
}

async function cleanup(): Promise<void> {
  const ids = (await q<{ id: string }>(sql`SELECT id FROM tenants WHERE slug LIKE 'bill-ent-%'`)).map((r) => r.id);
  for (const id of ids) {
    for (const t of ["events", "lifecycle_transitions", "contact_conflicts", "contacts", "api_keys", "sessions", "users"]) {
      await db.execute(sql.raw(`DELETE FROM ${t} WHERE tenant_id = '${id}'`));
    }
    await db.execute(sql`DELETE FROM tenants WHERE id = ${id}::uuid`);
  }
}

const planOf = async (t: Tenant) =>
  (await app.inject({ method: "GET", url: "/v1/plan", cookies: { [SESSION_COOKIE_NAME]: t.session } })).json();

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: TEST_DB_URL, connectionTimeoutMillis: 3000 });
  try {
    await pool.query("SELECT 1");
    db = drizzle(pool);
    dbAvailable = true;
  } catch (err) {
    if (process.env.CI === "true") throw new Error(`[billing-entitlements.test] DATABASE_URL not reachable in CI: ${(err as Error).message}`);
    console.warn("[billing-entitlements.test] DATABASE_URL not reachable - tests skipped.");
    return;
  }
  await cleanup();
  app = await buildApp({ logger: false, db, baseUrl: "http://localhost:3000", dashboardUrl: "http://localhost:3000" });
});

afterEach(async () => {
  if (dbAvailable) await cleanup();
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
});

// ============================================================================================
// Entitlements follow the paid-through date everywhere
// ============================================================================================

describe("entitlements follow the paid-through date", () => {
  const key = (): string => `mf_live_${randomBytes(24).toString("base64url")}`;
  async function withKey(t: Tenant): Promise<string> {
    const k = key();
    await db.execute(sql`
      INSERT INTO api_keys (tenant_id, key_hash, prefix, label)
      VALUES (${t.id}::uuid, ${createHash("sha256").update(k).digest("hex")}, ${k.slice(0, 8)}, 'billing test')`);
    return k;
  }
  const track = (k: string, userId: string) =>
    app.inject({ method: "POST", url: "/v1/track", headers: { authorization: `Bearer ${k}`, "content-type": "application/json" }, payload: JSON.stringify({ userId, event: "e" }) });

  it("a paid plan within its paid period (or its grace period) keeps the paid limits; past grace it is Free", async () => {
    if (!dbAvailable) return;
    process.env.MAILFORGE_ENFORCE_PLANS = "true";
    try {
      // 600 contacts is over Free (500) but well inside Growth (10,000).
      const current = await newTenant("growth", { paidThrough: new Date(Date.now() + 10 * DAY), contacts: 600 });
      expect((await track(await withKey(current), "n1")).statusCode).toBe(200);

      const inGrace = await newTenant("growth", { paidThrough: new Date(Date.now() - 1 * DAY), contacts: 600 });
      expect((await track(await withKey(inGrace), "n1")).statusCode).toBe(200);

      const lapsed = await newTenant("growth", { paidThrough: new Date(Date.now() - (BILLING_GRACE_DAYS + 1) * DAY), contacts: 600 });
      const res = await track(await withKey(lapsed), "n1");
      expect(res.statusCode).toBe(402);
      expect(res.json()).toMatchObject({ plan: "free", limit: 500 });
    } finally {
      delete process.env.MAILFORGE_ENFORCE_PLANS;
    }
  });

  it("a plan granted by hand (no paid-through date) never lapses", async () => {
    if (!dbAvailable) return;
    process.env.MAILFORGE_ENFORCE_PLANS = "true";
    try {
      const t = await newTenant("scale", { paidThrough: null, contacts: 600 });
      expect((await track(await withKey(t), "n1")).statusCode).toBe(200);
      expect((await planOf(t)).plan.id).toBe("scale");
    } finally {
      delete process.env.MAILFORGE_ENFORCE_PLANS;
    }
  });

  it("the public unsubscribe page shows the Free credit line once a plan has lapsed, and not while paid", async () => {
    if (!dbAvailable) return;
    process.env.MAILFORGE_ENFORCE_PLANS = "true";
    process.env.UNSUBSCRIBE_SIGNING_KEY = "billing-test-signing-key-do-not-use";
    process.env.MAILFORGE_SITE_URL = "https://mailforge.example";
    try {
      const { generateUnsubscribeToken } = await import("@mailforge/adapters");
      const page = async (t: Tenant) => {
        const token = generateUnsubscribeToken(t.id, "00000000-0000-4000-8000-000000000000", process.env.UNSUBSCRIBE_SIGNING_KEY!);
        return (await app.inject({ method: "GET", url: `/unsubscribe?token=${encodeURIComponent(token)}` })).body;
      };
      const paid = await newTenant("growth", { paidThrough: new Date(Date.now() + 10 * DAY) });
      const lapsed = await newTenant("growth", { paidThrough: new Date(Date.now() - (BILLING_GRACE_DAYS + 1) * DAY) });
      expect(await page(paid)).not.toContain('class="credit"');
      expect(await page(lapsed)).toContain('class="credit"');
    } finally {
      delete process.env.MAILFORGE_ENFORCE_PLANS;
      delete process.env.UNSUBSCRIBE_SIGNING_KEY;
      delete process.env.MAILFORGE_SITE_URL;
    }
  });
});
