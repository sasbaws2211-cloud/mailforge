/**
 * Integration tests for the drain worker (task 14).
 *
 * Tests:
 * - Verdict: allow -> sent
 * - Verdict: suppress -> status = 'suppressed'
 * - Verdict: defer_frequency -> status = 'approved', scheduled_send_at set
 * - Verdict: defer_window -> status = 'approved', scheduled_send_at set
 * - Ordering: critical-before-nurture even when nurture has higher priority number
 * - No-transport: message stays at approved when resolver returns null
 * - No-email: message stays at sending (skipped) when contact has no email
 * - Transport error: message stays at 'sending' (reap will recover in task 15)
 * - PgGate concurrency: two drains claim disjoint sets
 *
 * Requires local Postgres (docker compose up postgres).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { eq, sql, inArray } from "drizzle-orm";
import {
  tenants,
  contacts,
  flows,
  flowMemberships,
  lifecycleMessages,
  suppressions,
} from "@claros/db/schema";
import { processDrainTick, fetchDrainBatchSimple } from "../src/drain.js";
import type { TransportAdapter, TransportSendResult, TransportSendParams } from "../src/transport.js";

// ---------------------------------------------------------------------------
// Test-only LogTransportAdapter (lives in tests/, never in src/)
// ---------------------------------------------------------------------------

/**
 * A transport adapter that logs send attempts and always succeeds.
 * Used ONLY in tests. Lives in tests/ - structurally cannot be imported
 * by production code.
 */
class LogTransportAdapter implements TransportAdapter {
  public sends: TransportSendParams[] = [];

  async send(params: TransportSendParams): Promise<TransportSendResult> {
    this.sends.push(params);
    return { success: true, providerMessageId: `log-${params.messageId}` };
  }
}

/**
 * A transport adapter that always fails (simulates transport errors).
 */
class FailingTransportAdapter implements TransportAdapter {
  async send(_params: TransportSendParams): Promise<TransportSendResult> {
    return { success: false, error: "simulated transport failure" };
  }
}

// ---------------------------------------------------------------------------
// DB setup
// ---------------------------------------------------------------------------

const TEST_DB_URL = process.env.DATABASE_URL;
if (!TEST_DB_URL) {
  const inCI = process.env.CI === "true";
  throw new Error(
    `[drain.test] DATABASE_URL is not set.\n\n` +
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

const SLUG = "test-drain-worker";

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
        `[drain.test] DATABASE_URL not reachable in CI.\n` +
          `URL: ${TEST_DB_URL}\nCause: ${(err as Error).message}`,
      );
    }
    console.warn("[drain.test] DATABASE_URL not reachable - tests skipped.");
    return;
  }

  await cleanup();

  const [tenant] = await db
    .insert(tenants)
    .values({ name: "Test Drain Worker", slug: SLUG, plan: "free" })
    .returning({ id: tenants.id });
  testTenantId = tenant!.id;
});

