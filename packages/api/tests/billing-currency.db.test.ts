/**
 * Charging in a currency other than US dollars (for example Ghana cedis).
 *
 * Prices are set in USD. When the charge currency is GHS the amount sent to the payment
 * provider, stored on the checkout and subscription, and required of a payment is the USD
 * price times the configured rate, rounded up to a whole cedi. The dangerous failure this
 * guards against is charging the USD figure as if it were cedis (about fifteen times too little).
 *
 * The payment provider is a plain in-test stub object (no server): these tests are about
 * which AMOUNTS are asked for and accepted, not about Paystack's protocol.
 *
 * Needs a reachable Postgres via DATABASE_URL, like the other *.db tests.
 * Every tenant created here has a slug starting with "curr-".
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import { SESSION_COOKIE_NAME } from "../src/routes/auth.js";
import { PaystackError, signPaystackBody, type PaystackClient, type PaystackTransaction } from "../src/billing/paystack.js";

const TEST_DB_URL = process.env.DATABASE_URL;
if (!TEST_DB_URL) throw new Error("[billing-currency.test] DATABASE_URL is not set.");

const SECRET = "whsec_currency_test";
const RATE = 15.5;

let pool: pg.Pool;
let db: ReturnType<typeof drizzle>;
let dbAvailable = false;
let appGhs: FastifyInstance;
let appUsd: FastifyInstance;

interface Stub extends PaystackClient {
  plans: Array<{ name: string; amountCents: number; interval: string; currency: string; code: string }>;
  inits: Array<{ reference: string; amount: number; currency: string; email: string; planCode: string }>;
  txs: Map<string, PaystackTransaction>;
  reset(): void;
}

function makeStub(): Stub {
  const stub: Stub = {
    plans: [],
    inits: [],
    txs: new Map(),
    reset() {
      stub.plans.length = 0;
      stub.inits.length = 0;
      stub.txs.clear();
    },
    async createPlan(input) {
      const code = `PLN_stub${stub.plans.length + 1}_${input.currency}_${input.amountCents}`;
      stub.plans.push({ ...input, code });
      return { code };
    },
    async initializeTransaction(input) {
      stub.inits.push({ reference: input.reference, amount: input.amount, currency: input.currency, email: input.email, planCode: input.planCode });
      return { url: `https://checkout.example/${input.reference}`, accessCode: `ac_${input.reference.slice(-8)}` };
    },
    async verifyTransaction(reference) {
      const tx = stub.txs.get(reference);
      if (!tx) throw new PaystackError("Paystack: Transaction reference not found", 404, false);
      return tx;
    },
    async listSubscriptions() {
      return [];
    },
    async cancelSubscription() {},
  };
  return stub;
}

const stubGhs = makeStub();
const stubUsd = makeStub();

interface Tenant {
  id: string;
  email: string;
  session: string;
}

async function q<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  return (await db.execute(query)).rows as T[];
}

let counter = 0;
async function newTenant(): Promise<Tenant> {
  const slug = `curr-${Date.now()}-${counter++}`;
  const [t] = await q<{ id: string }>(sql`INSERT INTO tenants (name, slug, plan) VALUES (${"Acme " + slug}, ${slug}, 'free') RETURNING id`);
  const id = t!.id;
  const email = `${slug}@curr.example`;
  const [u] = await q<{ id: string }>(sql`INSERT INTO users (tenant_id, email, role) VALUES (${id}::uuid, ${email}, 'owner') RETURNING id`);
  const [s] = await q<{ id: string }>(
    sql`INSERT INTO sessions (tenant_id, user_id, expires_at) VALUES (${id}::uuid, ${u!.id}::uuid, now() + interval '1 day') RETURNING id`,
  );
  return { id, email, session: s!.id };
}

async function cleanup(): Promise<void> {
  await db.execute(sql`DELETE FROM billing_events WHERE tenant_id IS NULL OR tenant_id IN (SELECT id FROM tenants WHERE slug LIKE 'curr-%')`);
  const ids = (await q<{ id: string }>(sql`SELECT id FROM tenants WHERE slug LIKE 'curr-%'`)).map((r) => r.id);
  for (const id of ids) {
    for (const t of ["billing_events", "billing_checkouts", "subscriptions", "sessions", "users"]) {
      await db.execute(sql.raw(`DELETE FROM ${t} WHERE tenant_id = '${id}'`));
    }
    await db.execute(sql`DELETE FROM tenants WHERE id = ${id}::uuid`);
  }
}

const cookies = (t: Tenant) => ({ [SESSION_COOKIE_NAME]: t.session });
const checkout = (app: FastifyInstance, t: Tenant, plan: string, interval: string) =>
  app.inject({ method: "POST", url: "/v1/billing/checkout", cookies: cookies(t), payload: { plan, interval } });
const planOf = async (app: FastifyInstance, t: Tenant) => (await app.inject({ method: "GET", url: "/v1/plan", cookies: cookies(t) })).json();

const webhook = (app: FastifyInstance, body: unknown) => {
  const raw = JSON.stringify(body);
  return app.inject({ method: "POST", url: "/webhooks/paystack", headers: { "content-type": "application/json", "x-paystack-signature": signPaystackBody(raw, SECRET) }, payload: raw });
};

const checkoutRow = async (t: Tenant) =>
  (await q<{ tx_ref: string; amount_cents: number; currency: string; status: string; provider_plan_id: string }>(
    sql`SELECT tx_ref, amount_cents, currency, status, provider_plan_id FROM billing_checkouts WHERE tenant_id = ${t.id}::uuid ORDER BY created_at DESC LIMIT 1`,
  ))[0]!;

/** Start a checkout and make the stub report a payment for it, as Paystack would after the customer pays. */
async function startAndPay(app: FastifyInstance, stub: Stub, t: Tenant, plan: string, interval: string, paid: { amount?: number; currency?: string; status?: string } = {}) {
  const res = await checkout(app, t, plan, interval);
  expect(res.statusCode, res.body).toBe(200);
  const row = await checkoutRow(t);
  const tx: PaystackTransaction = {
    id: 910_000 + stub.txs.size + counter,
    reference: row.tx_ref,
    status: paid.status ?? "success",
    amount: paid.amount ?? row.amount_cents,
    currency: paid.currency ?? row.currency,
    customer: { id: 1, email: t.email },
    plan: { plan_code: row.provider_plan_id },
  };
  stub.txs.set(row.tx_ref, tx);
  return { row, tx };
}

