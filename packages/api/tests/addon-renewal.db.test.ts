/**
 * Monthly renewal of repeating top-ups. A fake payment provider stands in for Paystack, so these
 * exercise OUR rules: one charge per month, at today's price, only for workspaces that can use it,
 * never credited without a verified payment, stopped after two failures, and stoppable by the owner.
 *
 * Needs a reachable Postgres via DATABASE_URL, like the other *.db tests.
 * Every tenant created here has a slug starting with "renew-".
 */
import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { sql } from "drizzle-orm";
import type { TransportAdapter, TransportSendParams, TransportSendResult } from "@loomail/adapters";
import { tenantTablesInDeleteOrder } from "@loomail/db/purge";
import { applyVerifiedPayment, startAddonCheckout } from "../src/billing/service.js";
import { runAddonRenewals, stopAddonRenewal } from "../src/billing/addon-renewals.js";
import { loadAddonTotals } from "../src/plan/usage.js";
import type { ChargeAuthorizationInput, PaystackClient, PaystackTransaction } from "../src/billing/paystack.js";
import type { Db } from "../src/plugins/db.js";

const TEST_DB_URL = process.env.DATABASE_URL;
if (!TEST_DB_URL) throw new Error("[addon-renewal.test] DATABASE_URL is not set.");

const cfgBase = { currency: "USD", usdRate: 1, returnUrl: "http://localhost:3000/billing/return" };
const OCT = new Date("2026-10-15T10:00:00Z");
const NOV_2 = new Date("2026-11-02T09:00:00Z");
const NOV_3 = new Date("2026-11-03T10:00:00Z");

/** A fake provider that records charges and answers from a script. */
class FakePaystack {
  charges: ChargeAuthorizationInput[] = [];
  /** What the provider reports for a charged reference: "success", "failed", or "throw" on the call. */
  mode: "success" | "failed" | "throw-but-charged" | "throw-and-not-charged" = "success";
  private seen = new Map<string, PaystackTransaction>();
  private id = 5_000_000;

  async initializeTransaction() {
    return { url: "https://checkout.paystack.test/x", accessCode: "ac" };
  }
  async chargeAuthorization(input: ChargeAuthorizationInput): Promise<PaystackTransaction> {
    this.charges.push(input);
    const ok = this.mode === "success" || this.mode === "throw-but-charged";
    const tx: PaystackTransaction = {
      id: ++this.id,
      reference: input.reference,
      status: ok ? "success" : "failed",
      amount: input.amount,
      currency: input.currency,
      customer: { email: input.email },
    };
    this.seen.set(input.reference, tx);
    if (this.mode === "throw-but-charged" || this.mode === "throw-and-not-charged") throw new Error("network down");
    return tx;
  }
  async verifyTransaction(reference: string): Promise<PaystackTransaction> {
    const tx = this.seen.get(reference);
    if (!tx) throw new Error("unknown reference");
    return tx;
  }
}

class Outbox implements TransportAdapter {
  sent: TransportSendParams[] = [];
  async send(p: TransportSendParams): Promise<TransportSendResult> {
    this.sent.push(p);
    return { success: true, providerMessageId: `m-${this.sent.length}` };
  }
}

let pool: pg.Pool;
let db: ReturnType<typeof drizzle>;
let dbAvailable = false;
let counter = 0;
let seq = 8_000_000;
let ps: FakePaystack;
let outbox: Outbox;
const savedKey = process.env.ENCRYPTION_KEY;

async function q<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  return (await db.execute(query)).rows as T[];
}
const d = () => db as unknown as Db;
const client = () => ps as unknown as PaystackClient;

async function newTenant(o: { plan?: string; suspended?: boolean; trialEndsAt?: string | null; paidThrough?: string | null } = {}) {
  const slug = `renew-${Date.now()}-${counter++}`;
  const [t] = await q<{ id: string }>(sql`
    INSERT INTO tenants (name, slug, plan, trial_ends_at, plan_paid_through, suspended_at)
    VALUES (${"Acme " + slug}, ${slug}, ${o.plan ?? "essential"}, ${o.trialEndsAt ?? null}, ${o.paidThrough ?? null}, ${o.suspended ? new Date().toISOString() : null})
    RETURNING id`);
  const email = `${slug}@renew.example`;
  const [u] = await q<{ id: string }>(sql`INSERT INTO users (tenant_id, email, role) VALUES (${t!.id}::uuid, ${email}, 'owner') RETURNING id`);
  return { id: t!.id, userId: u!.id, email };
}

