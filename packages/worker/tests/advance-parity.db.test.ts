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

interface Scenario {
  name: string;
  steps?: unknown[];
  exitConditions?: unknown[];
  /** null means the flow has no compiled plan. */
  noPlan?: boolean;
  flowStatus?: string;
  contactState?: string;
  currentStep?: number;
  enteredAgoMs?: number;
  conditionError?: string;
  /** Events the contact has, as [name, ms ago]. */
  events?: Array<[string, number]>;
  /** Messages already created for the membership, as [step order, ms ago]. */
  messages?: Array<[number, number]>;
}

async function build(tenantId: string, sc: Scenario, now: number): Promise<string> {
  const [contact] = await db
    .insert(contacts)
    .values({
      tenantId,
      externalId: "parity",
      lifecycleState: sc.contactState ?? "engaged",
      firstSeenAt: new Date(now - 60 * DAY),
      lastSeenAt: new Date(now - DAY),
    })
    .returning({ id: contacts.id });
  const steps = sc.steps ?? [step(1, "0m")];
  const plan = sc.noPlan
    ? null
    : {
        trigger: { type: "lifecycle_transition", condition: {} },
        steps,
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
];

describe("the scan and the targeted job advance a membership identically", () => {
  it.each(scenarios.map((s) => [s.name, s] as const))("%s", async (_name, sc) => {
    if (!dbAvailable) return;
    const { viaScan, viaTargeted } = await runBoth(sc);
    expect(viaTargeted).toEqual(viaScan);
  });
});