const chargeBody = (tx: PaystackTransaction) => ({ event: "charge.success", data: { id: tx.id, reference: tx.reference, status: tx.status, amount: tx.amount, currency: tx.currency } });

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: TEST_DB_URL, connectionTimeoutMillis: 3000 });
  try {
    await pool.query("SELECT 1");
    db = drizzle(pool);
    dbAvailable = true;
  } catch (err) {
    if (process.env.CI === "true") throw new Error(`[billing-currency.test] DATABASE_URL not reachable in CI: ${(err as Error).message}`);
    console.warn("[billing-currency.test] DATABASE_URL not reachable - tests skipped.");
    return;
  }
  await cleanup();
  const opts = { logger: false as const, db, baseUrl: "http://localhost:3000", dashboardUrl: "http://localhost:3000" };
  appGhs = await buildApp({ ...opts, billing: { client: stubGhs, webhookSecret: SECRET, currency: "GHS", usdRate: RATE } });
  appUsd = await buildApp({ ...opts, billing: { client: stubUsd, webhookSecret: SECRET, currency: "USD", usdRate: 1 } });
});

beforeEach(async () => {
  if (!dbAvailable) return;
  stubGhs.reset();
  stubUsd.reset();
  await db.execute(sql`DELETE FROM billing_provider_plans`);
});

afterEach(async () => {
  if (dbAvailable) await cleanup();
});

afterAll(async () => {
  await appGhs?.close();
  await appUsd?.close();
  await pool?.end();
});

