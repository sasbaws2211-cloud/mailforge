/**
 * Integration tests for the platform admin console API and for workspace
 * suspension: who may use it, what it shows, what each change does, the audit
 * trail, and that a suspended workspace is really switched off.
 *
 * Needs a reachable Postgres via DATABASE_URL, like the other *.db tests.
 * Every tenant created here has a slug starting with "admin-t-".
 */
import { createHash, randomBytes } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import { SESSION_COOKIE_NAME } from "../src/routes/auth.js";
import { createFlutterwaveClient } from "../src/billing/flutterwave.js";
import { isPlatformAdmin, platformAdminEmails } from "../src/admin/platform-admins.js";
import { startFakeFlutterwave, type FakeFlutterwave } from "./helpers/fake-flutterwave.js";

const TEST_DB_URL = process.env.DATABASE_URL;
if (!TEST_DB_URL) throw new Error("[admin.test] DATABASE_URL is not set.");

const DAY = 86_400_000;
const ADMIN_EMAIL = "boss@admin-t.example";
let pool: pg.Pool;
let lockClient: pg.PoolClient | undefined;
let db: ReturnType<typeof drizzle>;
let dbAvailable = false;
let app: FastifyInstance;
let appBilling: FastifyInstance;
let fake: FakeFlutterwave;

interface Tenant {
  id: string;
  slug: string;
  email: string;
  key: string;
  session: string;
}

async function q<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  return (await db.execute(query)).rows as T[];
}

let counter = 0;
async function newTenant(opts: { plan?: string; email?: string; trialEndsAt?: Date | null; name?: string } = {}): Promise<Tenant> {
  const slug = `admin-t-${Date.now()}-${counter++}`;
  const email = opts.email ?? `${slug}@admin-t.example`;
  const [t] = await q<{ id: string }>(
    sql`INSERT INTO tenants (name, slug, plan, trial_ends_at) VALUES (${opts.name ?? slug}, ${slug}, ${opts.plan ?? "free"}, ${opts.trialEndsAt ?? null}) RETURNING id`,
  );
  const id = t!.id;
  const [u] = await q<{ id: string }>(sql`INSERT INTO users (tenant_id, email, role) VALUES (${id}::uuid, ${email}, 'owner') RETURNING id`);
  const [s] = await q<{ id: string }>(
    sql`INSERT INTO sessions (tenant_id, user_id, expires_at) VALUES (${id}::uuid, ${u!.id}::uuid, now() + interval '1 day') RETURNING id`,
  );
  const key = `mf_live_${randomBytes(24).toString("base64url")}`;
  await db.execute(sql`
    INSERT INTO api_keys (tenant_id, key_hash, prefix, label)
    VALUES (${id}::uuid, ${createHash("sha256").update(key).digest("hex")}, ${key.slice(0, 8)}, 'admin test')`);
  return { id, slug, email, key, session: s!.id };
}

async function cleanup(): Promise<void> {
  const ids = (await q<{ id: string }>(sql`SELECT id FROM tenants WHERE slug LIKE 'admin-t-%'`)).map((r) => r.id);
  for (const id of ids) {
    for (const t of ["admin_audit_log", "billing_events", "billing_checkouts", "subscriptions", "lifecycle_messages", "flow_memberships", "flows", "lifecycle_transitions", "events", "contact_conflicts", "contacts", "invites", "api_keys", "magic_link_tokens", "sessions", "users"]) {
      await db.execute(sql.raw(`DELETE FROM ${t} WHERE tenant_id = '${id}'`));
    }
    await db.execute(sql`DELETE FROM tenants WHERE id = ${id}::uuid`);
  }
}

const as = (t: Tenant) => ({ [SESSION_COOKIE_NAME]: t.session });
const get = (t: Tenant, url: string, a: FastifyInstance = app) => a.inject({ method: "GET", url, cookies: as(t) });
const post = (t: Tenant, url: string, payload: unknown, a: FastifyInstance = app) =>
  a.inject({ method: "POST", url, cookies: as(t), payload: payload as object });

async function tenantRow(id: string) {
  const [r] = await q<{ plan: string; trial_ends_at: Date | null; plan_paid_through: Date | null; suspended_at: Date | null; suspended_reason: string | null }>(
    sql`SELECT plan, trial_ends_at, plan_paid_through, suspended_at, suspended_reason FROM tenants WHERE id = ${id}::uuid`,
  );
  return r!;
}
const auditActions = async (tenantId: string) =>
  (await q<{ action: string }>(sql`SELECT action FROM admin_audit_log WHERE tenant_id = ${tenantId}::uuid ORDER BY created_at, id`)).map((r) => r.action);

