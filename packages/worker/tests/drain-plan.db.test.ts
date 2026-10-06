/**
 * Integration tests for plan enforcement in the drain: the monthly email
 * allowance and the "Sent with Mailforge" credit line for Free workspaces.
 *
 * Needs a reachable Postgres via DATABASE_URL, like the other *.db tests.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { eq, sql } from "drizzle-orm";
import { tenants, contacts, flows, flowMemberships, lifecycleMessages } from "@mailforge/db/schema";
import type { TransportAdapter, TransportSendParams, TransportSendResult } from "../src/transport.js";
import { makeDrainRunner } from "./drain-test-utils.js";

class RecordingAdapter implements TransportAdapter {
  sends: TransportSendParams[] = [];
  async send(p: TransportSendParams): Promise<TransportSendResult> {
    this.sends.push(p);
    return { success: true, providerMessageId: `rec-${p.messageId}` };
  }
}

const TEST_DB_URL = process.env.DATABASE_URL;
if (!TEST_DB_URL) throw new Error("[drain-plan.test] DATABASE_URL is not set.");

const SLUG = "test-drain-plan";
const SIGNING_KEY = "drain-plan-test-signing-key-do-not-use-in-production";
const NOW = new Date("2026-07-20T12:00:00Z");
const DAY = 86_400_000;

let pool: pg.Pool;
let db: ReturnType<typeof drizzle>;
let dbAvailable = false;
let tenantId: string;
let flowId: string;
let bulkContactId: string;
let bulkMembershipId: string;

function enforce(on: boolean): void {
  if (on) process.env.MAILFORGE_ENFORCE_PLANS = "true";
  else delete process.env.MAILFORGE_ENFORCE_PLANS;
}

async function wipe(): Promise<void> {
  const ids = (await db.execute<{ id: string }>(sql`SELECT id FROM tenants WHERE slug = ${SLUG}`)).rows.map((r) => r.id);
  for (const id of ids) {
    for (const t of ["lifecycle_messages", "flow_memberships", "flows", "lifecycle_transitions", "suppressions", "scan_checkpoints", "contacts"]) {
      await db.execute(sql.raw(`DELETE FROM ${t} WHERE ${t === "lifecycle_transitions" ? "contact_id IN (SELECT id FROM contacts WHERE tenant_id = '" + id + "')" : "tenant_id = '" + id + "'"}`));
    }
    await db.execute(sql`DELETE FROM tenants WHERE id = ${id}::uuid`);
  }
}

async function setPlan(plan: string, trialEndsAt: Date | null = null): Promise<void> {
  await db.execute(sql`UPDATE tenants SET plan = ${plan}, trial_ends_at = ${trialEndsAt} WHERE id = ${tenantId}::uuid`);
}

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: TEST_DB_URL, connectionTimeoutMillis: 3000 });
  try {
    await pool.query("SELECT 1");
    db = drizzle(pool);
    dbAvailable = true;
  } catch (err) {
    if (process.env.CI === "true") throw new Error(`[drain-plan.test] DATABASE_URL not reachable in CI: ${(err as Error).message}`);
    console.warn("[drain-plan.test] DATABASE_URL not reachable - tests skipped.");
    return;
  }
  await wipe();
  const [t] = await db
    .insert(tenants)
    .values({ name: "Drain Plan Co", slug: SLUG, plan: "free", settings: { postal_address: "1 Test St, Accra, Ghana" } })
    .returning({ id: tenants.id });
  tenantId = t!.id;
});

beforeEach(async () => {
  if (!dbAvailable) return;
  for (const t of ["lifecycle_messages", "flow_memberships", "flows", "suppressions"]) {
    await db.execute(sql.raw(`DELETE FROM ${t} WHERE tenant_id = '${tenantId}'`));
  }
  await db.execute(sql`DELETE FROM contacts WHERE tenant_id = ${tenantId}::uuid`);
  await setPlan("free");
  const [f] = await db
    .insert(flows)
    .values({
      tenantId,
      name: "plan-test",
      priority: 0,
      triggerType: "lifecycle_transition",
      triggerConfig: { from: "engaged", to: "at_risk" },
      steps: [{ order: 1, action_type: "nurture_value", delay: "0d", window_policy: "immediate" }],
      status: "paused",
      flowClass: "nurture",
      compiledPlan: { trigger: { type: "lifecycle_transition", condition: {} }, steps: [{ order: 1, action_type: "nurture_value", delay: "0d", window_policy: "immediate" }] },
    })
    .returning({ id: flows.id });
  flowId = f!.id;
  // One contact + membership that holds all the "already sent this month" history.
  const [c] = await db
    .insert(contacts)
    .values({ tenantId, externalId: "history", email: "history@example.com", lifecycleState: "engaged", firstSeenAt: NOW, lastSeenAt: NOW })
    .returning({ id: contacts.id });
  bulkContactId = c!.id;
  const [m] = await db
    .insert(flowMemberships)
    .values({ tenantId, contactId: bulkContactId, flowId, currentStep: 1, status: "completed", enteredAt: NOW, completedAt: NOW, exitReason: "completed" })
    .returning({ id: flowMemberships.id });
  bulkMembershipId = m!.id;
});

afterEach(() => {
  enforce(false);
  delete process.env.MAILFORGE_SITE_URL;
});

afterAll(async () => {
  if (dbAvailable) await wipe();
  await pool?.end();
});

/** Insert `n` already-sent messages in the given instant's month (history that counts against the allowance). */
async function seedSent(n: number, sentAt: Date, status = "sent"): Promise<void> {
  if (n <= 0) return;
  await db.execute(sql`
    INSERT INTO lifecycle_messages (tenant_id, contact_id, flow_id, membership_id, flow_step_order, status, sent_at)
    SELECT ${tenantId}::uuid, ${bulkContactId}::uuid, ${flowId}::uuid, ${bulkMembershipId}::uuid,
           g + (SELECT COALESCE(MAX(flow_step_order), 0) FROM lifecycle_messages WHERE membership_id = ${bulkMembershipId}::uuid),
           ${status}, ${sentAt.toISOString()}::timestamptz
    FROM generate_series(1, ${n}) g`);
}