describe("checkout in GHS", () => {
  it("asks for the converted amount in cedis, in pesewas, not the USD figure", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    await checkout(appGhs, t, "growth", "monthly");
    // $49 x 15.5 = 759.5 -> GHS 760 -> 76000 pesewas.
    expect(stubGhs.plans).toEqual([expect.objectContaining({ amountCents: 76000, currency: "GHS", interval: "monthly" })]);
    expect(stubGhs.inits).toEqual([expect.objectContaining({ amount: 76000, currency: "GHS" })]);
    expect(await checkoutRow(t)).toMatchObject({ amount_cents: 76000, currency: "GHS", status: "pending" });
  });

  it("a yearly plan converts the yearly price as a whole", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    await checkout(appGhs, t, "growth", "yearly");
    // $490 x 15.5 = 7595 -> 759500 pesewas.
    expect(stubGhs.plans[0]).toMatchObject({ amountCents: 759500, interval: "yearly" });
    expect((await checkoutRow(t)).amount_cents).toBe(759500);
  });

  it("every paid plan and interval is converted, and the charge is a whole number of cedis", async () => {
    if (!dbAvailable) return;
    const expected: Record<string, number> = {
      "starter/monthly": 295, // 19 x 15.5 = 294.5
      "starter/yearly": 2945, // 190 x 15.5
      "growth/monthly": 760,
      "growth/yearly": 7595,
      "scale/monthly": 2000, // 129 x 15.5 = 1999.5
      "scale/yearly": 19995, // 1290 x 15.5
    };
    for (const [key, cedis] of Object.entries(expected)) {
      const [plan, interval] = key.split("/") as [string, string];
      const t = await newTenant();
      await checkout(appGhs, t, plan, interval);
      expect((await checkoutRow(t)).amount_cents, key).toBe(cedis * 100);
    }
  });

  it("USD stays exactly as before: dollars in cents, no conversion", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    await checkout(appUsd, t, "growth", "monthly");
    expect(stubUsd.plans[0]).toMatchObject({ amountCents: 4900, currency: "USD" });
    expect(await checkoutRow(t)).toMatchObject({ amount_cents: 4900, currency: "USD" });
  });

  it("reuses the provider plan for the same price, and makes a new one when the rate changes", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    await checkout(appGhs, t, "growth", "monthly");
    await checkout(appGhs, t, "growth", "monthly");
    expect(stubGhs.plans).toHaveLength(1);

    // The operator changes the rate: 49 x 16 = 784 cedis. Subscribers on the old plan keep their price.
    const opts = { logger: false as const, db, baseUrl: "http://localhost:3000", dashboardUrl: "http://localhost:3000" };
    const appNewRate = await buildApp({ ...opts, billing: { client: stubGhs, webhookSecret: SECRET, currency: "GHS", usdRate: 16 } });
    try {
      await checkout(appNewRate, t, "growth", "monthly");
    } finally {
      await appNewRate.close();
    }
    expect(stubGhs.plans.map((p) => p.amountCents)).toEqual([76000, 78400]);
    const [n] = await q<{ n: string }>(sql`SELECT count(*)::text AS n FROM billing_provider_plans WHERE plan = 'growth' AND currency = 'GHS'`);
    expect(n!.n).toBe("2");
  });
});

