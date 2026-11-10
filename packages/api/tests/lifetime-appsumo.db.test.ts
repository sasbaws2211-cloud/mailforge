/**
 * AppSumo lifetime deals: the signed webhook, redeeming a licence (one per workspace), the codes Loomail generates,
 * refunds, the billing mode, and the admin endpoints. Runs against a real database.
 *
 * Needs a reachable Postgres via DATABASE_URL, like the other *.db tests.
 * Every tenant created here has a slug starting with "ltd-", and every licence key starts with "TK".
 */
import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { tenantTablesInDeleteOrder } from "@loomail/db/purge";
import { PLANS } from "@loomail/core";
import { buildApp } from "../src/index.js";
import { SESSION_COOKIE_NAME } from "../src/routes/auth.js";
import { MAX_SKEW_SECONDS, normalizeCode, signWebhook, verifyWebhook } from "../src/appsumo/lifetime.js";

const TEST_DB_URL = process.env.DATABASE_URL;
if (!TEST_DB_URL) throw new Error("[lifetime-appsumo.test] DATABASE_URL is not set.");

const API_KEY = "testkey-appsumo";
const ADMIN_EMAIL = "boss@ltd-admin.example";
const sfx = Date.now().toString(36).toUpperCase();
const K = (n: string) => `TK${sfx}${n}`;

let pool: pg.Pool;
let db: ReturnType<typeof drizzle>;
let dbAvailable = false;
let app: FastifyInstance;
let counter = 0;
const saved: Record<string, string | undefined> = {};

interface Tenant {
  id: string;
  email: string;
  session: string;
}

async function q<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  return (await db.execute(query)).rows as T[];
}

async function newTenant(o: { plan?: string; email?: string; trialEndsAt?: Date | null } = {}): Promise<Tenant> {
  const slug = `ltd-${Date.now()}-${counter++}`;
  const email = o.email ?? `${slug}@ltd.example`;
  const [t] = await q<{ id: string }>(
    sql`INSERT INTO tenants (name, slug, plan, trial_ends_at) VALUES (${"Acme " + slug}, ${slug}, ${o.plan ?? "trial"}, ${o.trialEndsAt ?? new Date(Date.now() + 5 * 86_400_000)}) RETURNING id`,
  );
  const [u] = await q<{ id: string }>(sql`INSERT INTO users (tenant_id, email, role) VALUES (${t!.id}::uuid, ${email}, 'owner') RETURNING id`);
  const [s] = await q<{ id: string }>(sql`INSERT INTO sessions (tenant_id, user_id, expires_at) VALUES (${t!.id}::uuid, ${u!.id}::uuid, now() + interval '1 day') RETURNING id`);
  return { id: t!.id, email, session: s!.id };
}

async function cleanup(): Promise<void> {
  const ids = (await q<{ id: string }>(sql`SELECT id FROM tenants WHERE slug LIKE 'ltd-%'`)).map((r) => r.id);
  for (const id of ids) {
    await db.execute(sql`UPDATE lifetime_licenses SET tenant_id = NULL WHERE tenant_id = ${id}::uuid`);
    for (const t of ["admin_audit_log", ...(await db.transaction(async (tx) => tenantTablesInDeleteOrder(tx as never)))]) {
      await db.execute(sql.raw(`DELETE FROM "${t}" WHERE tenant_id = '${id}'`));
    }
    await db.execute(sql`DELETE FROM tenants WHERE id = ${id}::uuid`);
  }
  await db.execute(sql`DELETE FROM lifetime_licenses WHERE license_key LIKE ${"TK%"} OR license_key LIKE 'LM-%' OR license_key LIKE ${"%" + sfx + "%"}`);
  await db.execute(sql`DELETE FROM appsumo_events WHERE license_key LIKE ${"TK%"} OR license_key = ''`);
  await db.execute(sql`DELETE FROM platform_settings WHERE key IN ('billing_mode', 'lifetime_cap')`);
  await db.execute(sql`DELETE FROM admin_audit_log WHERE action LIKE 'lifetime_%'`);
}

