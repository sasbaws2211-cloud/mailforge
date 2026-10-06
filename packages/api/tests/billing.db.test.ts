/**
 * Integration tests for billing: checkout, the Flutterwave webhook, the
 * customer return page, renewals, plan changes and cancellation, run against a
 * fake Flutterwave API and a real database.
 *
 * Needs a reachable Postgres via DATABASE_URL, like the other *.db tests.
 * Every tenant created here has a slug starting with "bill-".
 */
import { createHash, randomBytes } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { addBillingPeriod, BILLING_GRACE_DAYS } from "@mailforge/core";
import { buildApp } from "../src/index.js";
import { SESSION_COOKIE_NAME } from "../src/routes/auth.js";
import { createFlutterwaveClient } from "../src/billing/flutterwave.js";
import { chargeCompletedWebhook, startFakeFlutterwave, type FakeFlutterwave } from "./helpers/fake-flutterwave.js";

const TEST_DB_URL = process.env.DATABASE_URL;
if (!TEST_DB_URL) throw new Error("[billing.test] DATABASE_URL is not set.");

const HASH = "test-webhook-secret-hash";
const DAY = 86_400_000;

let pool: pg.Pool;
let db: ReturnType<typeof drizzle>;
let dbAvailable = false;
let fake: FakeFlutterwave;
let app: FastifyInstance;
let appNoBilling: FastifyInstance;

interface Tenant {
  id: string;
  ownerId: string;
  ownerEmail: string;
  session: string;
  memberSession: string;
}

async function q<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  return (await db.execute(query)).rows as T[];
}

let counter = 0;
async function newTenant(plan = "free", opts: { paidThrough?: Date | null; contacts?: number } = {}): Promise<Tenant> {
  const slug = `bill-${Date.now()}-${counter++}`;
  const [t] = await q<{ id: string }>(
    sql`INSERT INTO tenants (name, slug, plan, plan_paid_through) VALUES (${"Acme " + slug}, ${slug}, ${plan}, ${opts.paidThrough ?? null}) RETURNING id`,
  );
  const id = t!.id;
  const ownerEmail = `${slug}@bill.example`;
  const [u] = await q<{ id: string }>(sql`INSERT INTO users (tenant_id, email, role) VALUES (${id}::uuid, ${ownerEmail}, 'owner') RETURNING id`);
  const [s] = await q<{ id: string }>(
    sql`INSERT INTO sessions (tenant_id, user_id, expires_at) VALUES (${id}::uuid, ${u!.id}::uuid, now() + interval '1 day') RETURNING id`,
  );
  const [m] = await q<{ id: string }>(sql`INSERT INTO users (tenant_id, email, role) VALUES (${id}::uuid, ${"member-" + ownerEmail}, 'member') RETURNING id`);
  const [ms] = await q<{ id: string }>(
    sql`INSERT INTO sessions (tenant_id, user_id, expires_at) VALUES (${id}::uuid, ${m!.id}::uuid, now() + interval '1 day') RETURNING id`,
  );
  if (opts.contacts) {
    await db.execute(sql`
      INSERT INTO contacts (tenant_id, external_id, lifecycle_state, first_seen_at, last_seen_at)
      SELECT ${id}::uuid, 'seed-' || g, 'signed_up', now(), now() FROM generate_series(1, ${opts.contacts}) g`);
  }
  return { id, ownerId: u!.id, ownerEmail, session: s!.id, memberSession: ms!.id };
}

async function cleanup(): Promise<void> {
  // Ignored events have no tenant, so a per-tenant delete would leave them behind, and a fresh
  // fake reuses the same transaction ids. (Real Flutterwave ids are globally unique.) Events that
  // belong to another test file's tenants are left alone: test files run in parallel on one database.
  await db.execute(sql`DELETE FROM billing_events WHERE tenant_id IS NULL OR tenant_id IN (SELECT id FROM tenants WHERE slug LIKE 'bill-%')`);
  const ids = (await q<{ id: string }>(sql`SELECT id FROM tenants WHERE slug LIKE 'bill-%'`)).map((r) => r.id);
  for (const id of ids) {
    for (const t of ["billing_events", "billing_checkouts", "subscriptions", "events", "lifecycle_transitions", "contact_conflicts", "contacts", "api_keys", "invites", "magic_link_tokens", "sessions", "users"]) {
      await db.execute(sql.raw(`DELETE FROM ${t} WHERE tenant_id = '${id}'`));
    }
    await db.execute(sql`DELETE FROM tenants WHERE id = ${id}::uuid`);
  }
}

// ---- request helpers ------------------------------------------------------------------------

const asOwner = (t: Tenant) => ({ [SESSION_COOKIE_NAME]: t.session });
const asMember = (t: Tenant) => ({ [SESSION_COOKIE_NAME]: t.memberSession });

const checkout = (t: Tenant, plan: unknown, interval: unknown, cookies = asOwner(t)) =>
  app.inject({ method: "POST", url: "/v1/billing/checkout", cookies, payload: { plan, interval } });

/** Deliver a webhook. Pass `null` for no signature header at all (undefined would pick the default). */
const webhook = (body: unknown, hash: string | null = HASH) =>
  app.inject({
    method: "POST",
    url: "/webhooks/flutterwave",
    headers: { "content-type": "application/json", ...(hash === null ? {} : { "verif-hash": hash }) },
    payload: JSON.stringify(body),
  });

const planOf = async (t: Tenant) => (await app.inject({ method: "GET", url: "/v1/plan", cookies: asOwner(t) })).json();

/** Start a checkout, "pay" it on the fake, and return what the webhook would carry. */
async function pay(t: Tenant, plan: string, interval: string, opts: { status?: string; amount?: number; currency?: string } = {}) {
  const res = await checkout(t, plan, interval);
  expect(res.statusCode, res.body).toBe(200);
  const [row] = await q<{ tx_ref: string }>(sql`SELECT tx_ref FROM billing_checkouts WHERE tenant_id = ${t.id}::uuid ORDER BY created_at DESC LIMIT 1`);
  const txRef = row!.tx_ref;
  const { transactionId, payment } = fake.completePayment(txRef, opts);
  const body = chargeCompletedWebhook({
    transactionId,
    txRef,
    amount: opts.amount ?? payment.amount,
    currency: opts.currency ?? payment.currency,
    email: payment.email,
    status: opts.status,
  });
  return { txRef, transactionId, body };
}