let admin: Tenant;

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: TEST_DB_URL, connectionTimeoutMillis: 3000 });
  try {
    await pool.query("SELECT 1");
    db = drizzle(pool);
    dbAvailable = true;
    // These files share global tables (platform_llm_configs, platform_alert_state), so only one runs at a time.
    lockClient = await pool.connect();
    await lockClient.query("SELECT pg_advisory_lock(7770001)");
  } catch (err) {
    if (process.env.CI === "true") throw new Error(`[admin.test] DATABASE_URL not reachable in CI: ${(err as Error).message}`);
    console.warn("[admin.test] DATABASE_URL not reachable - tests skipped.");
    return;
  }
  await cleanup();
  process.env.MAILFORGE_PLATFORM_ADMINS = ` ${ADMIN_EMAIL.toUpperCase()} , someone-else@admin-t.example`;
  fake = await startFakeFlutterwave();
  const opts = { logger: false as const, db, baseUrl: "http://localhost:3000", dashboardUrl: "http://localhost:3000" };
  app = await buildApp(opts);
  appBilling = await buildApp({
    ...opts,
    billing: { client: createFlutterwaveClient({ secretKey: fake.secretKey, baseUrl: fake.baseUrl }), webhookHash: "h", currency: "USD" },
  });
});

afterEach(async () => {
  if (!dbAvailable) return;
  await cleanup();
  admin = undefined as unknown as Tenant;
});

afterAll(async () => {
  delete process.env.MAILFORGE_PLATFORM_ADMINS;
  if (app) await app.close();
  if (appBilling) await appBilling.close();
  if (fake) await fake.close();
  if (lockClient) {
    await lockClient.query("SELECT pg_advisory_unlock(7770001)");
    lockClient.release();
  }
  await pool?.end();
});

async function withAdmin(): Promise<Tenant> {
  admin = await newTenant({ email: ADMIN_EMAIL, plan: "growth" });
  return admin;
}

// ---------------------------------------------------------------------------

describe("who is a platform admin", () => {
  it("is read from the env list: trimmed, case-insensitive, nobody by default", () => {
    expect(platformAdminEmails({ MAILFORGE_PLATFORM_ADMINS: " A@x.com ,b@y.com,, " } as NodeJS.ProcessEnv)).toEqual(["a@x.com", "b@y.com"]);
    expect(isPlatformAdmin("A@X.COM", { MAILFORGE_PLATFORM_ADMINS: "a@x.com" } as NodeJS.ProcessEnv)).toBe(true);
    expect(isPlatformAdmin("a@x.com", {} as NodeJS.ProcessEnv)).toBe(false);
    expect(isPlatformAdmin(null, { MAILFORGE_PLATFORM_ADMINS: "a@x.com" } as NodeJS.ProcessEnv)).toBe(false);
    expect(isPlatformAdmin("", { MAILFORGE_PLATFORM_ADMINS: "" } as NodeJS.ProcessEnv)).toBe(false);
  });
});

