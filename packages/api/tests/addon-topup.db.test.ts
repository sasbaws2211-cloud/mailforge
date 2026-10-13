/**
 * Prepaid top-ups: a paid checkout for extra profiles, emails or AI credits raises this month's
 * limits once, an underpayment or a replay adds nothing, and last month's top-up does not count.
 * Runs against a real database with a fake payment provider.
 *
 * Needs a reachable Postgres via DATABASE_URL, like the other *.db tests.
 * Every tenant created here has a slug starting with "addon-".
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { sql } from "drizzle-orm";
import { addonUnits, PLANS } from "@loomail/core";
import { applyVerifiedPayment, startAddonCheckout } from "../src/billing/service.js";
import { loadEntitlements } from "../src/plan/usage.js";
import type { PaystackClient, PaystackTransaction } from "../src/billing/paystack.js";
import type { Db } from "../src/plugins/db.js";

const TEST_DB_URL = process.env.DATABASE_URL;
if (!TEST_DB_URL) throw new Error("[addon-topup.test] DATABASE_URL is not set.");

let pool: pg.Pool;
let db: ReturnType<typeof drizzle>;
let dbAvailable = false;
let counter = 0;
let seq = 9_000_000;

const cfg = { currency: "USD", usdRate: 1, returnUrl: "http://localhost:3000/billing/return" };

/** Only initializeTransaction is used by a top-up. */
const fakePs = {
  async initializeTransaction() {
    return { url: "https://checkout.paystack.test/abc", accessCode: "ac_test" };
  },
} as unknown as PaystackClient;

async function q<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  return (await db.execute(query)).rows as T[];
}

async function newTenant(): Promise<{ id: string; userId: string; email: string }> {
  const slug = `addon-${Date.now()}-${counter++}`;
  const [t] = await q<{ id: string }>(
    sql`INSERT INTO tenants (name, slug, plan, plan_paid_through) VALUES (${"Acme " + slug}, ${slug}, 'essential', null) RETURNING id`,
  );
  const email = `${slug}@addon.example`;
  const [u] = await q<{ id: string }>(sql`INSERT INTO users (tenant_id, email, role) VALUES (${t!.id}::uuid, ${email}, 'owner') RETURNING id`);
  return { id: t!.id, userId: u!.id, email };
}

async function cleanup(): Promise<void> {
  const ids = (await q<{ id: string }>(sql`SELECT id FROM tenants WHERE slug LIKE 'addon-%'`)).map((r) => r.id);
  for (const id of ids) {
    for (const t of ["addon_purchases", "billing_events", "billing_checkouts", "users"]) {
      await db.execute(sql.raw(`DELETE FROM ${t} WHERE tenant_id = '${id}'`));
    }
    await db.execute(sql`DELETE FROM tenants WHERE id = ${id}::uuid`);
  }
}

function paid(ref: string, cents: number, email: string, currency = "USD"): PaystackTransaction {
  return { id: ++seq, reference: ref, status: "success", amount: cents, currency, customer: { email } };
}

beforeAll(async () => {
  process.env.LOOMAIL_ENFORCE_PLANS = "true";
  pool = new pg.Pool({ connectionString: TEST_DB_URL, connectionTimeoutMillis: 3000 });
  try {
    await pool.query("SELECT 1");
    db = drizzle(pool);
    dbAvailable = true;
  } catch (err) {
    if (process.env.CI === "true") throw new Error(`[addon-topup.test] DATABASE_URL not reachable in CI: ${(err as Error).message}`);
    console.warn("[addon-topup.test] DATABASE_URL not reachable - tests skipped.");
    return;
  }
  await cleanup();
});

afterEach(async () => {
  if (dbAvailable) await cleanup();
});

afterAll(async () => {
  delete process.env.LOOMAIL_ENFORCE_PLANS;
  await pool?.end();
});

