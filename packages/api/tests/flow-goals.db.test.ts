/**
 * Flow goals through the API: setting one, and the results the dashboard reads.
 *
 * Covers: create/patch/remove a goal and its validation, the goal coming back on the flow, that a goal does not
 * need the flow to be recompiled, GET /v1/flows/:id/results (counts, rate, median time, per-email numbers, the
 * days window, tenant isolation) and the conversion numbers in GET /v1/flows/stats.
 *
 * Requires local Postgres (see flows.db.test.ts for DATABASE_URL).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { sql } from "drizzle-orm";
import { buildApp } from "../src/index.js";
import { tenants, users, sessions, contacts, flows, flowMemberships, flowConversions, lifecycleMessages } from "@loomail/db/schema";

const TEST_DB_URL = process.env.DATABASE_URL;
if (!TEST_DB_URL) throw new Error("[flow-goals.test] DATABASE_URL is not set (see flows.db.test.ts).");

const SLUG_A = "test-flow-goals-a";
const SLUG_B = "test-flow-goals-b";
const DAY = 86_400_000;
const HOUR = 3_600_000;

let pool: pg.Pool;
let db: ReturnType<typeof drizzle>;
let dbAvailable = false;
let tenantA: string;
let tenantB: string;
let cookieA: string;
let cookieB: string;

async function wipe() {
  for (const table of ["flow_conversions", "templates", "lifecycle_messages", "flow_memberships", "contacts", "flows", "sessions", "users"]) {
    await db.execute(sql.raw(`DELETE FROM ${table} WHERE tenant_id IN (SELECT id FROM tenants WHERE slug IN ('${SLUG_A}', '${SLUG_B}'))`));
  }
  await db.execute(sql.raw(`DELETE FROM tenants WHERE slug IN ('${SLUG_A}', '${SLUG_B}')`));
}

async function mkTenant(slug: string) {
  const [t] = await db.insert(tenants).values({ name: slug, slug, plan: "free" }).returning({ id: tenants.id });
  const [u] = await db.insert(users).values({ tenantId: t!.id, email: `owner@${slug}.test`, role: "owner" }).returning({ id: users.id });
  const [s] = await db.insert(sessions).values({ tenantId: t!.id, userId: u!.id, expiresAt: new Date(Date.now() + DAY) }).returning({ id: sessions.id });
  return { id: t!.id, cookie: `loomail_session=${s!.id}` };
}

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: TEST_DB_URL, connectionTimeoutMillis: 3000 });
  try {
    await pool.query("SELECT 1");
    db = drizzle(pool);
    dbAvailable = true;
  } catch {
    console.warn("[flow-goals.test] DATABASE_URL not reachable - tests skipped.");
    return;
  }
  await wipe();
  const a = await mkTenant(SLUG_A);
  const b = await mkTenant(SLUG_B);
  tenantA = a.id;
  cookieA = a.cookie;
  tenantB = b.id;
  cookieB = b.cookie;
});

afterAll(async () => {
  if (dbAvailable) await wipe();
  await pool.end();
});

const goal = (over: Record<string, unknown> = {}) => ({
  name: "Created a project",
  condition: { field: "event", name: "project_created", op: "performed", since: "flow" },
  ...over,
});

const flowBody = (over: Record<string, unknown> = {}) => ({
  name: "Goal flow",
  trigger_type: "event",
  trigger_config: { event: "signed_up" },
  steps: [],
  ...over,
});

describe("setting a goal", () => {
  it("create with a goal: defaults fill in and the goal comes back", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });
    const res = await app.inject({ method: "POST", url: "/v1/flows", headers: { cookie: cookieA }, payload: flowBody({ goal: goal() }) });
    expect(res.statusCode).toBe(201);
    expect(res.json().goal).toEqual({ ...goal(), window_days: 30, exit_on_conversion: true });
  });

  it("a flow without a goal returns goal null", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });
    const res = await app.inject({ method: "POST", url: "/v1/flows", headers: { cookie: cookieA }, payload: flowBody() });
    expect(res.json().goal).toBeNull();
  });

  it("patch sets, changes and removes a goal without touching the rest of the flow", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });
    const created = (await app.inject({ method: "POST", url: "/v1/flows", headers: { cookie: cookieA }, payload: flowBody({ name: "Patch goal" }) })).json();
    const patch = (payload: unknown) => app.inject({ method: "PATCH", url: `/v1/flows/${created.id}`, headers: { cookie: cookieA }, payload: payload as never });

    const set = await patch({ goal: goal({ window_days: 14, exit_on_conversion: false }) });
    expect(set.statusCode).toBe(200);
    expect(set.json().goal).toMatchObject({ name: "Created a project", window_days: 14, exit_on_conversion: false });
    expect(set.json().name).toBe("Patch goal");

    const renamed = await patch({ goal: goal({ name: "Made a project" }) });
    expect(renamed.json().goal.name).toBe("Made a project");

    const other = await patch({ description: "unrelated edit" });
    expect(other.json().goal.name).toBe("Made a project"); // untouched by an edit that does not mention it

    const removed = await patch({ goal: null });
    expect(removed.statusCode).toBe(200);
    expect(removed.json().goal).toBeNull();
  });

  it("can be changed on an active flow, and does not clear the compiled plan", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });
    const created = (await app.inject({ method: "POST", url: "/v1/flows", headers: { cookie: cookieA }, payload: flowBody({ name: "Active goal", content_mode: "fixed_content" }) })).json();
    await app.inject({
      method: "POST",
      url: `/v1/flows/${created.id}/plan`,
      headers: { cookie: cookieA },
      payload: { steps: [{ order: 1, delay: "0m", action_type: "nurture_value", window_policy: "immediate", subject: "Hi", body_html: "<p>Hi</p>" }] },
    });
    await db.execute(sql`UPDATE flows SET status = 'active' WHERE id = ${created.id}::uuid`);
    const before = (await app.inject({ method: "GET", url: `/v1/flows/${created.id}`, headers: { cookie: cookieA } })).json();
    const res = await app.inject({ method: "PATCH", url: `/v1/flows/${created.id}`, headers: { cookie: cookieA }, payload: { goal: goal() } });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("active");
    expect(res.json().compiled_plan).toEqual(before.compiled_plan);
    expect(res.json().compile_status).toBe(before.compile_status);
  });

  it("refuses a goal that is not valid, naming the problem", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });
    const bad: Array<[string, unknown, RegExp]> = [
      ["empty name", goal({ name: "  " }), /name/i],
      ["name too long", goal({ name: "x".repeat(81) }), /80/],
      ["no condition", { name: "x" }, /condition/i],
      ["a condition the engine does not know", goal({ condition: { favourite_colour: "red" } }), /./],
      ["window 0", goal({ window_days: 0 }), /./],
      ["window over 90", goal({ window_days: 91 }), /./],
      ["window not whole", goal({ window_days: 2.5 }), /./],
      ["exit flag not boolean", goal({ exit_on_conversion: "yes" }), /./],
      ["an unknown key", goal({ extra: 1 }), /./],
    ];
    for (const [label, g, message] of bad) {
      const res = await app.inject({ method: "POST", url: "/v1/flows", headers: { cookie: cookieA }, payload: flowBody({ goal: g }) });
      expect(res.statusCode, label).toBe(400);
      expect(JSON.stringify(res.json().issues), label).toMatch(message);
    }
  });

  it("accepts the limits: a 1-day and a 90-day window", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });
    for (const days of [1, 90]) {
      const res = await app.inject({ method: "POST", url: "/v1/flows", headers: { cookie: cookieA }, payload: flowBody({ goal: goal({ window_days: days }) }) });
      expect(res.statusCode, String(days)).toBe(201);
    }
  });
});

describe("GET /v1/flows/:id/results and the stats", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let flowId: string;

  /** A flow with 5 people who entered: 2 converted (after 1h and 3h), 3 did not. Email 1 went to 5, email 2 to 3. */
  beforeAll(async () => {
    if (!dbAvailable) return;
    app = await buildApp({ db, logger: false });
    const [f] = await db
      .insert(flows)
      .values({ tenantId: tenantA, name: "Results flow", triggerType: "event", triggerConfig: { event: "signed_up" }, steps: [], status: "active", goal: { ...goal(), window_days: 30, exit_on_conversion: true } })
      .returning({ id: flows.id });
    flowId = f!.id;
    const now = Date.now();
    const people: Array<{ convertedAfterMs: number | null; emails: number[]; enteredAgoMs?: number }> = [
      { convertedAfterMs: HOUR, emails: [1] },
      { convertedAfterMs: 3 * HOUR, emails: [1, 2] },
      { convertedAfterMs: null, emails: [1, 2] },
      { convertedAfterMs: null, emails: [1, 2] },
      { convertedAfterMs: null, emails: [1] },
      { convertedAfterMs: HOUR, emails: [1], enteredAgoMs: 60 * DAY }, // old: outside a 30-day view
    ];
    let n = 0;
    for (const p of people) {
      const entered = new Date(now - (p.enteredAgoMs ?? 5 * DAY));
      const [c] = await db.insert(contacts).values({ tenantId: tenantA, externalId: `r-${++n}`, lifecycleState: "engaged", firstSeenAt: entered, lastSeenAt: entered }).returning({ id: contacts.id });
      const [m] = await db
        .insert(flowMemberships)
        .values({ tenantId: tenantA, contactId: c!.id, flowId, currentStep: 1, status: "completed", enteredAt: entered, completedAt: entered })
        .returning({ id: flowMemberships.id });
      for (const order of p.emails) {
        await db.insert(lifecycleMessages).values({ tenantId: tenantA, contactId: c!.id, flowId, membershipId: m!.id, flowStepOrder: order, status: "sent", brainActionType: "nurture_value", sentAt: entered });
      }
      if (p.convertedAfterMs !== null) {
        await db.insert(flowConversions).values({ tenantId: tenantA, flowId, contactId: c!.id, membershipId: m!.id, goalName: "Created a project", convertedAt: new Date(entered.getTime() + p.convertedAfterMs) });
      }
    }
  });

  const results = (id: string, query = "", cookie = cookieA) => app.inject({ method: "GET", url: `/v1/flows/${id}/results${query}`, headers: { cookie } });

  it("counts who entered and who converted, with the rate and the median time", async () => {
    if (!dbAvailable) return;
    const res = await results(flowId);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.range_days).toBe(30);
    expect(body.entered).toBe(5);
    expect(body.converted).toBe(2);
    expect(body.conversion_rate).toBeCloseTo(0.4, 5);
    expect(body.median_hours_to_convert).toBe(2); // between 1h and 3h
    expect(body.goal).toMatchObject({ name: "Created a project" });
  });

  it("says, for each email, how many were sent it and how many of those converted", async () => {
    if (!dbAvailable) return;
    const body = (await results(flowId)).json();
    expect(body.by_step).toEqual([
      { step: 1, sent: 5, converted: 2 },
      { step: 2, sent: 3, converted: 1 },
    ]);
  });

  it("a wider window includes older entries", async () => {
    if (!dbAvailable) return;
    const body = (await results(flowId, "?days=90")).json();
    expect(body.entered).toBe(6);
    expect(body.converted).toBe(3);
    expect(body.range_days).toBe(90);
  });

  it("a flow with no goal and no entries gives zeros and a null rate, not an error", async () => {
    if (!dbAvailable) return;
    const [f] = await db.insert(flows).values({ tenantId: tenantA, name: "Empty", triggerType: "event", triggerConfig: { event: "x" }, steps: [], status: "draft" }).returning({ id: flows.id });
    const body = (await results(f!.id)).json();
    expect(body).toMatchObject({ goal: null, entered: 0, converted: 0, conversion_rate: null, median_hours_to_convert: null, by_step: [] });
  });

  it("validates the id and the days", async () => {
    if (!dbAvailable) return;
    expect((await results("not-a-uuid")).statusCode).toBe(400);
    for (const q of ["?days=0", "?days=366", "?days=abc", "?days=1.5"]) {
      expect((await results(flowId, q)).statusCode, q).toBe(400);
    }
    expect((await results(flowId, "?days=365")).statusCode).toBe(200);
    expect((await results(flowId, "?days=1")).statusCode).toBe(200);
  });

  it("404 for a flow that does not exist, and for another workspace's flow", async () => {
    if (!dbAvailable) return;
    expect((await results("00000000-0000-4000-8000-000000000000")).statusCode).toBe(404);
    expect((await results(flowId, "", cookieB)).statusCode).toBe(404);
  });

  it("needs a signed-in user", async () => {
    if (!dbAvailable) return;
    const res = await app.inject({ method: "GET", url: `/v1/flows/${flowId}/results` });
    expect([401, 403]).toContain(res.statusCode);
  });

  it("the flows list stats carry the 30-day conversion numbers and whether the flow has a goal", async () => {
    if (!dbAvailable) return;
    const res = await app.inject({ method: "GET", url: "/v1/flows/stats", headers: { cookie: cookieA } });
    expect(res.statusCode).toBe(200);
    const s = res.json().stats[flowId];
    expect(s).toMatchObject({ has_goal: true, entered_30d: 5, converted_30d: 2 });
  });

  it("another workspace's stats do not include these conversions", async () => {
    if (!dbAvailable) return;
    const res = await app.inject({ method: "GET", url: "/v1/flows/stats", headers: { cookie: cookieB } });
    expect(res.json().stats[flowId]).toBeUndefined();
    expect(tenantB).toBeDefined();
  });
});