describe("access", () => {
  it("signed-out requests get 401; an ordinary workspace owner gets a plain 404 on every route and nothing changes", async () => {
    if (!dbAvailable) return;
    const owner = await newTenant({ plan: "growth" });
    const victim = await newTenant();

    expect((await app.inject({ method: "GET", url: "/v1/admin/overview" })).statusCode).toBe(401);

    const calls: Array<[string, string, unknown?]> = [
      ["GET", "/v1/admin/overview"],
      ["GET", "/v1/admin/tenants"],
      ["GET", `/v1/admin/tenants/${victim.id}`],
      ["GET", "/v1/admin/audit"],
      ["POST", `/v1/admin/tenants/${victim.id}/plan`, { plan: "scale", reason: "sneaky" }],
      ["POST", `/v1/admin/tenants/${victim.id}/trial`, { days: 30, reason: "sneaky" }],
      ["POST", `/v1/admin/tenants/${victim.id}/suspend`, { reason: "sneaky" }],
      ["POST", `/v1/admin/tenants/${victim.id}/unsuspend`, { reason: "sneaky" }],
      ["POST", `/v1/admin/tenants/${victim.id}/cancel-subscription`, { reason: "sneaky" }],
    ];
    for (const [method, url, payload] of calls) {
      const res = await app.inject({ method: method as "GET" | "POST", url, cookies: as(owner), payload: payload as object | undefined });
      expect(res.statusCode, `${method} ${url}`).toBe(404);
      expect(res.json()).toEqual({ error: "Not found." });
    }
    const v = await tenantRow(victim.id);
    expect(v.plan).toBe("free");
    expect(v.suspended_at).toBeNull();
    expect(await auditActions(victim.id)).toEqual([]);
  });

  it("when no admins are configured, nobody gets in, not even an address that looks like an admin", async () => {
    if (!dbAvailable) return;
    const t = await newTenant({ email: ADMIN_EMAIL });
    const saved = process.env.MAILFORGE_PLATFORM_ADMINS;
    delete process.env.MAILFORGE_PLATFORM_ADMINS;
    try {
      expect((await get(t, "/v1/admin/overview")).statusCode).toBe(404);
    } finally {
      process.env.MAILFORGE_PLATFORM_ADMINS = saved;
    }
  });

  it("/auth/me tells the dashboard who is an admin, and nobody else", async () => {
    if (!dbAvailable) return;
    const a = await withAdmin();
    const other = await newTenant();
    const me = async (t: Tenant) => (await app.inject({ method: "GET", url: "/auth/me", cookies: as(t) })).json();
    expect((await me(a)).platformAdmin).toBe(true);
    expect((await me(other)).platformAdmin).toBe(false);
    expect((await me(a)).suspended).toBe(false);
  });
});

describe("overview", () => {
  // Totals are global and test files share one database, so another file creating or deleting a
  // workspace between the two readings can shift a count. Retried; a real bug fails every attempt.
  it("counts new workspaces, plans and paying subscriptions", { retry: 4 }, async () => {
    if (!dbAvailable) return;
    const a = await withAdmin();
    const before = (await get(a, "/v1/admin/overview")).json();

    const trial = await newTenant({ plan: "trial", trialEndsAt: new Date(Date.now() + 2 * DAY) });
    const starter = await newTenant({ plan: "starter" });
    await newTenant({ plan: "free" });
    await db.execute(sql`
      INSERT INTO subscriptions (tenant_id, provider, plan, interval, amount_cents, currency, status, customer_email, current_period_start, current_period_end)
      VALUES (${starter.id}::uuid, 'flutterwave', 'starter', 'yearly', 19000, 'USD', 'active', 'p@y.z', now(), now() + interval '1 year')`);
    await db.execute(sql`UPDATE tenants SET plan_paid_through = now() + interval '1 year' WHERE id = ${starter.id}::uuid`);
    void trial;

    const after = (await get(a, "/v1/admin/overview")).json();
    expect(after.workspaces.total - before.workspaces.total).toBe(3);
    expect(after.workspaces.signups_7d - before.workspaces.signups_7d).toBe(3);
    expect(after.workspaces.by_stored_plan.trial_running - before.workspaces.by_stored_plan.trial_running).toBe(1);
    expect(after.workspaces.by_stored_plan.starter - before.workspaces.by_stored_plan.starter).toBe(1);
    expect(after.workspaces.by_stored_plan.free - before.workspaces.by_stored_plan.free).toBe(1);
    expect(after.attention.trials_ending_in_3_days - before.attention.trials_ending_in_3_days).toBe(1);
    // $190 a year is counted as 190/12 = $15.83 a month.
    expect(after.revenue.mrr_usd - before.revenue.mrr_usd).toBeCloseTo(15.83, 1);
    expect(after.revenue.active_subscriptions - before.revenue.active_subscriptions).toBe(1);
    expect(after.billing_enabled).toBe(false);
  });

  it("flags a payment that is overdue (in grace) and one that has lapsed", { retry: 4 }, async () => {
    if (!dbAvailable) return;
    const a = await withAdmin();
    const before = (await get(a, "/v1/admin/overview")).json();
    const overdue = await newTenant({ plan: "growth" });
    const lapsed = await newTenant({ plan: "growth" });
    await db.execute(sql`UPDATE tenants SET plan_paid_through = now() - interval '1 day' WHERE id = ${overdue.id}::uuid`);
    await db.execute(sql`UPDATE tenants SET plan_paid_through = now() - interval '10 days' WHERE id = ${lapsed.id}::uuid`);
    const after = (await get(a, "/v1/admin/overview")).json();
    expect(after.attention.payments_overdue - before.attention.payments_overdue).toBe(1);
    expect(after.attention.subscriptions_lapsed - before.attention.subscriptions_lapsed).toBe(1);
  });
});