describe("prepaid top-ups", () => {
  it("a paid top-up raises only that limit, once, for this month", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    const d = db as unknown as Db;
    const base = await loadEntitlements(d, t.id);
    expect(base.limits.contacts).toBe(PLANS.essential.limits.contacts);

    const { txRef } = await startAddonCheckout(d, fakePs, cfg, {
      tenantId: t.id,
      userId: t.userId,
      email: t.email,
      workspaceName: "Acme",
      kind: "profiles",
      packs: 3,
    });
    const [row] = await q<{ plan: string; amount_cents: number; status: string }>(
      sql`SELECT plan, amount_cents, status FROM billing_checkouts WHERE tx_ref = ${txRef}`,
    );
    expect(row).toMatchObject({ plan: "addon:profiles", amount_cents: 2700, status: "pending" });

    const tx = paid(txRef, 2700, t.email);
    expect((await applyVerifiedPayment(d, fakePs, tx)).outcome).toBe("applied_initial");
    // A replay of the same payment adds nothing more.
    expect((await applyVerifiedPayment(d, fakePs, tx)).outcome).toBe("duplicate");

    const after = await loadEntitlements(d, t.id);
    expect(after.limits.contacts).toBe(PLANS.essential.limits.contacts! + addonUnits("profiles", 3));
    expect(after.limits.emailsPerMonth).toBe(PLANS.essential.limits.emailsPerMonth);
    expect(after.limits.aiTokensPerMonth).toBe(PLANS.essential.limits.aiTokensPerMonth);
    // The plan itself is untouched.
    expect(after.plan).toBe("essential");
    const subs = await q(sql`SELECT 1 FROM subscriptions WHERE tenant_id = ${t.id}::uuid`);
    expect(subs).toHaveLength(0);
    const [status] = await q<{ status: string }>(sql`SELECT status FROM billing_checkouts WHERE tx_ref = ${txRef}`);
    expect(status!.status).toBe("paid");
  });

  it("an underpayment is rejected and adds nothing", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    const d = db as unknown as Db;
    const { txRef } = await startAddonCheckout(d, fakePs, cfg, {
      tenantId: t.id,
      userId: t.userId,
      email: t.email,
      workspaceName: "Acme",
      kind: "emails",
      packs: 2,
    });
    const res = await applyVerifiedPayment(d, fakePs, paid(txRef, 100, t.email));
    expect(res.outcome).toBe("rejected");
    const e = await loadEntitlements(d, t.id);
    expect(e.limits.emailsPerMonth).toBe(PLANS.essential.limits.emailsPerMonth);
  });

  it("top-ups from an earlier month do not count", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    const d = db as unknown as Db;
    const { txRef } = await startAddonCheckout(d, fakePs, cfg, {
      tenantId: t.id,
      userId: t.userId,
      email: t.email,
      workspaceName: "Acme",
      kind: "ai",
      packs: 1,
    });
    // Paid in a past month.
    await applyVerifiedPayment(d, fakePs, paid(txRef, 1000, t.email), new Date("2020-03-15T10:00:00Z"));
    const now = await loadEntitlements(d, t.id);
    expect(now.limits.aiTokensPerMonth).toBe(PLANS.essential.limits.aiTokensPerMonth);
    const then = await loadEntitlements(d, t.id, new Date("2020-03-20T00:00:00Z"));
    expect(then.limits.aiTokensPerMonth).toBe(PLANS.essential.limits.aiTokensPerMonth! + 100_000);
  });

  it("refuses an invalid kind or pack count", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    const d = db as unknown as Db;
    for (const [kind, packs] of [["seats", 1], ["profiles", 0], ["profiles", 101]] as const) {
      await expect(
        startAddonCheckout(d, fakePs, cfg, { tenantId: t.id, userId: t.userId, email: t.email, workspaceName: "A", kind: kind as never, packs }),
      ).rejects.toMatchObject({ code: "invalid_plan" });
    }
  });
});
