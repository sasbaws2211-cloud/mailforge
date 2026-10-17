/**
 * Parity between the two ways a membership is advanced.
 *
 * A freshly enrolled contact is advanced at once by handleAdvanceMembership (the targeted job); everyone
 * else is advanced by the 15-minute scan (phaseStepAdvancement). They are meant to do the same thing to the
 * same membership. This test proves it: every scenario is built twice in two separate workspaces, one is run
 * through the scan and the other through the targeted job, and the resulting membership and message rows must
 * be identical.
 *
 * Requires local Postgres (see enrollment.db.test.ts for DATABASE_URL).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { eq, sql } from "drizzle-orm";
import { tenants, contacts, events, flows, flowMemberships, lifecycleMessages } from "@loomail/db/schema";
import { phaseStepAdvancement } from "../src/scan-step-advancement.js";
import { handleAdvanceMembership } from "../src/advance-membership.js";

const TEST_DB_URL = process.env.DATABASE_URL;
if (!TEST_DB_URL) {
  throw new Error("[advance-parity.test] DATABASE_URL is not set (see enrollment.db.test.ts).");
}

const SLUG_SCAN = "test-advance-parity-scan";
const SLUG_TARGETED = "test-advance-parity-targeted";

let pool: pg.Pool;
let db: ReturnType<typeof drizzle>;
let dbAvailable = false;
let scanTenant: string;
let targetedTenant: string;

async function cleanup() {
  for (const table of ["lifecycle_messages", "flow_memberships", "flows", "events", "lifecycle_transitions", "contacts", "scan_checkpoints"]) {
    await db.execute(
      sql.raw(`DELETE FROM ${table} WHERE tenant_id IN (SELECT id FROM tenants WHERE slug IN ('${SLUG_SCAN}', '${SLUG_TARGETED}'))`),
    );
  }
  await db.execute(sql.raw(`DELETE FROM tenants WHERE slug IN ('${SLUG_SCAN}', '${SLUG_TARGETED}')`));
}

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: TEST_DB_URL, connectionTimeoutMillis: 3000 });
  try {
    await pool.query("SELECT 1");
    db = drizzle(pool);
    dbAvailable = true;
  } catch {
    console.warn("[advance-parity.test] DATABASE_URL not reachable - tests skipped.");
    return;
  }
  await cleanup();
  const [a] = await db.insert(tenants).values({ name: "Parity scan", slug: SLUG_SCAN, plan: "free" }).returning({ id: tenants.id });
  const [b] = await db.insert(tenants).values({ name: "Parity targeted", slug: SLUG_TARGETED, plan: "free" }).returning({ id: tenants.id });
  scanTenant = a!.id;
  targetedTenant = b!.id;
});

beforeEach(async () => {
  if (!dbAvailable) return;
  for (const t of [scanTenant, targetedTenant]) {
    for (const table of ["lifecycle_messages", "flow_memberships", "flows", "events", "lifecycle_transitions", "contacts", "scan_checkpoints"]) {
      await db.execute(sql.raw(`DELETE FROM ${table} WHERE tenant_id = '${t}'`));
    }
  }
});

afterAll(async () => {
  if (dbAvailable) await cleanup();
  await pool.end();
});

// ---------------------------------------------------------------------------
// Scenario description
// ---------------------------------------------------------------------------

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const step = (order: number, delay: string, extra: Record<string, unknown> = {}) => ({
  order,
  action_type: "nurture_value",
  delay,
  window_policy: "immediate",
  ...extra,
});

/** A fork in a branching plan. */
const fork = (order: number, delay: string, condition: unknown, then: number | "end", otherwise: number | "end") => ({
  order,
  delay,
  condition,
  then,
  else: otherwise,
});

/** A wait-until fork: waits at most `delay`, goes on early the moment the condition holds. */
const waitFork = (order: number, delay: string, condition: unknown, then: number | "end", otherwise: number | "end") => ({
  ...fork(order, delay, condition, then, otherwise),
  early: true,
});