describe("finding workspaces", () => {
  it("lists newest first with the facts an operator needs, and shows what plan is really in force", async () => {
    if (!dbAvailable) return;
    const a = await withAdmin();
    const lapsed = await newTenant({ plan: "growth", name: "Lapsed Co" });
    await db.execute(sql`UPDATE tenants SET plan_paid_through = now() - interval '10 days' WHERE id = ${lapsed.id}::uuid`);
    await db.execute(sql`
      INSERT INTO contacts (tenant_id, external_id, lifecycle_state, first_seen_at, last_seen_at)
      SELECT ${lapsed.id}::uuid, 'c-' || g, 'signed_up', now(), now() FROM generate_series(1, 7) g`);

    const res = await get(a, "/v1/admin/tenants?q=Lapsed%20Co");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(1);
    const row = body.tenants[0];
    expect(row).toMatchObject({
      id: lapsed.id,
      name: "Lapsed Co",
      owner_email: lapsed.email,
      stored_plan: "growth",
      effective_plan: { id: "free", name: "Free" },
      payment_status: "lapsed",
      suspended: false,
      contacts: 7,
      members: 1,
      subscription: null,
    });
  });

  it("searches by workspace name, slug and any member's email; matches case-insensitively", async () => {
    if (!dbAvailable) return;
    const a = await withAdmin();
    const t = await newTenant({ name: "Zebra Widgets" });
    for (const q of ["zebra", "ZEBRA wid", t.slug, t.email.toUpperCase()]) {
      const body = (await get(a, `/v1/admin/tenants?q=${encodeURIComponent(q)}`)).json();
      expect(body.tenants.map((x: { id: string }) => x.id), q).toContain(t.id);
    }
    expect((await get(a, "/v1/admin/tenants?q=no-such-workspace-anywhere")).json().total).toBe(0);
  });

  it("treats % and _ in a search literally", async () => {
    if (!dbAvailable) return;
    const a = await withAdmin();
    await newTenant({ name: "Plain Name" });
    expect((await get(a, "/v1/admin/tenants?q=%25")).json().total).toBe(0);
    expect((await get(a, "/v1/admin/tenants?q=Plain_Name")).json().total).toBe(0);
  });

  it("filters by status and pages through results", async () => {
    if (!dbAvailable) return;
    const a = await withAdmin();
    const s1 = await newTenant({ plan: "starter", name: "Pg One" });
    const s2 = await newTenant({ plan: "starter", name: "Pg Two" });
    const s3 = await newTenant({ plan: "starter", name: "Pg Three" });
    const tr = await newTenant({ plan: "trial", trialEndsAt: new Date(Date.now() + DAY), name: "Pg Trial" });
    await post(a, `/v1/admin/tenants/${s3.id}/suspend`, { reason: "test" });

    const ids = async (qs: string) => (await get(a, `/v1/admin/tenants?q=Pg%20${qs}`)).json().tenants.map((x: { id: string }) => x.id);
    const paid = (await get(a, "/v1/admin/tenants?q=Pg%20&status=paid")).json();
    expect(paid.total).toBe(3);
    expect(paid.tenants.map((x: { id: string }) => x.id).sort()).toEqual([s1.id, s2.id, s3.id].sort());
    expect((await get(a, "/v1/admin/tenants?q=Pg%20&status=trial")).json().tenants.map((x: { id: string }) => x.id)).toEqual([tr.id]);
    expect((await get(a, "/v1/admin/tenants?q=Pg%20&status=suspended")).json().tenants.map((x: { id: string }) => x.id)).toEqual([s3.id]);
    expect((await get(a, "/v1/admin/tenants?q=Pg%20&status=free")).json().total).toBe(0);
    void ids;

    const p1 = (await get(a, "/v1/admin/tenants?q=Pg%20&limit=2&offset=0")).json();
    const p2 = (await get(a, "/v1/admin/tenants?q=Pg%20&limit=2&offset=2")).json();
    expect(p1.total).toBe(4);
    expect(p1.tenants).toHaveLength(2);
    expect(p2.tenants).toHaveLength(2);
    expect(new Set([...p1.tenants, ...p2.tenants].map((x: { id: string }) => x.id)).size).toBe(4);
  });

  it("rejects an unknown status filter and clamps silly page sizes", async () => {
    if (!dbAvailable) return;
    const a = await withAdmin();
    expect((await get(a, "/v1/admin/tenants?status=nonsense")).statusCode).toBe(400);
    expect((await get(a, "/v1/admin/tenants?limit=100000")).json().limit).toBe(100);
    expect((await get(a, "/v1/admin/tenants?limit=-4&offset=-9")).json()).toMatchObject({ limit: 1, offset: 0 });
  });

  it("is not injectable through the search box", async () => {
    if (!dbAvailable) return;
    const a = await withAdmin();
    const res = await get(a, `/v1/admin/tenants?q=${encodeURIComponent("'; DROP TABLE tenants; --")}`);
    expect(res.statusCode).toBe(200);
    expect((await get(a, "/v1/admin/overview")).statusCode).toBe(200);
  });
});