/** Queue `n` approved messages, each to its own contact so no per-contact cap interferes. Set-based, so large n is fast. */
async function queueApproved(n: number): Promise<string[]> {
  const tag = Math.random().toString(36).slice(2, 8);
  const r = await db.execute<{ id: string }>(sql`
    WITH c AS (
      INSERT INTO contacts (tenant_id, external_id, email, lifecycle_state, first_seen_at, last_seen_at)
      SELECT ${tenantId}::uuid, 'q-' || ${tag} || '-' || g, 'q-' || ${tag} || '-' || g || '@example.com', 'engaged', ${NOW.toISOString()}::timestamptz, ${NOW.toISOString()}::timestamptz
      FROM generate_series(1, ${n}) g RETURNING id
    ), m AS (
      INSERT INTO flow_memberships (tenant_id, contact_id, flow_id, current_step, status, entered_at, completed_at, exit_reason)
      SELECT ${tenantId}::uuid, c.id, ${flowId}::uuid, 1, 'completed', ${NOW.toISOString()}::timestamptz, ${NOW.toISOString()}::timestamptz, 'completed' FROM c RETURNING id, contact_id
    )
    INSERT INTO lifecycle_messages (tenant_id, contact_id, flow_id, membership_id, flow_step_order, status, subject, body_html, body_text, approved_at, created_at)
    SELECT ${tenantId}::uuid, m.contact_id, ${flowId}::uuid, m.id, 1, 'approved', 'Hello', '<p>Body</p>', 'Body', ${NOW.toISOString()}::timestamptz,
           ${NOW.toISOString()}::timestamptz + (row_number() OVER ())::int * interval '1 millisecond'
    FROM m RETURNING id`);
  return r.rows.map((x) => x.id);
}

