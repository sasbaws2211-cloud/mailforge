/**
 * Random splits (A/B tests and holdouts) through the API: saving a plan that has one, and the per-version results.
 *
 * Requires local Postgres (see flows.db.test.ts for DATABASE_URL).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { sql } from "drizzle-orm";
import { buildApp } from "../src/index.js";
import { tenants, users, sessions, contacts, flows, flowMemberships, flowConversions, flowSplitChoices, lifecycleMessages } from "@loomail/db/schema";

const TEST_DB_URL = process.env.DATABASE_URL;
if (!TEST_DB_URL) throw new Error("[flow-splits.test] DATABASE_URL is not set (see flows.db.test.ts).");

const SLUG_A = "test-flow-splits-a";
const SLUG_B = "test-flow-splits-b";
const DAY = 86_400_000;

let pool: pg.Pool;
let db: ReturnType<typeof drizzle>;
let dbAvailable = false;
let tenantA: string;
let cookieA: string;
let cookieB: string;
let app: Awaited<ReturnType<typeof buildApp>>;

async function wipe() {
  for (const table of ["flow_split_choices", "flow_conversions", "templates", "lifecycle_messages", "flow_memberships", "contacts", "flows", "sessions", "users"]) {
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
    console.warn("[flow-splits.test] DATABASE_URL not reachable - tests skipped.");
    return;
  }
  await wipe();
  const a = await mkTenant(SLUG_A);
  const b = await mkTenant(SLUG_B);
  tenantA = a.id;
  cookieA = a.cookie;
  cookieB = b.cookie;
  app = await buildApp({ db, logger: false });
});

afterAll(async () => {
  if (dbAvailable) await wipe();
  await pool.end();
});

const goal = { name: "Created a project", condition: { field: "event", name: "project_created", op: "performed", since: "flow" }, window_days: 30, exit_on_conversion: true };

const mailStep = (order: number, next: number | "end") => ({ order, action_type: "nurture_value", delay: "0m", window_policy: "immediate", subject: `Email ${order}`, body_html: "<p>Hi</p>", next });

describe("saving a plan with a random split", () => {
  let flowId: string;
  const save = (payload: unknown) => app.inject({ method: "POST", url: `/v1/flows/${flowId}/plan`, headers: { cookie: cookieA }, payload: payload as never });

  beforeAll(async () => {
    if (!dbAvailable) return;
    const created = await app.inject({
      method: "POST",
      url: "/v1/flows",
      headers: { cookie: cookieA },
      payload: { name: "Plan splits", trigger_type: "event", trigger_config: { event: "signed_up" }, steps: [], content_mode: "fixed_content" },
    });
    flowId = created.json().id;
  });

  const body = (branch: Record<string, unknown>, steps = [mailStep(2, "end"), mailStep(3, "end")]) => ({ version: 2, steps, branches: [{ order: 1, delay: "0m", then: 2, else: 3, ...branch }] });

  it("saves an A/B split and keeps its percentage", async () => {
    if (!dbAvailable) return;
    const res = await save(body({ split: { percent_a: 70 } }));
    expect(res.statusCode).toBe(200);
    expect(res.json().compiled_plan.branches[0]).toMatchObject({ order: 1, split: { percent_a: 70 }, then: 2, else: 3 });
    expect(res.json().compiled_plan.branches[0].condition).toBeUndefined();
  });

  it("saves a holdout: 90 percent get the flow, the rest get nothing", async () => {
    if (!dbAvailable) return;
    const res = await save(body({ split: { percent_a: 90 }, else: "end" }, [mailStep(2, "end")]));
    expect(res.statusCode).toBe(200);
    expect(res.json().compiled_plan.branches[0]).toMatchObject({ split: { percent_a: 90 }, else: "end" });
  });

  it("refuses a percentage outside 1 to 99", async () => {
    if (!dbAvailable) return;
    for (const percent_a of [0, 100, 50.5, -1]) {
      const res = await save(body({ split: { percent_a } }));
      expect(res.statusCode, String(percent_a)).toBe(400);
    }
  });

  it("refuses a fork that has both a split and a condition, or neither", async () => {
    if (!dbAvailable) return;
    const both = await save(body({ split: { percent_a: 50 }, condition: { field: "payment_status", op: "is", value: "paid" } }));
    expect(both.statusCode).toBe(400);
    expect(JSON.stringify(both.json().issues)).toMatch(/one or the other/);
    const neither = await save(body({}));
    expect(neither.statusCode).toBe(400);
    expect(JSON.stringify(neither.json().issues)).toMatch(/condition, or a random split/);
  });

  it("refuses a split that is also a wait-until", async () => {
    if (!dbAvailable) return;
    const res = await save(body({ split: { percent_a: 50 }, early: true, delay: "3d" }));
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.json().issues)).toMatch(/wait-until/);
  });

  it("the usual rules still apply: a split into a loop is refused", async () => {
    if (!dbAvailable) return;
    const res = await save({ version: 2, steps: [mailStep(2, 1)], branches: [{ order: 1, delay: "0m", split: { percent_a: 50 }, then: 2, else: "end" }] });
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.json().issues)).toMatch(/loops back/);
  });
});

describe("GET /v1/flows/:id/results: split_tests", () => {
  /** Everything for one split: who was assigned which version, who converted, what was sent. */
  async function seed(opts: {
    tenant?: string;
    plan: unknown;
    withGoal?: boolean;
    node?: number;
    a: { n: number; converted: number; sentStep: number | null; opened?: number; clicked?: number };
    b: { n: number; converted: number; sentStep: number | null; opened?: number; clicked?: number };
    chosenAgoMs?: number;
    beforeSplitStep?: number; // an email sent to everyone before the split
  }) {
    const tenant = opts.tenant ?? tenantA;
    const node = opts.node ?? 1;
    const [f] = await db
      .insert(flows)
      .values({ tenantId: tenant, name: "split results", triggerType: "event", triggerConfig: { event: "x" }, steps: [], status: "active", compiledPlan: opts.plan, compileStatus: "ready", ...(opts.withGoal === false ? {} : { goal }) })
      .returning({ id: flows.id });
    const flowId = f!.id;
    const chosenAt = new Date(Date.now() - (opts.chosenAgoMs ?? 2 * DAY));
    let i = 0;
    for (const [version, v] of [["a", opts.a], ["b", opts.b]] as const) {
      for (let k = 0; k < v.n; k++) {
        const [c] = await db.insert(contacts).values({ tenantId: tenant, externalId: `s-${flowId}-${version}-${k}`, lifecycleState: "engaged", firstSeenAt: chosenAt, lastSeenAt: chosenAt }).returning({ id: contacts.id });
        const [m] = await db.insert(flowMemberships).values({ tenantId: tenant, contactId: c!.id, flowId, currentStep: 1, status: "completed", enteredAt: chosenAt, completedAt: chosenAt }).returning({ id: flowMemberships.id });
        await db.insert(flowSplitChoices).values({ tenantId: tenant, flowId, membershipId: m!.id, nodeOrder: node, version, chosenAt });
        if (k < v.converted) await db.insert(flowConversions).values({ tenantId: tenant, flowId, contactId: c!.id, membershipId: m!.id, goalName: "Created a project", convertedAt: new Date(chosenAt.getTime() + 3_600_000) });
        const messageAt = (step: number, feedback: string | null) =>
          db.insert(lifecycleMessages).values({ tenantId: tenant, contactId: c!.id, flowId, membershipId: m!.id, flowStepOrder: step, status: "sent", brainActionType: "nurture_value", sentAt: chosenAt, ...(feedback ? { feedback } : {}) });
        if (opts.beforeSplitStep !== undefined) await messageAt(opts.beforeSplitStep, null);
        if (v.sentStep !== null) await messageAt(v.sentStep, k < (v.clicked ?? 0) ? "clicked" : k < (v.opened ?? 0) ? "opened" : null);
        i++;
      }
    }
    return flowId;
  }

  const results = async (flowId: string, query = "", cookie = cookieA) => (await app.inject({ method: "GET", url: `/v1/flows/${flowId}/results${query}`, headers: { cookie } })).json();

  const abPlan = { version: 2, trigger: { type: "event", condition: {} }, steps: [{ order: 1, action_type: "x", delay: "0m", next: 2 }, { order: 3, action_type: "x", delay: "0m", next: "end" }, { order: 4, action_type: "x", delay: "0m", next: "end" }], branches: [{ order: 2, delay: "0m", split: { percent_a: 50 }, then: 3, else: 4 }] };

  it("counts who was assigned each version and who converted, and picks a clear winner", async () => {
    if (!dbAvailable) return;
    const flowId = await seed({ plan: abPlan, node: 2, a: { n: 60, converted: 12, sentStep: 3 }, b: { n: 60, converted: 24, sentStep: 4 } });
    const [t] = (await results(flowId)).split_tests;
    expect(t).toMatchObject({ node_order: 2, percent_a: 50, in_plan: true });
    expect(t.a).toMatchObject({ assigned: 60, converted: 12, holdout: false });
    expect(t.b).toMatchObject({ assigned: 60, converted: 24, holdout: false });
    expect(t.comparison.rate_a).toBeCloseTo(0.2, 6);
    expect(t.comparison.rate_b).toBeCloseTo(0.4, 6);
    expect(t.comparison.verdict).toBe("b_better");
    expect(t.comparison.p_value).toBeLessThan(0.05);
  });

  it("counts emails sent, opened and clicked for each version's own path only (not emails before the split)", async () => {
    if (!dbAvailable) return;
    const flowId = await seed({ plan: abPlan, node: 2, beforeSplitStep: 1, a: { n: 40, converted: 8, sentStep: 3, opened: 20, clicked: 5 }, b: { n: 40, converted: 8, sentStep: 4, opened: 30, clicked: 10 } });
    const [t] = (await results(flowId)).split_tests;
    // Email 1 went to all 80 before the split; it must not show up in either version.
    expect(t.a).toMatchObject({ sent: 40, opened: 20, clicked: 5 });
    expect(t.b).toMatchObject({ sent: 40, opened: 30, clicked: 10 });
  });

  it("a holdout is labelled, and compared with the people who got the flow", async () => {
    if (!dbAvailable) return;
    const plan = { version: 2, trigger: { type: "event", condition: {} }, steps: [{ order: 2, action_type: "x", delay: "0m", next: "end" }], branches: [{ order: 1, delay: "0m", split: { percent_a: 90 }, then: 2, else: "end" }] };
    const flowId = await seed({ plan, a: { n: 90, converted: 27, sentStep: 2 }, b: { n: 30, converted: 3, sentStep: null } });
    const [t] = (await results(flowId)).split_tests;
    expect(t.percent_a).toBe(90);
    expect(t.a.holdout).toBe(false);
    expect(t.b).toMatchObject({ assigned: 30, converted: 3, sent: 0, holdout: true });
    expect(t.comparison.verdict).toBe("a_better"); // 30% against 10%: emailing helped
  });

  it("says too early with few people, and no difference when it is close", async () => {
    if (!dbAvailable) return;
    const early = await seed({ plan: abPlan, node: 2, a: { n: 10, converted: 5, sentStep: 3 }, b: { n: 10, converted: 1, sentStep: 4 } });
    expect((await results(early)).split_tests[0].comparison.verdict).toBe("too_early");
    const close = await seed({ plan: abPlan, node: 2, a: { n: 200, converted: 40, sentStep: 3 }, b: { n: 200, converted: 44, sentStep: 4 } });
    expect((await results(close)).split_tests[0].comparison.verdict).toBe("no_difference");
  });

  it("with no goal there is no verdict, but opens and clicks are still counted", async () => {
    if (!dbAvailable) return;
    const flowId = await seed({ plan: abPlan, node: 2, withGoal: false, a: { n: 35, converted: 0, sentStep: 3, opened: 10 }, b: { n: 35, converted: 0, sentStep: 4, opened: 20 } });
    const [t] = (await results(flowId)).split_tests;
    expect(t.comparison).toBeNull();
    expect(t.a.opened).toBe(10);
    expect(t.b.opened).toBe(20);
  });

  it("only people assigned inside the window count, and a wider window includes more", async () => {
    if (!dbAvailable) return;
    const flowId = await seed({ plan: abPlan, node: 2, chosenAgoMs: 50 * DAY, a: { n: 40, converted: 10, sentStep: 3 }, b: { n: 40, converted: 20, sentStep: 4 } });
    expect((await results(flowId)).split_tests).toEqual([]);
    const wide = (await results(flowId, "?days=90")).split_tests[0];
    expect(wide.a.assigned).toBe(40);
  });

  it("a flow with no split has an empty list", async () => {
    if (!dbAvailable) return;
    const [f] = await db.insert(flows).values({ tenantId: tenantA, name: "plain", triggerType: "event", triggerConfig: { event: "x" }, steps: [], status: "draft" }).returning({ id: flows.id });
    expect((await results(f!.id)).split_tests).toEqual([]);
  });

  it("keeps the numbers after the split is edited out of the plan, marked as no longer in the plan", async () => {
    if (!dbAvailable) return;
    const flowId = await seed({ plan: abPlan, node: 2, a: { n: 40, converted: 10, sentStep: 3 }, b: { n: 40, converted: 20, sentStep: 4 } });
    await db.execute(sql`UPDATE flows SET compiled_plan = ${JSON.stringify({ steps: [{ order: 1, action_type: "x", delay: "0m" }] })}::jsonb WHERE id = ${flowId}::uuid`);
    const [t] = (await results(flowId)).split_tests;
    expect(t).toMatchObject({ node_order: 2, in_plan: false, percent_a: null });
    expect(t.a.assigned).toBe(40);
    expect(t.b.assigned).toBe(40);
  });

  it("is not shown to another workspace", async () => {
    if (!dbAvailable) return;
    const flowId = await seed({ plan: abPlan, node: 2, a: { n: 31, converted: 5, sentStep: 3 }, b: { n: 31, converted: 9, sentStep: 4 } });
    const res = await app.inject({ method: "GET", url: `/v1/flows/${flowId}/results`, headers: { cookie: cookieB } });
    expect(res.statusCode).toBe(404);
  });
});