beforeEach(async () => {
  if (!dbAvailable) return;
  await db.execute(sql`DELETE FROM lifecycle_messages WHERE tenant_id = ${testTenantId}`);
  await db.execute(sql`DELETE FROM flow_memberships WHERE tenant_id = ${testTenantId}`);
  await db.execute(sql`DELETE FROM flows WHERE tenant_id = ${testTenantId}`);
  await db.execute(sql`DELETE FROM suppressions WHERE tenant_id = ${testTenantId}`);
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
    sql`DELETE FROM flows WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${SLUG})`,
  );
  await db.execute(
    sql`DELETE FROM suppressions WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${SLUG})`,
  );
  await db.execute(
    sql`DELETE FROM contacts WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${SLUG})`,
  );
  await db.execute(
    sql`DELETE FROM scan_checkpoints WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${SLUG})`,
  );
  await db.execute(sql`DELETE FROM tenants WHERE slug = ${SLUG}`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function insertContact(
  externalId: string,
  opts: { email?: string | null; timezone?: string } = {},
): Promise<string> {
  const email = opts.email === undefined ? `${externalId}@example.com` : opts.email;
  const properties = opts.timezone ? { timezone: opts.timezone } : null;
  const [row] = await db
    .insert(contacts)
    .values({
      tenantId: testTenantId,
      externalId,
      email,
      lifecycleState: "engaged",
      properties,
      firstSeenAt: new Date("2026-07-01T00:00:00Z"),
      lastSeenAt: new Date("2026-07-20T00:00:00Z"),
    })
    .returning({ id: contacts.id });
  return row!.id;
}

async function insertFlow(opts: {
  name: string;
  flowClass?: string;
  priority?: number;
  windowPolicy?: string;
}): Promise<string> {
  const windowPolicy = opts.windowPolicy ?? "immediate";
  const [row] = await db
    .insert(flows)
    .values({
      tenantId: testTenantId,
      name: opts.name,
      priority: opts.priority ?? 0,
      triggerType: "lifecycle_transition",
      triggerConfig: { from: "engaged", to: "at_risk" },
      steps: [{ order: 1, action_type: "nurture_value", delay: "0d", window_policy: windowPolicy }],
      // Use 'paused' status so phaseStepAdvancement skips these flows.
      // The drain only cares about message status, not flow status.
      status: "paused",
      flowClass: opts.flowClass ?? "nurture",
      compiledPlan: {
        trigger: { type: "lifecycle_transition", condition: { from: "engaged", to: "at_risk" } },
        steps: [{ order: 1, action_type: "nurture_value", delay: "0d", window_policy: windowPolicy }],
      },
    })
    .returning({ id: flows.id });
  return row!.id;
}

async function insertMembership(contactId: string, flowId: string): Promise<string> {
  const [row] = await db
    .insert(flowMemberships)
    .values({
      tenantId: testTenantId,
      contactId,
      flowId,
      currentStep: 1,
      // Use 'completed' so phaseStepAdvancement does not pick these up.
      // The drain only cares about message status, not membership status.
      status: "completed",
      enteredAt: new Date("2026-07-20T00:00:00Z"),
      completedAt: new Date("2026-07-20T00:00:00Z"),
      exitReason: "completed",
    })
    .returning({ id: flowMemberships.id });
  return row!.id;
}

async function insertApprovedMessage(opts: {
  contactId: string;
  flowId: string;
  membershipId: string;
  scheduledSendAt?: Date | null;
  subject?: string;
  bodyHtml?: string;
}): Promise<string> {
  const [row] = await db
    .insert(lifecycleMessages)
    .values({
      tenantId: testTenantId,
      contactId: opts.contactId,
      flowId: opts.flowId,
      membershipId: opts.membershipId,
      flowStepOrder: 1,
      status: "approved",
      subject: opts.subject ?? "Test subject",
      bodyHtml: opts.bodyHtml ?? "<p>Test body</p>",
      approvedAt: new Date("2026-07-20T10:00:00Z"),
      scheduledSendAt: opts.scheduledSendAt ?? null,
    })
    .returning({ id: lifecycleMessages.id });
  return row!.id;
}

function makeResolver(adapter: TransportAdapter | null) {
  // Scope resolver to the test tenant only. If processDrainTick picks up
  // another tenant's approved messages (e.g., from a concurrently running
  // reap test), returning null for unknown tenants keeps them untouched.
  return async (tenantId: string) => tenantId === testTenantId ? adapter : null;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("drain worker", () => {
  it("skips when DATABASE_URL is not reachable", () => {
    if (!dbAvailable) {
      expect(true).toBe(true);
    }
  });

  describe("verdict: allow -> sent", () => {
    it("sends the message and marks it sent", async () => {
      if (!dbAvailable) return;

      const contactId = await insertContact("allow-contact");
      const flowId = await insertFlow({ name: "allow-flow", windowPolicy: "immediate" });
      const membershipId = await insertMembership(contactId, flowId);
      const messageId = await insertApprovedMessage({
        contactId,
        flowId,
        membershipId,
      });

      const adapter = new LogTransportAdapter();
      const now = new Date("2026-07-21T10:00:00Z"); // within default window

      const result = await processDrainTick(
        db,
        now,
        makeResolver(adapter),
        fetchDrainBatchSimple,
      );

      expect(result.sent).toBe(1);
      expect(result.candidatesFetched).toBe(1);
      expect(adapter.sends).toHaveLength(1);
      expect(adapter.sends[0]!.to).toBe("allow-contact@example.com");
      expect(adapter.sends[0]!.messageId).toBe(messageId);

      // Check DB state
      const [msg] = await db
        .select({ status: lifecycleMessages.status, sentAt: lifecycleMessages.sentAt })
        .from(lifecycleMessages)
        .where(eq(lifecycleMessages.id, messageId));
      expect(msg!.status).toBe("sent");
      expect(msg!.sentAt).toBeTruthy();
    });
  });

  describe("verdict: suppress", () => {
    it("marks message as suppressed when contact is on suppression list", async () => {
      if (!dbAvailable) return;

      const contactId = await insertContact("suppress-contact");
      const flowId = await insertFlow({ name: "suppress-flow", windowPolicy: "immediate" });
      const membershipId = await insertMembership(contactId, flowId);
      const messageId = await insertApprovedMessage({
        contactId,
        flowId,
        membershipId,
      });

      // Add contact to suppression list
      await db.insert(suppressions).values({
        tenantId: testTenantId,
        email: "suppress-contact@example.com",
        reason: "manual",
        source: "admin",
      });

      const adapter = new LogTransportAdapter();
      const now = new Date("2026-07-21T10:00:00Z");

      const result = await processDrainTick(
        db,
        now,
        makeResolver(adapter),
        fetchDrainBatchSimple,
      );

      expect(result.suppressed).toBe(1);
      expect(result.sent).toBe(0);
      expect(adapter.sends).toHaveLength(0);

      const [msg] = await db
        .select({ status: lifecycleMessages.status })
        .from(lifecycleMessages)
        .where(eq(lifecycleMessages.id, messageId));
      expect(msg!.status).toBe("suppressed");
    });
  });

  describe("verdict: defer_frequency", () => {
    it("defers when min interval not elapsed", async () => {
      if (!dbAvailable) return;

      const contactId = await insertContact("freq-contact");
      const flowId = await insertFlow({ name: "freq-flow", windowPolicy: "immediate" });
      const membershipId = await insertMembership(contactId, flowId);
      const messageId = await insertApprovedMessage({
        contactId,
        flowId,
        membershipId,
      });

      // Insert a recent sent message to trigger frequency cap
      // Default min_interval is 48h. Put a sent message 1h ago.
      const now = new Date("2026-07-21T10:00:00Z");
      const recentSentAt = new Date(now.getTime() - 1 * 60 * 60 * 1000); // 1h ago

      // Need a second flow/membership for the prior message
      const flow2Id = await insertFlow({ name: "freq-flow-prior", windowPolicy: "immediate" });
      const membership2Id = await insertMembership(contactId, flow2Id);
      await db.insert(lifecycleMessages).values({
        tenantId: testTenantId,
        contactId,
        flowId: flow2Id,
        membershipId: membership2Id,
        flowStepOrder: 1,
        status: "sent",
        sentAt: recentSentAt,
        subject: "Prior message",
        bodyHtml: "<p>Prior</p>",
      });

      const adapter = new LogTransportAdapter();

      const result = await processDrainTick(
        db,
        now,
        makeResolver(adapter),
        fetchDrainBatchSimple,
      );

      expect(result.deferredFrequency).toBe(1);
      expect(result.sent).toBe(0);
      expect(adapter.sends).toHaveLength(0);

      const [msg] = await db
        .select({
          status: lifecycleMessages.status,
          scheduledSendAt: lifecycleMessages.scheduledSendAt,
        })
        .from(lifecycleMessages)
        .where(eq(lifecycleMessages.id, messageId));
      expect(msg!.status).toBe("approved");
      expect(msg!.scheduledSendAt).toBeTruthy();
      // Should be retryAfter = lastSentAt + 48h
      const expectedRetry = new Date(recentSentAt.getTime() + 48 * 60 * 60 * 1000);
      expect(msg!.scheduledSendAt!.getTime()).toBe(expectedRetry.getTime());
    });
  });

  describe("verdict: defer_window", () => {
    it("defers when outside send window with respect_window policy", async () => {
      if (!dbAvailable) return;

      // Contact in UTC, default window is Mon-Fri 09:00-17:00
      const contactId = await insertContact("window-contact", { timezone: "UTC" });
      const flowId = await insertFlow({ name: "window-flow", windowPolicy: "respect_window" });
      const membershipId = await insertMembership(contactId, flowId);
      const messageId = await insertApprovedMessage({
        contactId,
        flowId,
        membershipId,
      });

      const adapter = new LogTransportAdapter();
      // Saturday at 10:00 UTC - outside default weekday window
      const now = new Date("2026-07-25T10:00:00Z"); // July 25, 2026 is Saturday

      const result = await processDrainTick(
        db,
        now,
        makeResolver(adapter),
        fetchDrainBatchSimple,
      );

      expect(result.deferredWindow).toBe(1);
      expect(result.sent).toBe(0);

      const [msg] = await db
        .select({
          status: lifecycleMessages.status,
          scheduledSendAt: lifecycleMessages.scheduledSendAt,
        })
        .from(lifecycleMessages)
        .where(eq(lifecycleMessages.id, messageId));
      expect(msg!.status).toBe("approved");
      expect(msg!.scheduledSendAt).toBeTruthy();
      // Next window should be Monday 09:00 UTC (July 27, 2026)
      const expected = new Date("2026-07-27T09:00:00Z");
      // Allow 1 minute tolerance for computation differences
      const diff = Math.abs(msg!.scheduledSendAt!.getTime() - expected.getTime());
      expect(diff).toBeLessThan(2 * 60 * 1000);
    });
  });

  describe("ordering: critical before nurture", () => {
    it("processes critical messages first even when nurture has higher priority number", async () => {
      if (!dbAvailable) return;

      // Use two different contacts so frequency cap does not interfere
      const contactA = await insertContact("order-contact-a");
      const contactB = await insertContact("order-contact-b");

      // Nurture flow with priority 100 (high number)
      const nurtureFlowId = await insertFlow({
        name: "high-priority-nurture",
        flowClass: "nurture",
        priority: 100,
        windowPolicy: "immediate",
      });
      const nurtureMembershipId = await insertMembership(contactA, nurtureFlowId);
      await insertApprovedMessage({
        contactId: contactA,
        flowId: nurtureFlowId,
        membershipId: nurtureMembershipId,
        subject: "Nurture subject",
      });

      // Critical flow with priority 1 (low number)
      const criticalFlowId = await insertFlow({
        name: "low-priority-critical",
        flowClass: "critical",
        priority: 1,
        windowPolicy: "immediate",
      });
      const criticalMembershipId = await insertMembership(contactB, criticalFlowId);
      await insertApprovedMessage({
        contactId: contactB,
        flowId: criticalFlowId,
        membershipId: criticalMembershipId,
        subject: "Critical subject",
      });

      const adapter = new LogTransportAdapter();
      const now = new Date("2026-07-21T10:00:00Z");

      const result = await processDrainTick(
        db,
        now,
        makeResolver(adapter),
        fetchDrainBatchSimple,
      );

      // Both should be sent (different contacts, no frequency conflict)
      expect(result.candidatesFetched).toBe(2);
      expect(result.sent).toBe(2);
      expect(adapter.sends).toHaveLength(2);

      // Critical must be processed FIRST (index 0) despite lower priority number
      expect(adapter.sends[0]!.subject).toBe("Critical subject");
      expect(adapter.sends[1]!.subject).toBe("Nurture subject");
    });
  });

  describe("no-transport", () => {
    it("performs zero writes to lifecycle_messages when transport resolver returns null", async () => {
      if (!dbAvailable) return;

      const contactId = await insertContact("no-transport-contact");
      const flowId = await insertFlow({ name: "no-transport-flow", windowPolicy: "immediate" });
      const membershipId = await insertMembership(contactId, flowId);
      const messageId = await insertApprovedMessage({
        contactId,
        flowId,
        membershipId,
      });

      // Record the updated_at before the drain tick
      const [before] = await db
        .select({
          status: lifecycleMessages.status,
          updatedAt: lifecycleMessages.updatedAt,
        })
        .from(lifecycleMessages)
        .where(eq(lifecycleMessages.id, messageId));
      const originalUpdatedAt = before!.updatedAt;

      const now = new Date("2026-07-21T10:00:00Z");

      // Null resolver - simulates no transport configured
      const result = await processDrainTick(
        db,
        now,
        makeResolver(null),
        fetchDrainBatchSimple,
      );

      // skippedNoTransport counts ALL tenants with approved messages whose
      // resolver returned null. Other suites running concurrently may have
      // approved messages for their own tenants, so the count can exceed 1.
      // What we actually care about: our tenant was skipped (>= 1) and no
      // messages were claimed or sent.
      expect(result.skippedNoTransport).toBeGreaterThanOrEqual(1);
      expect(result.candidatesFetched).toBe(0);
      expect(result.sent).toBe(0);

      // Message must still be 'approved' with the same updated_at (zero writes)
      const [after] = await db
        .select({
          status: lifecycleMessages.status,
          updatedAt: lifecycleMessages.updatedAt,
        })
        .from(lifecycleMessages)
        .where(eq(lifecycleMessages.id, messageId));
      expect(after!.status).toBe("approved");
      expect(after!.updatedAt!.getTime()).toBe(originalUpdatedAt!.getTime());
    });

    it("skips entirely - no messages are claimed or reverted", async () => {
      if (!dbAvailable) return;

      // Create multiple messages to ensure none are touched
      const messages: string[] = [];
      for (let i = 0; i < 3; i++) {
        const contactId = await insertContact(`no-transport-multi-${i}`);
        const flowId = await insertFlow({ name: `no-transport-multi-flow-${i}`, windowPolicy: "immediate" });
        const membershipId = await insertMembership(contactId, flowId);
        const msgId = await insertApprovedMessage({
          contactId,
          flowId,
          membershipId,
        });
        messages.push(msgId);
      }

      // Record all updated_at values before
      const beforeRows = await db
        .select({
          id: lifecycleMessages.id,
          updatedAt: lifecycleMessages.updatedAt,
        })
        .from(lifecycleMessages)
        .where(inArray(lifecycleMessages.id, messages));
      const beforeMap = new Map(beforeRows.map((r) => [r.id, r.updatedAt!.getTime()]));

      const now = new Date("2026-07-21T10:00:00Z");
      await processDrainTick(db, now, makeResolver(null), fetchDrainBatchSimple);

      // Verify all messages unchanged
      const afterRows = await db
        .select({
          id: lifecycleMessages.id,
          status: lifecycleMessages.status,
          updatedAt: lifecycleMessages.updatedAt,
        })
        .from(lifecycleMessages)
        .where(inArray(lifecycleMessages.id, messages));

      for (const row of afterRows) {
        expect(row.status).toBe("approved");
        expect(row.updatedAt!.getTime()).toBe(beforeMap.get(row.id));
      }
    });
  });

  describe("no-email", () => {
    it("skips message when contact has no email address", async () => {
      if (!dbAvailable) return;

      // Contact with null email
      const contactId = await insertContact("no-email-contact", { email: null });
      const flowId = await insertFlow({ name: "no-email-flow", windowPolicy: "immediate" });
      const membershipId = await insertMembership(contactId, flowId);
      const messageId = await insertApprovedMessage({
        contactId,
        flowId,
        membershipId,
      });

      const adapter = new LogTransportAdapter();
      const now = new Date("2026-07-21T10:00:00Z");

      const result = await processDrainTick(
        db,
        now,
        makeResolver(adapter),
        fetchDrainBatchSimple,
      );

      expect(result.skippedNoEmail).toBe(1);
      expect(adapter.sends).toHaveLength(0);

      // Message reverts to 'approved' after being claimed then discovering
      // no email. Will be re-evaluated next tick; once contact gets an email,
      // it can proceed.
      const [msg] = await db
        .select({ status: lifecycleMessages.status })
        .from(lifecycleMessages)
        .where(eq(lifecycleMessages.id, messageId));
      expect(msg!.status).toBe("approved");
    });
  });

  describe("transport error", () => {
    it("leaves message at sending when transport fails", async () => {
      if (!dbAvailable) return;

      const contactId = await insertContact("error-contact");
      const flowId = await insertFlow({ name: "error-flow", windowPolicy: "immediate" });
      const membershipId = await insertMembership(contactId, flowId);
      const messageId = await insertApprovedMessage({
        contactId,
        flowId,
        membershipId,
      });

      const failingAdapter = new FailingTransportAdapter();
      const now = new Date("2026-07-21T10:00:00Z");

      const result = await processDrainTick(
        db,
        now,
        makeResolver(failingAdapter),
        fetchDrainBatchSimple,
      );

      expect(result.transportErrors).toBe(1);
      expect(result.sent).toBe(0);

      // Message stays at 'sending' - reap (task 15) will recover
      const [msg] = await db
        .select({ status: lifecycleMessages.status })
        .from(lifecycleMessages)
        .where(eq(lifecycleMessages.id, messageId));
      expect(msg!.status).toBe("sending");
    });
  });

  describe("scheduled_send_at gate", () => {
    it("does not pick up messages with future scheduled_send_at", async () => {
      if (!dbAvailable) return;

      const contactId = await insertContact("future-contact");
      const flowId = await insertFlow({ name: "future-flow", windowPolicy: "immediate" });
      const membershipId = await insertMembership(contactId, flowId);

      const now = new Date("2026-07-21T10:00:00Z");
      const future = new Date("2026-07-22T10:00:00Z"); // 24h from now

      await insertApprovedMessage({
        contactId,
        flowId,
        membershipId,
        scheduledSendAt: future,
      });

      const adapter = new LogTransportAdapter();
      const result = await processDrainTick(
        db,
        now,
        makeResolver(adapter),
        fetchDrainBatchSimple,
      );

      expect(result.candidatesFetched).toBe(0);
      expect(adapter.sends).toHaveLength(0);
    });
  });

  describe("PgGate concurrency", () => {
    it("two concurrent drains claim disjoint message sets", async () => {
      if (!dbAvailable) return;

      // Create 4 messages for different contacts
      const messages: string[] = [];
      for (let i = 0; i < 4; i++) {
        const contactId = await insertContact(`concurrent-${i}`);
        const flowId = await insertFlow({
          name: `concurrent-flow-${i}`,
          windowPolicy: "immediate",
        });
        const membershipId = await insertMembership(contactId, flowId);
        const msgId = await insertApprovedMessage({
          contactId,
          flowId,
          membershipId,
        });
        messages.push(msgId);
      }

      const adapter1 = new LogTransportAdapter();
      const adapter2 = new LogTransportAdapter();
      const now = new Date("2026-07-21T10:00:00Z");

      // Run two drain ticks concurrently. Each uses batchLimit=2
      // so they should each pick up 2 disjoint messages.
      const [result1, result2] = await Promise.all([
        processDrainTick(db, now, makeResolver(adapter1), fetchDrainBatchSimple, 2),
        processDrainTick(db, now, makeResolver(adapter2), fetchDrainBatchSimple, 2),
      ]);

      // Total sent across both should be <= 4
      // Due to SKIP LOCKED, they should get disjoint sets.
      const totalSent = result1.sent + result2.sent;
      const totalCandidates = result1.candidatesFetched + result2.candidatesFetched;

      // Both should have fetched candidates (SKIP LOCKED distributes work)
      expect(totalCandidates).toBe(4);
      // All should be sent (no frequency cap because different contacts)
      expect(totalSent).toBe(4);

      // Verify no duplicates: union of sent message IDs should have 4 distinct entries
      const allSentIds = [...adapter1.sends, ...adapter2.sends].map((s) => s.messageId);
      const uniqueIds = new Set(allSentIds);
      expect(uniqueIds.size).toBe(4);

      // Verify all messages are now 'sent' in DB
      for (const msgId of messages) {
        const [msg] = await db
          .select({ status: lifecycleMessages.status })
          .from(lifecycleMessages)
          .where(eq(lifecycleMessages.id, msgId));
        expect(msg!.status).toBe("sent");
      }
    });
  });
});