const cookie = (t: Tenant) => ({ [SESSION_COOKIE_NAME]: t.session });

function hook(event: string, key: string, over: { tier?: number; prev?: string; test?: boolean; badSig?: boolean; ts?: string } = {}) {
  const body = JSON.stringify({ event, license_key: key, tier: over.tier ?? 1, prev_license_key: over.prev ?? null, test: over.test ?? false });
  const ts = over.ts ?? String(Math.floor(Date.now() / 1000));
  const sig = over.badSig ? "0".repeat(64) : signWebhook(API_KEY, ts, body);
  return app.inject({
    method: "POST",
    url: "/webhooks/appsumo",
    headers: { "content-type": "application/json", "x-appsumo-timestamp": ts, "x-appsumo-signature": sig },
    payload: body,
  });
}
const redeem = (t: Tenant, license_key?: string, extraCookies: Record<string, string> = {}) =>
  app.inject({ method: "POST", url: "/v1/lifetime/redeem", cookies: { ...cookie(t), ...extraCookies }, payload: license_key === undefined ? {} : { license_key }, headers: { "content-type": "application/json" } });
const planOf = async (t: Tenant) => (await q<{ plan: string }>(sql`SELECT plan FROM tenants WHERE id = ${t.id}::uuid`))[0]!.plan;
const lic = async (key: string) => (await q<{ status: string; tenant_id: string | null; tier: number }>(sql`SELECT status, tenant_id, tier FROM lifetime_licenses WHERE license_key = ${key}`))[0];

beforeAll(async () => {
  for (const k of ["APPSUMO_API_KEY", "ENCRYPTION_KEY", "LOOMAIL_PLATFORM_ADMINS", "LOOMAIL_ENFORCE_PLANS", "APPSUMO_BUY_URL"]) saved[k] = process.env[k];
  process.env.APPSUMO_API_KEY = API_KEY;
  process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.LOOMAIL_PLATFORM_ADMINS = ADMIN_EMAIL;
  process.env.LOOMAIL_ENFORCE_PLANS = "true";
  pool = new pg.Pool({ connectionString: TEST_DB_URL, connectionTimeoutMillis: 3000 });
  try {
    await pool.query("SELECT 1");
    db = drizzle(pool);
    dbAvailable = true;
  } catch (err) {
    if (process.env.CI === "true") throw new Error(`[lifetime-appsumo.test] DATABASE_URL not reachable in CI: ${(err as Error).message}`);
    console.warn("[lifetime-appsumo.test] DATABASE_URL not reachable - tests skipped.");
    return;
  }
  await cleanup();
  app = await buildApp({ logger: false, db, baseUrl: "http://localhost:3000", dashboardUrl: "http://localhost:3000", publicSite: true });
});
afterEach(async () => {
  if (dbAvailable) await cleanup();
});
afterAll(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await app?.close();
  await pool?.end();
});

describe("webhook signature", () => {
  it("accepts a good signature, in seconds or milliseconds, and refuses everything else", () => {
    const body = '{"event":"purchase"}';
    const now = 1_800_000_000_000;
    const ts = String(now / 1000);
    expect(verifyWebhook(API_KEY, ts, signWebhook(API_KEY, ts, body), body, now)).toBe(true);
    const tsMs = String(now);
    expect(verifyWebhook(API_KEY, tsMs, signWebhook(API_KEY, tsMs, body), body, now)).toBe(true);
    expect(verifyWebhook(API_KEY, ts, "0".repeat(64), body, now)).toBe(false);
    expect(verifyWebhook(API_KEY, ts, signWebhook(API_KEY, ts, body), body + " ", now)).toBe(false); // body changed
    expect(verifyWebhook("another-key", ts, signWebhook(API_KEY, ts, body), body, now)).toBe(false);
    const stale = String(now / 1000 - MAX_SKEW_SECONDS - 5);
    expect(verifyWebhook(API_KEY, stale, signWebhook(API_KEY, stale, body), body, now)).toBe(false);
    expect(verifyWebhook("", ts, signWebhook(API_KEY, ts, body), body, now)).toBe(false);
    expect(verifyWebhook(API_KEY, "nope", "x", body, now)).toBe(false);
  });

  it("recognises a code typed without dashes, in lower case, with spaces", () => {
    expect(normalizeCode("  lm-ab2c-de3f-gh4j ")).toBe("LM-AB2C-DE3F-GH4J");
    expect(normalizeCode("lmab2cde3fgh4j")).toBe("LM-AB2C-DE3F-GH4J");
    expect(normalizeCode("some-appsumo-uuid")).toBe("some-appsumo-uuid"); // AppSumo's own keys are left alone
  });
});