const statuses = async (ids: string[]) =>
  (await db.select({ id: lifecycleMessages.id, status: lifecycleMessages.status }).from(lifecycleMessages).where(sql`${lifecycleMessages.id} IN (${sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `)})`)).map((r) => r.status);

function drain(adapter: TransportAdapter, now: Date = NOW) {
  return makeDrainRunner(db, tenantId, adapter, SIGNING_KEY, "http://localhost:3000")(now);
}

// ---------------------------------------------------------------------------

describe("monthly email allowance in the drain", () => {
  it("enforcement off: a Free tenant over 5,000 sent this month still sends", async () => {
    if (!dbAvailable) return;
    enforce(false);
    await seedSent(5_000, new Date("2026-07-05T00:00:00Z"));
    const ids = await queueApproved(2);
    const a = new RecordingAdapter();
    const r = await drain(a);
    expect(r.sent).toBe(2);
    expect(r.skippedPlanLimit).toBe(0);
    expect(await statuses(ids)).toEqual(["sent", "sent"]);
  });

  it("sends exactly up to the allowance and puts the rest back untouched", async () => {
    if (!dbAvailable) return;
    enforce(true);
    await seedSent(4_998, new Date("2026-07-05T00:00:00Z")); // 2 left of Free's 5,000
    const ids = await queueApproved(5);
    const a = new RecordingAdapter();
    const r = await drain(a);

    expect(r.sent).toBe(2); // the last two of the allowance
    expect(r.skippedPlanLimit).toBe(3); // the other three held back
    expect(a.sends).toHaveLength(2);
    const st = await statuses(ids);
    expect(st.filter((s) => s === "sent")).toHaveLength(2);
    expect(st.filter((s) => s === "approved")).toHaveLength(3); // waiting, not failed or dropped
    const [total] = (await db.execute<{ n: string }>(sql`SELECT count(*)::text AS n FROM lifecycle_messages WHERE tenant_id = ${tenantId}::uuid AND status = 'sent' AND sent_at >= '2026-07-01'`)).rows;
    expect(total!.n).toBe("5000"); // never one past the cap
  });

  it("once the allowance is used, the tenant is skipped before anything is claimed (zero writes)", async () => {
    if (!dbAvailable) return;
    enforce(true);
    await seedSent(5_000, new Date("2026-07-05T00:00:00Z"));
    const ids = await queueApproved(3);
    const before = await db.select({ u: lifecycleMessages.updatedAt }).from(lifecycleMessages).where(eq(lifecycleMessages.id, ids[0]!));

    const a = new RecordingAdapter();
    const r = await drain(a);
    expect(r.sent).toBe(0);
    expect(r.candidatesFetched).toBe(0); // never even claimed
    expect(r.skippedPlanLimit).toBe(1); // one tenant held
    expect(a.sends).toHaveLength(0);
    expect(await statuses(ids)).toEqual(["approved", "approved", "approved"]);
    const after = await db.select({ u: lifecycleMessages.updatedAt }).from(lifecycleMessages).where(eq(lifecycleMessages.id, ids[0]!));
    expect(after[0]!.u).toEqual(before[0]!.u); // untouched
  });

  it("held messages go out when the calendar month rolls over", async () => {
    if (!dbAvailable) return;
    enforce(true);
    await seedSent(5_000, new Date("2026-07-05T00:00:00Z"));
    const ids = await queueApproved(3);
    const a = new RecordingAdapter();
    expect((await drain(a, NOW)).sent).toBe(0);

    const nextMonth = new Date("2026-08-01T00:00:00Z"); // first instant of August (UTC)
    const r = await drain(a, nextMonth);
    expect(r.sent).toBe(3);
    expect(await statuses(ids)).toEqual(["sent", "sent", "sent"]);
  });

  it("the last second of the month still counts against July; the first second of August is a fresh allowance", async () => {
    if (!dbAvailable) return;
    enforce(true);
    await seedSent(5_000, new Date("2026-07-31T23:59:59Z"));
    await queueApproved(1);
    const a = new RecordingAdapter();
    expect((await drain(a, new Date("2026-07-31T23:59:59Z"))).sent).toBe(0);
    expect((await drain(a, new Date("2026-08-01T00:00:00Z"))).sent).toBe(1);
  });

  it("an upgrade releases held messages immediately", async () => {
    if (!dbAvailable) return;
    enforce(true);
    await seedSent(5_000, new Date("2026-07-05T00:00:00Z"));
    const ids = await queueApproved(3);
    const a = new RecordingAdapter();
    expect((await drain(a)).sent).toBe(0);

    await setPlan("starter"); // 25,000 a month
    const r = await drain(a);
    expect(r.sent).toBe(3);
    expect(await statuses(ids)).toEqual(["sent", "sent", "sent"]);
  });

  it("only sent messages count: approved, failed, suppressed and last month's do not", async () => {
    if (!dbAvailable) return;
    enforce(true);
    await seedSent(4_990, new Date("2026-07-05T00:00:00Z"), "sent"); // counts: leaves 10 of 5,000
    await seedSent(900, new Date("2026-07-06T00:00:00Z"), "failed"); // does not count
    await seedSent(900, new Date("2026-07-06T00:00:00Z"), "suppressed"); // does not count
    await seedSent(900, new Date("2026-06-15T00:00:00Z"), "sent"); // last month: does not count
    const ids = await queueApproved(15);
    const a = new RecordingAdapter();
    const r = await makeDrainRunner(db, tenantId, a, SIGNING_KEY, "http://localhost:3000")(NOW, { batchLimit: 100 });
    // If any of the non-counting rows were counted, fewer than 10 would go out.
    expect(r.sent).toBe(10);
    expect(r.skippedPlanLimit).toBe(5);
    expect((await statuses(ids)).filter((s) => s === "approved")).toHaveLength(5);
  });

  it("a running trial has Growth's allowance (100,000), not Free's", async () => {
    if (!dbAvailable) return;
    enforce(true);
    await setPlan("trial", new Date(NOW.getTime() + 5 * DAY));
    await seedSent(5_001, new Date("2026-07-05T00:00:00Z")); // already past Free's cap
    await queueApproved(2);
    const r = await drain(new RecordingAdapter());
    expect(r.sent).toBe(2);
  });

  it("once the trial has ended the tenant is Free, so the Free allowance applies", async () => {
    if (!dbAvailable) return;
    enforce(true);
    await setPlan("trial", new Date(NOW.getTime() - 1000));
    await seedSent(5_001, new Date("2026-07-05T00:00:00Z"));
    const ids = await queueApproved(2);
    const r = await drain(new RecordingAdapter());
    expect(r.sent).toBe(0);
    expect(await statuses(ids)).toEqual(["approved", "approved"]);
  });
});

describe("'Sent with Mailforge' credit line", () => {
  const sendOne = async (): Promise<TransportSendParams> => {
    await queueApproved(1);
    const a = new RecordingAdapter();
    const r = await drain(a);
    expect(r.sent).toBe(1);
    return a.sends[0]!;
  };

  it("a Free workspace's email carries the credit line, linked to the site, in HTML and text", async () => {
    if (!dbAvailable) return;
    enforce(true);
    process.env.MAILFORGE_SITE_URL = "https://mailforge.example";
    const sent = await sendOne();
    expect(sent.bodyHtml).toContain('<a href="https://mailforge.example"');
    expect(sent.bodyHtml).toContain("Sent with Mailforge");
    expect(sent.bodyText).toContain("Sent with Mailforge: https://mailforge.example");
    // The compliance footer is still there, and comes first.
    expect(sent.bodyHtml).toContain("Unsubscribe");
    expect(sent.bodyHtml!.indexOf("Unsubscribe")).toBeLessThan(sent.bodyHtml!.indexOf("Sent with Mailforge"));
  });

  it("a paid workspace's email does not", async () => {
    if (!dbAvailable) return;
    enforce(true);
    process.env.MAILFORGE_SITE_URL = "https://mailforge.example";
    await setPlan("starter");
    const sent = await sendOne();
    expect(sent.bodyHtml).not.toContain("Sent with Mailforge");
    expect(sent.bodyText).not.toContain("Sent with Mailforge");
  });

  it("a trial workspace (it has Growth) does not", async () => {
    if (!dbAvailable) return;
    enforce(true);
    process.env.MAILFORGE_SITE_URL = "https://mailforge.example";
    await setPlan("trial", new Date(NOW.getTime() + 3 * DAY));
    const sent = await sendOne();
    expect(sent.bodyHtml).not.toContain("Sent with Mailforge");
  });

  it("with enforcement off nobody gets it, whatever the plan", async () => {
    if (!dbAvailable) return;
    enforce(false);
    process.env.MAILFORGE_SITE_URL = "https://mailforge.example";
    const sent = await sendOne(); // plan is free
    expect(sent.bodyHtml).not.toContain("Sent with Mailforge");
  });

  it("with no site URL configured there is nothing to link to, so no line is added", async () => {
    if (!dbAvailable) return;
    enforce(true);
    delete process.env.MAILFORGE_SITE_URL;
    const prev = process.env.BASE_URL;
    delete process.env.BASE_URL;
    try {
      const sent = await sendOne();
      expect(sent.bodyHtml).not.toContain("Sent with Mailforge");
    } finally {
      if (prev !== undefined) process.env.BASE_URL = prev;
    }
  });
});

describe("suspended workspaces in the drain", () => {
  const suspend = (on: boolean) =>
    db.execute(sql`UPDATE tenants SET suspended_at = ${on ? NOW.toISOString() : null}::timestamptz, suspended_reason = ${on ? "test" : null} WHERE id = ${tenantId}::uuid`);

  it("sends nothing for a suspended workspace, even with plan enforcement off, and touches nothing", async () => {
    if (!dbAvailable) return;
    enforce(false);
    const ids = await queueApproved(3);
    await suspend(true);
    try {
      const a = new RecordingAdapter();
      const r = await drain(a);
      expect(r.sent).toBe(0);
      expect(r.candidatesFetched).toBe(0); // dropped before any claim
      expect(r.skippedSuspended).toBe(1);
      expect(a.sends).toHaveLength(0);
      expect(await statuses(ids)).toEqual(["approved", "approved", "approved"]);
    } finally {
      await suspend(false);
    }
  });

  it("the held messages go out as soon as the workspace is reinstated", async () => {
    if (!dbAvailable) return;
    enforce(false);
    const ids = await queueApproved(2);
    await suspend(true);
    await drain(new RecordingAdapter());
    await suspend(false);
    const a = new RecordingAdapter();
    const r = await drain(a);
    expect(r.sent).toBe(2);
    expect(r.skippedSuspended).toBe(0);
    expect(await statuses(ids)).toEqual(["sent", "sent"]);
  });

  it("sends nothing for a workspace scheduled for deletion, and goes back to normal if that is cancelled", async () => {
    if (!dbAvailable) return;
    enforce(false);
    const ids = await queueApproved(2);
    await db.execute(sql`UPDATE tenants SET deletion_scheduled_at = ${NOW.toISOString()}::timestamptz WHERE id = ${tenantId}::uuid`);
    try {
      const a = new RecordingAdapter();
      const r = await drain(a);
      expect(r.sent).toBe(0);
      expect(r.skippedSuspended).toBe(1);
      expect(await statuses(ids)).toEqual(["approved", "approved"]);
    } finally {
      await db.execute(sql`UPDATE tenants SET deletion_scheduled_at = NULL WHERE id = ${tenantId}::uuid`);
    }
    const a2 = new RecordingAdapter();
    expect((await drain(a2)).sent).toBe(2);
  });
});