/** Buy a top-up with "repeat" ticked, paid with a reusable card, in October. */
async function buyRepeating(t: { id: string; userId: string; email: string }, kind: "profiles" | "emails" | "ai", packs: number, reusable = true) {
  const { txRef } = await startAddonCheckout(d(), client(), cfgBase, {
    tenantId: t.id,
    userId: t.userId,
    email: t.email,
    workspaceName: "Acme",
    kind,
    packs,
    repeat: true,
  });
  const cents = (await q<{ amount_cents: number }>(sql`SELECT amount_cents FROM billing_checkouts WHERE tx_ref = ${txRef}`))[0]!.amount_cents;
  const tx: PaystackTransaction = {
    id: ++seq,
    reference: txRef,
    status: "success",
    amount: cents,
    currency: "USD",
    customer: { email: t.email },
    authorization: { authorization_code: "AUTH_secret123", reusable, last4: "4242", brand: "visa" },
  };
  await applyVerifiedPayment(d(), client(), tx, OCT);
}

async function cleanup(): Promise<void> {
  const ids = (await q<{ id: string }>(sql`SELECT id FROM tenants WHERE slug LIKE 'renew-%'`)).map((r) => r.id);
  for (const id of ids) {
    for (const t of ["addon_auto_renewals", "addon_purchases", "billing_events", "billing_checkouts", "users"]) {
      await db.execute(sql.raw(`DELETE FROM ${t} WHERE tenant_id = '${id}'`));
    }
    await db.execute(sql`DELETE FROM tenants WHERE id = ${id}::uuid`);
  }
}

beforeAll(async () => {
  process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.LOOMAIL_ENFORCE_PLANS = "true";
  pool = new pg.Pool({ connectionString: TEST_DB_URL, connectionTimeoutMillis: 3000 });
  try {
    await pool.query("SELECT 1");
    db = drizzle(pool);
    dbAvailable = true;
  } catch (err) {
    if (process.env.CI === "true") throw new Error(`[addon-renewal.test] DATABASE_URL not reachable in CI: ${(err as Error).message}`);
    console.warn("[addon-renewal.test] DATABASE_URL not reachable - tests skipped.");
    return;
  }
  await cleanup();
});
beforeEach(() => {
  ps = new FakePaystack();
  outbox = new Outbox();
});
afterEach(async () => {
  if (dbAvailable) await cleanup();
});
afterAll(async () => {
  if (savedKey === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = savedKey;
  delete process.env.LOOMAIL_ENFORCE_PLANS;
  await pool?.end();
});

const renew = (now: Date) =>
  runAddonRenewals(d(), { client: client(), currency: "USD", usdRate: 1 }, { now, transport: { adapter: outbox, fromEmail: "no-reply@p.example", fromName: "Loomail" } });
const mine = (t: { id: string }) => ps.charges.filter((c) => c.reference.includes(t.id.slice(0, 8)));
const renewalRow = async (t: { id: string }) =>
  (await q<{ enabled: boolean; fail_count: number; last_period: string; authorization_enc: string; card_last4: string }>(
    sql`SELECT enabled, fail_count, last_period, authorization_enc, card_last4 FROM addon_auto_renewals WHERE tenant_id = ${t.id}::uuid`,
  ))[0];

describe("remembering the card", () => {
  it("stores the authorization encrypted, only for a reusable card, and only when repeat was ticked", async () => {
    if (!dbAvailable) return;
    const a = await newTenant();
    await buyRepeating(a, "profiles", 3);
    const row = await renewalRow(a);
    expect(row).toMatchObject({ enabled: true, fail_count: 0, card_last4: "4242" });
    expect(row!.authorization_enc).not.toContain("AUTH_secret123"); // encrypted at rest

    const b = await newTenant();
    await buyRepeating(b, "profiles", 3, false); // the bank will not let the card be reused
    expect(await renewalRow(b)).toBeUndefined();
    // The top-up itself still worked.
    expect((await loadAddonTotals(d(), b.id, OCT)).contacts).toBe(3000);
  });

  it("refuses a repeating top-up of more than 10 packs", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    await expect(
      startAddonCheckout(d(), client(), cfgBase, { tenantId: t.id, userId: t.userId, email: t.email, workspaceName: "A", kind: "profiles", packs: 11, repeat: true }),
    ).rejects.toMatchObject({ code: "invalid_plan" });
  });
});