describe("the webhook", () => {
  it("refuses a bad signature, acknowledges a test ping without a row, and stores a purchase once", async () => {
    if (!dbAvailable) return;
    expect((await hook("purchase", K("A"), { badSig: true })).statusCode).toBe(401);
    expect(await lic(K("A"))).toBeUndefined();
    expect((await hook("purchase", K("T"), { test: true })).json()).toMatchObject({ success: true });
    expect(await lic(K("T"))).toBeUndefined();
    expect((await hook("purchase", K("A"))).json()).toMatchObject({ event: "purchase", success: true });
    expect(await lic(K("A"))).toMatchObject({ status: "inactive", tier: 1 });
    expect((await hook("purchase", K("A"))).statusCode).toBe(200); // a retry changes nothing
    const n = await q<{ n: string }>(sql`SELECT count(*)::text AS n FROM lifetime_licenses WHERE license_key = ${K("A")}`);
    expect(n[0]!.n).toBe("1");
  });

  it("is 503 when AppSumo is not configured, and 400 for a body that is not JSON", async () => {
    if (!dbAvailable) return;
    const body = "not json";
    const ts = String(Math.floor(Date.now() / 1000));
    const bad = await app.inject({
      method: "POST",
      url: "/webhooks/appsumo",
      headers: { "content-type": "application/json", "x-appsumo-timestamp": ts, "x-appsumo-signature": signWebhook(API_KEY, ts, body) },
      payload: body,
    });
    expect(bad.statusCode).toBe(400);
    delete process.env.APPSUMO_API_KEY;
    expect((await hook("purchase", K("B"))).statusCode).toBe(503);
    process.env.APPSUMO_API_KEY = API_KEY;
  });

  it("logs every event it acts on, and ignores add-on events", async () => {
    if (!dbAvailable) return;
    await hook("purchase", K("C"));
    await hook("activate", K("C"));
    await hook("purchase", K("D"), { test: false });
    const addon = JSON.stringify({ event: "purchase", license_key: K("E"), parent_license_key: "PARENT" });
    const ts = String(Math.floor(Date.now() / 1000));
    const ignored = await app.inject({
      method: "POST",
      url: "/webhooks/appsumo",
      headers: { "content-type": "application/json", "x-appsumo-timestamp": ts, "x-appsumo-signature": signWebhook(API_KEY, ts, addon) },
      payload: addon,
    });
    expect(ignored.statusCode).toBe(200); // acknowledged, so AppSumo stops retrying it
    expect(await lic(K("E"))).toBeUndefined(); // but Loomail sells no add-ons, so nothing is stored
    const note = await q<{ outcome: string }>(sql`SELECT outcome FROM appsumo_events WHERE license_key = ${K("E")}`);
    expect(note[0]!.outcome).toMatch(/add-on/);
    const logged = await q<{ n: string }>(sql`SELECT count(*)::text AS n FROM appsumo_events WHERE license_key LIKE ${"TK" + sfx + "%"}`);
    expect(Number(logged[0]!.n)).toBeGreaterThanOrEqual(3);
  });
});

