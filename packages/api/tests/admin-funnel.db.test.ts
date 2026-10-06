/**
 * Integration tests for the admin signup funnel: who may read it, what each stage counts,
 * which workspaces are in the cohort, and the derived numbers (biggest drop, median time,
 * stalled).
 *
 * The counting tests call the loader with a "now" in 2040, and put every test workspace
 * just before it, so workspaces other test files create in real time can never fall in the
 * window. Needs a reachable Postgres via DATABASE_URL. Test tenants have slugs starting "funnel-t-".
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { tenantTablesInDeleteOrder } from "@mailforge/db/purge";
import { buildApp } from "../src/index.js";
import { SESSION_COOKIE_NAME } from "../src/routes/auth.js";
import { biggestDrop, goalCounts, loadOnboardingFunnel, parseFunnelWindow, type FunnelStageId } from "../src/admin/funnel.js";

const TEST_DB_URL = process.env.DATABASE_URL;
if (!TEST_DB_URL) throw new Error("[admin-funnel.test] DATABASE_URL is not set.");

const HOUR = 3_600_000;
const NOW = new Date("2040-01-15T12:00:00Z");
const ago = (h: number) => new Date(NOW.getTime() - h * HOUR);
const ADMIN_EMAIL = "boss@funnel-t.example";

let pool: pg.Pool;
let db: ReturnType<typeof drizzle>;
let dbAvailable = false;
let app: FastifyInstance;

async function q<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  return (await db.execute(query)).rows as T[];
}

let counter = 0;
interface Opts {
  createdHoursAgo?: number;
  signup?: boolean;
  loggedIn?: boolean;
  address?: boolean;
  transport?: boolean;
  managed?: boolean;
  flow?: boolean;
  event?: boolean;
  /** Hours after signup the first email was sent. */
  firstEmailAfterH?: number;
  plan?: string;
  onboarding?: Record<string, unknown>;
  goal?: string;
}
async function newTenant(o: Opts = {}): Promise<string> {
  const slug = `funnel-t-${Date.now()}-${counter++}`;
  const created = ago(o.createdHoursAgo ?? 48);
  const settings: Record<string, unknown> = {};
  if (o.signup !== false) settings.signup = { plan_interest: "growth", ...(o.goal ? { goal: o.goal } : {}) };
  if (o.address) settings.postal_address = "1 Main St";
  if (o.onboarding) settings.onboarding = o.onboarding;
  const [t] = await q<{ id: string }>(sql`
    INSERT INTO tenants (name, slug, plan, settings, created_at)
    VALUES (${slug}, ${slug}, ${o.plan ?? "trial"}, ${JSON.stringify(settings)}::jsonb, ${created.toISOString()}::timestamptz) RETURNING id`);
  const id = t!.id;
  await db.execute(sql`INSERT INTO users (tenant_id, email, role, last_login_at) VALUES (${id}::uuid, ${slug + "@funnel-t.example"}, 'owner', ${o.loggedIn ? created.toISOString() : null})`);
  if (o.transport) await db.execute(sql`INSERT INTO transport_configs (tenant_id, provider, config, is_active, from_email) VALUES (${id}::uuid, 'resend', '{}'::jsonb, true, 'a@b.example')`);
  if (o.managed) await db.execute(sql`INSERT INTO managed_sending (tenant_id, enabled) VALUES (${id}::uuid, true)`);
  let flowId: string | null = null;
  if (o.flow || o.firstEmailAfterH !== undefined) {
    const [f] = await q<{ id: string }>(sql`INSERT INTO flows (tenant_id, name, trigger_type, trigger_config, steps, status) VALUES (${id}::uuid, 'F', 'event', '{}'::jsonb, '[]'::jsonb, ${o.flow ? "active" : "draft"}) RETURNING id`);
    flowId = f!.id;
  }
  if (o.event || o.firstEmailAfterH !== undefined) {
    const [c] = await q<{ id: string }>(sql`INSERT INTO contacts (tenant_id, external_id, email, lifecycle_state) VALUES (${id}::uuid, 'c', 'c@p.example', 'engaged') RETURNING id`);
    if (o.event) await db.execute(sql`INSERT INTO events (tenant_id, contact_id, type, event_name, timestamp) VALUES (${id}::uuid, ${c!.id}::uuid, 'track', 'signed_up', ${created.toISOString()}::timestamptz)`);
    if (o.firstEmailAfterH !== undefined) {
      const [m] = await q<{ id: string }>(sql`INSERT INTO flow_memberships (tenant_id, contact_id, flow_id, entered_at) VALUES (${id}::uuid, ${c!.id}::uuid, ${flowId}::uuid, now()) RETURNING id`);
      const sent = new Date(created.getTime() + o.firstEmailAfterH * HOUR).toISOString();
      await db.execute(sql`INSERT INTO lifecycle_messages (tenant_id, contact_id, flow_id, membership_id, status, subject, sent_at) VALUES (${id}::uuid, ${c!.id}::uuid, ${flowId}::uuid, ${m!.id}::uuid, 'sent', 'Hi', ${sent}::timestamptz)`);
    }
  }
  return id;
}

