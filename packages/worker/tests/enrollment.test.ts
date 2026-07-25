/**
 * Integration tests for flow enrollment (task 12b).
 *
 * Tests:
 * - Lifecycle-transition trigger matching and enrollment
 * - Event trigger matching and enrollment (via trigger-check handler)
 * - Suppression blocks enrollment
 * - Nurture class concurrency: one active nurture membership per contact
 * - Priority eviction: higher-priority nurture flow evicts lower
 * - Re-entry policy: once, cooldown, every_time
 * - priority_override exit does not consume cooldown
 * - Uncompiled/draft flows are skipped
 * - Segment-trigger flows are skipped
 * - ON CONFLICT DO NOTHING race backstop
 *
 * PgGate concurrency tests:
 * - Two scans enrolling the same contact into the same flow: exactly 1 membership
 * - Scan + trigger-check racing to enroll different nurture flows: exactly 1 active
 *   nurture membership, and it belongs to the higher-priority flow
 * - Re-entry cooldown boundary: two callers at cooldown expiry: exactly 1 membership
 *
 * Requires local Postgres (docker compose up postgres).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { eq, and, sql } from "drizzle-orm";
import {
  tenants,
  contacts,
  flows,
  flowMemberships,
  suppressions,
} from "@claros/db/schema";
import { phaseEnrollment } from "../src/scan-enrollment.js";
import { handleTriggerCheck } from "../src/trigger-check.js";
import type { AppliedTransition } from "../src/scan-enrollment.js";

const TEST_DB_URL = process.env.DATABASE_URL;
if (!TEST_DB_URL) {
  const inCI = process.env.CI === "true";
  throw new Error(
    `[enrollment.test] DATABASE_URL is not set.\n\n` +
      `This test requires a Postgres connection.\n` +
      (inCI
        ? `Set the variable in the workflow env block:\n\n  DATABASE_URL: postgres://claros:claros@localhost:5432/claros\n`
        : `Set the variable in .env (see .env.example) or export it:\n\n  export DATABASE_URL='postgres://claros:claros@localhost:5433/claros'\n`),
  );
}

let pool: pg.Pool;
let db: ReturnType<typeof drizzle>;
let dbAvailable = false;
let testTenantId: string;

const SLUG = "test-enrollment";
const NOW = new Date("2026-07-20T12:00:00Z");

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: TEST_DB_URL, connectionTimeoutMillis: 3000 });
  try {
    await pool.query("SELECT 1");
    db = drizzle(pool);
    dbAvailable = true;
  } catch (err) {
    const inCI = process.env.CI === "true";
    if (inCI) {
      throw new Error(
        `[enrollment.test] DATABASE_URL not reachable in CI.\n` +
          `URL: ${TEST_DB_URL}\nCause: ${(err as Error).message}`,
      );
    }
    console.warn("[enrollment.test] DATABASE_URL not reachable - tests skipped.");
    return;
  }

  // Clean up
  await cleanup();

  // Create test tenant
  const [tenant] = await db
    .insert(tenants)
    .values({ name: "Test Enrollment", slug: SLUG, plan: "free" })
    .returning({ id: tenants.id });
  testTenantId = tenant!.id;
});

beforeEach(async () => {
  if (!dbAvailable) return;
  // Clean flows and memberships between tests to prevent cross-test interference
  await db.execute(
    sql`DELETE FROM flow_memberships WHERE tenant_id = ${testTenantId}`,
  );
  await db.execute(
    sql`DELETE FROM suppressions WHERE tenant_id = ${testTenantId}`,
  );
  await db.execute(
    sql`DELETE FROM flows WHERE tenant_id = ${testTenantId}`,
  );
  await db.execute(
    sql`DELETE FROM contacts WHERE tenant_id = ${testTenantId}`,
  );
});

afterAll(async () => {
  if (dbAvailable) {
    await cleanup();
  }
  await pool.end();
});

async function cleanup() {
  await db.execute(
    sql`DELETE FROM flow_memberships WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${SLUG})`,
  );
  await db.execute(
    sql`DELETE FROM suppressions WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${SLUG})`,
  );
  await db.execute(
    sql`DELETE FROM flows WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${SLUG})`,
  );
  await db.execute(
    sql`DELETE FROM contacts WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${SLUG})`,
  );
  await db.execute(sql`DELETE FROM tenants WHERE slug = ${SLUG}`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function insertContact(externalId: string, email?: string): Promise<string> {
  const [row] = await db
    .insert(contacts)
    .values({
      tenantId: testTenantId,
      externalId,
      lifecycleState: "engaged",
      firstSeenAt: NOW,
      lastSeenAt: NOW,
      email: email ?? null,
    })
    .returning({ id: contacts.id });
  return row!.id;
}

async function insertFlow(opts: {
  name: string;
  triggerType: string;
  triggerConfig: unknown;
  priority?: number;
  flowClass?: string;
  reentryPolicy?: string;
  reentryCooldownDays?: number;
  status?: string;
  compileStatus?: string;
  compiledPlan?: unknown;
}): Promise<string> {
  const [row] = await db
    .insert(flows)
    .values({
      tenantId: testTenantId,
      name: opts.name,
      triggerType: opts.triggerType,
      triggerConfig: opts.triggerConfig,
      steps: [{ order: 1, action_type: "nurture_value", delay: "0m", window_policy: "immediate" }],
      priority: opts.priority ?? 0,
      flowClass: opts.flowClass ?? "nurture",
      reentryPolicy: opts.reentryPolicy ?? "cooldown",
      reentryCooldownDays: opts.reentryCooldownDays ?? 30,
      status: opts.status ?? "active",
      compileStatus: opts.compileStatus ?? "ready",
      compiledPlan: opts.compiledPlan ?? { steps: [{ order: 1 }] },
    })
    .returning({ id: flows.id });
  return row!.id;
}

async function getActiveMemberships(contactId: string) {
  return db
    .select()
    .from(flowMemberships)
    .where(
      and(
        eq(flowMemberships.contactId, contactId),
        eq(flowMemberships.status, "active"),
      ),
    );
}

async function getAllMemberships(contactId: string) {
  return db
    .select()
    .from(flowMemberships)
    .where(eq(flowMemberships.contactId, contactId));
}

// ---------------------------------------------------------------------------
// Basic enrollment tests
// ---------------------------------------------------------------------------

describe("phaseEnrollment - basic lifecycle-transition enrollment", () => {
  it("enrolls a contact when a matching flow exists", async () => {
    if (!dbAvailable) return;

    const contactId = await insertContact("enroll_basic_1");
    const flowId = await insertFlow({
      name: "Win-back",
      triggerType: "lifecycle_transition",
      triggerConfig: { from: "engaged", to: "at_risk" },
    });

    const transitions: AppliedTransition[] = [
      { tenantId: testTenantId, contactId, fromState: "engaged", toState: "at_risk" },
    ];

    const result = await phaseEnrollment(db, transitions, NOW);

    expect(result.enrollmentsSucceeded).toBe(1);
    const memberships = await getActiveMemberships(contactId);
    expect(memberships).toHaveLength(1);
    expect(memberships[0]!.flowId).toBe(flowId);
    expect(memberships[0]!.currentStep).toBe(1);
    expect(memberships[0]!.status).toBe("active");
  });

  it("does not enroll when no flow matches the transition", async () => {
    if (!dbAvailable) return;

    const contactId = await insertContact("enroll_no_match");
    await insertFlow({
      name: "At-risk only",
      triggerType: "lifecycle_transition",
      triggerConfig: { from: "engaged", to: "at_risk" },
    });

    // Transition is dormant->churned, flow triggers on engaged->at_risk
    const transitions: AppliedTransition[] = [
      { tenantId: testTenantId, contactId, fromState: "dormant", toState: "churned" },
    ];

    const result = await phaseEnrollment(db, transitions, NOW);

    expect(result.enrollmentsSucceeded).toBe(0);
    const memberships = await getActiveMemberships(contactId);
    expect(memberships).toHaveLength(0);
  });

  it("skips flows with compile_status != ready", async () => {
    if (!dbAvailable) return;

    const contactId = await insertContact("enroll_uncompiled");
    await insertFlow({
      name: "Uncompiled flow",
      triggerType: "lifecycle_transition",
      triggerConfig: { from: "engaged", to: "at_risk" },
      compileStatus: "pending",
      compiledPlan: null,
    });

    const transitions: AppliedTransition[] = [
      { tenantId: testTenantId, contactId, fromState: "engaged", toState: "at_risk" },
    ];

    const result = await phaseEnrollment(db, transitions, NOW);

    expect(result.enrollmentsSucceeded).toBe(0);
    const memberships = await getActiveMemberships(contactId);
    expect(memberships).toHaveLength(0);
  });

  it("skips draft flows", async () => {
    if (!dbAvailable) return;

    const contactId = await insertContact("enroll_draft");
    await insertFlow({
      name: "Draft flow",
      triggerType: "lifecycle_transition",
      triggerConfig: { from: "engaged", to: "at_risk" },
      status: "draft",
    });

    const transitions: AppliedTransition[] = [
      { tenantId: testTenantId, contactId, fromState: "engaged", toState: "at_risk" },
    ];

    const result = await phaseEnrollment(db, transitions, NOW);

    expect(result.enrollmentsSucceeded).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Suppression tests
// ---------------------------------------------------------------------------

describe("enrollment - suppression blocks enrollment", () => {
  it("does not enroll a suppressed contact", async () => {
    if (!dbAvailable) return;

    const contactId = await insertContact("enroll_suppressed", "suppressed@example.com");
    await insertFlow({
      name: "Suppression test flow",
      triggerType: "lifecycle_transition",
      triggerConfig: { from: "engaged", to: "at_risk" },
    });

    // Add the contact's email to suppressions
    await db.insert(suppressions).values({
      tenantId: testTenantId,
      email: "suppressed@example.com",
      reason: "unsubscribe",
      source: "one_click",
    });

    const transitions: AppliedTransition[] = [
      { tenantId: testTenantId, contactId, fromState: "engaged", toState: "at_risk" },
    ];

    const result = await phaseEnrollment(db, transitions, NOW);

    expect(result.enrollmentsSucceeded).toBe(0);
    const memberships = await getActiveMemberships(contactId);
    expect(memberships).toHaveLength(0);
  });

  it("enrolls a contact with no email (suppression check inapplicable)", async () => {
    if (!dbAvailable) return;

    const contactId = await insertContact("enroll_no_email"); // no email
    await insertFlow({
      name: "No-email flow",
      triggerType: "lifecycle_transition",
      triggerConfig: { from: "engaged", to: "at_risk" },
    });

    const transitions: AppliedTransition[] = [
      { tenantId: testTenantId, contactId, fromState: "engaged", toState: "at_risk" },
    ];

    const result = await phaseEnrollment(db, transitions, NOW);

    expect(result.enrollmentsSucceeded).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Nurture concurrency tests
// ---------------------------------------------------------------------------

describe("enrollment - nurture class concurrency", () => {
  it("blocks enrollment when an existing nurture membership has equal or higher priority", async () => {
    if (!dbAvailable) return;

    const contactId = await insertContact("enroll_nurture_block");
    const existingFlowId = await insertFlow({
      name: "Existing nurture",
      triggerType: "lifecycle_transition",
      triggerConfig: { from: "at_risk", to: "dormant" },
      priority: 10,
      flowClass: "nurture",
    });

    // Manually enroll in existing flow
    await db.insert(flowMemberships).values({
      tenantId: testTenantId,
      contactId,
      flowId: existingFlowId,
      status: "active",
      enteredAt: new Date("2026-07-15T00:00:00Z"),
    });

    // New nurture flow with lower priority triggers
    await insertFlow({
      name: "Lower priority nurture",
      triggerType: "lifecycle_transition",
      triggerConfig: { from: "engaged", to: "at_risk" },
      priority: 5,
      flowClass: "nurture",
    });

    const transitions: AppliedTransition[] = [
      { tenantId: testTenantId, contactId, fromState: "engaged", toState: "at_risk" },
    ];

    const result = await phaseEnrollment(db, transitions, NOW);

    expect(result.enrollmentsSucceeded).toBe(0);
    // Only the original membership should exist
    const active = await getActiveMemberships(contactId);
    expect(active).toHaveLength(1);
    expect(active[0]!.flowId).toBe(existingFlowId);
  });

  it("evicts existing nurture membership when new flow has higher priority", async () => {
    if (!dbAvailable) return;

    const contactId = await insertContact("enroll_eviction");
    const lowFlowId = await insertFlow({
      name: "Low priority nurture",
      triggerType: "lifecycle_transition",
      triggerConfig: { from: "at_risk", to: "dormant" },
      priority: 3,
      flowClass: "nurture",
    });

    // Manually enroll in low-priority flow
    await db.insert(flowMemberships).values({
      tenantId: testTenantId,
      contactId,
      flowId: lowFlowId,
      status: "active",
      enteredAt: new Date("2026-07-15T00:00:00Z"),
    });

    // Higher priority nurture flow triggers
    const highFlowId = await insertFlow({
      name: "High priority nurture",
      triggerType: "lifecycle_transition",
      triggerConfig: { from: "engaged", to: "at_risk" },
      priority: 10,
      flowClass: "nurture",
    });

    const transitions: AppliedTransition[] = [
      { tenantId: testTenantId, contactId, fromState: "engaged", toState: "at_risk" },
    ];

    const result = await phaseEnrollment(db, transitions, NOW);

    expect(result.enrollmentsSucceeded).toBe(1);
    expect(result.evictions).toBe(1);

    const active = await getActiveMemberships(contactId);
    expect(active).toHaveLength(1);
    expect(active[0]!.flowId).toBe(highFlowId);

    // Evicted membership should be exited with priority_override
    const all = await getAllMemberships(contactId);
    const evicted = all.find((m) => m.flowId === lowFlowId);
    expect(evicted).toBeDefined();
    expect(evicted!.status).toBe("exited");
    expect(evicted!.exitReason).toBe("priority_override");
    expect(evicted!.exitedAt).not.toBeNull();
  });

  it("critical flows bypass nurture concurrency", async () => {
    if (!dbAvailable) return;

    const contactId = await insertContact("enroll_critical_bypass");
    const nurtureFlowId = await insertFlow({
      name: "Active nurture",
      triggerType: "lifecycle_transition",
      triggerConfig: { from: "at_risk", to: "dormant" },
      priority: 10,
      flowClass: "nurture",
    });

    // Enroll in nurture flow
    await db.insert(flowMemberships).values({
      tenantId: testTenantId,
      contactId,
      flowId: nurtureFlowId,
      status: "active",
      enteredAt: new Date("2026-07-15T00:00:00Z"),
    });

    // Critical flow triggers - should enroll without evicting nurture
    const criticalFlowId = await insertFlow({
      name: "Dunning",
      triggerType: "lifecycle_transition",
      triggerConfig: { from: "engaged", to: "at_risk" },
      priority: 1,
      flowClass: "critical",
    });

    const transitions: AppliedTransition[] = [
      { tenantId: testTenantId, contactId, fromState: "engaged", toState: "at_risk" },
    ];

    const result = await phaseEnrollment(db, transitions, NOW);

    expect(result.enrollmentsSucceeded).toBe(1);
    expect(result.evictions).toBe(0);

    // Both memberships should be active
    const active = await getActiveMemberships(contactId);
    expect(active).toHaveLength(2);
    const flowIds = active.map((m) => m.flowId);
    expect(flowIds).toContain(nurtureFlowId);
    expect(flowIds).toContain(criticalFlowId);
  });
});

// ---------------------------------------------------------------------------
// Re-entry policy tests
// ---------------------------------------------------------------------------

describe("enrollment - re-entry policy", () => {
  it("once: blocks re-entry when a prior membership exists", async () => {
    if (!dbAvailable) return;

    const contactId = await insertContact("reentry_once");
    const flowId = await insertFlow({
      name: "Once-only flow",
      triggerType: "lifecycle_transition",
      triggerConfig: { from: "engaged", to: "at_risk" },
      reentryPolicy: "once",
    });

    // Insert a completed prior membership
    await db.insert(flowMemberships).values({
      tenantId: testTenantId,
      contactId,
      flowId,
      status: "completed",
      enteredAt: new Date("2026-06-01T00:00:00Z"),
      completedAt: new Date("2026-06-10T00:00:00Z"),
      exitReason: "completed",
    });

    const transitions: AppliedTransition[] = [
      { tenantId: testTenantId, contactId, fromState: "engaged", toState: "at_risk" },
    ];

    const result = await phaseEnrollment(db, transitions, NOW);
    expect(result.enrollmentsSucceeded).toBe(0);
  });

  it("cooldown: blocks re-entry within cooldown period", async () => {
    if (!dbAvailable) return;

    const contactId = await insertContact("reentry_cooldown_block");
    const flowId = await insertFlow({
      name: "Cooldown flow",
      triggerType: "lifecycle_transition",
      triggerConfig: { from: "engaged", to: "at_risk" },
      reentryPolicy: "cooldown",
      reentryCooldownDays: 30,
    });

    // Prior membership completed 10 days ago (within 30-day cooldown)
    await db.insert(flowMemberships).values({
      tenantId: testTenantId,
      contactId,
      flowId,
      status: "completed",
      enteredAt: new Date("2026-07-01T00:00:00Z"),
      completedAt: new Date("2026-07-10T00:00:00Z"), // 10 days before NOW
      exitReason: "completed",
    });

    const transitions: AppliedTransition[] = [
      { tenantId: testTenantId, contactId, fromState: "engaged", toState: "at_risk" },
    ];

    const result = await phaseEnrollment(db, transitions, NOW);
    expect(result.enrollmentsSucceeded).toBe(0);
  });

  it("cooldown: allows re-entry after cooldown period expires", async () => {
    if (!dbAvailable) return;

    const contactId = await insertContact("reentry_cooldown_pass");
    const flowId = await insertFlow({
      name: "Cooldown expired flow",
      triggerType: "lifecycle_transition",
      triggerConfig: { from: "engaged", to: "at_risk" },
      reentryPolicy: "cooldown",
      reentryCooldownDays: 30,
    });

    // Prior membership completed 31 days ago (past 30-day cooldown)
    await db.insert(flowMemberships).values({
      tenantId: testTenantId,
      contactId,
      flowId,
      status: "completed",
      enteredAt: new Date("2026-06-01T00:00:00Z"),
      completedAt: new Date("2026-06-19T00:00:00Z"), // 31 days before NOW (Jul 20)
      exitReason: "completed",
    });

    const transitions: AppliedTransition[] = [
      { tenantId: testTenantId, contactId, fromState: "engaged", toState: "at_risk" },
    ];

    const result = await phaseEnrollment(db, transitions, NOW);
    expect(result.enrollmentsSucceeded).toBe(1);
  });

  it("cooldown: priority_override exit does NOT consume cooldown", async () => {
    if (!dbAvailable) return;

    const contactId = await insertContact("reentry_override_waive");
    const flowId = await insertFlow({
      name: "Cooldown waive flow",
      triggerType: "lifecycle_transition",
      triggerConfig: { from: "engaged", to: "at_risk" },
      reentryPolicy: "cooldown",
      reentryCooldownDays: 30,
    });

    // Prior membership was evicted 5 days ago (within cooldown, but exit is priority_override)
    await db.insert(flowMemberships).values({
      tenantId: testTenantId,
      contactId,
      flowId,
      status: "exited",
      enteredAt: new Date("2026-07-10T00:00:00Z"),
      exitedAt: new Date("2026-07-15T00:00:00Z"), // 5 days before NOW
      exitReason: "priority_override",
    });

    const transitions: AppliedTransition[] = [
      { tenantId: testTenantId, contactId, fromState: "engaged", toState: "at_risk" },
    ];

    const result = await phaseEnrollment(db, transitions, NOW);
    expect(result.enrollmentsSucceeded).toBe(1);
  });

  it("every_time: always allows re-entry", async () => {
    if (!dbAvailable) return;

    const contactId = await insertContact("reentry_everytime");
    const flowId = await insertFlow({
      name: "Every-time flow",
      triggerType: "lifecycle_transition",
      triggerConfig: { from: "engaged", to: "at_risk" },
      reentryPolicy: "every_time",
    });

    // Prior membership completed yesterday
    await db.insert(flowMemberships).values({
      tenantId: testTenantId,
      contactId,
      flowId,
      status: "completed",
      enteredAt: new Date("2026-07-18T00:00:00Z"),
      completedAt: new Date("2026-07-19T00:00:00Z"),
      exitReason: "completed",
    });

    const transitions: AppliedTransition[] = [
      { tenantId: testTenantId, contactId, fromState: "engaged", toState: "at_risk" },
    ];

    const result = await phaseEnrollment(db, transitions, NOW);
    expect(result.enrollmentsSucceeded).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Event trigger tests (via handleTriggerCheck)
// ---------------------------------------------------------------------------

describe("handleTriggerCheck - event-triggered enrollment", () => {
  it("enrolls a contact when an event-trigger flow matches", async () => {
    if (!dbAvailable) return;

    const contactId = await insertContact("trigger_check_1");
    const flowId = await insertFlow({
      name: "Plan upgraded flow",
      triggerType: "event",
      triggerConfig: { event: "plan_upgraded" },
    });

    await handleTriggerCheck(
      { tenant_id: testTenantId, contact_id: contactId, event_name: "plan_upgraded" },
      db,
    );

    const memberships = await getActiveMemberships(contactId);
    expect(memberships).toHaveLength(1);
    expect(memberships[0]!.flowId).toBe(flowId);
  });

  it("does not enroll when event name does not match", async () => {
    if (!dbAvailable) return;

    const contactId = await insertContact("trigger_check_no_match");
    await insertFlow({
      name: "Plan upgraded only",
      triggerType: "event",
      triggerConfig: { event: "plan_upgraded" },
    });

    await handleTriggerCheck(
      { tenant_id: testTenantId, contact_id: contactId, event_name: "feature_used" },
      db,
    );

    const memberships = await getActiveMemberships(contactId);
    expect(memberships).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// PgGate concurrency tests
// ---------------------------------------------------------------------------

const GATE_LOCK_ID = 799_400; // unique within the test DB, different from scan tests

class PgGate {
  private controlClient: pg.Client;
  private url: string;
  private n: number;

  constructor(url: string, n: number) {
    this.url = url;
    this.n = n;
    this.controlClient = new pg.Client({ connectionString: url });
  }

  async lock(): Promise<void> {
    await this.controlClient.connect();
    await this.controlClient.query("SELECT pg_advisory_lock($1)", [GATE_LOCK_ID]);
  }

  async waitForAllBlocked(): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const result = await this.controlClient.query(
        `SELECT count(*)::int AS n
         FROM pg_stat_activity
         WHERE wait_event_type = 'Lock'
           AND wait_event = 'advisory'
           AND datname = current_database()
           AND pid != pg_backend_pid()`,
      );
      if (result.rows[0].n >= this.n) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(
      `PgGate: timed out waiting for ${this.n} callers to block on advisory lock`,
    );
  }

  async release(): Promise<void> {
    await this.controlClient.query("SELECT pg_advisory_unlock($1)", [GATE_LOCK_ID]);
  }

  async close(): Promise<void> {
    await this.controlClient.end();
  }

  callerFn<T>(workFn: () => Promise<T>) {
    return async (): Promise<{ result: T; unblockTime: Date }> => {
      const client = new pg.Client({ connectionString: this.url });
      await client.connect();
      await client.query("SELECT pg_advisory_lock_shared($1)", [GATE_LOCK_ID]);
      const tsResult = await client.query("SELECT clock_timestamp() AS ts");
      const unblockTime = tsResult.rows[0].ts as Date;
      try {
        const result = await workFn();
        return { result, unblockTime };
      } finally {
        await client.query("SELECT pg_advisory_unlock_shared($1)", [GATE_LOCK_ID]);
        await client.end();
      }
    };
  }
}

function assertOverlap(times: Date[], label: string): void {
  const sorted = times.map((t) => t.getTime()).sort((a, b) => a - b);
  const spreadMs = sorted[sorted.length - 1]! - sorted[0]!;
  if (spreadMs > 200) {
    throw new Error(
      `[${label}] Overlap not achieved: spread=${spreadMs}ms (threshold=200ms).`,
    );
  }
}

describe("concurrency: two scans enrolling the same contact into the same flow", () => {
  it("ON CONFLICT DO NOTHING ensures exactly one membership", async () => {
    if (!dbAvailable) return;

    const contactId = await insertContact("race_same_flow");
    const flowId = await insertFlow({
      name: "Race same flow",
      triggerType: "lifecycle_transition",
      triggerConfig: { from: "engaged", to: "at_risk" },
    });

    const transitions: AppliedTransition[] = [
      { tenantId: testTenantId, contactId, fromState: "engaged", toState: "at_risk" },
    ];

    const gate = new PgGate(TEST_DB_URL!, 2);
    await gate.lock();

    const callerA = gate.callerFn(async () => phaseEnrollment(db, transitions, NOW));
    const callerB = gate.callerFn(async () => phaseEnrollment(db, transitions, NOW));

    const promises = [callerA(), callerB()];
    await gate.waitForAllBlocked();
    await gate.release();

    const results = await Promise.all(promises);
    assertOverlap(results.map((r) => r.unblockTime), "two-scans-same-flow");

    // Exactly one active membership
    const active = await getActiveMemberships(contactId);
    expect(active).toHaveLength(1);
    expect(active[0]!.flowId).toBe(flowId);

    // Exactly one total enrollment succeeded across both callers
    const totalSucceeded =
      results[0]!.result.enrollmentsSucceeded + results[1]!.result.enrollmentsSucceeded;
    expect(totalSucceeded).toBe(1);

    await gate.close();
  });
});

describe("concurrency: scan + trigger-check racing on different nurture flows", () => {
  it("advisory lock ensures exactly one active nurture membership (higher priority wins)", async () => {
    if (!dbAvailable) return;

    const contactId = await insertContact("race_nurture_priority");

    // Flow A: lifecycle-transition trigger, priority 5
    const flowAId = await insertFlow({
      name: "Low Priority Nurture",
      triggerType: "lifecycle_transition",
      triggerConfig: { from: "engaged", to: "at_risk" },
      priority: 5,
      flowClass: "nurture",
    });

    // Flow B: event trigger, priority 10
    const flowBId = await insertFlow({
      name: "High Priority Nurture",
      triggerType: "event",
      triggerConfig: { event: "plan_downgraded" },
      priority: 10,
      flowClass: "nurture",
    });

    const transitions: AppliedTransition[] = [
      { tenantId: testTenantId, contactId, fromState: "engaged", toState: "at_risk" },
    ];

    const gate = new PgGate(TEST_DB_URL!, 2);
    await gate.lock();

    // Caller A: scan phase 2 (tries to enroll in flow A, priority 5)
    const callerA = gate.callerFn(async () => phaseEnrollment(db, transitions, NOW));

    // Caller B: trigger-check (tries to enroll in flow B, priority 10)
    const callerB = gate.callerFn(async () =>
      handleTriggerCheck(
        { tenant_id: testTenantId, contact_id: contactId, event_name: "plan_downgraded" },
        db,
      ),
    );

    const promises = [callerA(), callerB()];
    await gate.waitForAllBlocked();
    await gate.release();

    const results = await Promise.all(promises);
    assertOverlap(results.map((r) => r.unblockTime), "scan-vs-trigger-check");

    // Exactly one active nurture membership
    const active = await getActiveMemberships(contactId);
    const activeNurture = [];
    for (const m of active) {
      const flowRow = await db
        .select({ flowClass: flows.flowClass })
        .from(flows)
        .where(eq(flows.id, m.flowId))
        .limit(1);
      if (flowRow[0]?.flowClass === "nurture") {
        activeNurture.push(m);
      }
    }
    expect(activeNurture).toHaveLength(1);

    // The winner should be flow B (higher priority)
    expect(activeNurture[0]!.flowId).toBe(flowBId);

    await gate.close();
  });
});

describe("concurrency: re-entry cooldown at boundary by two callers", () => {
  it("ON CONFLICT DO NOTHING ensures at most one enrollment", async () => {
    if (!dbAvailable) return;

    const contactId = await insertContact("race_reentry");
    const flowId = await insertFlow({
      name: "Cooldown boundary flow",
      triggerType: "lifecycle_transition",
      triggerConfig: { from: "engaged", to: "at_risk" },
      reentryPolicy: "cooldown",
      reentryCooldownDays: 30,
    });

    // Prior membership completed exactly 30 days ago (at the boundary)
    await db.insert(flowMemberships).values({
      tenantId: testTenantId,
      contactId,
      flowId,
      status: "completed",
      enteredAt: new Date("2026-06-01T00:00:00Z"),
      completedAt: new Date("2026-06-20T12:00:00Z"), // exactly 30 days before NOW
      exitReason: "completed",
    });

    const transitions: AppliedTransition[] = [
      { tenantId: testTenantId, contactId, fromState: "engaged", toState: "at_risk" },
    ];

    const gate = new PgGate(TEST_DB_URL!, 2);
    await gate.lock();

    const callerA = gate.callerFn(async () => phaseEnrollment(db, transitions, NOW));
    const callerB = gate.callerFn(async () => phaseEnrollment(db, transitions, NOW));

    const promises = [callerA(), callerB()];
    await gate.waitForAllBlocked();
    await gate.release();

    const results = await Promise.all(promises);
    assertOverlap(results.map((r) => r.unblockTime), "reentry-cooldown-boundary");

    // At most one active membership (ON CONFLICT DO NOTHING catches the second)
    const active = await getActiveMemberships(contactId);
    expect(active.length).toBeLessThanOrEqual(1);

    // Exactly one enrollment succeeded across both callers
    const totalSucceeded =
      results[0]!.result.enrollmentsSucceeded + results[1]!.result.enrollmentsSucceeded;
    expect(totalSucceeded).toBe(1);

    await gate.close();
  });
});