describe("redeeming a licence from the dashboard", () => {
  it("unlocks tier 1, switches Loomail Sending off, and is harmless to repeat", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    await db.execute(sql`INSERT INTO managed_sending (tenant_id, enabled) VALUES (${t.id}::uuid, true)`);
    await hook("purchase", K("R1"));
    expect((await redeem(t, "nope-nope-nope")).statusCode).toBe(404);
    const ok = await redeem(t, K("R1"));
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ ok: true, tier: 1, plan_code: "lifetime_1" });
    expect(await planOf(t)).toBe("lifetime_1");
    const ms = await q<{ enabled: boolean }>(sql`SELECT enabled FROM managed_sending WHERE tenant_id = ${t.id}::uuid`);
    expect(ms[0]!.enabled).toBe(false);
    expect((await redeem(t, K("R1"))).statusCode).toBe(200);
    expect(await planOf(t)).toBe("lifetime_1");
    // The trial is gone and the plan never lapses.
    const row = await q<{ trial_ends_at: Date | null; plan_paid_through: Date | null }>(sql`SELECT trial_ends_at, plan_paid_through FROM tenants WHERE id = ${t.id}::uuid`);
    expect(row[0]).toMatchObject({ trial_ends_at: null, plan_paid_through: null });
  });

  it("finds a licence key pasted in a different case", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    await hook("purchase", K("c1"));
    const r = await redeem(t, K("c1").toLowerCase());
    expect(r.statusCode, r.body).toBe(200);
    expect(await planOf(t)).toBe("lifetime_1");
  });

  it("gives the workspace the lifetime limits and no managed sending", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    await hook("purchase", K("R2"));
    await redeem(t, K("R2"));
    const plan = (await app.inject({ method: "GET", url: "/v1/plan", cookies: cookie(t) })).json();
    expect(plan.plan.id).toBe("lifetime_1");
    expect(plan.meters.contacts.limit).toBe(PLANS.lifetime_1.limits.contacts);
    expect(plan.lifetime).toMatchObject({ on_lifetime_plan: true, max_tier: 1, mode: "both" });
    expect(plan.lifetime.license).toMatchObject({ tier: 1 });
    expect(plan.lifetime.tiers).toHaveLength(1);
    // Lifetime tiers are never offered as something to buy.
    expect(plan.plans.map((p: { id: string }) => p.id)).toEqual(["essential"]);
    expect((await app.inject({ method: "POST", url: "/v1/sending/enable", cookies: cookie(t) })).statusCode).not.toBe(200);
  });

  it("refuses a code that another workspace has, and a workspace with a live subscription", async () => {
    if (!dbAvailable) return;
    const a = await newTenant();
    const b = await newTenant();
    await hook("purchase", K("R3"));
    expect((await redeem(a, K("R3"))).statusCode).toBe(200);
    const taken = await redeem(b, K("R3"));
    expect(taken.statusCode).toBe(409);
    expect(taken.json().error).toMatch(/already used/);

    const sub = await newTenant({ plan: "essential" });
    await db.execute(sql`
      INSERT INTO subscriptions (tenant_id, plan, interval, amount_cents, status, customer_email, current_period_start, current_period_end)
      VALUES (${sub.id}::uuid, 'essential', 'monthly', 10000, 'active', ${sub.email}, now(), now() + interval '20 days')`);
    await hook("purchase", K("R4"));
    const blocked = await redeem(sub, K("R4"));
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error).toMatch(/paid subscription/);
    expect(await planOf(sub)).toBe("essential");
  });

  it("follows an upgrade to the new key (still the one lifetime tier), keeps access when the old key is refunded, and ends it with the last", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    await hook("purchase", K("U1"), { tier: 1 });
    await redeem(t, K("U1"));
    expect((await hook("upgrade", K("U2"), { tier: 3, prev: K("U1") })).statusCode).toBe(200);
    expect(await planOf(t)).toBe("lifetime_1"); // there is one tier, however high AppSumo says
    expect((await lic(K("U1")))!.status).toBe("superseded");
    expect((await lic(K("U2")))!.tenant_id).toBe(t.id);
    expect((await hook("deactivate", K("U1"))).statusCode).toBe(200); // the replaced key being refunded changes nothing
    expect(await planOf(t)).toBe("lifetime_1");
    expect((await hook("deactivate", K("U2"))).statusCode).toBe(200);
    expect(await planOf(t)).toBe("free"); // no plan: the data stays, limits drop to nothing
    const again = await redeem(t, K("U2"));
    expect(again.statusCode).toBe(400); // refunded
  });
});