async function cleanup(): Promise<void> {
  const ids = (await q<{ id: string }>(sql`SELECT id FROM tenants WHERE slug LIKE 'funnel-t-%'`)).map((r) => r.id);
  for (const id of ids) {
    for (const t of await db.transaction(async (tx) => tenantTablesInDeleteOrder(tx as never))) {
      await db.execute(sql.raw(`DELETE FROM "${t}" WHERE tenant_id = '${id}'`));
    }
    await db.execute(sql`DELETE FROM tenants WHERE id = ${id}::uuid`);
  }
}

const funnel = (days: 7 | 30 | 90 = 30) => loadOnboardingFunnel(db as never, days, NOW);
const count = (f: Awaited<ReturnType<typeof funnel>>, id: FunnelStageId) => f.stages.find((s) => s.id === id)!.count;

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: TEST_DB_URL, connectionTimeoutMillis: 3000 });
  try {
    await pool.query("SELECT 1");
    db = drizzle(pool);
    dbAvailable = true;
  } catch (err) {
    if (process.env.CI === "true") throw new Error(`[admin-funnel.test] DATABASE_URL not reachable in CI: ${(err as Error).message}`);
    console.warn("[admin-funnel.test] DATABASE_URL not reachable - tests skipped.");
    return;
  }
  await cleanup();
  process.env.MAILFORGE_PLATFORM_ADMINS = ADMIN_EMAIL;
  app = await buildApp({ logger: false, db, baseUrl: "http://localhost:3000", dashboardUrl: "http://localhost:3000" });
});
afterEach(async () => {
  if (dbAvailable) await cleanup();
});
afterAll(async () => {
  delete process.env.MAILFORGE_PLATFORM_ADMINS;
  if (app) await app.close();
  await pool?.end();
});

const it_ = (name: string, fn: () => Promise<void>) => it(name, async () => (dbAvailable ? fn() : undefined));

// ---------------------------------------------------------------------------

describe("parseFunnelWindow", () => {
  it("defaults to 30 and accepts 7, 30 and 90", () => {
    expect(parseFunnelWindow(undefined)).toBe(30);
    expect(parseFunnelWindow("")).toBe(30);
    for (const d of [7, 30, 90]) expect(parseFunnelWindow(String(d))).toBe(d);
  });
  it("refuses anything else", () => {
    for (const bad of ["1", "0", "-7", "abc", "30.5", "365", "7; drop table tenants"]) expect(parseFunnelWindow(bad)).toBeNull();
  });
});

describe("biggestDrop", () => {
  const mk = (counts: number[]) => ["signed_up", "signed_in", "address", "sender", "flow", "event", "first_email"].map((id, i) => ({ id: id as FunnelStageId, count: counts[i]! }));
  it("finds the largest loss between neighbouring stages", () => {
    expect(biggestDrop(mk([100, 90, 40, 38, 30, 20, 10]))).toEqual({ from: "signed_in", to: "address", lost: 50 });
  });
  it("ignores stages that grow, since stages are counted independently", () => {
    expect(biggestDrop(mk([10, 10, 5, 8, 8, 8, 8]))).toEqual({ from: "signed_in", to: "address", lost: 5 });
  });
  it("prefers the earlier stage on a tie", () => {
    expect(biggestDrop(mk([10, 5, 0, 0, 0, 0, 0]))).toEqual({ from: "signed_up", to: "signed_in", lost: 5 });
  });
  it("is null when nothing is lost or the cohort is empty", () => {
    expect(biggestDrop(mk([4, 4, 4, 4, 4, 4, 4]))).toBeNull();
    expect(biggestDrop(mk([0, 0, 0, 0, 0, 0, 0]))).toBeNull();
  });
});

