/**
 * Integration tests for segment-trigger enrollment (scan phase 2b).
 *
 * Tests:
 * - A contact inside the flow's retention-grid cell is enrolled
 * - Contacts outside the cell (wrong recency, wrong tenure) are not
 * - Re-running the phase does not duplicate an active membership
 * - Suppression blocks enrollment
 * - Re-entry policy 'once' blocks a contact with a prior membership
 * - Draft/uncompiled flows and malformed trigger_config are skipped
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
import { phaseSegmentEnrollment } from "../src/scan-segment-enrollment.js";

const TEST_DB_URL = process.env.DATABASE_URL;
if (!TEST_DB_URL) {
  const inCI = process.env.CI === "true";
  throw new Error(
    `[segment-enrollment.test] DATABASE_URL is not set.\n\n` +
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

const SLUG = "test-segment-enrollment";
const NOW = new Date("2026-07-20T12:00:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;

function daysAgo(n: number): Date {
  return new Date(NOW.getTime() - n * DAY_MS);
}

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
        `[segment-enrollment.test] DATABASE_URL not reachable in CI.\n` +
          `URL: ${TEST_DB_URL}\nCause: ${(err as Error).message}`,
      );
    }
    console.warn("[segment-enrollment.test] DATABASE_URL not reachable - tests skipped.");
    return;
  }

  await cleanup();

  // natural_frequency_days 7 (default): recency buckets are
  // active <7d, cooling 7-13d, idle 14-27d, dormant 28d+.
  const [tenant] = await db
    .insert(tenants)
    .values({ name: "Test Segment Enrollment", slug: SLUG, plan: "free" })
    .returning({ id: tenants.id });
  testTenantId = tenant!.id;
});

beforeEach(async () => {
  if (!dbAvailable) return;
  await db.execute(sql`DELETE FROM flow_memberships WHERE tenant_id = ${testTenantId}`);
  await db.execute(sql`DELETE FROM suppressions WHERE tenant_id = ${testTenantId}`);
  await db.execute(sql`DELETE FROM flows WHERE tenant_id = ${testTenantId}`);
  await db.execute(sql`DELETE FROM lifecycle_transitions WHERE contact_id IN (SELECT id FROM contacts WHERE tenant_id = ${testTenantId})`);
  await db.execute(sql`DELETE FROM contacts WHERE tenant_id = ${testTenantId}`);
});

afterAll(async () => {
  if (dbAvailable) {
    await cleanup();
  }
  await pool.end();
});

async function cleanup() {
  await db.execute(
    sql`DELETE FROM lifecycle_messages WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${SLUG})`,
  );
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
    sql`DELETE FROM lifecycle_transitions WHERE contact_id IN (SELECT id FROM contacts WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${SLUG}))`,
  );
  await db.execute(
    sql`DELETE FROM contacts WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${SLUG})`,
  );
  await db.execute(sql`DELETE FROM tenants WHERE slug = ${SLUG}`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function insertContact(opts: {
  externalId: string;
  email?: string;
  firstSeenDaysAgo: number;
  lastSeenDaysAgo: number;
}): Promise<string> {
  const [row] = await db
    .insert(contacts)
    .values({
      tenantId: testTenantId,
      externalId: opts.externalId,
      lifecycleState: "engaged",
      firstSeenAt: daysAgo(opts.firstSeenDaysAgo),
      lastSeenAt: daysAgo(opts.lastSeenDaysAgo),
      email: opts.email ?? null,
    })
    .returning({ id: contacts.id });
  return row!.id;
}

async function insertSegmentFlow(opts: {
  name: string;
  triggerConfig: unknown;
  reentryPolicy?: string;
  status?: string;
  compileStatus?: string;
}): Promise<string> {
  const [row] = await db
    .insert(flows)
    .values({
      tenantId: testTenantId,
      name: opts.name,
      triggerType: "segment",
      triggerConfig: opts.triggerConfig,
      steps: [{ order: 1, action_type: "nurture_value", delay: "0m", window_policy: "immediate" }],
      priority: 0,
      flowClass: "nurture",
      reentryPolicy: opts.reentryPolicy ?? "cooldown",
      reentryCooldownDays: 30,
      status: opts.status ?? "active",
      compileStatus: opts.compileStatus ?? "ready",
      compiledPlan: { steps: [{ order: 1 }] },
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("database availability sentinel", () => {
  it("database unavailable: integration tests skipped", () => {
    if (dbAvailable) return;
    console.warn("[segment-enrollment.test] All DB integration tests skipped.");
  });
});

describe("phaseSegmentEnrollment", () => {
  it("enrolls a contact inside the flow's cell", async () => {
    if (!dbAvailable) return;

    // new (10d tenure) + active (2d quiet) with default freq 7
    const contactId = await insertContact({
      externalId: "seg_in_cell",
      firstSeenDaysAgo: 10,
      lastSeenDaysAgo: 2,
    });
    const flowId = await insertSegmentFlow({
      name: "New active welcome",
      triggerConfig: { tenure_bucket: "new", recency_bucket: "active" },
    });

    const result = await phaseSegmentEnrollment(db, NOW, [testTenantId]);

    expect(result.flowsEvaluated).toBe(1);
    expect(result.enrollmentsSucceeded).toBe(1);
    const memberships = await getActiveMemberships(contactId);
    expect(memberships).toHaveLength(1);
    expect(memberships[0]!.flowId).toBe(flowId);
  });

  it("does not enroll contacts outside the cell", async () => {
    if (!dbAvailable) return;

    // cooling (10d quiet) - outside the (new, active) cell
    const coolingId = await insertContact({
      externalId: "seg_cooling",
      firstSeenDaysAgo: 10,
      lastSeenDaysAgo: 10,
    });
    // loyal (200d tenure) - wrong tenure even though active
    const loyalId = await insertContact({
      externalId: "seg_loyal",
      firstSeenDaysAgo: 200,
      lastSeenDaysAgo: 1,
    });
    await insertSegmentFlow({
      name: "New active welcome",
      triggerConfig: { tenure_bucket: "new", recency_bucket: "active" },
    });

    const result = await phaseSegmentEnrollment(db, NOW, [testTenantId]);

    expect(result.enrollmentsSucceeded).toBe(0);
    expect(await getActiveMemberships(coolingId)).toHaveLength(0);
    expect(await getActiveMemberships(loyalId)).toHaveLength(0);
  });

  it("re-running does not duplicate an active membership", async () => {
    if (!dbAvailable) return;

    const contactId = await insertContact({
      externalId: "seg_rerun",
      firstSeenDaysAgo: 10,
      lastSeenDaysAgo: 2,
    });
    await insertSegmentFlow({
      name: "New active welcome",
      triggerConfig: { tenure_bucket: "new", recency_bucket: "active" },
    });

    await phaseSegmentEnrollment(db, NOW, [testTenantId]);
    const second = await phaseSegmentEnrollment(db, NOW, [testTenantId]);

    expect(second.enrollmentsSucceeded).toBe(0);
    expect(await getActiveMemberships(contactId)).toHaveLength(1);
  });

  it("suppression blocks enrollment", async () => {
    if (!dbAvailable) return;

    const contactId = await insertContact({
      externalId: "seg_suppressed",
      email: "seg-suppressed@example.com",
      firstSeenDaysAgo: 10,
      lastSeenDaysAgo: 2,
    });
    await db.insert(suppressions).values({
      tenantId: testTenantId,
      email: "seg-suppressed@example.com",
      reason: "unsubscribed",
      source: "manual",
    });
    await insertSegmentFlow({
      name: "New active welcome",
      triggerConfig: { tenure_bucket: "new", recency_bucket: "active" },
    });

    const result = await phaseSegmentEnrollment(db, NOW, [testTenantId]);

    expect(result.enrollmentsSucceeded).toBe(0);
    expect(await getActiveMemberships(contactId)).toHaveLength(0);
  });

  it("re-entry policy 'once' blocks a contact with a prior membership", async () => {
    if (!dbAvailable) return;

    const contactId = await insertContact({
      externalId: "seg_once",
      firstSeenDaysAgo: 10,
      lastSeenDaysAgo: 2,
    });
    const flowId = await insertSegmentFlow({
      name: "New active welcome",
      triggerConfig: { tenure_bucket: "new", recency_bucket: "active" },
      reentryPolicy: "once",
    });
    // Prior completed membership in this flow
    await db.insert(flowMemberships).values({
      tenantId: testTenantId,
      contactId,
      flowId,
      currentStep: 1,
      status: "completed",
      enteredAt: daysAgo(5),
      completedAt: daysAgo(4),
      exitReason: "completed",
    });

    const result = await phaseSegmentEnrollment(db, NOW, [testTenantId]);

    expect(result.enrollmentsSucceeded).toBe(0);
    expect(await getActiveMemberships(contactId)).toHaveLength(0);
  });

  it("skips draft flows and malformed trigger_config", async () => {
    if (!dbAvailable) return;

    const contactId = await insertContact({
      externalId: "seg_skipped",
      firstSeenDaysAgo: 10,
      lastSeenDaysAgo: 2,
    });
    await insertSegmentFlow({
      name: "Draft segment flow",
      triggerConfig: { tenure_bucket: "new", recency_bucket: "active" },
      status: "draft",
    });
    await insertSegmentFlow({
      name: "Malformed segment flow",
      triggerConfig: { nonsense: true },
    });

    const result = await phaseSegmentEnrollment(db, NOW, [testTenantId]);

    expect(result.flowsEvaluated).toBe(0);
    expect(result.enrollmentsSucceeded).toBe(0);
    expect(await getActiveMemberships(contactId)).toHaveLength(0);
  });
});