describe("codes Loomail generates", () => {
  it("makes unique LM- codes, a headerless CSV, and counts only redeemed ones as sold", async () => {
    if (!dbAvailable) return;
    const admin = await newTenant({ email: ADMIN_EMAIL });
    const made = await app.inject({
      method: "POST",
      url: "/v1/admin/lifetime/codes",
      cookies: cookie(admin),
      payload: { count: 4, reason: "launch batch" },
      headers: { "content-type": "application/json" },
    });
    expect(made.statusCode, made.body).toBe(200);
    expect(made.json().made).toBe(4);
    const codes = (await q<{ license_key: string }>(sql`SELECT license_key FROM lifetime_licenses WHERE source = 'code' ORDER BY created_at`)).map((r) => r.license_key);
    expect(codes).toHaveLength(4);
    expect(new Set(codes).size).toBe(4);
    for (const c of codes) expect(c).toMatch(/^LM-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    const csv = await app.inject({ method: "GET", url: "/v1/admin/lifetime/codes.csv", cookies: cookie(admin) });
    expect(csv.headers["content-type"]).toMatch(/text\/csv/);
    expect(csv.body.split("\n").filter(Boolean).sort()).toEqual([...codes].sort());
    expect(csv.body.toLowerCase().startsWith("code")).toBe(false);
    const overview = (await app.inject({ method: "GET", url: "/v1/admin/lifetime", cookies: cookie(admin) })).json();
    expect(overview.codes).toMatchObject({ total: 4, unused: 4, redeemed: 0, refunded: 0 });
    expect(overview.spots.sold).toBe(0);
  });

  it("allows one code per workspace, refuses a second, and a refund ends it", async () => {
    if (!dbAvailable) return;
    const admin = await newTenant({ email: ADMIN_EMAIL });
    await app.inject({ method: "POST", url: "/v1/admin/lifetime/codes", cookies: cookie(admin), payload: { count: 2, reason: "test" }, headers: { "content-type": "application/json" } });
    const codes = (await q<{ license_key: string }>(sql`SELECT license_key FROM lifetime_licenses WHERE source = 'code' ORDER BY license_key`)).map((r) => r.license_key);
    const t = await newTenant();
    // typed without dashes, in lower case
    const typed = codes[0]!.replace(/-/g, "").toLowerCase();
    expect((await redeem(t, "  " + typed + " ")).json()).toMatchObject({ tier: 1, plan_code: "lifetime_1" });
    expect(await planOf(t)).toBe("lifetime_1");
    const second = await redeem(t, codes[1]!);
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toMatch(/already has a lifetime licence/);
    expect((await redeem(t, codes[0]!)).statusCode).toBe(200); // the same code twice is harmless
    expect(await lic(codes[1]!)).toMatchObject({ status: "inactive", tenant_id: null }); // the refused code is untouched

    const refund = (code: string) =>
      app.inject({ method: "POST", url: "/v1/admin/lifetime/codes/refund", cookies: cookie(admin), payload: { code, reason: "AppSumo refund" }, headers: { "content-type": "application/json" } });
    expect((await refund(codes[0]!)).statusCode).toBe(200);
    expect(await planOf(t)).toBe("free");
    expect((await refund(codes[0]!)).json().result).toMatch(/deactivated/);
    // The refunded code cannot be used again; the other one still works in another workspace.
    const t2 = await newTenant();
    expect((await redeem(t2, codes[0]!)).statusCode).toBe(400);
    expect((await redeem(t2, codes[1]!)).statusCode).toBe(200);
    const actions = await q<{ action: string }>(sql`SELECT action FROM admin_audit_log WHERE action LIKE 'lifetime_%'`);
    expect(actions.map((x) => x.action)).toContain("lifetime_codes_generated");
    expect(actions.filter((x) => x.action === "lifetime_code_refunded").length).toBeGreaterThanOrEqual(1);
  });

  it("will not refund a licence that came from AppSumo by hand: AppSumo's webhook does that", async () => {
    if (!dbAvailable) return;
    const admin = await newTenant({ email: ADMIN_EMAIL });
    await hook("purchase", K("H1"));
    const r = await app.inject({
      method: "POST",
      url: "/v1/admin/lifetime/codes/refund",
      cookies: cookie(admin),
      payload: { code: K("H1"), reason: "customer asked" },
      headers: { "content-type": "application/json" },
    });
    expect(r.statusCode).toBe(409);
    expect((await lic(K("H1")))!.status).toBe("inactive");
  });

  it("is only for platform admins, and every change needs a reason", async () => {
    if (!dbAvailable) return;
    const nobody = await newTenant();
    expect((await app.inject({ method: "GET", url: "/v1/admin/lifetime", cookies: cookie(nobody) })).statusCode).toBe(404);
    const admin = await newTenant({ email: ADMIN_EMAIL });
    const noReason = await app.inject({ method: "POST", url: "/v1/admin/lifetime/codes", cookies: cookie(admin), payload: { count: 1 }, headers: { "content-type": "application/json" } });
    expect(noReason.statusCode).toBe(400);
    expect(noReason.json().code).toBe("reason_required");
  });
});

describe("/redeem and the activation link", () => {
  it("shows the form, remembers a code for a visitor with no account, and finishes it after sign-up", async () => {
    if (!dbAvailable) return;
    expect((await app.inject({ method: "GET", url: "/redeem" })).body).toContain("Redeem your code");
    await hook("purchase", K("P1"));
    expect((await app.inject({ method: "GET", url: "/redeem?code=nope-nope" })).statusCode).toBe(404);
    const waiting = await app.inject({ method: "GET", url: `/redeem?code=${K("P1")}` });
    expect(waiting.statusCode).toBe(303);
    expect(waiting.headers.location).toBe("/signup?code=waiting");
    const setCookie = String(waiting.headers["set-cookie"]);
    expect(setCookie).toContain("loomail_appsumo_license=");
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).not.toContain(K("P1")); // encrypted, not the key itself
    const pending = setCookie.split(";")[0]!.split("=").slice(1).join("=");

    // The signup page says the code is saved.
    expect((await app.inject({ method: "GET", url: "/signup?code=waiting" })).body).toContain("Your AppSumo code is saved");

    // After they have an account, one press (no key typed) finishes it.
    const t = await newTenant();
    const plan0 = (await app.inject({ method: "GET", url: "/v1/plan", cookies: { ...cookie(t), loomail_appsumo_license: decodeURIComponent(pending) } })).json();
    expect(plan0.lifetime.pending_code).toBe(true);
    const done = await redeem(t, undefined, { loomail_appsumo_license: decodeURIComponent(pending) });
    expect(done.statusCode, done.body).toBe(200);
    expect(await planOf(t)).toBe("lifetime_1");
  });

  it("claims straight away for a signed-in owner, and the OAuth callback does the same", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    await hook("purchase", K("P2"));
    const r = await app.inject({ method: "GET", url: `/redeem?code=${K("P2")}`, cookies: cookie(t) });
    expect(r.statusCode).toBe(303);
    expect(r.headers.location).toContain("/settings/plan");
    expect(await planOf(t)).toBe("lifetime_1");
    // The callback with no code just says it is alive.
    expect((await app.inject({ method: "GET", url: "/appsumo/callback" })).json()).toEqual({ ok: true });
  });

  it("refuses a refunded or already-used code on the public page", async () => {
    if (!dbAvailable) return;
    await hook("purchase", K("P3"));
    await hook("deactivate", K("P3"));
    const r = await app.inject({ method: "GET", url: `/redeem?code=${K("P3")}` });
    expect(r.statusCode).toBe(400);
    expect(r.body).toContain("no longer active");
  });
});

