/**
 * The in-app payment popup flow: starting a checkout returns an access code for Paystack's inline
 * popup, and the page then polls GET /v1/billing/checkouts/:reference until the payment is done.
 * The poll itself asks the provider, so it works without a webhook or a redirect back.
 *
 * The payment provider is a plain in-test stub object (no server); these tests are about what the
 * endpoint answers, who may ask, and what it does to the workspace.
 *
 * Needs a reachable Postgres via DATABASE_URL, like the other *.db tests.
 * Every tenant created here has a slug starting with "poll-".
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import { SESSION_COOKIE_NAME } from "../src/routes/auth.js";
import { resetCheckoutThrottle } from "../src/billing/service.js";
import { PaystackError, signPaystackBody, type PaystackClient, type PaystackTransaction } from "../src/billing/paystack.js";

const TEST_DB_URL = process.env.DATABASE_URL;
if (!TEST_DB_URL) throw new Error("[billing-checkout-status.test] DATABASE_URL is not set.");

const SECRET = "whsec_poll_test";

let pool: pg.Pool;
let db: ReturnType<typeof drizzle>;
let dbAvailable = false;
let app: FastifyInstance;
let appNoBilling: FastifyInstance;

interface Stub extends PaystackClient {
  plans: number;
  verifyCalls: string[];
  txs: Map<string, PaystackTransaction>;
  /** Make the next verify calls fail with this HTTP status. */
  failVerify: number | null;
  /** What initializeTransaction reports as the access code (null = Paystack sent none). */
  accessCode: string | null;
  known: Set<string>;
  reset(): void;
}

const stub: Stub = {
  plans: 0,
  verifyCalls: [],
  txs: new Map(),
  failVerify: null,
  accessCode: "ac_default123",
  known: new Set(),
  reset() {
    stub.plans = 0;
    stub.verifyCalls.length = 0;
    stub.txs.clear();
    stub.failVerify = null;
    stub.accessCode = "ac_default123";
    stub.known.clear();
  },
  async createPlan(input) {
    stub.plans += 1;
    return { code: `PLN_poll_${input.currency}_${input.amountCents}` };
  },
  async initializeTransaction(input) {
    stub.known.add(input.reference);
    return { url: `https://checkout.example/${input.reference}`, accessCode: stub.accessCode };
  },
  async verifyTransaction(reference) {
    stub.verifyCalls.push(reference);
    if (stub.failVerify !== null) throw new PaystackError("Paystack is down", stub.failVerify, stub.failVerify >= 500);
    const tx = stub.txs.get(reference);
    if (tx) return tx;
    // Initialised but never paid: Paystack reports "abandoned".
    if (stub.known.has(reference)) return { id: 0, reference, status: "abandoned", amount: 0, currency: "USD", customer: { email: "x@y.z" }, plan: {} };
    throw new PaystackError("Paystack: Transaction reference not found", 404, false);
  },
  async listSubscriptions() {
    return [];
  },
  async cancelSubscription() {},
};

interface Tenant {
  id: string;
  email: string;
  session: string;
  memberSession: string;
}

async function q<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  return (await db.execute(query)).rows as T[];
}

let counter = 0;
async function newTenant(): Promise<Tenant> {
  const slug = `poll-${Date.now()}-${counter++}`;
  const [t] = await q<{ id: string }>(sql`INSERT INTO tenants (name, slug, plan) VALUES (${"Acme " + slug}, ${slug}, 'free') RETURNING id`);
  const id = t!.id;
  const email = `${slug}@poll.example`;
  const [u] = await q<{ id: string }>(sql`INSERT INTO users (tenant_id, email, role) VALUES (${id}::uuid, ${email}, 'owner') RETURNING id`);
  const [s] = await q<{ id: string }>(sql`INSERT INTO sessions (tenant_id, user_id, expires_at) VALUES (${id}::uuid, ${u!.id}::uuid, now() + interval '1 day') RETURNING id`);
  const [m] = await q<{ id: string }>(sql`INSERT INTO users (tenant_id, email, role) VALUES (${id}::uuid, ${"member-" + email}, 'member') RETURNING id`);
  const [ms] = await q<{ id: string }>(sql`INSERT INTO sessions (tenant_id, user_id, expires_at) VALUES (${id}::uuid, ${m!.id}::uuid, now() + interval '1 day') RETURNING id`);
  return { id, email, session: s!.id, memberSession: ms!.id };
}

