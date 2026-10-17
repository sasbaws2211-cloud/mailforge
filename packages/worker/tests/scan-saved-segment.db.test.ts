/**
 * Flows that start from a saved segment (scan phase 2b, saved-segment path).
 *
 * The scan finds a segment's members by running its rules as a query, and leaves out contacts the enrollment
 * guards would only turn away, so the per-scan cap goes to contacts who can enroll. The guards still decide.
 * The last test proves the two agree: the query never leaves out someone the guards would have enrolled, and
 * (so no attempt is wasted) never lets through someone they would have refused.
 *
 * Requires local Postgres (see enrollment.db.test.ts for DATABASE_URL).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { and, eq, sql } from "drizzle-orm";
import { tenants, contacts, events, flows, flowMemberships, segments, suppressions } from "@loomail/db/schema";
import { phaseSegmentEnrollment } from "../src/scan-segment-enrollment.js";
import { enrollContactInFlows } from "../src/enroll.js";

const TEST_DB_URL = process.env.DATABASE_URL;
if (!TEST_DB_URL) throw new Error("[scan-saved-segment.test] DATABASE_URL is not set (see enrollment.db.test.ts).");

const SLUG = "test-saved-segment-scan";
const SLUG_OTHER = "test-saved-segment-scan-other";
const DAY = 86_400_000;

let pool: pg.Pool;
let db: ReturnType<typeof drizzle>;
let dbAvailable = false;
let tenantId: string;
let otherTenantId: string;

const TABLES = ["flow_memberships", "events", "suppressions", "flows", "segments", "contacts"];
async function cleanup() {
  for (const table of TABLES) {
    await db.execute(sql.raw(`DELETE FROM ${table} WHERE tenant_id IN (SELECT id FROM tenants WHERE slug IN ('${SLUG}', '${SLUG_OTHER}'))`));
  }
  await db.execute(sql.raw(`DELETE FROM scan_checkpoints WHERE tenant_id IN (SELECT id FROM tenants WHERE slug IN ('${SLUG}', '${SLUG_OTHER}'))`));
  await db.execute(sql.raw(`DELETE FROM tenants WHERE slug IN ('${SLUG}', '${SLUG_OTHER}')`));
}

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: TEST_DB_URL, connectionTimeoutMillis: 3000 });
  try {
    await pool.query("SELECT 1");
    db = drizzle(pool);
    dbAvailable = true;
  } catch {
    console.warn("[scan-saved-segment.test] DATABASE_URL not reachable - tests skipped.");
    return;
  }
  await cleanup();
  const [t] = await db.insert(tenants).values({ name: "Saved segment scan", slug: SLUG, plan: "free" }).returning({ id: tenants.id });
  const [o] = await db.insert(tenants).values({ name: "Saved segment scan other", slug: SLUG_OTHER, plan: "free" }).returning({ id: tenants.id });
  tenantId = t!.id;
  otherTenantId = o!.id;
});

beforeEach(async () => {
  if (!dbAvailable) return;
  for (const table of TABLES) {
    await db.execute(sql.raw(`DELETE FROM ${table} WHERE tenant_id IN ('${tenantId}', '${otherTenantId}')`));
  }
});

afterAll(async () => {
  if (dbAvailable) await cleanup();
  await pool.end();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const paidRules = { match: "all", rules: [{ field: "payment_status", op: "is", value: "paid" }] };
let n = 0;

async function insertSegment(definition: unknown = paidRules, opts: { archived?: boolean; owner?: string } = {}) {
  const [row] = await db
    .insert(segments)
    .values({
      tenantId: opts.owner ?? tenantId,
      name: `segment ${Date.now()}-${++n}`,
      definition,
      archivedAt: opts.archived ? new Date() : null,
    })
    .returning({ id: segments.id });
  return row!.id;
}

async function insertContact(opts: { paymentStatus?: string; email?: string | null; owner?: string; properties?: unknown } = {}) {
  const [row] = await db
    .insert(contacts)
    .values({
      tenantId: opts.owner ?? tenantId,
      externalId: `c${Date.now()}-${++n}`,
      lifecycleState: "engaged",
      paymentStatus: opts.paymentStatus ?? "paid",
      email: opts.email === undefined ? `c${n}-${Date.now()}@seg.test` : opts.email,
      properties: (opts.properties as Record<string, unknown>) ?? null,
      firstSeenAt: new Date(Date.now() - 30 * DAY),
      lastSeenAt: new Date(Date.now() - DAY),
    })
    .returning({ id: contacts.id, email: contacts.email });
  return row!;
}

async function insertFlow(opts: {
  triggerConfig: unknown;
  priority?: number;
  flowClass?: string;
  reentryPolicy?: string;
  cooldownDays?: number;
  status?: string;
  triggerType?: string;
}) {
  const [row] = await db
    .insert(flows)
    .values({
      tenantId,
      name: `flow ${Date.now()}-${++n}`,
      triggerType: opts.triggerType ?? "segment",
      triggerConfig: opts.triggerConfig,
      steps: [{ order: 1, action_type: "nurture_value", delay: "0m", window_policy: "immediate" }],
      priority: opts.priority ?? 0,
      flowClass: opts.flowClass ?? "nurture",
      reentryPolicy: opts.reentryPolicy ?? "cooldown",
      reentryCooldownDays: opts.cooldownDays ?? 30,
      status: opts.status ?? "active",
      compileStatus: "ready",
      compiledPlan: { steps: [{ order: 1 }] },
    })
    .returning({ id: flows.id });
  return row!.id;
}

const segmentFlow = (segmentId: string, extra: Parameters<typeof insertFlow>[0] extends infer O ? Partial<O> : never = {}) =>
  insertFlow({ triggerConfig: { segment_id: segmentId }, ...extra });

async function insertMembership(opts: {
  contactId: string;
  flowId: string;
  status: "active" | "completed" | "exited";
  endedDaysAgo?: number;
  exitReason?: string;
}) {
  const ended = opts.endedDaysAgo === undefined ? null : new Date(Date.now() - opts.endedDaysAgo * DAY);
  await db.insert(flowMemberships).values({
    tenantId,
    contactId: opts.contactId,
    flowId: opts.flowId,
    currentStep: 1,
    status: opts.status,
    enteredAt: new Date(Date.now() - ((opts.endedDaysAgo ?? 0) + 5) * DAY),
    completedAt: opts.status === "completed" ? ended : null,
    exitedAt: opts.status === "exited" ? ended : null,
    exitReason: opts.exitReason ?? (opts.status === "completed" ? "completed" : null),
  });
}

const activeIn = async (flowId: string) =>
  (await db.select({ contactId: flowMemberships.contactId }).from(flowMemberships).where(and(eq(flowMemberships.flowId, flowId), eq(flowMemberships.status, "active")))).map((r) => r.contactId);

const scan = () => phaseSegmentEnrollment(db as never, new Date(), [tenantId]);

// ---------------------------------------------------------------------------
// Who gets enrolled
// ---------------------------------------------------------------------------

describe("a flow that starts from a saved segment", () => {
  it("enrolls the members and not the others", async () => {
    if (!dbAvailable) return;
    const segmentId = await insertSegment();
    const flowId = await segmentFlow(segmentId);
    const members = [await insertContact(), await insertContact(), await insertContact()];
    await insertContact({ paymentStatus: "free" });
    await insertContact({ paymentStatus: "free" });

    const result = await scan();

    expect((await activeIn(flowId)).sort()).toEqual(members.map((m) => m.id).sort());
    expect(result).toMatchObject({ flowsEvaluated: 1, enrollmentsAttempted: 3, enrollmentsSucceeded: 3, flowsCapped: 0, flowsSkipped: 0 });
  });

  it("never enrolls another workspace's contacts, even ones the rules match", async () => {
    if (!dbAvailable) return;
    const flowId = await segmentFlow(await insertSegment());
    const mine = await insertContact();
    await insertContact({ owner: otherTenantId });
    await scan();
    expect(await activeIn(flowId)).toEqual([mine.id]);
  });

  it("running it again changes nothing: members already in the flow are not tried again", async () => {
    if (!dbAvailable) return;
    const flowId = await segmentFlow(await insertSegment());
    await insertContact();
    await insertContact();
    await scan();
    const again = await scan();
    expect(again.enrollmentsAttempted).toBe(0);
    expect(await activeIn(flowId)).toHaveLength(2);
  });

  it("uses the rules as they are now: editing the segment changes who enrolls on the next scan", async () => {
    if (!dbAvailable) return;
    const segmentId = await insertSegment();
    const flowId = await segmentFlow(segmentId);
    const free = await insertContact({ paymentStatus: "free" });
    await scan();
    expect(await activeIn(flowId)).toEqual([]);
    await db.update(segments).set({ definition: { match: "all", rules: [{ field: "payment_status", op: "is", value: "free" }] } }).where(eq(segments.id, segmentId));
    await scan();
    expect(await activeIn(flowId)).toEqual([free.id]);
  });

  it("works with traits and events in the rules", async () => {
    if (!dbAvailable) return;
    const segmentId = await insertSegment({
      match: "all",
      rules: [
        { field: "trait", key: "seats", op: "gt", value: 10 },
        { field: "event", name: "exported", op: "performed", within_days: 30 },
      ],
    });
    const flowId = await segmentFlow(segmentId);
    const yes = await insertContact({ properties: { seats: 25 } });
    const fewSeats = await insertContact({ properties: { seats: 3 } });
    const noEvent = await insertContact({ properties: { seats: 99 } });
    for (const c of [yes, fewSeats]) {
      await db.insert(events).values({ tenantId, contactId: c.id, type: "track", eventName: "exported", timestamp: new Date(Date.now() - 3 * DAY) });
    }
    void noEvent;
    await scan();
    expect(await activeIn(flowId)).toEqual([yes.id]);
  });

  it("runs next to a retention-cell flow in the same workspace; each gets its own people", async () => {
    if (!dbAvailable) return;
    const savedFlow = await segmentFlow(await insertSegment());
    const gridFlow = await insertFlow({ triggerConfig: { tenure_bucket: "growing", recency_bucket: "active" }, priority: 1 });
    const c = await insertContact(); // 30 days old, seen yesterday: inside growing/active, and paid
    const result = await scan();
    expect(result.flowsEvaluated).toBe(2);
    // the contact can be in only one nurture flow at a time; the higher-priority one (the retention cell) wins
    expect([...(await activeIn(savedFlow)), ...(await activeIn(gridFlow))]).toHaveLength(1);
    void c;
  });
});

// ---------------------------------------------------------------------------
// A segment that cannot run
// ---------------------------------------------------------------------------

describe("a segment that cannot be used", () => {
  it("an archived segment: the flow is skipped, nobody enrolls, and the scan says so", async () => {
    if (!dbAvailable) return;
    const flowId = await segmentFlow(await insertSegment(paidRules, { archived: true }));
    await insertContact();
    const result = await scan();
    expect(await activeIn(flowId)).toEqual([]);
    expect(result).toMatchObject({ flowsEvaluated: 1, flowsSkipped: 1, enrollmentsAttempted: 0 });
  });

  it("a segment that does not exist, or belongs to another workspace", async () => {
    if (!dbAvailable) return;
    await segmentFlow("00000000-0000-0000-0000-000000000000");
    await segmentFlow(await insertSegment(paidRules, { owner: otherTenantId }));
    await insertContact();
    const result = await scan();
    expect(result).toMatchObject({ flowsSkipped: 2, enrollmentsSucceeded: 0 });
  });

  it("stored rules that no longer parse: skipped, not guessed at", async () => {
    if (!dbAvailable) return;
    const flowId = await segmentFlow(await insertSegment({ match: "all", rules: [{ field: "hair", op: "is", value: "red" }] }));
    await insertContact();
    const result = await scan();
    expect(await activeIn(flowId)).toEqual([]);
    expect(result.flowsSkipped).toBe(1);
  });

  it("one bad segment does not stop the next flow", async () => {
    if (!dbAvailable) return;
    await segmentFlow(await insertSegment(paidRules, { archived: true }));
    const good = await segmentFlow(await insertSegment(), { priority: 5 });
    await insertContact();
    const result = await scan();
    expect(result).toMatchObject({ flowsSkipped: 1, enrollmentsSucceeded: 1 });
    expect(await activeIn(good)).toHaveLength(1);
  });

  it("draft and uncompiled flows are ignored, as for retention cells", async () => {
    if (!dbAvailable) return;
    const segmentId = await insertSegment();
    await segmentFlow(segmentId, { status: "draft" });
    await insertContact();
    const result = await scan();
    expect(result.flowsEvaluated).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The pre-filter: contacts the guards would turn away are not even tried
// ---------------------------------------------------------------------------

describe("contacts the guards would refuse are left out of the query", () => {
  it("a suppressed address", async () => {
    if (!dbAvailable) return;
    const flowId = await segmentFlow(await insertSegment());
    const ok = await insertContact();
    const blocked = await insertContact();
    await db.insert(suppressions).values({ tenantId, email: blocked.email!, reason: "manual" });
    const result = await scan();
    expect(await activeIn(flowId)).toEqual([ok.id]);
    expect(result.enrollmentsAttempted).toBe(1); // the suppressed contact was never tried
  });

  it("re-entry 'once': anyone with a past membership", async () => {
    if (!dbAvailable) return;
    const flowId = await segmentFlow(await insertSegment(), { reentryPolicy: "once" });
    const before = await insertContact();
    const fresh = await insertContact();
    await insertMembership({ contactId: before.id, flowId, status: "completed", endedDaysAgo: 400 });
    const result = await scan();
    expect(await activeIn(flowId)).toEqual([fresh.id]);
    expect(result.enrollmentsAttempted).toBe(1);
  });

  it("re-entry cooldown: recent endings wait, old ones may return, a forced eviction does not count", async () => {
    if (!dbAvailable) return;
    const flowId = await segmentFlow(await insertSegment(), { reentryPolicy: "cooldown", cooldownDays: 30 });
    const recent = await insertContact();
    const old = await insertContact();
    const evicted = await insertContact();
    const never = await insertContact();
    await insertMembership({ contactId: recent.id, flowId, status: "completed", endedDaysAgo: 5 });
    await insertMembership({ contactId: old.id, flowId, status: "completed", endedDaysAgo: 40 });
    await insertMembership({ contactId: evicted.id, flowId, status: "exited", endedDaysAgo: 2, exitReason: "priority_override" });
    const result = await scan();
    expect((await activeIn(flowId)).sort()).toEqual([old.id, evicted.id, never.id].sort());
    expect(result.enrollmentsAttempted).toBe(3);
  });

  it("re-entry 'every time': past memberships never block", async () => {
    if (!dbAvailable) return;
    const flowId = await segmentFlow(await insertSegment(), { reentryPolicy: "every_time" });
    const c = await insertContact();
    await insertMembership({ contactId: c.id, flowId, status: "completed", endedDaysAgo: 0.1 });
    await scan();
    expect(await activeIn(flowId)).toEqual([c.id]);
  });

  it("a running nurture flow of equal or higher priority; a lower one is evicted; a critical flow is not held back", async () => {
    if (!dbAvailable) return;
    const other = await insertFlow({ triggerConfig: { event: "x" }, triggerType: "event", priority: 5 });
    const flowId = await segmentFlow(await insertSegment(), { priority: 5 });
    const equal = await insertContact();
    const lowerRunning = await insertContact();
    const free = await insertContact();
    const lowFlow = await insertFlow({ triggerConfig: { event: "y" }, triggerType: "event", priority: 1 });
    await insertMembership({ contactId: equal.id, flowId: other, status: "active" });
    await insertMembership({ contactId: lowerRunning.id, flowId: lowFlow, status: "active" });
    const result = await scan();
    expect((await activeIn(flowId)).sort()).toEqual([lowerRunning.id, free.id].sort());
    expect(result.enrollmentsAttempted).toBe(2); // the contact held by the equal-priority flow was never tried
    expect(await activeIn(lowFlow)).toEqual([]); // evicted

    // a critical flow has no such limit
    const critical = await segmentFlow(await insertSegment(), { flowClass: "critical", priority: 0 });
    await scan();
    expect(await activeIn(critical)).toContain(equal.id);
  });

  it("does not starve: a crowd of blocked members cannot use up the cap and hide the ones who can enroll", async () => {
    if (!dbAvailable) return;
    const flowId = await segmentFlow(await insertSegment());
    const blocked = await db
      .insert(contacts)
      .values(Array.from({ length: 260 }, (_, i) => ({
        tenantId, externalId: `blocked-${i}`, lifecycleState: "engaged", paymentStatus: "paid", email: `blocked-${i}@seg.test`, lastSeenAt: new Date(),
      })))
      .returning({ email: contacts.email });
    await db.insert(suppressions).values(blocked.map((b) => ({ tenantId, email: b.email!, reason: "manual" })));
    const ok = [await insertContact(), await insertContact(), await insertContact()];
    const result = await scan();
    expect((await activeIn(flowId)).sort()).toEqual(ok.map((c) => c.id).sort());
    expect(result).toMatchObject({ enrollmentsAttempted: 3, flowsCapped: 0 });
  });
});

// ---------------------------------------------------------------------------
// The per-scan cap
// ---------------------------------------------------------------------------

describe("the per-scan cap", () => {
  it("enrolls up to 200 per scan and carries on at the next one", async () => {
    if (!dbAvailable) return;
    const flowId = await segmentFlow(await insertSegment());
    await db.insert(contacts).values(
      Array.from({ length: 230 }, (_, i) => ({
        tenantId, externalId: `crowd-${i}`, lifecycleState: "engaged", paymentStatus: "paid", email: `crowd-${i}@seg.test`, lastSeenAt: new Date(),
      })),
    );
    const first = await scan();
    expect(first).toMatchObject({ enrollmentsAttempted: 200, enrollmentsSucceeded: 200, flowsCapped: 1 });
    expect(await activeIn(flowId)).toHaveLength(200);
    const second = await scan();
    expect(second).toMatchObject({ enrollmentsSucceeded: 30, flowsCapped: 0 });
    expect(await activeIn(flowId)).toHaveLength(230);
  });
});

// ---------------------------------------------------------------------------
// The query and the guards agree
// ---------------------------------------------------------------------------

describe("the pre-filter and the enrollment guards agree", () => {
  it("over contacts in every combination of states: the same contacts enroll, and no attempt is wasted", async () => {
    if (!dbAvailable) return;
    const priority = 5;
    const flowId = await segmentFlow(await insertSegment(), { priority, reentryPolicy: "cooldown", cooldownDays: 30 });
    const highFlow = await insertFlow({ triggerConfig: { event: "h" }, triggerType: "event", priority: 9 });
    const equalFlow = await insertFlow({ triggerConfig: { event: "e" }, triggerType: "event", priority });
    const lowFlow = await insertFlow({ triggerConfig: { event: "l" }, triggerType: "event", priority: 1 });

    const history = [
      () => ({}),
      () => ({ status: "completed" as const, endedDaysAgo: 5 }),
      () => ({ status: "completed" as const, endedDaysAgo: 40 }),
      () => ({ status: "exited" as const, endedDaysAgo: 2, exitReason: "priority_override" }),
      () => ({ status: "exited" as const, endedDaysAgo: 10, exitReason: "condition_met" }),
      () => ({ status: "exited" as const, endedDaysAgo: 90, exitReason: "condition_met" }),
    ];
    const running = [null, highFlow, equalFlow, lowFlow];
    const created: string[] = [];
    let i = 0;
    for (const h of history) {
      for (const r of running) {
        for (const suppressed of [false, true]) {
          const c = await insertContact();
          created.push(c.id);
          const past = h();
          if ("status" in past) await insertMembership({ contactId: c.id, flowId, ...past });
          if (r) await insertMembership({ contactId: c.id, flowId: r, status: "active" });
          if (suppressed) await db.insert(suppressions).values({ tenantId, email: c.email!, reason: "manual" });
          i++;
        }
      }
    }
    expect(i).toBe(48);

    // The oracle: ask the guards about every contact, in a transaction that is rolled back each time.
    const would = new Set<string>();
    for (const id of created) {
      try {
        await db.transaction(async (tx) => {
          const res = await enrollContactInFlows(tx as never, id, tenantId, [
            { id: flowId, tenantId, priority, triggerType: "segment", triggerConfig: {}, flowClass: "nurture", reentryPolicy: "cooldown", reentryCooldownDays: 30 },
          ], new Date());
          if (res.some((r) => r.enrolled)) would.add(id);
          tx.rollback();
        });
      } catch (err) {
        if (!(err instanceof Error) || !/rollback/i.test(err.message)) throw err;
      }
    }
    expect(would.size).toBeGreaterThan(5);
    expect(would.size).toBeLessThan(created.length - 5);

    const result = await scan();
    const enrolled = new Set(await activeIn(flowId));
    expect([...enrolled].sort()).toEqual([...would].sort());
    // and every contact the query let through was one the guards accepted: nothing wasted
    expect(result.enrollmentsAttempted).toBe(would.size);
  });
});