describe("one workspace", () => {
  it("shows plan, usage, members, subscription and history", async () => {
    if (!dbAvailable) return;
    const a = await withAdmin();
    const t = await newTenant({ plan: "starter" });
    await db.execute(sql`
      INSERT INTO subscriptions (tenant_id, provider, plan, interval, amount_cents, currency, status, customer_email, current_period_start, current_period_end)
      VALUES (${t.id}::uuid, 'flutterwave', 'starter', 'monthly', 1900, 'USD', 'active', 'payer@y.z', now(), now() + interval '1 month')`);
    await db.execute(sql`INSERT INTO billing_events (provider, event_key, event_type, tenant_id, outcome) VALUES ('flutterwave', ${"charge:" + t.id}, 'charge.completed', ${t.id}::uuid, 'applied')`);
    await post(a, `/v1/admin/tenants/${t.id}/suspend`, { reason: "chargeback" });

    const res = await get(a, `/v1/admin/tenants/${t.id}`);
    expect(res.statusCode).toBe(200);
    const d = res.json();
    expect(d.workspace).toMatchObject({ id: t.id, stored_plan: "starter", suspended: true, suspended_reason: "chargeback" });
    expect(d.usage).toMatchObject({ contacts: 0, members: 1, pending_invites: 0 });
    expect(d.members).toEqual([expect.objectContaining({ email: t.email, role: "owner", deactivated: false })]);
    expect(d.subscriptions[0]).toMatchObject({ plan: "starter", interval: "monthly", amount_usd: 19, status: "active", payer_email: "payer@y.z" });
    expect(d.billing_events[0]).toMatchObject({ type: "charge.completed", outcome: "applied" });
    expect(d.audit[0]).toMatchObject({ actor: ADMIN_EMAIL, action: "suspend" });
    expect(d.activity).toMatchObject({ flows: 0, has_email_transport: false, last_email_sent_at: null });
  });

  it("never exposes API keys or their hashes", async () => {
    if (!dbAvailable) return;
    const a = await withAdmin();
    const t = await newTenant();
    const text = (await get(a, `/v1/admin/tenants/${t.id}`)).body;
    expect(text).not.toContain(t.key);
    expect(text).not.toContain(createHash("sha256").update(t.key).digest("hex"));
    expect(text).not.toContain(t.session);
  });

  it("answers 404 for an unknown or malformed id (not a 500)", async () => {
    if (!dbAvailable) return;
    const a = await withAdmin();
    expect((await get(a, "/v1/admin/tenants/00000000-0000-0000-0000-000000000000")).statusCode).toBe(404);
    expect((await get(a, "/v1/admin/tenants/not-a-uuid")).statusCode).toBe(404);
    expect((await post(a, "/v1/admin/tenants/not-a-uuid/suspend", { reason: "x" })).statusCode).toBe(404);
  });
});