/** Pay and deliver the webhook; returns the webhook response. */
async function payAndConfirm(t: Tenant, plan: string, interval: string, opts: { status?: string; amount?: number; currency?: string } = {}) {
  const p = await pay(t, plan, interval, opts);
  const res = await webhook(p.body);
  return { ...p, res };
}

interface SubRow {
  id: string;
  plan: string;
  interval: string;
  status: string;
  amount_cents: number;
  currency: string;
  customer_email: string;
  provider_plan_id: string | null;
  provider_subscription_id: string | null;
  current_period_start: Date;
  current_period_end: Date;
  cancel_at_period_end: boolean;
}
// Raw SQL rows give timestamps as strings, so convert them once here and the tests can use Date methods.
const asDate = (v: unknown): Date => new Date(v as string);
const subs = async (t: Tenant): Promise<SubRow[]> =>
  (await q<SubRow>(sql`SELECT * FROM subscriptions WHERE tenant_id = ${t.id}::uuid ORDER BY created_at`)).map((r) => ({
    ...r,
    current_period_start: asDate(r.current_period_start),
    current_period_end: asDate(r.current_period_end),
  }));
const tenantRow = async (t: Tenant) => {
  const [r] = await q<{ plan: string; plan_paid_through: Date | string | null }>(sql`SELECT plan, plan_paid_through FROM tenants WHERE id = ${t.id}::uuid`);
  return { plan: r!.plan, plan_paid_through: r!.plan_paid_through ? asDate(r!.plan_paid_through) : null };
};
const eventsOf = (t: Tenant) => q<{ event_key: string; event_type: string; outcome: string }>(sql`SELECT event_key, event_type, outcome FROM billing_events WHERE tenant_id = ${t.id}::uuid ORDER BY created_at`);
const checkoutsOf = (t: Tenant) => q<{ status: string; plan: string; interval: string; amount_cents: number; tx_ref: string; provider_transaction_id: string | null }>(sql`SELECT * FROM billing_checkouts WHERE tenant_id = ${t.id}::uuid ORDER BY created_at`);

const near = (d: Date, target: Date, ms = 10_000) => Math.abs(d.getTime() - target.getTime()) <= ms;

// ---- lifecycle ------------------------------------------------------------------------------

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: TEST_DB_URL, connectionTimeoutMillis: 3000 });
  try {
    await pool.query("SELECT 1");
    db = drizzle(pool);
    dbAvailable = true;
  } catch (err) {
    if (process.env.CI === "true") throw new Error(`[billing.test] DATABASE_URL not reachable in CI: ${(err as Error).message}`);
    console.warn("[billing.test] DATABASE_URL not reachable - tests skipped.");
    return;
  }
  await cleanup();
  fake = await startFakeFlutterwave();
  const opts = { logger: false as const, db, baseUrl: "http://localhost:3000", dashboardUrl: "http://localhost:3000" };
  app = await buildApp({
    ...opts,
    billing: { client: createFlutterwaveClient({ secretKey: fake.secretKey, baseUrl: fake.baseUrl }), webhookHash: HASH, currency: "USD" },
  });
  appNoBilling = await buildApp(opts);
});

beforeEach(async () => {
  if (!dbAvailable) return;
  fake.reset();
  // Provider plan ids belong to one fake instance; a stale cache row would point at a plan the fake never made.
  await db.execute(sql`DELETE FROM billing_provider_plans`);
});

afterEach(async () => {
  if (dbAvailable) await cleanup();
});

afterAll(async () => {
  await app?.close();
  await appNoBilling?.close();
  await fake?.close();
  await pool?.end();
});

// ============================================================================================
// Checkout
// ============================================================================================