describe("accepting a payment in GHS", () => {
  it("applies a payment of the converted amount", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    const { tx } = await startAndPay(appGhs, stubGhs, t, "growth", "monthly");
    const res = await webhook(appGhs, chargeBody(tx));
    expect(res.json().outcome).toBe("applied_initial");
    const [sub] = await q<{ plan: string; amount_cents: number; currency: string; status: string }>(sql`SELECT plan, amount_cents, currency, status FROM subscriptions WHERE tenant_id = ${t.id}::uuid`);
    expect(sub).toMatchObject({ plan: "growth", amount_cents: 76000, currency: "GHS", status: "active" });
  });

  it("REJECTS a payment of the USD figure in cedis: 49 GHS is not 760 GHS", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    const { tx } = await startAndPay(appGhs, stubGhs, t, "growth", "monthly", { amount: 4900 });
    const res = await webhook(appGhs, chargeBody(tx));
    expect(res.json().outcome).toBe("rejected");
    const [row] = await q<{ plan: string }>(sql`SELECT plan FROM tenants WHERE id = ${t.id}::uuid`);
    expect(row!.plan).toBe("free");
    expect((await checkoutRow(t)).status).toBe("failed");
  });

  it("rejects the right number in the wrong currency", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    const { tx } = await startAndPay(appGhs, stubGhs, t, "growth", "monthly", { currency: "USD", amount: 76000 });
    expect((await webhook(appGhs, chargeBody(tx))).json().outcome).toBe("rejected");
  });

  it("renews a GHS subscription, matched on its plan, currency and cedi amount", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    const { tx, row } = await startAndPay(appGhs, stubGhs, t, "growth", "monthly");
    await webhook(appGhs, chargeBody(tx));
    await db.execute(sql`UPDATE subscriptions SET current_period_end = now() + interval '1 day' WHERE tenant_id = ${t.id}::uuid`);
    const renewal: PaystackTransaction = { id: 920_001 + counter, reference: `RENEW_${counter}`, status: "success", amount: 76000, currency: "GHS", customer: { email: t.email }, plan: { plan_code: row.provider_plan_id } };
    stubGhs.txs.set(renewal.reference, renewal);
    expect((await webhook(appGhs, chargeBody(renewal))).json().outcome).toBe("applied_renewal");

    // The old dollar-sized amount is not a renewal of this subscription.
    const wrong: PaystackTransaction = { ...renewal, id: renewal.id + 1, reference: `RENEW_B_${counter}`, amount: 4900 };
    stubGhs.txs.set(wrong.reference, wrong);
    expect((await webhook(appGhs, chargeBody(wrong))).json().outcome).toBe("ignored");
  });
});

describe("what the dashboard is told", () => {
  it("lists the cedi price of each paid plan next to the USD price, and the rate", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    const plan = await planOf(appGhs, t);
    expect(plan.billing).toMatchObject({ enabled: true, currency: "GHS", usd_rate: RATE });
    const byId = Object.fromEntries((plan.plans as Array<Record<string, unknown>>).map((p) => [p.id, p]));
    expect(byId.growth).toMatchObject({ price_monthly_usd: 49, price_annual_usd: 490, charge_monthly: 760, charge_annual: 7595 });
    expect(byId.starter).toMatchObject({ charge_monthly: 295, charge_annual: 2945 });
    expect(byId.scale).toMatchObject({ charge_monthly: 2000, charge_annual: 19995 });
    expect(byId.free).toMatchObject({ charge_monthly: null, charge_annual: null });
  });

  it("in USD there is nothing extra to show", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    const plan = await planOf(appUsd, t);
    expect(plan.billing).toMatchObject({ currency: "USD", usd_rate: 1 });
    for (const p of plan.plans as Array<Record<string, unknown>>) expect([p.id, p.charge_monthly, p.charge_annual]).toEqual([p.id, null, null]);
  });

  it("reports a GHS subscription as the USD plan price it stands for, plus what is really charged", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    const { tx } = await startAndPay(appGhs, stubGhs, t, "growth", "monthly");
    await webhook(appGhs, chargeBody(tx));
    const plan = await planOf(appGhs, t);
    expect(plan.billing.subscription).toMatchObject({ plan: "growth", amount_usd: 49, charged_amount: 760, currency: "GHS", status: "active" });
  });

  it("a USD subscription keeps showing what it paid, even if the list price has since changed", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    await db.execute(sql`
      INSERT INTO subscriptions (tenant_id, provider, plan, interval, amount_cents, currency, status, customer_email, current_period_start, current_period_end)
      VALUES (${t.id}::uuid, 'paystack', 'growth', 'monthly', 3900, 'USD', 'active', ${t.email}, now(), now() + interval '1 month')`);
    expect((await planOf(appUsd, t)).billing.subscription).toMatchObject({ amount_usd: 39, charged_amount: 39, currency: "USD" });
  });
});