describe("setting a plan by hand", () => {
  it("needs a valid plan and a written reason, and changes nothing without them", async () => {
    if (!dbAvailable) return;
    const a = await withAdmin();
    const t = await newTenant();
    const url = `/v1/admin/tenants/${t.id}/plan`;
    expect((await post(a, url, { plan: "scale" })).json().code).toBe("reason_required");
    expect((await post(a, url, { plan: "scale", reason: "   " })).statusCode).toBe(400);
    expect((await post(a, url, { plan: "scale", reason: "x".repeat(301) })).statusCode).toBe(400);
    expect((await post(a, url, { plan: "platinum", reason: "ok" })).json().code).toBe("invalid_plan");
    expect((await post(a, url, { plan: "trial", reason: "ok" })).statusCode).toBe(400); // trials have their own route
    expect((await post(a, url, { reason: "ok" })).statusCode).toBe(400);
    expect((await tenantRow(t.id)).plan).toBe("free");
    expect(await auditActions(t.id)).toEqual([]);
  });

  it("puts the workspace on the plan with no expiry, clears a trial, and records who did it and why", async () => {
    if (!dbAvailable) return;
    const a = await withAdmin();
    const t = await newTenant({ plan: "trial", trialEndsAt: new Date(Date.now() + 5 * DAY) });
    const res = await post(a, `/v1/admin/tenants/${t.id}/plan`, { plan: "scale", reason: "Design partner, free for a year" });
    expect(res.statusCode).toBe(200);
    expect(res.json().workspace).toMatchObject({ stored_plan: "scale", effective_plan: { id: "scale" }, on_trial: false, payment_status: "none" });
    const row = await tenantRow(t.id);
    expect(row).toMatchObject({ plan: "scale", trial_ends_at: null, plan_paid_through: null });

    const [entry] = await q<{ actor_email: string; actor_user_id: string; action: string; detail: { reason: string; before: { plan: string }; after: { plan: string } } }>(
      sql`SELECT actor_email, actor_user_id, action, detail FROM admin_audit_log WHERE tenant_id = ${t.id}::uuid`,
    );
    expect(entry).toMatchObject({ actor_email: ADMIN_EMAIL, action: "set_plan" });
    expect(entry!.detail).toMatchObject({ reason: "Design partner, free for a year", before: { plan: "trial" }, after: { plan: "scale" } });
  });

  it("can put a paid workspace back to free by hand", async () => {
    if (!dbAvailable) return;
    const a = await withAdmin();
    const t = await newTenant({ plan: "growth" });
    expect((await post(a, `/v1/admin/tenants/${t.id}/plan`, { plan: "free", reason: "Customer asked to downgrade" })).statusCode).toBe(200);
    expect((await tenantRow(t.id)).plan).toBe("free");
  });

  it("refuses while a paid subscription is live, because the next charge would overwrite it", async () => {
    if (!dbAvailable) return;
    const a = await withAdmin();
    const t = await newTenant({ plan: "growth" });
    await db.execute(sql`
      INSERT INTO subscriptions (tenant_id, provider, plan, interval, amount_cents, currency, status, customer_email, current_period_start, current_period_end)
      VALUES (${t.id}::uuid, 'flutterwave', 'growth', 'monthly', 4900, 'USD', 'active', 'p@y.z', now(), now() + interval '1 month')`);
    const res = await post(a, `/v1/admin/tenants/${t.id}/plan`, { plan: "scale", reason: "upsell" });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("has_subscription");
    expect((await tenantRow(t.id)).plan).toBe("growth");
    expect(await auditActions(t.id)).toEqual([]);
    expect((await post(a, `/v1/admin/tenants/${t.id}/trial`, { days: 5, reason: "x" })).statusCode).toBe(409);
  });
});

describe("trials", () => {
  it("validates days, then gives a trial that ends that many days from now", async () => {
    if (!dbAvailable) return;
    const a = await withAdmin();
    const t = await newTenant();
    const url = `/v1/admin/tenants/${t.id}/trial`;
    for (const days of [0, -1, 91, 1.5, "7", null, undefined]) {
      expect((await post(a, url, { days, reason: "r" })).statusCode, String(days)).toBe(400);
    }
    expect((await post(a, url, { days: 7 })).json().code).toBe("reason_required");
    expect((await tenantRow(t.id)).plan).toBe("free");

    const res = await post(a, url, { days: 7, reason: "Evaluating for a big customer" });
    expect(res.statusCode).toBe(200);
    expect(res.json().workspace).toMatchObject({ stored_plan: "trial", on_trial: true, effective_plan: { id: "growth" } });
    const row = await tenantRow(t.id);
    const leftDays = (new Date(row.trial_ends_at!).getTime() - Date.now()) / DAY;
    expect(leftDays).toBeGreaterThan(6.99);
    expect(leftDays).toBeLessThan(7.01);
    expect(await auditActions(t.id)).toEqual(["extend_trial"]);
  });

  it("can revive an expired trial", async () => {
    if (!dbAvailable) return;
    const a = await withAdmin();
    const t = await newTenant({ plan: "trial", trialEndsAt: new Date(Date.now() - 3 * DAY) });
    expect((await get(a, `/v1/admin/tenants/${t.id}`)).json().workspace.effective_plan.id).toBe("free");
    await post(a, `/v1/admin/tenants/${t.id}/trial`, { days: 14, reason: "Needed more time" });
    expect((await get(a, `/v1/admin/tenants/${t.id}`)).json().workspace.effective_plan.id).toBe("growth");
  });
});