async function cleanup(): Promise<void> {
  await db.execute(sql`DELETE FROM billing_events WHERE tenant_id IS NULL OR tenant_id IN (SELECT id FROM tenants WHERE slug LIKE 'poll-%')`);
  const ids = (await q<{ id: string }>(sql`SELECT id FROM tenants WHERE slug LIKE 'poll-%'`)).map((r) => r.id);
  for (const id of ids) {
    for (const t of ["billing_events", "billing_checkouts", "subscriptions", "sessions", "users"]) {
      await db.execute(sql.raw(`DELETE FROM ${t} WHERE tenant_id = '${id}'`));
    }
    await db.execute(sql`DELETE FROM tenants WHERE id = ${id}::uuid`);
  }
}

const owner = (t: Tenant) => ({ [SESSION_COOKIE_NAME]: t.session });
const member = (t: Tenant) => ({ [SESSION_COOKIE_NAME]: t.memberSession });

const start = (t: Tenant, plan = "starter", interval = "yearly") =>
  app.inject({ method: "POST", url: "/v1/billing/checkout", cookies: owner(t), payload: { plan, interval } });
const poll = (reference: string, cookies: Record<string, string>, a: FastifyInstance = app) =>
  a.inject({ method: "GET", url: `/v1/billing/checkouts/${encodeURIComponent(reference)}`, cookies });

/** Start a checkout and return its reference. */
async function begin(t: Tenant, plan = "starter", interval = "yearly"): Promise<string> {
  const res = await start(t, plan, interval);
  expect(res.statusCode, res.body).toBe(200);
  return res.json().reference as string;
}

/** Make the stub report this checkout as paid (or failed), as Paystack would after the customer acts. */
function settle(reference: string, t: Tenant, opts: { status?: string; amount?: number } = {}): PaystackTransaction {
  const tx: PaystackTransaction = {
    id: 930_000 + counter,
    reference,
    status: opts.status ?? "success",
    amount: opts.amount ?? 19000,
    currency: "USD",
    customer: { id: 1, email: t.email },
    plan: { plan_code: "PLN_poll_USD_19000" },
  };
  stub.txs.set(reference, tx);
  return tx;
}

const tenantPlan = async (t: Tenant) => (await q<{ plan: string }>(sql`SELECT plan FROM tenants WHERE id = ${t.id}::uuid`))[0]!.plan;

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: TEST_DB_URL, connectionTimeoutMillis: 3000 });
  try {
    await pool.query("SELECT 1");
    db = drizzle(pool);
    dbAvailable = true;
  } catch (err) {
    if (process.env.CI === "true") throw new Error(`[billing-checkout-status.test] DATABASE_URL not reachable in CI: ${(err as Error).message}`);
    console.warn("[billing-checkout-status.test] DATABASE_URL not reachable - tests skipped.");
    return;
  }
  await cleanup();
  const opts = { logger: false as const, db, baseUrl: "http://localhost:3000", dashboardUrl: "http://localhost:3000" };
  app = await buildApp({ ...opts, billing: { client: stub, webhookSecret: SECRET, currency: "USD", usdRate: 1 } });
  appNoBilling = await buildApp(opts);
});

beforeEach(async () => {
  if (!dbAvailable) return;
  stub.reset();
  resetCheckoutThrottle();
  // Only this file's cached plan: other test files share the table and run in parallel.
  await db.execute(sql`DELETE FROM billing_provider_plans WHERE plan = 'starter' AND interval = 'yearly' AND currency = 'USD'`);
});

afterEach(async () => {
  if (dbAvailable) await cleanup();
});

afterAll(async () => {
  await app?.close();
  await appNoBilling?.close();
  await pool?.end();
});

describe("starting a checkout for the popup", () => {
  it("returns the hosted URL (fallback), the reference to poll, and the access code for the popup", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    const res = await start(t);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.url).toMatch(/^https:\/\/checkout\.example\/mf_/);
    expect(body.access_code).toBe("ac_default123");
    expect(body.reference).toMatch(new RegExp(`^mf_${t.id.slice(0, 8)}_[0-9a-f]{18}$`));
    const [row] = await q<{ tx_ref: string }>(sql`SELECT tx_ref FROM billing_checkouts WHERE tenant_id = ${t.id}::uuid`);
    expect(row!.tx_ref).toBe(body.reference);
  });

  it("access_code is null when Paystack sent none, so the page falls back to the hosted URL", async () => {
    if (!dbAvailable) return;
    stub.accessCode = null;
    const t = await newTenant();
    const body = (await start(t)).json();
    expect(body.access_code).toBeNull();
    expect(body.url).toBeTruthy();
  });
});