describe("the billing mode", () => {
  it("defaults to both, shows the offer with a buy link, and lifetime-only removes the trial", async () => {
    if (!dbAvailable) return;
    const admin = await newTenant({ email: ADMIN_EMAIL });
    const get = async () => (await app.inject({ method: "GET", url: "/v1/admin/lifetime", cookies: cookie(admin) })).json();
    expect((await get()).mode).toBe("both");

    process.env.APPSUMO_BUY_URL = "https://appsumo.com/products/loomail-test";
    const both = await app.inject({ method: "GET", url: "/pricing" });
    expect(both.body).toContain("Prefer to pay once?");
    expect(both.body).toContain("https://appsumo.com/products/loomail-test");
    expect(both.body).toContain("Start 7-day free trial");

    const set = await app.inject({
      method: "PUT",
      url: "/v1/admin/lifetime/settings",
      cookies: cookie(admin),
      payload: { mode: "lifetime", cap: 50, reason: "AppSumo launch" },
      headers: { "content-type": "application/json" },
    });
    expect(set.statusCode, set.body).toBe(200);
    expect(set.json().spots.cap).toBe(50);

    const only = await app.inject({ method: "GET", url: "/pricing" });
    expect(only.body).toContain("Pay once. Use it forever.");
    expect(only.body).toContain("Lifetime");
    expect(only.body).not.toContain("Lifetime Tier");
    expect(only.body.match(/<div class="plan-card/g)).toHaveLength(1);
    expect(only.body).not.toContain("Start 7-day free trial");
    expect(only.body).toContain("Get the lifetime deal");
    expect((await app.inject({ method: "GET", url: "/signup" })).body).toContain("Create your account");

    // A new workspace gets no trial and no plan: it waits for a licence.
    const email = `ltd-signup-${Date.now()}@ltd.example`;
    const signup = await app.inject({
      method: "POST",
      url: "/signup",
      remoteAddress: "10.77.7.7",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ workspace: "Lifetime Co " + sfx, email, terms: "yes" }).toString(),
    });
    expect(signup.statusCode, signup.body).toBe(200);
    const created = await q<{ plan: string; trial_ends_at: Date | null; slug: string }>(
      sql`SELECT t.plan, t.trial_ends_at, t.slug FROM tenants t JOIN users u ON u.tenant_id = t.id WHERE u.email = ${email}`,
    );
    expect(created[0]).toMatchObject({ plan: "free", trial_ends_at: null });
    await db.execute(sql`UPDATE tenants SET slug = ${"ltd-" + created[0]!.slug} WHERE slug = ${created[0]!.slug}`);

    // Card checkout is closed in this mode.
    const holder = await newTenant({ plan: "trial" });
    const checkout = await app.inject({ method: "POST", url: "/v1/billing/checkout", cookies: cookie(holder), payload: { plan: "essential", interval: "monthly" }, headers: { "content-type": "application/json" } });
    expect([400, 503]).toContain(checkout.statusCode);

    const bad = await app.inject({ method: "PUT", url: "/v1/admin/lifetime/settings", cookies: cookie(admin), payload: { mode: "nonsense", reason: "x" }, headers: { "content-type": "application/json" } });
    expect(bad.statusCode).toBe(400);
    delete process.env.APPSUMO_BUY_URL;
  });

  it("counts spots without the replaced or refunded, and no offer shows until a buy link is set", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    await hook("purchase", K("S1"));
    await hook("purchase", K("S2"));
    await redeem(t, K("S1"));
    await hook("upgrade", K("S3"), { tier: 2, prev: K("S1") });
    const admin = await newTenant({ email: ADMIN_EMAIL });
    const o = (await app.inject({ method: "GET", url: "/v1/admin/lifetime", cookies: cookie(admin) })).json();
    // S2 (bought) + S3 (the upgrade); S1 is superseded and does not count twice.
    expect(o.spots.sold).toBe(2);
    expect((await app.inject({ method: "GET", url: "/pricing" })).body).not.toContain("Prefer to pay once?");
  });
});