describe("checkout", () => {
  it("an owner gets a hosted checkout link, and a pending checkout is recorded", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    const res = await checkout(t, "growth", "monthly");
    expect(res.statusCode).toBe(200);
    expect(res.json().url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/hosted\/pay\/tok\d+$/);

    const [c] = await checkoutsOf(t);
    expect(c).toMatchObject({ status: "pending", plan: "growth", interval: "monthly", amount_cents: 4900 });
    expect(c!.tx_ref).toMatch(new RegExp(`^mf_${t.id.slice(0, 8)}_[0-9a-f]{18}$`));
  });

  it("asks the provider for the plan, then the link, with exactly the right fields", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    await checkout(t, "growth", "monthly");

    const [planCall] = fake.callsTo("POST", "/payment-plans");
    expect(planCall!.body).toEqual({ name: "Mailforge Growth (monthly)", amount: 49, interval: "monthly", currency: "USD" });

    const [linkCall] = fake.callsTo("POST", "/payments");
    const body = linkCall!.body as Record<string, any>;
    expect(body).toMatchObject({
      amount: 49,
      currency: "USD",
      redirect_url: "http://localhost:3000/billing/return",
      payment_plan: String(fake.plans[0]!.id),
      customer: { email: t.ownerEmail },
      meta: { tenant_id: t.id, plan: "growth", interval: "monthly" },
    });
    expect(body.tx_ref).toMatch(/^mf_/);
    expect(body.customizations.description).toBe("Growth plan, billed monthly");
  });

  it("charges the exact yearly total, not twelve times a rounded figure", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    await checkout(t, "growth", "yearly");
    expect(fake.callsTo("POST", "/payment-plans")[0]!.body).toMatchObject({ amount: 490, interval: "yearly" });
    expect(fake.callsTo("POST", "/payments")[0]!.body).toMatchObject({ amount: 490 });
    expect((await checkoutsOf(t))[0]!.amount_cents).toBe(49000);
  });

  it("creates each provider plan once and reuses it", async () => {
    if (!dbAvailable) return;
    const a = await newTenant();
    const b = await newTenant();
    await checkout(a, "growth", "monthly");
    await checkout(b, "growth", "monthly");
    await checkout(a, "growth", "monthly");
    expect(fake.plans).toHaveLength(1);
    // The same provider plan id went to the provider each time.
    const ids = fake.callsTo("POST", "/payments").map((r) => (r.body as { payment_plan: string }).payment_plan);
    expect(new Set(ids).size).toBe(1);
    // A different interval is a different plan.
    await checkout(a, "growth", "yearly");
    expect(fake.plans).toHaveLength(2);
  });

  it("five simultaneous first checkouts still create only one provider plan", async () => {
    if (!dbAvailable) return;
    const tenants = await Promise.all([1, 2, 3, 4, 5].map(() => newTenant()));
    const results = await Promise.all(tenants.map((t) => checkout(t, "scale", "monthly")));
    expect(results.map((r) => r.statusCode)).toEqual([200, 200, 200, 200, 200]);
    expect(fake.plans).toHaveLength(1);
    const [n] = await q<{ n: string }>(sql`SELECT count(*)::text AS n FROM billing_provider_plans WHERE plan = 'scale' AND interval = 'monthly'`);
    expect(n!.n).toBe("1");
  });

  it("a price change makes a new provider plan, leaving the old one alone", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    await checkout(t, "growth", "monthly");
    // Pretend the cached plan was made at an older price.
    await db.execute(sql`UPDATE billing_provider_plans SET amount_cents = 3900 WHERE plan = 'growth' AND interval = 'monthly'`);
    await checkout(t, "growth", "monthly");
    expect(fake.plans.map((p) => p.amount)).toEqual([49, 49]);
    const [n] = await q<{ n: string }>(sql`SELECT count(*)::text AS n FROM billing_provider_plans WHERE plan = 'growth'`);
    expect(n!.n).toBe("2");
  });

  it("refuses anything that is not a paid plan or a real interval, without calling the provider", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    for (const [plan, interval] of [["free", "monthly"], ["enterprise", "monthly"], ["growth", "weekly"], ["growth", undefined], [undefined, "monthly"], [7, "monthly"], ["trial", "monthly"]] as const) {
      const res = await checkout(t, plan, interval);
      expect(res.statusCode, `${plan}/${interval}`).toBe(400);
      expect(res.json().code).toBe("invalid_plan");
    }
    const bare = await app.inject({ method: "POST", url: "/v1/billing/checkout", cookies: asOwner(t) });
    expect(bare.statusCode).toBe(400);
    expect(fake.requests).toHaveLength(0);
    expect(await checkoutsOf(t)).toHaveLength(0);
  });

  it("is for owners only, and needs a session", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    expect((await checkout(t, "growth", "monthly", asMember(t))).statusCode).toBe(403);
    const anon = await app.inject({ method: "POST", url: "/v1/billing/checkout", payload: { plan: "growth", interval: "monthly" } });
    expect(anon.statusCode).toBe(401);
    expect(fake.requests).toHaveLength(0);
  });

  it("answers 503 when billing is not configured, and registers no webhook", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    const res = await appNoBilling.inject({ method: "POST", url: "/v1/billing/checkout", cookies: asOwner(t), payload: { plan: "growth", interval: "monthly" } });
    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe("billing_disabled");
    expect((await appNoBilling.inject({ method: "POST", url: "/webhooks/flutterwave", payload: {} })).statusCode).toBe(404);
    expect((await appNoBilling.inject({ method: "GET", url: "/billing/return" })).statusCode).toBe(404);
    const cancel = await appNoBilling.inject({ method: "POST", url: "/v1/billing/cancel", cookies: asOwner(t) });
    expect(cancel.statusCode).toBe(503);
  });

  it("a provider outage while creating the plan is a clear 502 and leaves no checkout behind", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    fake.failNext("/payment-plans", 500);
    const res = await checkout(t, "growth", "monthly");
    expect(res.statusCode).toBe(502);
    expect(res.json().code).toBe("provider_error");
    expect(res.json().error).toMatch(/not responding/);
    expect(await checkoutsOf(t)).toHaveLength(0);
    // The next try works: nothing was left half-made.
    expect((await checkout(t, "growth", "monthly")).statusCode).toBe(200);
  });

  it("a failure creating the link marks that checkout failed", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    fake.failNext("/payments", 500);
    const res = await checkout(t, "growth", "monthly");
    expect(res.statusCode).toBe(502);
    expect((await checkoutsOf(t))[0]!.status).toBe("failed");
  });

  it("never leaks the provider key or its raw errors to the customer", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    fake.failNext("/payment-plans", 401);
    const res = await checkout(t, "growth", "monthly");
    expect(res.statusCode).toBe(502);
    expect(res.body).not.toContain(fake.secretKey);
    expect(res.body.toLowerCase()).not.toContain("authorization");
    expect(res.body.toLowerCase()).not.toContain("flutterwave");
  });

  it("refuses a second purchase of the plan and interval already active, but allows a change", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    expect((await payAndConfirm(t, "growth", "monthly")).res.statusCode).toBe(200);
    const again = await checkout(t, "growth", "monthly");
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe("already_subscribed");
    expect((await checkout(t, "growth", "yearly")).statusCode).toBe(200); // different interval
    expect((await checkout(t, "scale", "monthly")).statusCode).toBe(200); // different plan
  });
});

// ============================================================================================
// A first payment arriving by webhook
// ============================================================================================