describe("suspension", () => {
  it("switches a workspace off everywhere: dashboard API, session check, and the ingest API", async () => {
    if (!dbAvailable) return;
    const a = await withAdmin();
    const t = await newTenant({ plan: "growth" });

    // Working before.
    expect((await get(t, "/v1/plan")).statusCode).toBe(200);
    const track = () => app.inject({
      method: "POST", url: "/v1/track",
      headers: { authorization: `Bearer ${t.key}`, "content-type": "application/json" },
      payload: JSON.stringify({ userId: "u1", event: "e" }),
    });
    expect((await track()).statusCode).toBe(200);

    const res = await post(a, `/v1/admin/tenants/${t.id}/suspend`, { reason: "Spam complaints" });
    expect(res.statusCode).toBe(200);
    expect(res.json().workspace).toMatchObject({ suspended: true, suspended_reason: "Spam complaints" });

    const blocked = await get(t, "/v1/plan");
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().code).toBe("workspace_suspended");
    expect((await get(t, "/v1/flows")).statusCode).toBe(403);
    const ingest = await track();
    expect(ingest.statusCode).toBe(403);
    expect(ingest.json().code).toBe("workspace_suspended");

    const me = (await app.inject({ method: "GET", url: "/auth/me", cookies: as(t) })).json();
    expect(me.suspended).toBe(true);
    // Not deleted: the data is all still there.
    expect((await tenantRow(t.id)).plan).toBe("growth");
  });

  it("does not affect other workspaces", async () => {
    if (!dbAvailable) return;
    const a = await withAdmin();
    const t = await newTenant();
    const bystander = await newTenant();
    await post(a, `/v1/admin/tenants/${t.id}/suspend`, { reason: "r" });
    expect((await get(bystander, "/v1/plan")).statusCode).toBe(200);
  });

  it("unsuspending restores access completely", async () => {
    if (!dbAvailable) return;
    const a = await withAdmin();
    const t = await newTenant();
    await post(a, `/v1/admin/tenants/${t.id}/suspend`, { reason: "r" });
    const res = await post(a, `/v1/admin/tenants/${t.id}/unsuspend`, { reason: "Resolved with the customer" });
    expect(res.statusCode).toBe(200);
    expect(res.json().workspace.suspended).toBe(false);
    expect((await get(t, "/v1/plan")).statusCode).toBe(200);
    expect((await tenantRow(t.id)).suspended_reason).toBeNull();
    expect(await auditActions(t.id)).toEqual(["suspend", "unsuspend"]);
  });

  it("needs a reason; cannot suspend twice, unsuspend a live workspace, or suspend your own", async () => {
    if (!dbAvailable) return;
    const a = await withAdmin();
    const t = await newTenant();
    expect((await post(a, `/v1/admin/tenants/${t.id}/suspend`, {})).json().code).toBe("reason_required");
    expect((await post(a, `/v1/admin/tenants/${t.id}/unsuspend`, { reason: "r" })).json().code).toBe("not_suspended");
    await post(a, `/v1/admin/tenants/${t.id}/suspend`, { reason: "r" });
    expect((await post(a, `/v1/admin/tenants/${t.id}/suspend`, { reason: "again" })).json().code).toBe("already_suspended");
    expect((await post(a, `/v1/admin/tenants/${a.id}/suspend`, { reason: "oops" })).json().code).toBe("own_workspace");
    expect((await tenantRow(a.id)).suspended_at).toBeNull();
    expect(await auditActions(t.id)).toEqual(["suspend"]);
  });

  it("an admin whose own workspace is suspended can still use the console", async () => {
    if (!dbAvailable) return;
    const a = await withAdmin();
    await db.execute(sql`UPDATE tenants SET suspended_at = now(), suspended_reason = 'x' WHERE id = ${a.id}::uuid`);
    expect((await get(a, "/v1/plan")).statusCode).toBe(403);
    expect((await get(a, "/v1/admin/overview")).statusCode).toBe(200);
  });
});

