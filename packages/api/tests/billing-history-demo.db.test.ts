/**
 * Billing history and receipts, and demo data. Runs against a real database.
 *
 * Needs a reachable Postgres via DATABASE_URL, like the other *.db tests.
 * Every tenant created here has a slug starting with "histdemo-".
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { tenantTablesInDeleteOrder } from "@loomail/db/purge";
import { buildApp } from "../src/index.js";
import { SESSION_COOKIE_NAME } from "../src/routes/auth.js";

const TEST_DB_URL = process.env.DATABASE_URL;
if (!TEST_DB_URL) throw new Error("[billing-history-demo.test] DATABASE_URL is not set.");

let pool: pg.Pool;
let db: ReturnType<typeof drizzle>;
let dbAvailable = false;
let app: FastifyInstance;
let counter = 0;

interface Tenant {
  id: string;
  session: string;
}

async function q<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  return (await db.execute(query)).rows as T[];
}

async function newTenant(plan = "essential"): Promise<Tenant> {
  const slug = `histdemo-${Date.now()}-${counter++}`;
  const [t] = await q<{ id: string }>(
    sql`INSERT INTO tenants (name, slug, plan, settings) VALUES (${"Acme <b>" + slug}, ${slug}, ${plan}, ${JSON.stringify({ postal_address: "1 Main St\nAccra" })}::jsonb) RETURNING id`,
  );
  const [u] = await q<{ id: string }>(sql`INSERT INTO users (tenant_id, email, role) VALUES (${t!.id}::uuid, ${slug + "@hist.example"}, 'owner') RETURNING id`);
  const [s] = await q<{ id: string }>(
    sql`INSERT INTO sessions (tenant_id, user_id, expires_at) VALUES (${t!.id}::uuid, ${u!.id}::uuid, now() + interval '1 day') RETURNING id`,
  );
  return { id: t!.id, session: s!.id };
}

async function cleanup(): Promise<void> {
  const ids = (await q<{ id: string }>(sql`SELECT id FROM tenants WHERE slug LIKE 'histdemo-%'`)).map((r) => r.id);
  for (const id of ids) {
    await db.execute(sql`DELETE FROM billing_events WHERE tenant_id = ${id}::uuid`);
    await db.execute(sql`DELETE FROM billing_checkouts WHERE tenant_id = ${id}::uuid`);
    for (const t of await db.transaction(async (tx) => tenantTablesInDeleteOrder(tx as never))) {
      await db.execute(sql.raw(`DELETE FROM "${t}" WHERE tenant_id = '${id}'`));
    }
    await db.execute(sql`DELETE FROM tenants WHERE id = ${id}::uuid`);
  }
}

const cookie = (t: Tenant) => ({ [SESSION_COOKIE_NAME]: t.session });

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: TEST_DB_URL, connectionTimeoutMillis: 3000 });
  try {
    await pool.query("SELECT 1");
    db = drizzle(pool);
    dbAvailable = true;
  } catch (err) {
    if (process.env.CI === "true") throw new Error(`[billing-history-demo.test] DATABASE_URL not reachable in CI: ${(err as Error).message}`);
    console.warn("[billing-history-demo.test] DATABASE_URL not reachable - tests skipped.");
    return;
  }
  await cleanup();
  process.env.LOOMAIL_ENFORCE_PLANS = "true";
  app = await buildApp({ logger: false, db, baseUrl: "http://localhost:3000", dashboardUrl: "http://localhost:3000" });
});
afterEach(async () => {
  if (dbAvailable) await cleanup();
});
afterAll(async () => {
  delete process.env.LOOMAIL_ENFORCE_PLANS;
  await app?.close();
  await pool?.end();
});

describe("billing history and receipts", () => {
  async function pay(t: Tenant, reference: string, cents: number, over: { plan?: string; interval?: string; outcome?: string } = {}) {
    if (over.plan) {
      await db.execute(sql`
        INSERT INTO billing_checkouts (tenant_id, tx_ref, plan, interval, amount_cents, currency, customer_email, status)
        VALUES (${t.id}::uuid, ${reference}, ${over.plan}, ${over.interval ?? "monthly"}, ${cents}, 'USD', 'a@b.example', 'paid')`);
    }
    await db.execute(sql`
      INSERT INTO billing_events (provider, event_key, event_type, tenant_id, outcome, payload)
      VALUES ('paystack', ${"charge:" + reference}, 'charge.completed', ${t.id}::uuid, ${over.outcome ?? "applied"},
              ${JSON.stringify({ id: 1, reference, status: "success", amount: cents, currency: "USD", email: "a@b.example" })}::jsonb)`);
  }

  it("lists this workspace's payments with what each was for, and nobody else's", async () => {
    if (!dbAvailable) return;
    const a = await newTenant();
    const b = await newTenant();
    await pay(a, "ref-plan", 10000, { plan: "essential", interval: "monthly" });
    await pay(a, "ref-addon", 900, { plan: "addon:profiles", interval: "x3" });
    await pay(a, "ref-renew", 10000); // a renewal: no checkout row
    await pay(a, "ref-rejected", 5000, { outcome: "rejected: amount mismatch" });
    await pay(b, "ref-other", 10000, { plan: "essential" });

    const res = await app.inject({ method: "GET", url: "/v1/billing/payments", cookies: cookie(a) });
    expect(res.statusCode).toBe(200);
    const list = res.json().payments as Array<{ reference: string; description: string; amount: number; receipt_url: string }>;
    expect(list.map((p) => p.reference).sort()).toEqual(["ref-addon", "ref-plan", "ref-renew"]);
    expect(list.find((p) => p.reference === "ref-plan")).toMatchObject({ description: "Essential plan, billed monthly", amount: 100 });
    expect(list.find((p) => p.reference === "ref-addon")!.description).toContain("+3,000");
    expect(list.find((p) => p.reference === "ref-renew")!.description).toContain("renewal");
    expect(list[0]!.receipt_url).toMatch(/^\/v1\/billing\/receipts\//);
  });

  it("renders a receipt with the workspace's details, escaped, and refuses another workspace's", async () => {
    if (!dbAvailable) return;
    const a = await newTenant();
    const b = await newTenant();
    await pay(a, "ref-r1", 10000, { plan: "essential" });
    const ok = await app.inject({ method: "GET", url: "/v1/billing/receipts/ref-r1", cookies: cookie(a) });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers["content-type"]).toMatch(/text\/html/);
    expect(ok.body).toContain("Total paid");
    expect(ok.body).toContain("$100.00");
    expect(ok.body).toContain("Acme &lt;b&gt;"); // workspace name is escaped
    expect(ok.body).toContain("1 Main St<br>Accra");
    expect(ok.body).not.toContain("<b>histdemo");

    const other = await app.inject({ method: "GET", url: "/v1/billing/receipts/ref-r1", cookies: cookie(b) });
    expect(other.statusCode).toBe(404);
  });
});

describe("demo data", () => {
  it("adds made-up customers, never counts them against the plan, and clears exactly them", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    await db.execute(sql`
      INSERT INTO contacts (tenant_id, external_id, email, lifecycle_state, first_seen_at, last_seen_at)
      VALUES (${t.id}::uuid, 'real-1', 'real@x.example', 'signed_up', now(), now())`);

    const add = await app.inject({ method: "POST", url: "/v1/onboarding/demo-data", cookies: cookie(t) });
    expect(add.statusCode).toBe(200);
    expect(add.json().added).toBeGreaterThan(10);
    // Asking again adds nothing.
    expect((await app.inject({ method: "POST", url: "/v1/onboarding/demo-data", cookies: cookie(t) })).json().added).toBe(0);

    const demo = await q<{ n: string; emails: string }>(
      sql`SELECT count(*)::text AS n, count(email)::text AS emails FROM contacts WHERE tenant_id = ${t.id}::uuid AND external_id LIKE 'demo\_%'`,
    );
    expect(Number(demo[0]!.n)).toBeGreaterThan(10);
    expect(demo[0]!.emails).toBe("0"); // nothing can ever be emailed to a demo contact

    const plan = (await app.inject({ method: "GET", url: "/v1/plan", cookies: cookie(t) })).json();
    expect(plan.meters.contacts.used).toBe(1); // only the real contact counts

    const onboarding = (await app.inject({ method: "GET", url: "/v1/onboarding", cookies: cookie(t) })).json();
    expect(onboarding.has_demo_data).toBe(true);

    const del = await app.inject({ method: "DELETE", url: "/v1/onboarding/demo-data", cookies: cookie(t) });
    expect(del.json().removed).toBe(Number(demo[0]!.n));
    const left = await q<{ n: string }>(sql`SELECT count(*)::text AS n FROM contacts WHERE tenant_id = ${t.id}::uuid`);
    expect(left[0]!.n).toBe("1"); // the real contact is untouched
  });
});