describe("loadOnboardingFunnel", () => {
  it_("counts each stage from what is in the workspace", async () => {
    await newTenant({}); // signed up only
    await newTenant({ loggedIn: true });
    await newTenant({ loggedIn: true, address: true, transport: true });
    await newTenant({ loggedIn: true, address: true, managed: true, flow: true, event: true, firstEmailAfterH: 3, plan: "growth" });
    const f = await funnel();
    expect(f.cohort).toBe(4);
    expect(count(f, "signed_up")).toBe(4);
    expect(count(f, "signed_in")).toBe(3);
    expect(count(f, "address")).toBe(2);
    expect(count(f, "sender")).toBe(2);
    expect(count(f, "flow")).toBe(1);
    expect(count(f, "event")).toBe(1);
    expect(count(f, "first_email")).toBe(1);
    expect(count(f, "paid")).toBe(1);
    expect(f.stages.map((s) => s.percent)).toEqual([100, 75, 50, 50, 25, 25, 25, 25]);
    expect(f.biggest_drop).toEqual({ from: "signed_up", to: "signed_in", lost: 1 }); // every drop is 1; ties go to the earlier stage
  });

  it_("does not count an inactive transport, a disabled managed row, a draft flow or an unsent message", async () => {
    const id = await newTenant({ loggedIn: true, firstEmailAfterH: 1 });
    await db.execute(sql`UPDATE lifecycle_messages SET status = 'approved' WHERE tenant_id = ${id}::uuid`);
    await db.execute(sql`INSERT INTO transport_configs (tenant_id, provider, config, is_active, from_email) VALUES (${id}::uuid, 'resend', '{}'::jsonb, false, 'a@b.example')`);
    await db.execute(sql`INSERT INTO managed_sending (tenant_id, enabled) VALUES (${id}::uuid, false)`);
    const f = await funnel();
    expect(count(f, "sender")).toBe(0);
    expect(count(f, "flow")).toBe(0);
    expect(count(f, "first_email")).toBe(0);
  });

  it_("leaves out workspaces that did not come through signup", async () => {
    await newTenant({ signup: false, loggedIn: true });
    await newTenant({});
    expect((await funnel()).cohort).toBe(1);
  });

  it_("honours the window: older workspaces drop out of 7 days but stay in 90", async () => {
    await newTenant({ createdHoursAgo: 24 * 3 });
    await newTenant({ createdHoursAgo: 24 * 20 });
    await newTenant({ createdHoursAgo: 24 * 60 });
    await newTenant({ createdHoursAgo: 24 * 120 });
    expect((await funnel(7)).cohort).toBe(1);
    expect((await funnel(30)).cohort).toBe(2);
    expect((await funnel(90)).cohort).toBe(3);
  });

  it_("reports an empty cohort as zeros, not an error", async () => {
    const f = await funnel();
    expect(f.cohort).toBe(0);
    expect(f.stages.every((s) => s.count === 0 && s.percent === 0)).toBe(true);
    expect(f.biggest_drop).toBeNull();
    expect(f.median_hours_to_first_email).toBeNull();
    expect(f.stalled).toBe(0);
  });

  it_("takes the median hours to the first email, from the earliest sent message", async () => {
    await newTenant({ loggedIn: true, firstEmailAfterH: 1 });
    await newTenant({ loggedIn: true, firstEmailAfterH: 3 });
    await newTenant({ loggedIn: true, firstEmailAfterH: 11 });
    await newTenant({ loggedIn: true }); // never got one: not part of the median
    expect((await funnel()).median_hours_to_first_email).toBe(3);
    const id = await newTenant({ loggedIn: true, firstEmailAfterH: 5 });
    await db.execute(sql`INSERT INTO lifecycle_messages (tenant_id, contact_id, flow_id, membership_id, status, subject, sent_at)
      SELECT tenant_id, contact_id, flow_id, membership_id, 'sent', 'Later', sent_at + interval '40 hours' FROM lifecycle_messages WHERE tenant_id = ${id}::uuid LIMIT 1`);
    expect((await funnel()).median_hours_to_first_email).toBe(4); // earliest of that workspace is still 5h; median of 1,3,5,11 = 4
  });

  it_("counts stalled: signed in, no first email, over a day old, not set aside", async () => {
    await newTenant({ loggedIn: true, createdHoursAgo: 48 }); // stalled
    await newTenant({ loggedIn: true, createdHoursAgo: 12 }); // too new
    await newTenant({ createdHoursAgo: 48 }); // never signed in
    await newTenant({ loggedIn: true, createdHoursAgo: 48, firstEmailAfterH: 2 }); // got there
    await newTenant({ loggedIn: true, createdHoursAgo: 48, onboarding: { dismissed_at: "2040-01-14T00:00:00Z" } }); // set aside
    const f = await funnel();
    expect(f.stalled).toBe(1);
    expect(f.set_aside).toBe(1);
  });

  it_("counts workspaces that got a reminder, once each however many", async () => {
    await newTenant({ loggedIn: true, onboarding: { nudge_count: 2 } });
    await newTenant({ loggedIn: true, onboarding: { nudge_count: 1 } });
    await newTenant({ loggedIn: true, onboarding: { nudge_count: 0 } });
    await newTenant({ loggedIn: true });
    expect((await funnel()).nudged).toBe(2);
  });
});