describe("cancelling a customer's subscription", () => {
  const insertLive = (tenantId: string) =>
    db.execute(sql`
      INSERT INTO subscriptions (tenant_id, provider, plan, interval, amount_cents, currency, status, customer_email, current_period_start, current_period_end)
      VALUES (${tenantId}::uuid, 'flutterwave', 'growth', 'monthly', 4900, 'USD', 'active', 'p@y.z', now(), now() + interval '1 month')`);

  it("answers 503 when online billing is not configured", async () => {
    if (!dbAvailable) return;
    const a = await withAdmin();
    const t = await newTenant({ plan: "growth" });
    await insertLive(t.id);
    const res = await post(a, `/v1/admin/tenants/${t.id}/cancel-subscription`, { reason: "r" });
    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe("billing_disabled");
  });

  it("stops renewals, keeps the plan until the period ends, and is audited", async () => {
    if (!dbAvailable) return;
    const a = await withAdmin();
    const t = await newTenant({ plan: "growth" });
    await insertLive(t.id);
    const res = await post(a, `/v1/admin/tenants/${t.id}/cancel-subscription`, { reason: "Customer emailed to cancel" }, appBilling);
    expect(res.statusCode).toBe(200);
    expect(res.json().workspace.subscription).toMatchObject({ status: "cancelled", plan: "growth" });
    expect((await tenantRow(t.id)).plan).toBe("growth");
    expect(await auditActions(t.id)).toEqual(["cancel_subscription"]);
  });

  it("needs a reason, and says so plainly when there is nothing to cancel", async () => {
    if (!dbAvailable) return;
    const a = await withAdmin();
    const t = await newTenant();
    expect((await post(a, `/v1/admin/tenants/${t.id}/cancel-subscription`, {}, appBilling)).json().code).toBe("reason_required");
    const res = await post(a, `/v1/admin/tenants/${t.id}/cancel-subscription`, { reason: "r" }, appBilling);
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("no_subscription");
    expect(await auditActions(t.id)).toEqual([]);
  });
});

describe("audit trail", () => {
  it("lists changes newest first with who, what and which workspace, and can be narrowed to one", async () => {
    if (!dbAvailable) return;
    const a = await withAdmin();
    const t1 = await newTenant({ name: "Audit One" });
    const t2 = await newTenant({ name: "Audit Two" });
    await post(a, `/v1/admin/tenants/${t1.id}/suspend`, { reason: "first" });
    await post(a, `/v1/admin/tenants/${t2.id}/plan`, { plan: "starter", reason: "second" });
    await post(a, `/v1/admin/tenants/${t1.id}/unsuspend`, { reason: "third" });

    // The log is global and other test files write to it in parallel, so look at our own entries only.
    const everything = (await get(a, "/v1/admin/audit?limit=200")).json().entries as Array<{ action: string; tenant_id: string | null }>;
    const all = everything.filter((e) => e.tenant_id === t1.id || e.tenant_id === t2.id);
    expect(all.map((e) => e.action)).toEqual(["unsuspend", "set_plan", "suspend"]);
    expect(all[0]).toMatchObject({ actor: ADMIN_EMAIL, tenant_id: t1.id, tenant_name: "Audit One", detail: { reason: "third" } });

    const only = (await get(a, `/v1/admin/audit?tenant_id=${t2.id}`)).json().entries;
    expect(only.map((e: { action: string }) => e.action)).toEqual(["set_plan"]);
    expect((await get(a, "/v1/admin/audit?tenant_id=nope")).statusCode).toBe(400);
  });

  it("a failed change leaves no audit row and a change always leaves exactly one", async () => {
    if (!dbAvailable) return;
    const a = await withAdmin();
    const t = await newTenant();
    await post(a, `/v1/admin/tenants/${t.id}/plan`, { plan: "nope", reason: "r" });
    expect(await auditActions(t.id)).toEqual([]);
    await post(a, `/v1/admin/tenants/${t.id}/plan`, { plan: "starter", reason: "r" });
    expect(await auditActions(t.id)).toEqual(["set_plan"]);
  });
});