describe("first payment (webhook)", () => {
  it("activates the plan, records the subscription, and reports it through /v1/plan", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    const { res, txRef, transactionId } = await payAndConfirm(t, "growth", "monthly");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, outcome: "applied_initial" });

    const tenant = await tenantRow(t);
    expect(tenant.plan).toBe("growth");
    const expectedEnd = addBillingPeriod(new Date(), "monthly");
    expect(near(tenant.plan_paid_through!, expectedEnd)).toBe(true);

    const [sub] = await subs(t);
    expect(sub).toMatchObject({ plan: "growth", interval: "monthly", status: "active", amount_cents: 4900, currency: "USD", customer_email: t.ownerEmail, cancel_at_period_end: false });
    expect(sub!.provider_plan_id).toBe(String(fake.plans[0]!.id));
    // The provider's subscription id was looked up, so it can be cancelled later.
    expect(sub!.provider_subscription_id).toBe(String(fake.subscriptions[0]!.id));
    expect(near(sub!.current_period_end, expectedEnd)).toBe(true);

    const [c] = await checkoutsOf(t);
    expect(c).toMatchObject({ status: "paid", provider_transaction_id: String(transactionId), tx_ref: txRef });
    expect((await eventsOf(t))[0]).toMatchObject({ event_key: `charge:${transactionId}`, event_type: "charge.completed", outcome: "applied" });

    const plan = await planOf(t);
    expect(plan.plan.id).toBe("growth");
    expect(plan.payment).toMatchObject({ status: "current" });
    expect(plan.billing).toMatchObject({ enabled: true, currency: "USD" });
    expect(plan.billing.subscription).toMatchObject({ plan: "growth", interval: "monthly", amount_usd: 49, status: "active", cancel_at_period_end: false });
  });

  it("a yearly payment is paid through a year, not a month", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    await payAndConfirm(t, "scale", "yearly");
    const tenant = await tenantRow(t);
    expect(near(tenant.plan_paid_through!, addBillingPeriod(new Date(), "yearly"))).toBe(true);
    expect((await subs(t))[0]).toMatchObject({ plan: "scale", interval: "yearly", amount_cents: 129000 });
  });

  it("an upgrade takes effect on the limits straight away", async () => {
    if (!dbAvailable) return;
    process.env.MAILFORGE_ENFORCE_PLANS = "true";
    try {
      const t = await newTenant("free");
      expect((await planOf(t)).meters.contacts.limit).toBe(500);
      await payAndConfirm(t, "growth", "monthly");
      expect((await planOf(t)).meters.contacts.limit).toBe(10000);
    } finally {
      delete process.env.MAILFORGE_ENFORCE_PLANS;
    }
  });

  it("applies an overpayment, since the customer paid at least what was asked", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    const { res } = await payAndConfirm(t, "growth", "monthly", { amount: 60 });
    expect(res.json().outcome).toBe("applied_initial");
  });

  it("a failed payment changes nothing but marks the checkout failed", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    const { res } = await payAndConfirm(t, "growth", "monthly", { status: "failed" });
    expect(res.statusCode).toBe(200);
    expect(res.json().outcome).toBe("ignored");
    expect((await tenantRow(t)).plan).toBe("free");
    expect(await subs(t)).toHaveLength(0);
    expect((await checkoutsOf(t))[0]!.status).toBe("failed");
  });

  it("a failed attempt does not stop a later successful one for the same customer", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    await payAndConfirm(t, "growth", "monthly", { status: "failed" });
    const retry = await payAndConfirm(t, "growth", "monthly");
    expect(retry.res.json().outcome).toBe("applied_initial");
    expect((await tenantRow(t)).plan).toBe("growth");
  });

  it("rejects a payment for less than the price, and leaves the plan alone", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    const { res } = await payAndConfirm(t, "growth", "monthly", { amount: 10 });
    expect(res.statusCode).toBe(200); // acknowledged, so the provider stops retrying
    expect(res.json().outcome).toBe("rejected");
    expect((await tenantRow(t)).plan).toBe("free");
    expect(await subs(t)).toHaveLength(0);
    expect((await checkoutsOf(t))[0]!.status).toBe("failed");
    expect((await eventsOf(t))[0]!.outcome).toMatch(/^rejected/);
  });

  it("rejects a payment in the wrong currency even if the number is big enough", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    const { res } = await payAndConfirm(t, "growth", "monthly", { currency: "GHS", amount: 600 });
    expect(res.json().outcome).toBe("rejected");
    expect((await tenantRow(t)).plan).toBe("free");
  });

  it("believes the provider, not the webhook body: a body claiming success for a failed charge does nothing", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    const p = await pay(t, "growth", "monthly", { status: "failed" });
    // The body lies: it says successful and a big amount.
    const lie = chargeCompletedWebhook({ transactionId: p.transactionId, txRef: p.txRef, amount: 9999, currency: "USD", email: "x@y.z", status: "successful" });
    const res = await webhook(lie);
    expect(res.json().outcome).toBe("ignored");
    expect((await tenantRow(t)).plan).toBe("free");
  });

  it("a webhook for a transaction the provider does not know is acknowledged and ignored", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    const res = await webhook(chargeCompletedWebhook({ transactionId: 424242, txRef: "made-up", amount: 49, currency: "USD", email: t.ownerEmail }));
    expect(res.statusCode).toBe(200);
    expect(res.json().ignored).toBe("unknown transaction");
    expect((await tenantRow(t)).plan).toBe("free");
  });

  it("only upgrades the workspace whose checkout it was", async () => {
    if (!dbAvailable) return;
    const a = await newTenant();
    const b = await newTenant();
    await payAndConfirm(a, "growth", "monthly");
    expect((await tenantRow(a)).plan).toBe("growth");
    expect((await tenantRow(b)).plan).toBe("free");
    expect(await subs(b)).toHaveLength(0);
  });
});

// ============================================================================================
// Webhook authenticity and delivery rules
// ============================================================================================