describe("GET /v1/admin/funnel", () => {
  const admin = async () => {
    const slug = `funnel-t-admin-${Date.now()}-${counter++}`;
    const [t] = await q<{ id: string }>(sql`INSERT INTO tenants (name, slug, plan) VALUES (${slug}, ${slug}, 'free') RETURNING id`);
    const [u] = await q<{ id: string }>(sql`INSERT INTO users (tenant_id, email, role) VALUES (${t!.id}::uuid, ${ADMIN_EMAIL}, 'owner') RETURNING id`);
    const [s] = await q<{ id: string }>(sql`INSERT INTO sessions (tenant_id, user_id, expires_at) VALUES (${t!.id}::uuid, ${u!.id}::uuid, now() + interval '1 day') RETURNING id`);
    return { [SESSION_COOKIE_NAME]: s!.id };
  };
  const ordinary = async () => {
    const slug = `funnel-t-user-${Date.now()}-${counter++}`;
    const [t] = await q<{ id: string }>(sql`INSERT INTO tenants (name, slug, plan) VALUES (${slug}, ${slug}, 'free') RETURNING id`);
    const [u] = await q<{ id: string }>(sql`INSERT INTO users (tenant_id, email, role) VALUES (${t!.id}::uuid, ${slug + "@funnel-t.example"}, 'owner') RETURNING id`);
    const [s] = await q<{ id: string }>(sql`INSERT INTO sessions (tenant_id, user_id, expires_at) VALUES (${t!.id}::uuid, ${u!.id}::uuid, now() + interval '1 day') RETURNING id`);
    return { [SESSION_COOKIE_NAME]: s!.id };
  };

  it_("answers 404 to everyone who is not a platform admin, and 401 without a session", async () => {
    expect((await app.inject({ method: "GET", url: "/v1/admin/funnel" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/v1/admin/funnel", cookies: await ordinary() })).statusCode).toBe(404);
  });

  it_("returns the funnel to an admin, 30 days by default", async () => {
    const r = await app.inject({ method: "GET", url: "/v1/admin/funnel", cookies: await admin() });
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b.days).toBe(30);
    expect(b.stages.map((s: { id: string }) => s.id)).toEqual(["signed_up", "signed_in", "address", "sender", "flow", "event", "first_email", "paid"]);
    expect(typeof b.cohort).toBe("number");
  });

  it_("accepts 7 and 90 and refuses other windows", async () => {
    const c = await admin();
    expect((await app.inject({ method: "GET", url: "/v1/admin/funnel?days=7", cookies: c })).json().days).toBe(7);
    expect((await app.inject({ method: "GET", url: "/v1/admin/funnel?days=90", cookies: c })).json().days).toBe(90);
    expect((await app.inject({ method: "GET", url: "/v1/admin/funnel?days=365", cookies: c })).statusCode).toBe(400);
  });

  it_("exposes counts only: no workspace names, emails or message content", async () => {
    await newTenant({ loggedIn: true, firstEmailAfterH: 1 });
    const body = (await app.inject({ method: "GET", url: "/v1/admin/funnel", cookies: await admin() })).body;
    expect(body).not.toContain("funnel-t-");
    expect(body).not.toContain("@");
  });
});

describe("signup goals in the funnel", () => {
  it("goalCounts adds the skipped ones as none and never goes negative", () => {
    expect(goalCounts(10, { welcome: 3, convert_trials: 2, upgrade_free: 1, explore: 0 })).toEqual({ welcome: 3, convert_trials: 2, upgrade_free: 1, explore: 0, none: 4 });
    expect(goalCounts(2, { welcome: 3, convert_trials: 0, upgrade_free: 0, explore: 0 }).none).toBe(0);
  });

  it_("counts what the cohort asked for, with skipped as none", async () => {
    await newTenant({ goal: "welcome" });
    await newTenant({ goal: "convert_trials" });
    await newTenant({ goal: "convert_trials" });
    await newTenant({ goal: "upgrade_free" });
    await newTenant({});
    await newTenant({ signup: false });
    await newTenant({ goal: "bogus" });
    const f = await funnel();
    expect(f.goals).toEqual({ welcome: 1, convert_trials: 2, upgrade_free: 1, explore: 0, none: 2 });
    expect(f.cohort).toBe(6);
  });
});
