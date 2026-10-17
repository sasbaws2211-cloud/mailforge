/**
 * Instant reaction to an event for contacts who are waiting on it.
 *
 * Drives the real path: an event arrives, handleTriggerCheck finds the contact's memberships that are waiting on
 * that event name (a wait-until fork, a goal, a plan-level exit), and each is then advanced by the same engine
 * the scan uses. Also proves what must NOT wake: other events, other contacts, other workspaces, paused and
 * archived flows, and conditions that are not about events.
 *
 * Requires local Postgres (see enrollment.db.test.ts for DATABASE_URL).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { eq, sql } from "drizzle-orm";
import { tenants, contacts, events, flows, flowMemberships, flowConversions, lifecycleMessages } from "@loomail/db/schema";
import { handleTriggerCheck } from "../src/trigger-check.js";
import { handleAdvanceMembership } from "../src/advance-membership.js";
import { MAX_WATCHED_MEMBERSHIPS } from "../src/event-watchers.js";

const TEST_DB_URL = process.env.DATABASE_URL;
if (!TEST_DB_URL) throw new Error("[event-watchers.test] DATABASE_URL is not set (see enrollment.db.test.ts).");

const SLUG = "test-event-watchers";
const OTHER = "test-event-watchers-other";
const DAY = 86_400_000;
const HOUR = 3_600_000;
const MIN = 60_000;

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
    console.warn("[event-watchers.test] DATABASE_URL not reachable - tests skipped.");
    return;
  }
  await wipe();
  await db.execute(sql.raw(`DELETE FROM tenants WHERE slug IN ('${SLUG}', '${OTHER}')`));
  const [a] = await db.insert(tenants).values({ name: "Watchers", slug: SLUG, plan: "free" }).returning({ id: tenants.id });
  const [b] = await db.insert(tenants).values({ name: "Watchers other", slug: OTHER, plan: "free" }).returning({ id: tenants.id });
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

const did = (name: string, since: "step" | "flow" = "step") => ({ field: "event", name, op: "performed", since });
const step = (order: number, delay: string, extra: Record<string, unknown> = {}) => ({ order, action_type: "nurture_value", delay, window_policy: "immediate", ...extra });
const fork = (order: number, delay: string, condition: unknown, then: number | "end", otherwise: number | "end", extra: Record<string, unknown> = {}) => ({ order, delay, condition, then, else: otherwise, ...extra });

interface Setup {
  tenant?: string;
  contactId?: string;
  flowStatus?: string;
  plan?: Record<string, unknown>;
  goal?: unknown;
  currentStep?: number;
  status?: string;
  enteredAgoMs?: number;
  stepEnteredAgoMs?: number;
}

async function mkContact(tenant = tenantId) {
  const [c] = await db
    .insert(contacts)
    .values({ tenantId: tenant, externalId: `c-${Math.random().toString(36).slice(2)}`, lifecycleState: "engaged", firstSeenAt: new Date(), lastSeenAt: new Date() })
    .returning({ id: contacts.id });
  return c!.id;
}

async function mkMembership(o: Setup = {}) {
  const tenant = o.tenant ?? tenantId;
  const contactId = o.contactId ?? (await mkContact(tenant));
  const plan = o.plan ?? { version: 2, trigger: { type: "event", condition: {} }, steps: [step(2, "0m", { next: "end" }), step(3, "0m", { next: "end" })], branches: [fork(1, "3d", did("project_created"), 2, 3, { early: true })] };
  const [f] = await db
    .insert(flows)
    .values({
      tenantId: tenant,
      name: "watch flow",
      triggerType: "lifecycle_transition",
      triggerConfig: { from: "engaged", to: "at_risk" },
      steps: [],
      status: o.flowStatus ?? "active",
      compileStatus: "ready",
      compiledPlan: plan,
      approvalMode: "require",
      ...(o.goal !== undefined ? { goal: o.goal } : {}),
    })
    .returning({ id: flows.id });
  const now = Date.now();
  const [m] = await db
    .insert(flowMemberships)
    .values({
      tenantId: tenant,
      contactId,
      flowId: f!.id,
      currentStep: o.currentStep ?? 1,
      status: o.status ?? "active",
      enteredAt: new Date(now - (o.enteredAgoMs ?? HOUR)),
      stepEnteredAt: new Date(now - (o.stepEnteredAgoMs ?? o.enteredAgoMs ?? HOUR)),
      ...(o.status && o.status !== "active" ? { completedAt: new Date(now - HOUR) } : {}),
    })
    .returning({ id: flowMemberships.id });
  return { membershipId: m!.id, contactId, flowId: f!.id, tenant };
}

const happen = (tenant: string, contactId: string, name: string, agoMs = MIN) =>
  db.insert(events).values({ tenantId: tenant, contactId, type: "track", eventName: name, timestamp: new Date(Date.now() - agoMs) });

const arrives = (tenant: string, contactId: string, name: string) => handleTriggerCheck({ tenant_id: tenant, contact_id: contactId, event_name: name } as never, db);
const state = async (id: string) => (await db.select().from(flowMemberships).where(eq(flowMemberships.id, id)))[0]!;
const conversions = (flowId: string) => db.select().from(flowConversions).where(eq(flowConversions.flowId, flowId));
const goal = (over: Record<string, unknown> = {}) => ({ name: "Created a project", condition: did("project_created", "flow"), window_days: 30, exit_on_conversion: true, ...over });

describe("a wait-until fork wakes the moment its event arrives", () => {
  it("finds the waiting membership, and advancing it moves the contact down the 'it happened' path", async () => {
    if (!dbAvailable) return;
    const s = await mkMembership();
    await happen(s.tenant, s.contactId, "project_created");
    const r = await arrives(s.tenant, s.contactId, "project_created");
    expect(r.watchingMembershipIds).toEqual([s.membershipId]);
    expect(r.enrolledMembershipIds).toEqual([]);

    await handleAdvanceMembership({ tenant_id: s.tenant, membership_id: s.membershipId } as never, db);
    const m = await state(s.membershipId);
    expect(m.status).toBe("completed");
    expect(m.currentStep).toBe(2); // the "it happened" path, not the timeout path
    const msgs = await db.select().from(lifecycleMessages).where(eq(lifecycleMessages.membershipId, s.membershipId));
    expect(msgs.map((x) => x.flowStepOrder)).toEqual([2]);
  });

  it("an unrelated event wakes nobody", async () => {
    if (!dbAvailable) return;
    const s = await mkMembership();
    const r = await arrives(s.tenant, s.contactId, "something_else");
    expect(r.watchingMembershipIds).toEqual([]);
  });

  it("an event from before the contact reached the fork is found waiting but advancing leaves them waiting (harmless)", async () => {
    if (!dbAvailable) return;
    const s = await mkMembership({ enteredAgoMs: DAY, stepEnteredAgoMs: HOUR });
    await happen(s.tenant, s.contactId, "project_created", 5 * HOUR);
    const r = await arrives(s.tenant, s.contactId, "project_created");
    expect(r.watchingMembershipIds).toEqual([s.membershipId]);
    await handleAdvanceMembership({ tenant_id: s.tenant, membership_id: s.membershipId } as never, db);
    const m = await state(s.membershipId);
    expect(m.status).toBe("active");
    expect(m.currentStep).toBe(1);
  });

  it("a fork that is not wait-until (no early) is left to its own deadline", async () => {
    if (!dbAvailable) return;
    const s = await mkMembership({ plan: { version: 2, trigger: { type: "event", condition: {} }, steps: [step(2, "0m", { next: "end" }), step(3, "0m", { next: "end" })], branches: [fork(1, "3d", did("project_created"), 2, 3)] } });
    expect((await arrives(s.tenant, s.contactId, "project_created")).watchingMembershipIds).toEqual([]);
  });

  it("only the fork the contact is sitting on counts, not one further down the plan", async () => {
    if (!dbAvailable) return;
    const plan = { version: 2, trigger: { type: "event", condition: {} }, steps: [step(1, "0m", { next: 2 }), step(3, "0m", { next: "end" }), step(4, "0m", { next: "end" })], branches: [fork(2, "3d", did("project_created"), 3, 4, { early: true })] };
    const s = await mkMembership({ plan, currentStep: 1 });
    expect((await arrives(s.tenant, s.contactId, "project_created")).watchingMembershipIds).toEqual([]);
  });

  it("a wait on a contact fact or a lifecycle stage is not about events, so it is left to the scan", async () => {
    if (!dbAvailable) return;
    for (const condition of [{ field: "payment_status", op: "is", value: "paid" }, { lifecycle_state: "activated" }]) {
      const s = await mkMembership({ plan: { version: 2, trigger: { type: "event", condition: {} }, steps: [step(2, "0m", { next: "end" }), step(3, "0m", { next: "end" })], branches: [fork(1, "3d", condition, 2, 3, { early: true })] } });
      expect((await arrives(s.tenant, s.contactId, "project_created")).watchingMembershipIds, JSON.stringify(condition)).toEqual([]);
    }
  });

  it("'did not do X' is not woken by X", async () => {
    if (!dbAvailable) return;
    const cond = { field: "event", name: "project_created", op: "not_performed", since: "step" };
    const s = await mkMembership({ plan: { version: 2, trigger: { type: "event", condition: {} }, steps: [step(2, "0m", { next: "end" }), step(3, "0m", { next: "end" })], branches: [fork(1, "3d", cond, 2, 3, { early: true })] } });
    expect((await arrives(s.tenant, s.contactId, "project_created")).watchingMembershipIds).toEqual([]);
  });
});

describe("a goal reacts to its event", () => {
  it("a contact still in the flow is woken, and advancing records the conversion and exits them", async () => {
    if (!dbAvailable) return;
    const s = await mkMembership({ plan: { trigger: { type: "event", condition: {} }, steps: [step(1, "1d"), step(2, "2d")] }, goal: goal() });
    await happen(s.tenant, s.contactId, "project_created");
    const r = await arrives(s.tenant, s.contactId, "project_created");
    expect(r.watchingMembershipIds).toEqual([s.membershipId]);
    await handleAdvanceMembership({ tenant_id: s.tenant, membership_id: s.membershipId } as never, db);
    const m = await state(s.membershipId);
    expect(m.status).toBe("exited");
    expect(m.exitReason).toBe("goal_reached");
    expect(await conversions(s.flowId)).toHaveLength(1);
  });

  it("someone who already left the flow converts straight away, at the time of the event, with nothing to advance", async () => {
    if (!dbAvailable) return;
    const s = await mkMembership({ status: "completed", enteredAgoMs: 5 * DAY, goal: goal() });
    const t0 = Date.now();
    await happen(s.tenant, s.contactId, "project_created", 2 * HOUR);
    const r = await arrives(s.tenant, s.contactId, "project_created");
    expect(r.watchingMembershipIds).toEqual([]);
    const rows = await conversions(s.flowId);
    expect(rows).toHaveLength(1);
    expect(Math.abs(rows[0]!.convertedAt.getTime() - (t0 - 2 * HOUR))).toBeLessThan(1000);
  });

  it("is recorded once however many times the event arrives", async () => {
    if (!dbAvailable) return;
    const s = await mkMembership({ status: "completed", enteredAgoMs: 5 * DAY, goal: goal() });
    await happen(s.tenant, s.contactId, "project_created");
    await arrives(s.tenant, s.contactId, "project_created");
    await happen(s.tenant, s.contactId, "project_created");
    await arrives(s.tenant, s.contactId, "project_created");
    expect(await conversions(s.flowId)).toHaveLength(1);
  });

  it("not once the goal window has passed", async () => {
    if (!dbAvailable) return;
    const s = await mkMembership({ status: "completed", enteredAgoMs: 40 * DAY, goal: goal({ window_days: 30 }) });
    await happen(s.tenant, s.contactId, "project_created");
    await arrives(s.tenant, s.contactId, "project_created");
    expect(await conversions(s.flowId)).toHaveLength(0);
  });

  it("not for an event the goal is not waiting on", async () => {
    if (!dbAvailable) return;
    const s = await mkMembership({ status: "completed", enteredAgoMs: 5 * DAY, goal: goal() });
    await happen(s.tenant, s.contactId, "other_event");
    await arrives(s.tenant, s.contactId, "other_event");
    expect(await conversions(s.flowId)).toHaveLength(0);
  });

  it("a goal on a contact fact is not woken by events", async () => {
    if (!dbAvailable) return;
    const s = await mkMembership({ plan: { trigger: { type: "event", condition: {} }, steps: [step(1, "1d")] }, goal: goal({ condition: { field: "payment_status", op: "is", value: "paid" } }) });
    expect((await arrives(s.tenant, s.contactId, "project_created")).watchingMembershipIds).toEqual([]);
  });
});

describe("a plan-level exit reacts to its event", () => {
  it("'exit when X happens' wakes the membership, and advancing exits it", async () => {
    if (!dbAvailable) return;
    const s = await mkMembership({ plan: { trigger: { type: "event", condition: {} }, steps: [step(1, "1d")], exit_conditions: [{ event: "cancelled" }] } });
    await happen(s.tenant, s.contactId, "cancelled");
    const r = await arrives(s.tenant, s.contactId, "cancelled");
    expect(r.watchingMembershipIds).toEqual([s.membershipId]);
    await handleAdvanceMembership({ tenant_id: s.tenant, membership_id: s.membershipId } as never, db);
    expect((await state(s.membershipId)).status).toBe("exited");
  });

  it("the { condition } exit shape works too, and a stage-change exit is left to the scan", async () => {
    if (!dbAvailable) return;
    const a = await mkMembership({ plan: { trigger: { type: "event", condition: {} }, steps: [step(1, "1d")], exit_conditions: [{ condition: did("paid", "flow") }] } });
    expect((await arrives(a.tenant, a.contactId, "paid")).watchingMembershipIds).toEqual([a.membershipId]);
    const b = await mkMembership({ plan: { trigger: { type: "event", condition: {} }, steps: [step(1, "1d")], exit_conditions: [{ lifecycle_state_change: { to: "churned" } }] } });
    expect((await arrives(b.tenant, b.contactId, "paid")).watchingMembershipIds).toEqual([]);
  });
});

describe("who must not be woken", () => {
  it("a paused flow, a draft flow and an archived flow", async () => {
    if (!dbAvailable) return;
    for (const flowStatus of ["paused", "draft", "archived"]) {
      const s = await mkMembership({ flowStatus });
      expect((await arrives(s.tenant, s.contactId, "project_created")).watchingMembershipIds, flowStatus).toEqual([]);
    }
  });

  it("another contact's membership in the same flow", async () => {
    if (!dbAvailable) return;
    const mine = await mkMembership();
    const theirs = await mkMembership();
    const r = await arrives(mine.tenant, mine.contactId, "project_created");
    expect(r.watchingMembershipIds).toEqual([mine.membershipId]);
    expect(r.watchingMembershipIds).not.toContain(theirs.membershipId);
  });

  it("another workspace, even for a contact with the same id lookup", async () => {
    if (!dbAvailable) return;
    const theirs = await mkMembership({ tenant: otherTenantId });
    const r = await arrives(tenantId, theirs.contactId, "project_created");
    expect(r.watchingMembershipIds).toEqual([]);
  });

  it("a completed membership with no goal", async () => {
    if (!dbAvailable) return;
    const s = await mkMembership({ status: "completed" });
    expect((await arrives(s.tenant, s.contactId, "project_created")).watchingMembershipIds).toEqual([]);
  });
});

describe("alongside enrollment, and limits", () => {
  it("an event that enrolls the contact in a flow also wakes a membership that was waiting, and does not list the new one twice", async () => {
    if (!dbAvailable) return;
    const waiting = await mkMembership();
    const [trigger] = await db
      .insert(flows)
      .values({
        tenantId,
        name: "trigger flow",
        triggerType: "event",
        triggerConfig: { event: "project_created" },
        steps: [],
        status: "active",
        flowClass: "critical", // critical flows enroll alongside the nurture flow the contact is already in
        goal: goal(), // so the freshly enrolled membership is itself waiting on this event, and must not be listed twice
        compileStatus: "ready",
        compiledPlan: { trigger: { type: "event", condition: {} }, steps: [step(1, "0m")] },
        approvalMode: "require",
      })
      .returning({ id: flows.id });
    await happen(tenantId, waiting.contactId, "project_created");
    const r = await arrives(tenantId, waiting.contactId, "project_created");
    expect(r.enrolledMembershipIds).toHaveLength(1);
    expect(r.watchingMembershipIds).toEqual([waiting.membershipId]);
    const enrolled = await db.select().from(flowMemberships).where(eq(flowMemberships.flowId, trigger!.id));
    expect(enrolled.map((m) => m.id)).toEqual(r.enrolledMembershipIds);
  });

  it("looks at no more than the cap of memberships for one event", async () => {
    if (!dbAvailable) return;
    const contactId = await mkContact();
    for (let i = 0; i < MAX_WATCHED_MEMBERSHIPS + 5; i++) await mkMembership({ contactId });
    const r = await arrives(tenantId, contactId, "project_created");
    expect(r.watchingMembershipIds).toHaveLength(MAX_WATCHED_MEMBERSHIPS);
  });

  it("a contact with no memberships costs nothing and returns empty", async () => {
    if (!dbAvailable) return;
    const contactId = await mkContact();
    expect(await arrives(tenantId, contactId, "project_created")).toEqual({ enrolledMembershipIds: [], watchingMembershipIds: [] });
  });
});