describe("monthly renewal", () => {
  it("charges once at the current price, adds the units for the new month, and does not repeat", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    await buyRepeating(t, "profiles", 3);
    // Nothing is due while it is still October.
    await renew(new Date("2026-10-20T10:00:00Z"));
    expect(mine(t)).toHaveLength(0);

    const r = await renew(NOV_2);
    expect(r.renewed).toBeGreaterThanOrEqual(1);
    expect(mine(t)).toHaveLength(1);
    expect(mine(t)[0]).toMatchObject({ amount: 2700, currency: "USD", authorizationCode: "AUTH_secret123", email: t.email });
    expect((await loadAddonTotals(d(), t.id, NOV_2)).contacts).toBe(3000);
    expect(new Date((await renewalRow(t))!.last_period).toISOString()).toBe("2026-11-01T00:00:00.000Z");
    expect(outbox.sent.some((m) => m.to === t.email && /renewed/i.test(m.subject))).toBe(true);

    // A second sweep the same month, and one the next day, charge nothing more.
    await renew(NOV_2);
    await renew(NOV_3);
    expect(mine(t)).toHaveLength(1);
  });

  it("is idempotent across two servers racing: only one charge", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    await buyRepeating(t, "emails", 1);
    await Promise.all([renew(NOV_2), renew(NOV_2)]);
    expect(mine(t)).toHaveLength(1);
    expect((await loadAddonTotals(d(), t.id, NOV_2)).emailsPerMonth).toBe(100_000);
  });

  it("credits a charge whose call failed on the network but which the provider confirms", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    await buyRepeating(t, "ai", 1);
    ps.mode = "throw-but-charged";
    await renew(NOV_2);
    expect((await loadAddonTotals(d(), t.id, NOV_2)).aiTokensPerMonth).toBe(100_000);
  });

  it("does not credit anything when the provider does not confirm the charge", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    await buyRepeating(t, "profiles", 2);
    ps.mode = "failed";
    await renew(NOV_2);
    expect((await loadAddonTotals(d(), t.id, NOV_2)).contacts ?? 0).toBe(0);
    expect((await renewalRow(t))!.fail_count).toBe(1);
    expect(outbox.sent.some((m) => m.to === t.email && /could not renew/i.test(m.subject))).toBe(true);
  });
});

describe("failures and stopping", () => {
  it("retries a failure once after a day, then switches itself off and says so", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    await buyRepeating(t, "profiles", 1);
    ps.mode = "failed";
    await renew(NOV_2);
    expect(mine(t)).toHaveLength(1);
    await renew(new Date(NOV_2.getTime() + 3_600_000)); // an hour later: too soon to retry
    expect(mine(t)).toHaveLength(1);
    await renew(new Date(NOV_2.getTime() + 25 * 3_600_000)); // next day
    expect(mine(t)).toHaveLength(2);
    const row = await renewalRow(t);
    expect(row).toMatchObject({ enabled: false, fail_count: 2 });
    expect(outbox.sent.some((m) => /has stopped/i.test(m.subject))).toBe(true);
    // Switched off: never charged again.
    await renew(new Date(NOV_2.getTime() + 72 * 3_600_000));
    expect(mine(t)).toHaveLength(2);
  });

  it("never charges a workspace that is on no plan, suspended, or whose trial has ended", async () => {
    if (!dbAvailable) return;
    const noPlan = await newTenant({ plan: "trial", trialEndsAt: "2026-10-10T00:00:00Z" });
    await buyRepeating(noPlan, "profiles", 1);
    const suspended = await newTenant({ suspended: true });
    await buyRepeating(suspended, "profiles", 1);
    await renew(NOV_2);
    expect(mine(noPlan)).toHaveLength(0);
    expect(mine(suspended)).toHaveLength(0);
    // The no-plan one is not marked as failed: it simply was not due to be charged.
    expect((await renewalRow(noPlan))!.fail_count).toBe(0);
  });

  it("stops on request and forgets the card", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    await buyRepeating(t, "profiles", 1);
    expect(await stopAddonRenewal(d(), t.id, "profiles")).toBe(true);
    expect(await renewalRow(t)).toBeUndefined();
    await renew(NOV_2);
    expect(mine(t)).toHaveLength(0);
    expect(await stopAddonRenewal(d(), t.id, "profiles")).toBe(false);
  });
});