describe("webhook security and delivery", () => {
  it("rejects a missing or wrong signature with 401 and does nothing", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    const p = await pay(t, "growth", "monthly");
    for (const hash of [null, "", "wrong", HASH + "x", HASH.slice(0, -1), "a".repeat(500)]) {
      const res = await webhook(p.body, hash);
      expect(res.statusCode, String(hash)).toBe(401);
    }
    expect((await tenantRow(t)).plan).toBe("free");
    expect(await eventsOf(t)).toHaveLength(0);
    // No call to verify was even made for the unsigned ones.
    expect(fake.callsTo("GET", "/transactions/")).toHaveLength(0);
  });

  it("accepts the right signature", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    const p = await pay(t, "growth", "monthly");
    expect((await webhook(p.body, HASH)).statusCode).toBe(200);
  });

  it("the same webhook delivered twice is applied once", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    const p = await pay(t, "growth", "monthly");
    const first = await webhook(p.body);
    const paidThrough = (await tenantRow(t)).plan_paid_through!;
    const second = await webhook(p.body);
    expect(first.json().outcome).toBe("applied_initial");
    expect(second.json().outcome).toBe("duplicate");
    expect(await subs(t)).toHaveLength(1);
    expect((await tenantRow(t)).plan_paid_through!.getTime()).toBe(paidThrough.getTime());
    expect(await eventsOf(t)).toHaveLength(1);
  });

  it("three deliveries at the same instant still apply exactly once", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    const p = await pay(t, "growth", "monthly");
    const results = await Promise.all([webhook(p.body), webhook(p.body), webhook(p.body)]);
    expect(results.map((r) => r.statusCode)).toEqual([200, 200, 200]);
    const outcomes = results.map((r) => r.json().outcome).sort();
    expect(outcomes.filter((o) => o === "applied_initial")).toHaveLength(1);
    expect(await subs(t)).toHaveLength(1);
    expect(await eventsOf(t)).toHaveLength(1);
  });

  it("when the provider is briefly down it asks for a retry, and the retry then works", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    const p = await pay(t, "growth", "monthly");
    fake.failNext("/transactions/", 500);
    const down = await webhook(p.body);
    expect(down.statusCode).toBe(500); // Flutterwave will call again in 30 minutes
    expect((await tenantRow(t)).plan).toBe("free");
    expect(await eventsOf(t)).toHaveLength(0); // nothing recorded, so the retry is not mistaken for a duplicate

    const retry = await webhook(p.body);
    expect(retry.statusCode).toBe(200);
    expect(retry.json().outcome).toBe("applied_initial");
    expect((await tenantRow(t)).plan).toBe("growth");
  });

  it("if our own key is rejected it also asks for a retry rather than losing the event", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    const p = await pay(t, "growth", "monthly");
    fake.failNext("/transactions/", 401);
    expect((await webhook(p.body)).statusCode).toBe(500);
    expect((await webhook(p.body)).statusCode).toBe(200); // after the key is fixed
  });

  it("acknowledges events it does not handle, and bodies with no event", async () => {
    if (!dbAvailable) return;
    for (const body of [{ event: "transfer.completed", data: {} }, { foo: "bar" }, {}, { event: 5 }]) {
      const res = await webhook(body);
      expect(res.statusCode, JSON.stringify(body)).toBe(200);
      expect(res.json().ok).toBe(true);
    }
    expect((await webhook({ event: "charge.completed", data: {} })).json().ignored).toBe("no transaction id");
  });

  it("a charge with no checkout and no matching subscription is ignored and remembered", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    const { transactionId } = fake.completePayment((await (async () => {
      await checkout(t, "growth", "monthly");
      return (await checkoutsOf(t))[0]!.tx_ref;
    })()));
    // Delete the checkout so it looks like a stranger's charge.
    await db.execute(sql`DELETE FROM billing_checkouts WHERE tenant_id = ${t.id}::uuid`);
    const res = await webhook(chargeCompletedWebhook({ transactionId, txRef: "unknown", amount: 49, currency: "USD", email: t.ownerEmail }));
    expect(res.json().outcome).toBe("ignored");
    expect((await tenantRow(t)).plan).toBe("free");
  });
});

// ============================================================================================
// The customer's return page
// ============================================================================================

describe("customer return page", () => {
  const ret = (qs: Record<string, string | number>) =>
    app.inject({ method: "GET", url: `/billing/return?${new URLSearchParams(Object.entries(qs).map(([k, v]) => [k, String(v)]))}` });

  it("verifies the payment and upgrades at once, without waiting for the webhook", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    const p = await pay(t, "growth", "monthly");
    const res = await ret({ status: "successful", tx_ref: p.txRef, transaction_id: p.transactionId });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("http://localhost:3000/settings/plan?billing=success");
    expect((await tenantRow(t)).plan).toBe("growth");
    expect(await subs(t)).toHaveLength(1);
  });

  it("the webhook arriving afterwards does not extend the plan a second time", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    const p = await pay(t, "growth", "monthly");
    await ret({ status: "successful", tx_ref: p.txRef, transaction_id: p.transactionId });
    const before = (await tenantRow(t)).plan_paid_through!;
    const hook = await webhook(p.body);
    expect(hook.json().outcome).toBe("duplicate");
    expect((await tenantRow(t)).plan_paid_through!.getTime()).toBe(before.getTime());
    expect(await subs(t)).toHaveLength(1);
  });

  it("and the other way round: webhook first, then the return page, is also applied once", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    const p = await pay(t, "growth", "monthly");
    await webhook(p.body);
    const res = await ret({ status: "successful", tx_ref: p.txRef, transaction_id: p.transactionId });
    expect(res.headers.location).toContain("billing=success");
    expect(await subs(t)).toHaveLength(1);
  });

  it("a cancelled checkout is recorded and nothing changes", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    await checkout(t, "growth", "monthly");
    const [c] = await checkoutsOf(t);
    const res = await ret({ status: "cancelled", tx_ref: c!.tx_ref });
    expect(res.headers.location).toBe("http://localhost:3000/settings/plan?billing=cancelled");
    expect((await checkoutsOf(t))[0]!.status).toBe("cancelled");
    expect((await tenantRow(t)).plan).toBe("free");
  });

  it("a failed payment sends the customer back with a failure notice", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    const p = await pay(t, "growth", "monthly", { status: "failed" });
    const res = await ret({ status: "failed", tx_ref: p.txRef, transaction_id: p.transactionId });
    expect(res.headers.location).toContain("billing=failed");
    expect((await tenantRow(t)).plan).toBe("free");
  });

  it("cannot be tricked into upgrading with someone else's paid transaction", async () => {
    if (!dbAvailable) return;
    const a = await newTenant();
    const b = await newTenant();
    await checkout(a, "growth", "monthly");
    const [ca] = await checkoutsOf(a);
    const paidByB = await pay(b, "growth", "monthly"); // B really pays
    // An attacker pairs A's checkout reference with B's genuine transaction id.
    const res = await ret({ status: "successful", tx_ref: ca!.tx_ref, transaction_id: paidByB.transactionId });
    expect(res.headers.location).toContain("billing=unknown");
    expect((await tenantRow(a)).plan).toBe("free");
    expect((await checkoutsOf(a))[0]!.status).toBe("pending");
  });

  it("claiming success with no transaction id, or an unknown checkout, upgrades nothing", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    await checkout(t, "growth", "monthly");
    const [c] = await checkoutsOf(t);
    expect((await ret({ status: "successful", tx_ref: c!.tx_ref })).headers.location).toContain("billing=pending");
    expect((await ret({ status: "successful", tx_ref: "nope", transaction_id: 1 })).headers.location).toContain("billing=unknown");
    expect((await ret({})).headers.location).toContain("billing=unknown");
    expect((await ret({ status: "successful", tx_ref: c!.tx_ref, transaction_id: 99999 })).headers.location).toContain("billing=pending");
    expect((await tenantRow(t)).plan).toBe("free");
  });

  it("when the provider cannot confirm yet it says pending, and the webhook finishes the job", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    const p = await pay(t, "growth", "monthly");
    fake.failNext("/transactions/", 500);
    const res = await ret({ status: "successful", tx_ref: p.txRef, transaction_id: p.transactionId });
    expect(res.headers.location).toContain("billing=pending");
    expect((await tenantRow(t)).plan).toBe("free");
    expect((await webhook(p.body)).json().outcome).toBe("applied_initial");
    expect((await tenantRow(t)).plan).toBe("growth");
  });
});