describe("polling a checkout", () => {
  it("is pending until the customer pays, and changes nothing meanwhile", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    const ref = await begin(t);
    const res = await poll(ref, owner(t));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "pending", plan: "starter", interval: "yearly" });
    expect(await tenantPlan(t)).toBe("free");
  });

  it("turns paid, and upgrades the workspace, as soon as Paystack says so (no webhook, no redirect)", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    const ref = await begin(t);
    expect((await poll(ref, owner(t))).json().status).toBe("pending");

    settle(ref, t);
    resetCheckoutThrottle();
    const res = await poll(ref, owner(t));
    expect(res.json()).toEqual({ status: "paid", plan: "starter", interval: "yearly" });
    expect(await tenantPlan(t)).toBe("starter");
    const subs = await q<{ status: string; plan: string }>(sql`SELECT status, plan FROM subscriptions WHERE tenant_id = ${t.id}::uuid`);
    expect(subs).toEqual([{ status: "active", plan: "starter" }]);
  });

  it("once paid it answers from the database and does not call the provider again", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    const ref = await begin(t);
    settle(ref, t);
    await poll(ref, owner(t));
    const calls = stub.verifyCalls.length;
    resetCheckoutThrottle();
    for (let i = 0; i < 3; i++) expect((await poll(ref, owner(t))).json().status).toBe("paid");
    expect(stub.verifyCalls).toHaveLength(calls);
  });

  it("a payment that comes in by webhook as well is counted once", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    const ref = await begin(t);
    const tx = settle(ref, t);
    await poll(ref, owner(t));
    const raw = JSON.stringify({ event: "charge.success", data: { id: tx.id, reference: ref } });
    const hook = await app.inject({ method: "POST", url: "/webhooks/paystack", headers: { "content-type": "application/json", "x-paystack-signature": signPaystackBody(raw, SECRET) }, payload: raw });
    expect(hook.json().outcome).toBe("duplicate");
    const [n] = await q<{ n: string }>(sql`SELECT count(*)::text AS n FROM subscriptions WHERE tenant_id = ${t.id}::uuid`);
    expect(n!.n).toBe("1");
  });

  it("asks the provider at most once every couple of seconds, however fast the page polls", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    const ref = await begin(t);
    await Promise.all([poll(ref, owner(t)), poll(ref, owner(t)), poll(ref, owner(t))]);
    await poll(ref, owner(t));
    expect(stub.verifyCalls.filter((r) => r === ref)).toHaveLength(1);
  });

  it("a declined payment becomes failed, and the plan is untouched", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    const ref = await begin(t);
    settle(ref, t, { status: "failed" });
    expect((await poll(ref, owner(t))).json().status).toBe("failed");
    expect(await tenantPlan(t)).toBe("free");
  });

  it("a payment for less than the price is failed, not paid", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    const ref = await begin(t);
    settle(ref, t, { amount: 1000 });
    expect((await poll(ref, owner(t))).json().status).toBe("failed");
    expect(await tenantPlan(t)).toBe("free");
  });

  it("a provider outage leaves it pending (and is not an error), then it recovers", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    const ref = await begin(t);
    settle(ref, t);
    stub.failVerify = 500;
    const down = await poll(ref, owner(t));
    expect(down.statusCode).toBe(200);
    expect(down.json().status).toBe("pending");
    stub.failVerify = null;
    resetCheckoutThrottle();
    expect((await poll(ref, owner(t))).json().status).toBe("paid");
  });

  it("is never cached by the browser", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    const ref = await begin(t);
    expect((await poll(ref, owner(t))).headers["cache-control"]).toBe("no-store");
  });

  it("reports a checkout the customer closed as cancelled", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    const ref = await begin(t);
    const closed = await app.inject({ method: "GET", url: `/billing/return?status=cancelled&reference=${ref}` });
    expect(closed.statusCode).toBe(302);
    expect((await poll(ref, owner(t))).json().status).toBe("cancelled");
  });
});

describe("who may poll", () => {
  it("only the workspace that started the checkout: anyone else gets 404, and the provider is not asked", async () => {
    if (!dbAvailable) return;
    const a = await newTenant();
    const b = await newTenant();
    const ref = await begin(a);
    settle(ref, a);
    const res = await poll(ref, owner(b));
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("checkout_not_found");
    expect(stub.verifyCalls).toHaveLength(0);
    expect(await tenantPlan(a)).toBe("free");
    expect(await tenantPlan(b)).toBe("free");
  });

  it("an unknown reference is 404, whatever it looks like", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    for (const ref of ["nope", "mf_00000000_" + "0".repeat(18), "../../etc/passwd", "a".repeat(300)]) {
      expect((await poll(ref, owner(t))).statusCode, ref).toBe(404);
    }
    expect(stub.verifyCalls).toHaveLength(0);
  });

  it("owners only, and a session is required", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    const ref = await begin(t);
    expect((await poll(ref, member(t))).statusCode).toBe(403);
    expect((await poll(ref, {})).statusCode).toBe(401);
    expect(stub.verifyCalls).toHaveLength(0);
  });

  it("answers 503 when billing is not configured", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    const res = await poll("mf_x", owner(t), appNoBilling);
    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe("billing_disabled");
  });
});
