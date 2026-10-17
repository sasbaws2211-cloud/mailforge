/**
 * Conversions for people who have already left a flow (phaseGoalConversions).
 *
 * People still in a flow are covered by the advance-parity test. This covers finished and exited memberships
 * that convert later, inside the goal window: recorded once, never outside the window, never for a flow
 * without a goal or an archived one, and never counting what happened before the contact entered.
 *
 * Requires local Postgres (see enrollment.db.test.ts for DATABASE_URL).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { eq, sql } from "drizzle-orm";
import { tenants, contacts, events, flows, flowMemberships, flowConversions } from "@loomail/db/schema";
import { phaseGoalConversions } from "../src/scan-goal-conversions.js";

const TEST_DB_URL = process.env.DATABASE_URL;
if (!TEST_DB_URL) throw new Error("[scan-goal-conversions.test] DATABASE_URL is not set (see enrollment.db.test.ts).");

const SLUG = "test-goal-scan";
const OTHER = "test-goal-scan-other";
const DAY = 86_400_000;
const HOUR = 3_600_000;

let pool: pg.Pool;
let db: ReturnType<typeof drizzle>;
let dbAvailable = false;
let tenantId: string;
let otherTenantId: string;

const TABLES = ["flow_conversions", "lifecycle_messages", "flow_memberships", "flows", "events", "contacts"];

async function wipe() {
  for (const table of TABLES) {
    await db.execute(sql.raw(`DELETE FROM ${table} WHERE tenant_id IN (SELECT id FROM tenants WHERE slug IN ('${SLUG}', '${OTHER}'))`));
  }
}

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: TEST_DB_URL, connectionTimeoutMillis: 3000 });
  try {
    await pool.query("SELECT 1");
    db = drizzle(pool);
    dbAvailable = true;
  } catch {
    console.warn("[scan-goal-conversions.test] DATABASE_URL not reachable - tests skipped.");
    return;
  }
  await wipe();
  await db.execute(sql.raw(`DELETE FROM tenants WHERE slug IN ('${SLUG}', '${OTHER}')`));
  const [a] = await db.insert(tenants).values({ name: "Goal scan", slug: SLUG, plan: "free" }).returning({ id: tenants.id });
  const [b] = await db.insert(tenants).values({ name: "Goal scan other", slug: OTHER, plan: "free" }).returning({ id: tenants.id });
  tenantId = a!.id;
  otherTenantId = b!.id;
});

beforeEach(async () => {
  if (dbAvailable) await wipe();
});

afterAll(async () => {
  if (dbAvailable) {
    await wipe();
    await db.execute(sql.raw(`DELETE FROM tenants WHERE slug IN ('${SLUG}', '${OTHER}')`));
  }
  await pool.end();
});

const projectCreated = { field: "event", name: "project_created", op: "performed", since: "flow" };
const goalOf = (over: Record<string, unknown> = {}) => ({ name: "Created a project", condition: projectCreated, window_days: 30, exit_on_conversion: true, ...over });

interface Setup {
  goal?: unknown;
  flowStatus?: string;
  status?: string;
  enteredAgoMs?: number;
  events?: Array<[string, number]>;
  tenant?: string;
}

async function setup(o: Setup = {}) {
  const t = o.tenant ?? tenantId;
  const [contact] = await db
    .insert(contacts)
    .values({ tenantId: t, externalId: `c-${Math.random().toString(36).slice(2)}`, lifecycleState: "engaged", firstSeenAt: new Date(), lastSeenAt: new Date() })
    .returning({ id: contacts.id });
  const [flow] = await db
    .insert(flows)
    .values({
      tenantId: t,
      name: "goal flow",
      triggerType: "event",
      triggerConfig: { event: "signed_up" },
      steps: [],
      status: o.flowStatus ?? "active",
      goal: o.goal === undefined ? goalOf() : o.goal,
    })
    .returning({ id: flows.id });
  return addMembership(t, contact!.id, flow!.id, o);
}

async function addMembership(t: string, contactId: string, flowId: string, o: Setup) {
  const now = Date.now();
  const [m] = await db
    .insert(flowMemberships)
    .values({
      tenantId: t,
      contactId,
      flowId,
      currentStep: 1,
      status: o.status ?? "completed",
      enteredAt: new Date(now - (o.enteredAgoMs ?? 5 * DAY)),
      completedAt: new Date(now - 4 * DAY),
    })
    .returning({ id: flowMemberships.id });
  for (const [name, ago] of o.events ?? []) {
    await db.insert(events).values({ tenantId: t, contactId, type: "track", eventName: name, timestamp: new Date(now - ago) });
  }
  return { membershipId: m!.id, contactId, flowId };
}

const conversionsOf = (flowId: string) => db.select().from(flowConversions).where(eq(flowConversions.flowId, flowId));

describe("phaseGoalConversions", () => {
  it("records a conversion for someone who finished the flow and then reached the goal", async () => {
    if (!dbAvailable) return;
    const s = await setup({ events: [["project_created", DAY]] });
    const r = await phaseGoalConversions(db, new Date(), [tenantId, otherTenantId]);
    expect(r.conversionsRecorded).toBe(1);
    const rows = await conversionsOf(s.flowId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ membershipId: s.membershipId, contactId: s.contactId, goalName: "Created a project", tenantId });
  });

  it("records it once however many scans see it", async () => {
    if (!dbAvailable) return;
    const s = await setup({ events: [["project_created", DAY]] });
    await phaseGoalConversions(db, new Date(), [tenantId, otherTenantId]);
    const again = await phaseGoalConversions(db, new Date(), [tenantId, otherTenantId]);
    expect(again.conversionsRecorded).toBe(0);
    expect(await conversionsOf(s.flowId)).toHaveLength(1);
  });

  it("also covers someone who was exited from the flow", async () => {
    if (!dbAvailable) return;
    const s = await setup({ status: "exited", events: [["project_created", HOUR]] });
    expect((await phaseGoalConversions(db, new Date(), [tenantId, otherTenantId])).conversionsRecorded).toBe(1);
    expect(await conversionsOf(s.flowId)).toHaveLength(1);
  });

  it("does not record when the goal has not happened", async () => {
    if (!dbAvailable) return;
    const s = await setup({ events: [["something_else", HOUR]] });
    expect((await phaseGoalConversions(db, new Date(), [tenantId, otherTenantId])).conversionsRecorded).toBe(0);
    expect(await conversionsOf(s.flowId)).toHaveLength(0);
  });

  it("does not count an event from before the contact entered the flow", async () => {
    if (!dbAvailable) return;
    const s = await setup({ enteredAgoMs: 2 * DAY, events: [["project_created", 5 * DAY]] });
    await phaseGoalConversions(db, new Date(), [tenantId, otherTenantId]);
    expect(await conversionsOf(s.flowId)).toHaveLength(0);
  });

  it("does not look at memberships whose goal window has passed", async () => {
    if (!dbAvailable) return;
    const s = await setup({ enteredAgoMs: 40 * DAY, events: [["project_created", DAY]], goal: goalOf({ window_days: 30 }) });
    const r = await phaseGoalConversions(db, new Date(), [tenantId, otherTenantId]);
    expect(r.membershipsChecked).toBe(0);
    expect(await conversionsOf(s.flowId)).toHaveLength(0);
  });

  it("a longer window reaches further back", async () => {
    if (!dbAvailable) return;
    const s = await setup({ enteredAgoMs: 40 * DAY, events: [["project_created", DAY]], goal: goalOf({ window_days: 60 }) });
    await phaseGoalConversions(db, new Date(), [tenantId, otherTenantId]);
    expect(await conversionsOf(s.flowId)).toHaveLength(1);
  });

  it("ignores active memberships (the advance step handles those)", async () => {
    if (!dbAvailable) return;
    const s = await setup({ status: "active", events: [["project_created", HOUR]] });
    const r = await phaseGoalConversions(db, new Date(), [tenantId, otherTenantId]);
    expect(r.membershipsChecked).toBe(0);
    expect(await conversionsOf(s.flowId)).toHaveLength(0);
  });

  it("ignores flows without a goal and archived flows", async () => {
    if (!dbAvailable) return;
    const none = await setup({ goal: null, events: [["project_created", HOUR]] });
    const archived = await setup({ flowStatus: "archived", events: [["project_created", HOUR]] });
    const r = await phaseGoalConversions(db, new Date(), [tenantId, otherTenantId]);
    expect(r.flowsEvaluated).toBe(0);
    expect(await conversionsOf(none.flowId)).toHaveLength(0);
    expect(await conversionsOf(archived.flowId)).toHaveLength(0);
  });

  it("skips a stored goal it cannot read", async () => {
    if (!dbAvailable) return;
    const s = await setup({ goal: { name: "", condition: { nope: 1 } }, events: [["project_created", HOUR]] });
    const r = await phaseGoalConversions(db, new Date(), [tenantId, otherTenantId]);
    expect(r.flowsEvaluated).toBe(0);
    expect(await conversionsOf(s.flowId)).toHaveLength(0);
  });

  it("works on a contact fact as well as an event", async () => {
    if (!dbAvailable) return;
    const s = await setup({ goal: goalOf({ name: "Became paid", condition: { field: "payment_status", op: "is", value: "paid" } }) });
    await db.update(contacts).set({ paymentStatus: "paid" }).where(eq(contacts.id, s.contactId));
    await phaseGoalConversions(db, new Date(), [tenantId, otherTenantId]);
    const rows = await conversionsOf(s.flowId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.goalName).toBe("Became paid");
  });

  it("keeps each workspace to its own flows", async () => {
    if (!dbAvailable) return;
    const mine = await setup({ events: [["project_created", HOUR]] });
    const theirs = await setup({ tenant: otherTenantId, events: [["project_created", HOUR]] });
    await phaseGoalConversions(db, new Date(), [tenantId, otherTenantId]);
    const mineRows = await conversionsOf(mine.flowId);
    const theirRows = await conversionsOf(theirs.flowId);
    expect(mineRows.map((r) => r.tenantId)).toEqual([tenantId]);
    expect(theirRows.map((r) => r.tenantId)).toEqual([otherTenantId]);
  });

  it("only looks at the workspaces it is asked to", async () => {
    if (!dbAvailable) return;
    const mine = await setup({ events: [["project_created", HOUR]] });
    const theirs = await setup({ tenant: otherTenantId, events: [["project_created", HOUR]] });
    await phaseGoalConversions(db, new Date(), [tenantId]);
    expect(await conversionsOf(mine.flowId)).toHaveLength(1);
    expect(await conversionsOf(theirs.flowId)).toHaveLength(0);
  });

  it("two memberships of the same contact convert independently", async () => {
    if (!dbAvailable) return;
    const first = await setup({ enteredAgoMs: 10 * DAY, events: [["project_created", DAY]] });
    // A second, later entry into the same flow, after which the event has not happened again... but the event
    // from the first entry is before it, so only the first converts.
    await addMembership(tenantId, first.contactId, first.flowId, { enteredAgoMs: 12 * HOUR });
    await phaseGoalConversions(db, new Date(), [tenantId, otherTenantId]);
    const rows = await conversionsOf(first.flowId);
    expect(rows.map((r) => r.membershipId)).toEqual([first.membershipId]);
  });

  describe("the time a conversion is recorded at", () => {
    const near = (a: Date, ms: number) => Math.abs(a.getTime() - ms) < 1000;

    it("is when the event happened, not when the scan noticed (so a goal added later still times correctly)", async () => {
      if (!dbAvailable) return;
      const t0 = Date.now();
      const s = await setup({ enteredAgoMs: 5 * DAY, events: [["project_created", 4 * DAY]] });
      await phaseGoalConversions(db, new Date(), [tenantId, otherTenantId]);
      const [row] = await conversionsOf(s.flowId);
      expect(near(row!.convertedAt, t0 - 4 * DAY)).toBe(true);
    });

    it("takes the earliest matching event when there are several", async () => {
      if (!dbAvailable) return;
      const t0 = Date.now();
      const s = await setup({ enteredAgoMs: 5 * DAY, events: [["project_created", 3 * DAY], ["project_created", 4 * DAY], ["project_created", DAY]] });
      await phaseGoalConversions(db, new Date(), [tenantId, otherTenantId]);
      const [row] = await conversionsOf(s.flowId);
      expect(near(row!.convertedAt, t0 - 4 * DAY)).toBe(true);
    });

    it("for 'at least N times' is the time of the Nth event", async () => {
      if (!dbAvailable) return;
      const t0 = Date.now();
      const s = await setup({
        goal: goalOf({ condition: { ...projectCreated, min_count: 3 } }),
        enteredAgoMs: 6 * DAY,
        events: [["project_created", 5 * DAY], ["project_created", 4 * DAY], ["project_created", 2 * DAY], ["project_created", DAY]],
      });
      await phaseGoalConversions(db, new Date(), [tenantId, otherTenantId]);
      const [row] = await conversionsOf(s.flowId);
      expect(near(row!.convertedAt, t0 - 2 * DAY)).toBe(true);
    });

    it("is never before the contact entered the flow", async () => {
      if (!dbAvailable) return;
      const t0 = Date.now();
      // "within the last 10 days" can count an event from before entry; the conversion is then dated at entry.
      const s = await setup({
        goal: goalOf({ condition: { field: "event", name: "project_created", op: "performed", within_days: 10 } }),
        enteredAgoMs: 2 * DAY,
        events: [["project_created", 5 * DAY]],
      });
      await phaseGoalConversions(db, new Date(), [tenantId, otherTenantId]);
      const [row] = await conversionsOf(s.flowId);
      expect(near(row!.convertedAt, t0 - 2 * DAY)).toBe(true);
    });

    it("for a condition that is not a single event is the time it was noticed", async () => {
      if (!dbAvailable) return;
      const s = await setup({ goal: goalOf({ name: "Became paid", condition: { field: "payment_status", op: "is", value: "paid" } }) });
      await db.update(contacts).set({ paymentStatus: "paid" }).where(eq(contacts.id, s.contactId));
      const before = Date.now();
      await phaseGoalConversions(db, new Date(), [tenantId, otherTenantId]);
      const [row] = await conversionsOf(s.flowId);
      expect(row!.convertedAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
      expect(row!.convertedAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    });
  });
});