interface Scenario {
  name: string;
  steps?: unknown[];
  exitConditions?: unknown[];
  /** null means the flow has no compiled plan. */
  noPlan?: boolean;
  flowStatus?: string;
  contactState?: string;
  paymentStatus?: string;
  properties?: Record<string, unknown>;
  currentStep?: number;
  enteredAgoMs?: number;
  conditionError?: string;
  /** Events the contact has, as [name, ms ago]. */
  events?: Array<[string, number]>;
  /** Messages already created for the membership, as [step order, ms ago]. */
  messages?: Array<[number, number]>;
  /** A branching (version 2) plan: forks, and when the contact arrived at the current node. */
  version?: 2;
  branches?: unknown[];
  stepEnteredAgoMs?: number;
  /** What the membership must look like afterwards (checked on the scan's result; the targeted job must match it). */
  expect?: { status: string; currentStep: number; messageOrders: number[]; stepEntered?: boolean; error?: RegExp };
}

async function build(tenantId: string, sc: Scenario, now: number): Promise<string> {
  const [contact] = await db
    .insert(contacts)
    .values({
      tenantId,
      externalId: "parity",
      lifecycleState: sc.contactState ?? "engaged",
      ...(sc.paymentStatus !== undefined ? { paymentStatus: sc.paymentStatus } : {}),
      ...(sc.properties !== undefined ? { properties: sc.properties } : {}),
      firstSeenAt: new Date(now - 60 * DAY),
      lastSeenAt: new Date(now - DAY),
    })
    .returning({ id: contacts.id });
  const steps = sc.steps ?? [step(1, "0m")];
  const plan = sc.noPlan
    ? null
    : {
        ...(sc.version ? { version: sc.version } : {}),
        trigger: { type: "lifecycle_transition", condition: {} },
        steps,
        ...(sc.branches ? { branches: sc.branches } : {}),
        ...(sc.exitConditions ? { exit_conditions: sc.exitConditions } : {}),
      };
  const [flow] = await db
    .insert(flows)
    .values({
      tenantId,
      name: "parity flow",
      triggerType: "lifecycle_transition",
      triggerConfig: { from: "engaged", to: "at_risk" },
      steps,
      status: sc.flowStatus ?? "active",
      compileStatus: plan ? "ready" : null,
      compiledPlan: plan,
      approvalMode: "require",
    })
    .returning({ id: flows.id });
  const [membership] = await db
    .insert(flowMemberships)
    .values({
      tenantId,
      contactId: contact!.id,
      flowId: flow!.id,
      currentStep: sc.currentStep ?? 1,
      status: "active",
      enteredAt: new Date(now - (sc.enteredAgoMs ?? HOUR)),
      ...(sc.stepEnteredAgoMs !== undefined ? { stepEnteredAt: new Date(now - sc.stepEnteredAgoMs) } : {}),
      ...(sc.conditionError ? { conditionError: sc.conditionError } : {}),
    })
    .returning({ id: flowMemberships.id });
  for (const [name, agoMs] of sc.events ?? []) {
    await db.insert(events).values({ tenantId, contactId: contact!.id, type: "track", eventName: name, timestamp: new Date(now - agoMs) });
  }
  for (const [order, agoMs] of sc.messages ?? []) {
    await db.insert(lifecycleMessages).values({
      tenantId,
      contactId: contact!.id,
      flowId: flow!.id,
      membershipId: membership!.id,
      flowStepOrder: order,
      status: "pending_generation",
      brainActionType: "nurture_value",
      createdAt: new Date(now - agoMs),
    });
  }
  return membership!.id;
}

/** What a membership and its messages look like afterwards, without ids and exact timestamps. */
async function snapshot(membershipId: string) {
  const [m] = await db.select().from(flowMemberships).where(eq(flowMemberships.id, membershipId));
  const msgs = await db.select().from(lifecycleMessages).where(eq(lifecycleMessages.membershipId, membershipId));
  return {
    status: m!.status,
    currentStep: m!.currentStep,
    exitReason: m!.exitReason,
    conditionError: m!.conditionError,
    stepEnteredSet: m!.stepEnteredAt !== null,
    completed: m!.completedAt !== null,
    exited: m!.exitedAt !== null,
    messages: msgs
      .map((x) => ({ order: x.flowStepOrder, status: x.status, actionType: x.brainActionType }))
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
  };
}