// ============================================================================================
// Renewals
// ============================================================================================

describe("renewals", () => {
  async function subscribed(plan = "growth", interval = "monthly") {
    const t = await newTenant();
    await payAndConfirm(t, plan, interval);
    const [sub] = await subs(t);
    const fsub = fake.subscriptions.find((s) => String(s.id) === sub!.provider_subscription_id)!;
    return { t, sub: sub!, fsub };
  }
  const recur = (fsubId: number, opts: { status?: string; amount?: number; currency?: string } = {}) => {
    const { transactionId, txRef } = fake.recurringCharge(fsubId, opts);
    const email = fake.subscriptions.find((s) => s.id === fsubId)!.email;
    const plan = fake.plans.find((p) => p.id === fake.subscriptions.find((s) => s.id === fsubId)!.plan)!;
    return chargeCompletedWebhook({ transactionId, txRef, amount: opts.amount ?? plan.amount, currency: opts.currency ?? plan.currency, email, status: opts.status });
  };

  it("an on-time renewal extends from where the paid period ended", async () => {
    if (!dbAvailable) return;
    const { t, sub, fsub } = await subscribed();
    const oldEnd = new Date(Date.now() + DAY); // due tomorrow
    await db.execute(sql`UPDATE subscriptions SET current_period_end = ${oldEnd} WHERE id = ${sub.id}::uuid`);
    await db.execute(sql`UPDATE tenants SET plan_paid_through = ${oldEnd} WHERE id = ${t.id}::uuid`);

    const res = await webhook(recur(fsub.id));
    expect(res.json().outcome).toBe("applied_renewal");
    const [after] = await subs(t);
    expect(after!.current_period_end.getTime()).toBe(addBillingPeriod(oldEnd, "monthly").getTime());
    expect(after!.current_period_start.getTime()).toBe(oldEnd.getTime());
    expect((await tenantRow(t)).plan_paid_through!.getTime()).toBe(after!.current_period_end.getTime());
  });

  it("a late renewal (inside the grace period) extends from now, not from the missed date", async () => {
    if (!dbAvailable) return;
    const { t, sub, fsub } = await subscribed();
    const missed = new Date(Date.now() - 2 * DAY);
    await db.execute(sql`UPDATE subscriptions SET current_period_end = ${missed} WHERE id = ${sub.id}::uuid`);
    await db.execute(sql`UPDATE tenants SET plan_paid_through = ${missed} WHERE id = ${t.id}::uuid`);
    expect((await planOf(t)).payment.status).toBe("overdue");

    await webhook(recur(fsub.id));
    const [after] = await subs(t);
    expect(near(after!.current_period_end, addBillingPeriod(new Date(), "monthly"))).toBe(true);
    expect((await planOf(t)).payment.status).toBe("current");
  });

  it("a yearly subscription renews for a year", async () => {
    if (!dbAvailable) return;
    const { t, sub, fsub } = await subscribed("scale", "yearly");
    const oldEnd = new Date(Date.now() + DAY);
    await db.execute(sql`UPDATE subscriptions SET current_period_end = ${oldEnd} WHERE id = ${sub.id}::uuid`);
    await webhook(recur(fsub.id));
    expect((await subs(t))[0]!.current_period_end.getTime()).toBe(addBillingPeriod(oldEnd, "yearly").getTime());
  });

  it("a failed recurring charge changes nothing, so the plan simply runs out by date", async () => {
    if (!dbAvailable) return;
    const { t, sub, fsub } = await subscribed();
    const res = await webhook(recur(fsub.id, { status: "failed" }));
    expect(res.json().outcome).toBe("ignored");
    expect((await subs(t))[0]!.current_period_end.getTime()).toBe(sub.current_period_end.getTime());
  });

  it("a charge whose amount does not match the subscription is not applied", async () => {
    if (!dbAvailable) return;
    const { t, sub, fsub } = await subscribed();
    const res = await webhook(recur(fsub.id, { amount: 5 }));
    expect(res.json().outcome).toBe("ignored");
    expect((await subs(t))[0]!.current_period_end.getTime()).toBe(sub.current_period_end.getTime());
  });

  it("the same renewal delivered twice extends once", async () => {
    if (!dbAvailable) return;
    const { t, fsub } = await subscribed();
    const body = recur(fsub.id);
    const one = await webhook(body);
    const end1 = (await subs(t))[0]!.current_period_end.getTime();
    const two = await webhook(body);
    expect(one.json().outcome).toBe("applied_renewal");
    expect(two.json().outcome).toBe("duplicate");
    expect((await subs(t))[0]!.current_period_end.getTime()).toBe(end1);
  });

  it("two workspaces paid for by the same email: the one that is due first is renewed", async () => {
    if (!dbAvailable) return;
    const a = await newTenant();
    const b = await newTenant();
    // Same payer email on both: point both checkouts at one address.
    await checkout(a, "growth", "monthly");
    await checkout(b, "growth", "monthly");
    await db.execute(sql`UPDATE billing_checkouts SET customer_email = 'shared@payer.example'`);
    for (const t of [a, b]) {
      const [c] = await checkoutsOf(t);
      const { transactionId, payment } = fake.completePayment(c!.tx_ref, { email: "shared@payer.example" });
      await webhook(chargeCompletedWebhook({ transactionId, txRef: c!.tx_ref, amount: payment.amount, currency: "USD", email: "shared@payer.example" }));
    }
    // A is due sooner than B.
    await db.execute(sql`UPDATE subscriptions SET current_period_end = now() + interval '1 day' WHERE tenant_id = ${a.id}::uuid`);
    await db.execute(sql`UPDATE subscriptions SET current_period_end = now() + interval '20 days' WHERE tenant_id = ${b.id}::uuid`);
    const bBefore = (await subs(b))[0]!.current_period_end.getTime();
    const aBefore = (await subs(a))[0]!.current_period_end.getTime();

    await webhook(recur(fake.subscriptions[0]!.id));
    expect((await subs(a))[0]!.current_period_end.getTime()).toBeGreaterThan(aBefore);
    expect((await subs(b))[0]!.current_period_end.getTime()).toBe(bBefore);
  });

  it("a charge after the customer cancelled is flagged for a refund and not applied", async () => {
    if (!dbAvailable) return;
    const { t, sub, fsub } = await subscribed();
    await db.execute(sql`UPDATE subscriptions SET status = 'cancelled', cancel_at_period_end = true WHERE id = ${sub.id}::uuid`);
    const res = await webhook(recur(fsub.id));
    expect(res.json().outcome).toBe("rejected");
    expect((await subs(t))[0]!.current_period_end.getTime()).toBe(sub.current_period_end.getTime());
    const ev = (await eventsOf(t)).find((e) => e.outcome.startsWith("rejected"));
    expect(ev!.outcome).toContain("refund");
  });
});