async function runBoth(sc: Scenario) {
  const now = Date.now();
  const scanMembership = await build(scanTenant, sc, now);
  const targetedMembership = await build(targetedTenant, sc, now);
  await phaseStepAdvancement(db, new Date(), [scanTenant]);
  await handleAdvanceMembership({ tenant_id: targetedTenant, membership_id: targetedMembership } as never, db);
  return { viaScan: await snapshot(scanMembership), viaTargeted: await snapshot(targetedMembership) };
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

const scenarios: Scenario[] = [
  { name: "first step due: message created, advanced", steps: [step(1, "0m"), step(2, "2d")] },
  { name: "last step due: message created, completed", steps: [step(1, "0m")] },
  { name: "delay not elapsed: untouched", steps: [step(1, "3d")], enteredAgoMs: DAY },
  { name: "step 2 counts its delay from step 1's message", steps: [step(1, "0m"), step(2, "2d")], currentStep: 2, enteredAgoMs: 10 * DAY, messages: [[1, 3 * DAY]] },
  { name: "step 2 not due yet, measured from step 1's message", steps: [step(1, "0m"), step(2, "2d")], currentStep: 2, enteredAgoMs: 10 * DAY, messages: [[1, DAY]] },
  { name: "step 2 after a skipped step 1 falls back to the entry time", steps: [step(1, "0m"), step(2, "2d")], currentStep: 2, enteredAgoMs: 10 * DAY },
  { name: "archived flow: membership exits", steps: [step(1, "0m")], flowStatus: "archived" },
  { name: "paused flow: untouched", steps: [step(1, "0m")], flowStatus: "paused" },
  { name: "no compiled plan: untouched", noPlan: true },
  { name: "step missing from a recompiled plan: completes", steps: [step(1, "0m"), step(2, "1d")], currentStep: 5 },
  { name: "condition false on a middle step: skipped, advanced, no message", steps: [step(1, "0m", { condition: { lifecycle_state: "dormant" } }), step(2, "1d")] },
  { name: "condition false on the last step: completes, no message", steps: [step(1, "0m", { condition: { lifecycle_state: "dormant" } })] },
  { name: "condition true: message created", steps: [step(1, "0m", { condition: { lifecycle_state: "engaged" } })] },
  { name: "lifecycle_state_not condition", steps: [step(1, "0m", { condition: { lifecycle_state_not: "engaged" } })] },
  { name: "event_since_step true", steps: [step(1, "0m", { condition: { event_since_step: "did_it" } })], events: [["did_it", 30 * 60_000]] },
  { name: "event_since_step false (event is older than the step)", steps: [step(1, "0m", { condition: { event_since_step: "did_it" } })], events: [["did_it", 5 * DAY]] },
  { name: "step exit_condition true: exits", steps: [step(1, "0m", { exit_condition: { lifecycle_state: "engaged" } })] },
  { name: "step exit_condition false: carries on", steps: [step(1, "0m", { exit_condition: { lifecycle_state: "dormant" } })] },
  { name: "plan exit by event: exits", steps: [step(1, "5d")], exitConditions: [{ event: "upgraded" }], events: [["upgraded", 10 * 60_000]] },
  { name: "plan exit event from before entry is ignored", steps: [step(1, "0m")], exitConditions: [{ event: "upgraded" }], events: [["upgraded", 3 * DAY]] },
  { name: "plan exit by lifecycle state: exits", steps: [step(1, "0m")], exitConditions: [{ lifecycle_state_change: { to: "engaged" } }] },
  { name: "combined plan exit needs both: only the state holds", steps: [step(1, "0m")], exitConditions: [{ event: "upgraded", lifecycle_state_change: { to: "engaged" } }] },
  { name: "combined plan exit needs both: both hold", steps: [step(1, "0m")], exitConditions: [{ event: "upgraded", lifecycle_state_change: { to: "engaged" } }], events: [["upgraded", 10 * 60_000]] },
  { name: "unrecognised step condition: stuck with a recorded error", steps: [step(1, "0m", { condition: { favourite_colour: "red" } })] },
  { name: "unrecognised step exit_condition: stuck with a recorded error", steps: [step(1, "0m", { exit_condition: { nope: 1 } })] },
  { name: "unrecognised plan exit condition: stuck with a recorded error", steps: [step(1, "0m")], exitConditions: [{ mystery: true }] },
  { name: "invalid delay in the plan: untouched", steps: [step(1, "soon")] },
  { name: "message already exists (crash before advancing): advances without a duplicate", steps: [step(1, "0m"), step(2, "1d")], messages: [[1, 60_000]] },
  { name: "an old condition error clears when the delay is not yet due", steps: [step(1, "3d")], enteredAgoMs: DAY, conditionError: "step 1 condition: stale" },
  { name: "an old condition error clears once the step succeeds", steps: [step(1, "0m")], conditionError: "step 1 condition: stale" },
  // --- richer conditions -------------------------------------------------
  { name: "payment status condition false: step skipped", steps: [step(1, "0m", { condition: { field: "payment_status", op: "is", value: "free" } }), step(2, "1d")], paymentStatus: "paid", expect: { status: "active", currentStep: 2, messageOrders: [] } },
  { name: "payment status condition true: message created", steps: [step(1, "0m", { condition: { field: "payment_status", op: "is", value: "paid" } }), step(2, "1d")], paymentStatus: "paid", expect: { status: "active", currentStep: 2, messageOrders: [1] } },
  { name: "plan trait condition", steps: [step(1, "0m", { condition: { field: "plan", op: "is", value: "pro" } })], properties: { plan: "Pro" }, expect: { status: "completed", currentStep: 1, messageOrders: [1] } },
  { name: "custom trait greater-than condition false", steps: [step(1, "0m", { condition: { field: "trait", key: "seats", op: "gt", value: 50 } })], properties: { seats: 12 }, expect: { status: "completed", currentStep: 1, messageOrders: [] } },
  { name: "not performed in 7 days, but it happened 3 days ago: skipped", steps: [step(1, "0m", { condition: { field: "event", name: "exported", op: "not_performed", within_days: 7 } })], events: [["exported", 3 * DAY]], expect: { status: "completed", currentStep: 1, messageOrders: [] } },
  { name: "not performed in 7 days, last done 9 days ago: sends", steps: [step(1, "0m", { condition: { field: "event", name: "exported", op: "not_performed", within_days: 7 } })], events: [["exported", 9 * DAY]], expect: { status: "completed", currentStep: 1, messageOrders: [1] } },
  { name: "performed at least 3 times, with 3: sends", steps: [step(1, "0m", { condition: { field: "event", name: "login", op: "performed", since: "flow", min_count: 3 } })], enteredAgoMs: 5 * DAY, events: [["login", DAY], ["login", 2 * DAY], ["login", 3 * DAY]], expect: { status: "completed", currentStep: 1, messageOrders: [1] } },
  { name: "performed at least 3 times, with 2: skipped", steps: [step(1, "0m", { condition: { field: "event", name: "login", op: "performed", since: "flow", min_count: 3 } })], enteredAgoMs: 5 * DAY, events: [["login", DAY], ["login", 2 * DAY]], expect: { status: "completed", currentStep: 1, messageOrders: [] } },
  { name: "events before entering the flow do not count for since-flow", steps: [step(1, "0m", { condition: { field: "event", name: "login", op: "performed", since: "flow" } })], enteredAgoMs: DAY, events: [["login", 5 * DAY]], expect: { status: "completed", currentStep: 1, messageOrders: [] } },
  { name: "any group: one of two holds", steps: [step(1, "0m", { condition: { any: [{ field: "payment_status", op: "is", value: "free" }, { field: "plan", op: "is", value: "Pro" }] } })], paymentStatus: "paid", properties: { plan: "Pro" }, expect: { status: "completed", currentStep: 1, messageOrders: [1] } },
  { name: "all group: one of two fails", steps: [step(1, "0m", { condition: { all: [{ field: "payment_status", op: "is", value: "paid" }, { field: "plan", op: "is", value: "Growth" }] } })], paymentStatus: "paid", properties: { plan: "Pro" }, expect: { status: "completed", currentStep: 1, messageOrders: [] } },
  { name: "nested groups mixing fields and events", steps: [step(1, "0m", { condition: { all: [{ field: "payment_status", op: "is", value: "paid" }, { any: [{ field: "event", name: "a", op: "performed", since: "flow" }, { field: "event", name: "b", op: "performed", within_days: 2 }] }] } })], paymentStatus: "paid", events: [["b", HOUR]], expect: { status: "completed", currentStep: 1, messageOrders: [1] } },
  { name: "step exit_condition on payment status: exits", steps: [step(1, "0m", { exit_condition: { field: "payment_status", op: "is", value: "cancelled" } })], paymentStatus: "cancelled", expect: { status: "exited", currentStep: 1, messageOrders: [] } },
  { name: "plan exit { condition } on an event since entry: exits", steps: [step(1, "5d")], exitConditions: [{ condition: { field: "event", name: "upgraded", op: "performed", since: "flow" } }], events: [["upgraded", 10 * 60_000]], expect: { status: "exited", currentStep: 1, messageOrders: [] } },
  { name: "plan exit { condition } not met: carries on", steps: [step(1, "0m")], exitConditions: [{ condition: { field: "payment_status", op: "is", value: "cancelled" } }], paymentStatus: "paid", expect: { status: "completed", currentStep: 1, messageOrders: [1] } },
  { name: "event condition with no window is stuck with a recorded error", steps: [step(1, "0m", { condition: { field: "event", name: "x", op: "performed" } })] },
  // --- branching plans (version 2) -------------------------------------
  { name: "a fork first: the condition holds, so the contact goes down the then path and the email is sent in the same call", version: 2, branches: [fork(1, "0m", { field: "payment_status", op: "is", value: "paid" }, 2, 3)], steps: [step(2, "0m", { next: "end" }), step(3, "0m", { next: "end" })], paymentStatus: "paid", expect: { status: "completed", currentStep: 2, messageOrders: [2] } },
  { name: "a fork first: the condition fails, so the else path", version: 2, branches: [fork(1, "0m", { field: "payment_status", op: "is", value: "paid" }, 2, 3)], steps: [step(2, "0m", { next: "end" }), step(3, "0m", { next: "end" })], paymentStatus: "free", expect: { status: "completed", currentStep: 3, messageOrders: [3] } },
  { name: "a fork whose delay has not elapsed waits", version: 2, branches: [fork(1, "3d", { lifecycle_state: "engaged" }, 2, 3)], steps: [step(2, "0m", { next: "end" }), step(3, "0m", { next: "end" })], enteredAgoMs: DAY, expect: { status: "active", currentStep: 1, messageOrders: [], stepEntered: false } },
  { name: "a fork whose delay has elapsed decides", version: 2, branches: [fork(1, "2d", { lifecycle_state: "engaged" }, 2, 3)], steps: [step(2, "0m", { next: "end" }), step(3, "0m", { next: "end" })], enteredAgoMs: 3 * DAY, expect: { status: "completed", currentStep: 2, messageOrders: [2] } },
  { name: "a fork can send the contact straight to the end", version: 2, branches: [fork(1, "0m", { lifecycle_state: "engaged" }, "end", 2)], steps: [step(2, "0m", { next: "end" })], expect: { status: "completed", currentStep: 1, messageOrders: [] } },
  { name: "an email's next pointer can jump over a step", version: 2, steps: [step(1, "0m", { next: 3 }), step(2, "0m"), step(3, "0m", { next: "end" })], expect: { status: "active", currentStep: 3, messageOrders: [1], stepEntered: true } },
  { name: "an email skipped by its condition goes to its next, not to the following order", version: 2, steps: [step(1, "0m", { condition: { field: "payment_status", op: "is", value: "free" }, next: 3 }), step(2, "0m"), step(3, "0m", { next: "end" })], paymentStatus: "paid", expect: { status: "active", currentStep: 3, messageOrders: [], stepEntered: true } },
  { name: "paths that rejoin: the email on one path leads to the shared step", version: 2, branches: [fork(1, "0m", { lifecycle_state: "engaged" }, 2, 3)], steps: [step(2, "0m", { next: 4 }), step(3, "0m", { next: 4 }), step(4, "0m", { next: "end" })], expect: { status: "active", currentStep: 4, messageOrders: [2], stepEntered: true } },
  { name: "in a branching plan the delay counts from arriving at the step, not from the previous email: not due", version: 2, steps: [step(1, "0m", { next: 2 }), step(2, "2d", { next: "end" })], currentStep: 2, enteredAgoMs: 10 * DAY, stepEnteredAgoMs: DAY, expect: { status: "active", currentStep: 2, messageOrders: [] } },
  { name: "in a branching plan the delay counts from arriving at the step: due", version: 2, steps: [step(1, "0m", { next: 2 }), step(2, "2d", { next: "end" })], currentStep: 2, enteredAgoMs: 10 * DAY, stepEnteredAgoMs: 3 * DAY, expect: { status: "completed", currentStep: 2, messageOrders: [2] } },
  { name: "two forks back to back are both taken in one call", version: 2, branches: [fork(1, "0m", { field: "payment_status", op: "is", value: "paid" }, 2, 5), fork(2, "0m", { field: "plan", op: "is", value: "Pro" }, 3, 5)], steps: [step(3, "0m", { next: "end" }), step(5, "0m", { next: "end" })], paymentStatus: "paid", properties: { plan: "Pro" }, expect: { status: "completed", currentStep: 3, messageOrders: [3] } },
  { name: "a fork that leads to a step that is not due yet stops there, recording the arrival", version: 2, branches: [fork(1, "0m", { lifecycle_state: "engaged" }, 2, 3)], steps: [step(2, "2d", { next: "end" }), step(3, "0m", { next: "end" })], expect: { status: "active", currentStep: 2, messageOrders: [], stepEntered: true } },
  // Wait until an event: a fork with early = true goes on the moment its condition holds, else at the deadline.
  { name: "wait-until: the event already happened since arrival, so the contact goes on before the deadline", version: 2, branches: [waitFork(1, "3d", {"field": "event", "name": "project_created", "op": "performed", "since": "step"}, 2, 3)], steps: [step(2, "0m", { next: "end" }), step(3, "0m", { next: "end" })], enteredAgoMs: DAY, events: [["project_created", HOUR]], expect: { status: "completed", currentStep: 2, messageOrders: [2] } },
  { name: "wait-until: nothing yet and time left, so the contact keeps waiting and is not moved", version: 2, branches: [waitFork(1, "3d", {"field": "event", "name": "project_created", "op": "performed", "since": "step"}, 2, 3)], steps: [step(2, "0m", { next: "end" }), step(3, "0m", { next: "end" })], enteredAgoMs: DAY, expect: { status: "active", currentStep: 1, messageOrders: [], stepEntered: false } },
  { name: "wait-until: the deadline passed without the event, so the otherwise path", version: 2, branches: [waitFork(1, "3d", {"field": "event", "name": "project_created", "op": "performed", "since": "step"}, 2, 3)], steps: [step(2, "0m", { next: "end" }), step(3, "0m", { next: "end" })], enteredAgoMs: 4 * DAY, expect: { status: "completed", currentStep: 3, messageOrders: [3] } },
  { name: "wait-until: an event from before the contact reached the fork does not count", version: 2, branches: [waitFork(1, "3d", {"field": "event", "name": "project_created", "op": "performed", "since": "step"}, 2, 3)], steps: [step(2, "0m", { next: "end" }), step(3, "0m", { next: "end" })], enteredAgoMs: DAY, stepEnteredAgoMs: DAY, events: [["project_created", 2 * DAY]], expect: { status: "active", currentStep: 1, messageOrders: [], stepEntered: true } },
  { name: "wait-until: the event happened at the deadline, then path", version: 2, branches: [waitFork(1, "3d", {"field": "event", "name": "project_created", "op": "performed", "since": "step"}, 2, 3)], steps: [step(2, "0m", { next: "end" }), step(3, "0m", { next: "end" })], enteredAgoMs: 4 * DAY, events: [["project_created", 2 * DAY]], expect: { status: "completed", currentStep: 2, messageOrders: [2] } },
  { name: "wait-until on a contact fact: payment becomes paid before the deadline", version: 2, branches: [waitFork(1, "7d", { field: "payment_status", op: "is", value: "paid" }, 2, 3)], steps: [step(2, "0m", { next: "end" }), step(3, "0m", { next: "end" })], enteredAgoMs: DAY, paymentStatus: "paid", expect: { status: "completed", currentStep: 2, messageOrders: [2] } },
  { name: "wait-until: a condition the engine cannot read is reported even while waiting", version: 2, branches: [waitFork(1, "3d", { field: "no_such_field", op: "is", value: "x" }, 2, 3)], steps: [step(2, "0m", { next: "end" }), step(3, "0m", { next: "end" })], enteredAgoMs: DAY, expect: { status: "active", currentStep: 1, messageOrders: [], stepEntered: false, error: /condition/i } },
  { name: "wait-until reaching a later wait-until in the same call", version: 2, branches: [waitFork(1, "3d", {"field": "event", "name": "project_created", "op": "performed", "since": "step"}, 2, 5), waitFork(2, "3d", { field: "payment_status", op: "is", value: "paid" }, 3, 5)], steps: [step(3, "0m", { next: "end" }), step(5, "0m", { next: "end" })], enteredAgoMs: DAY, events: [["project_created", HOUR]], paymentStatus: "paid", expect: { status: "completed", currentStep: 3, messageOrders: [3] } },
  { name: "an event since this step on a fork counts from arrival: an older event does not count", version: 2, branches: [fork(2, "0m", { field: "event", name: "x", op: "performed", since: "step" }, 3, 4)], steps: [step(1, "0m", { next: 2 }), step(3, "0m", { next: "end" }), step(4, "0m", { next: "end" })], currentStep: 2, enteredAgoMs: 10 * DAY, stepEnteredAgoMs: DAY, events: [["x", 3 * DAY]], expect: { status: "completed", currentStep: 4, messageOrders: [4] } },
  { name: "an event since this step on a fork counts from arrival: a newer event does", version: 2, branches: [fork(2, "0m", { field: "event", name: "x", op: "performed", since: "step" }, 3, 4)], steps: [step(1, "0m", { next: 2 }), step(3, "0m", { next: "end" }), step(4, "0m", { next: "end" })], currentStep: 2, enteredAgoMs: 10 * DAY, stepEnteredAgoMs: DAY, events: [["x", HOUR]], expect: { status: "completed", currentStep: 3, messageOrders: [3] } },
  { name: "the plan-level exit still applies in a branching plan", version: 2, branches: [fork(1, "0m", { lifecycle_state: "engaged" }, 2, 3)], steps: [step(2, "0m", { next: "end" }), step(3, "0m", { next: "end" })], exitConditions: [{ condition: { field: "payment_status", op: "is", value: "cancelled" } }], paymentStatus: "cancelled", expect: { status: "exited", currentStep: 1, messageOrders: [] } },
  { name: "a steps own exit_condition applies in a branching plan", version: 2, steps: [step(1, "0m", { exit_condition: { field: "payment_status", op: "is", value: "cancelled" }, next: "end" })], paymentStatus: "cancelled", expect: { status: "exited", currentStep: 1, messageOrders: [] } },
  { name: "a message left by a crash is not duplicated; the contact moves on", version: 2, steps: [step(1, "0m", { next: 2 }), step(2, "1d", { next: "end" })], messages: [[1, 60_000]], expect: { status: "active", currentStep: 2, messageOrders: [1], stepEntered: true } },
  { name: "an unreadable fork condition leaves the contact where they are, with the reason recorded", version: 2, branches: [fork(1, "0m", { favourite_colour: "red" }, 2, 3)], steps: [step(2, "0m", { next: "end" }), step(3, "0m", { next: "end" })], expect: { status: "active", currentStep: 1, messageOrders: [], error: /step 1 condition/ } },
  { name: "a corrupt plan that loops stops after a fixed number of branches instead of spinning", version: 2, branches: [fork(1, "0m", { lifecycle_state: "engaged" }, 2, 2), fork(2, "0m", { lifecycle_state: "engaged" }, 1, 1)], steps: [step(3, "0m")], expect: { status: "active", currentStep: 2, messageOrders: [], error: /too many branches/ } },
  { name: "a fork that points at a step the plan does not have completes the contact", version: 2, branches: [fork(1, "0m", { lifecycle_state: "engaged" }, 9, 9)], steps: [step(2, "0m")], expect: { status: "completed", currentStep: 9, messageOrders: [] } },
  { name: "a straight-line plan never records an arrival time", steps: [step(1, "0m"), step(2, "1d")], expect: { status: "active", currentStep: 2, messageOrders: [1], stepEntered: false } },
];

describe("the scan and the targeted job advance a membership identically", () => {
  it.each(scenarios.map((s) => [s.name, s] as const))("%s", async (_name, sc) => {
    if (!dbAvailable) return;
    const { viaScan, viaTargeted } = await runBoth(sc);
    expect(viaTargeted).toEqual(viaScan);
    if (sc.expect) {
      const { stepEntered, error, ...shape } = sc.expect;
      expect({
        status: viaScan.status,
        currentStep: viaScan.currentStep,
        messageOrders: viaScan.messages.map((m) => m.order),
      }).toEqual(shape);
      if (stepEntered !== undefined) expect(viaScan.stepEnteredSet).toBe(stepEntered);
      if (error) expect(viaScan.conditionError ?? "").toMatch(error);
    }
  });
});