// ============================================================================================
// Changing plan
// ============================================================================================

describe("changing plan", () => {
  it("upgrading replaces the old subscription and stops the old one at the provider", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    await payAndConfirm(t, "starter", "monthly");
    const oldProviderSub = fake.subscriptions[0]!;
    expect((await tenantRow(t)).plan).toBe("starter");

    const up = await payAndConfirm(t, "growth", "monthly");
    expect(up.res.json().outcome).toBe("applied_initial");

    const rows = await subs(t);
    expect(rows.map((r) => [r.plan, r.status])).toEqual([["starter", "replaced"], ["growth", "active"]]);
    expect((await tenantRow(t)).plan).toBe("growth");
    expect(oldProviderSub.status).toBe("cancelled"); // no double billing
    expect(fake.subscriptions[1]!.status).toBe("active");
    expect(fake.callsTo("PUT", "/subscriptions/")).toHaveLength(1);
  });

  it("a downgrade works the same way", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    await payAndConfirm(t, "scale", "monthly");
    await payAndConfirm(t, "starter", "monthly");
    expect((await tenantRow(t)).plan).toBe("starter");
    expect((await subs(t)).map((r) => r.status)).toEqual(["replaced", "active"]);
    expect(fake.subscriptions[0]!.status).toBe("cancelled");
  });

  it("moving from monthly to yearly on the same plan is a change too", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    await payAndConfirm(t, "growth", "monthly");
    await payAndConfirm(t, "growth", "yearly");
    const rows = await subs(t);
    expect(rows.map((r) => [r.interval, r.status])).toEqual([["monthly", "replaced"], ["yearly", "active"]]);
    expect(near((await tenantRow(t)).plan_paid_through!, addBillingPeriod(new Date(), "yearly"))).toBe(true);
  });

  it("the customer is upgraded even if stopping the old subscription at the provider fails", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    await payAndConfirm(t, "starter", "monthly");
    fake.failNext("/subscriptions/", 500, 5);
    const up = await payAndConfirm(t, "growth", "monthly");
    expect(up.res.statusCode).toBe(200);
    expect((await tenantRow(t)).plan).toBe("growth");
    expect((await subs(t)).map((r) => r.status)).toEqual(["replaced", "active"]);
  });

  it("replacing a subscription that was already cancelled does not call the provider to cancel it again", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    await payAndConfirm(t, "starter", "monthly");
    expect((await app.inject({ method: "POST", url: "/v1/billing/cancel", cookies: asOwner(t) })).statusCode).toBe(200);
    const putsBefore = fake.callsTo("PUT", "/subscriptions/").length;
    await payAndConfirm(t, "growth", "monthly");
    expect(fake.callsTo("PUT", "/subscriptions/")).toHaveLength(putsBefore);
    expect((await subs(t)).map((r) => r.status)).toEqual(["replaced", "active"]);
  });

  it("at most one live subscription per workspace, enforced by the database itself", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    await payAndConfirm(t, "starter", "monthly");
    const insertLive = () =>
      db.execute(sql`
        INSERT INTO subscriptions (tenant_id, provider, plan, interval, amount_cents, currency, status, customer_email, current_period_start, current_period_end)
        VALUES (${t.id}::uuid, 'flutterwave', 'growth', 'monthly', 4900, 'USD', 'active', 'x@y.z', now(), now() + interval '1 month')`);
    await expect(insertLive()).rejects.toThrow();
  });
});

// ============================================================================================
// Cancelling
// ============================================================================================

describe("cancelling", () => {
  const cancel = (t: Tenant, cookies = asOwner(t)) => app.inject({ method: "POST", url: "/v1/billing/cancel", cookies });

  it("stops future charges at the provider and keeps the plan until the period ends", async () => {
    if (!dbAvailable) return;
    process.env.MAILFORGE_ENFORCE_PLANS = "true";
    try {
      const t = await newTenant();
      await payAndConfirm(t, "growth", "monthly");
      const res = await cancel(t);
      expect(res.statusCode).toBe(200);
      expect(res.json().subscription).toMatchObject({ plan: "growth", status: "cancelling", cancelAtPeriodEnd: true });

      expect(fake.subscriptions[0]!.status).toBe("cancelled"); // provider stopped charging
      const [sub] = await subs(t);
      expect(sub).toMatchObject({ status: "cancelled", cancel_at_period_end: true });

      // Still on Growth, with Growth's limits, because the month is paid for.
      const plan = await planOf(t);
      expect(plan.plan.id).toBe("growth");
      expect(plan.meters.contacts.limit).toBe(10000);
      expect(plan.payment.status).toBe("current");
      expect(plan.billing.subscription).toMatchObject({ status: "cancelling", cancel_at_period_end: true });
    } finally {
      delete process.env.MAILFORGE_ENFORCE_PLANS;
    }
  });

  it("after the paid period and the grace period, the workspace is Free and the subscription has ended", async () => {
    if (!dbAvailable) return;
    process.env.MAILFORGE_ENFORCE_PLANS = "true";
    try {
      const t = await newTenant();
      await payAndConfirm(t, "growth", "monthly");
      await cancel(t);
      const past = new Date(Date.now() - (BILLING_GRACE_DAYS + 1) * DAY);
      await db.execute(sql`UPDATE subscriptions SET current_period_end = ${past} WHERE tenant_id = ${t.id}::uuid`);
      await db.execute(sql`UPDATE tenants SET plan_paid_through = ${past} WHERE id = ${t.id}::uuid`);

      const plan = await planOf(t);
      expect(plan.plan.id).toBe("free");
      expect(plan.stored_plan).toBe("growth");
      expect(plan.payment.status).toBe("lapsed");
      expect(plan.meters.contacts.limit).toBe(500);
      expect(plan.billing.subscription.status).toBe("ended");
    } finally {
      delete process.env.MAILFORGE_ENFORCE_PLANS;
    }
  });

  it("looks the provider subscription up by email when its id was never learned", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    await payAndConfirm(t, "growth", "monthly");
    await db.execute(sql`UPDATE subscriptions SET provider_subscription_id = NULL WHERE tenant_id = ${t.id}::uuid`);
    expect((await cancel(t)).statusCode).toBe(200);
    expect(fake.subscriptions[0]!.status).toBe("cancelled");
  });

  it("says so plainly when there is nothing to cancel", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    const res = await cancel(t);
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("no_subscription");
    expect(fake.callsTo("PUT", "/subscriptions/")).toHaveLength(0);
  });

  it("cancelling twice is a clear no-op, not a double cancel", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    await payAndConfirm(t, "growth", "monthly");
    expect((await cancel(t)).statusCode).toBe(200);
    expect((await cancel(t)).statusCode).toBe(404);
    expect(fake.callsTo("PUT", "/subscriptions/")).toHaveLength(1);
  });

  it("a provider failure leaves the subscription active, so the customer is not misled", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    await payAndConfirm(t, "growth", "monthly");
    fake.failNext("/subscriptions/", 500);
    const res = await cancel(t);
    expect(res.statusCode).toBe(502);
    expect((await subs(t))[0]!.status).toBe("active");
    expect((await cancel(t)).statusCode).toBe(200); // and it works on the next try
  });

  it("if the provider has no such subscription any more, nothing can charge, so it is marked cancelled", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    await payAndConfirm(t, "growth", "monthly");
    fake.subscriptions.length = 0; // provider forgot it
    await db.execute(sql`UPDATE subscriptions SET provider_subscription_id = '999999' WHERE tenant_id = ${t.id}::uuid`);
    expect((await cancel(t)).statusCode).toBe(200);
    expect((await subs(t))[0]!.status).toBe("cancelled");
  });

  it("is for owners only", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    await payAndConfirm(t, "growth", "monthly");
    expect((await cancel(t, asMember(t))).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/v1/billing/cancel" })).statusCode).toBe(401);
    expect((await subs(t))[0]!.status).toBe("active");
  });

  it("can subscribe again after cancelling", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    await payAndConfirm(t, "growth", "monthly");
    await cancel(t);
    const again = await payAndConfirm(t, "growth", "monthly");
    expect(again.res.json().outcome).toBe("applied_initial");
    expect((await subs(t)).map((r) => r.status)).toEqual(["replaced", "active"]);
  });
});

describe("cancellation reported by the provider", () => {
  const cancelledEvent = (id: number | string, email: string, plan: number | string) => ({
    event: "subscription.cancelled",
    data: { id, customer: { customer_email: email }, plan, status: "cancelled" },
  });

  it("a customer cancelling through Flutterwave's own email link is reflected here, with the plan kept until the period ends", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    await payAndConfirm(t, "growth", "monthly");
    const fsub = fake.subscriptions[0]!;
    const res = await webhook(cancelledEvent(fsub.id, t.ownerEmail, fsub.plan));
    expect(res.json().outcome).toBe("applied_cancellation");
    expect((await subs(t))[0]).toMatchObject({ status: "cancelled", cancel_at_period_end: true });
    expect((await tenantRow(t)).plan).toBe("growth");
    expect((await planOf(t)).billing.subscription.status).toBe("cancelling");
  });

  it("is idempotent", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    await payAndConfirm(t, "growth", "monthly");
    const fsub = fake.subscriptions[0]!;
    const ev = cancelledEvent(fsub.id, t.ownerEmail, fsub.plan);
    expect((await webhook(ev)).json().outcome).toBe("applied_cancellation");
    expect((await webhook(ev)).json().outcome).toBe("duplicate");
  });

  it("an event about a subscription we do not have is ignored", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    await payAndConfirm(t, "growth", "monthly");
    const res = await webhook(cancelledEvent(55555, "stranger@example.com", 1));
    expect(res.json().outcome).toBe("ignored");
    expect((await subs(t))[0]!.status).toBe("active");
  });

  it("a late event about an old, replaced subscription cannot cancel its replacement", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    await payAndConfirm(t, "starter", "monthly");
    const oldFsub = fake.subscriptions[0]!;
    await payAndConfirm(t, "growth", "monthly"); // replaces starter; provider cancels the old one
    // Flutterwave now reports the old subscription's cancellation, late.
    const res = await webhook(cancelledEvent(oldFsub.id, t.ownerEmail, oldFsub.plan));
    expect(res.json().outcome).toBe("ignored");
    expect((await subs(t)).map((r) => r.status)).toEqual(["replaced", "active"]);
    expect((await tenantRow(t)).plan).toBe("growth");
  });

  it("requires the signature like every other event", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    await payAndConfirm(t, "growth", "monthly");
    const fsub = fake.subscriptions[0]!;
    expect((await webhook(cancelledEvent(fsub.id, t.ownerEmail, fsub.plan), "forged")).statusCode).toBe(401);
    expect((await subs(t))[0]!.status).toBe("active");
  });
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
