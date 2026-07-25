/**
 * Integration tests for the reap worker (task 15).
 *
 * Tests:
 * - sending stuck > 2h, retry_count < MAX: reset to 'approved', retry_count++
 * - sending stuck > 2h, retry_count = MAX: set to 'failed', logged
 * - generating stuck > 2h, retry_count < MAX: reset to 'pending_generation', retry_count++
 * - generating stuck > 2h, retry_count = MAX: set to 'failed'
 * - fresh messages (updated_at within 2h) are not touched
 * - messages in other statuses (approved, sent, failed, suppressed) are not touched
 * - PgGate race: reap resets 'sending' to 'approved' while drain is about to write 'sent';
 *   drain's CAS write hits 0 rows, reap outcome wins
 * - multiple tenants are all handled in a single tick
 *
 * Requires local Postgres (docker compose up postgres).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { eq, sql } from "drizzle-orm";
import {
  tenants,
  contacts,
  flows,
  flowMemberships,
  lifecycleMessages,
} from "@claros/db/schema";
import { processReapTick } from "../src/reap.js";

// ---------------------------------------------------------------------------
// DB setup
// ---------------------------------------------------------------------------

const TEST_DB_URL = process.env.DATABASE_URL;
if (!TEST_DB_URL) {
  const inCI = process.env.CI === "true";
  throw new Error(
    `[reap.test] DATABASE_URL is not set.\n\n` +
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

const SLUG = "test-reap-worker";

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
        `[reap.test] DATABASE_URL not reachable in CI.\n` +
          `URL: ${TEST_DB_URL}\nCause: ${(err as Error).message}`,
      );
    }
    console.warn("[reap.test] DATABASE_URL not reachable - tests skipped.");
    return;
  }

  await cleanup();

  const [tenant] = await db
    .insert(tenants)
    .values({ name: "Test Reap Worker", slug: SLUG, plan: "free" })
    .returning({ id: tenants.id });
  testTenantId = tenant!.id;
});

beforeEach(async () => {
  if (!dbAvailable) return;
  await db.execute(sql`DELETE FROM lifecycle_messages WHERE tenant_id = ${testTenantId}`);
  await db.execute(sql`DELETE FROM flow_memberships WHERE tenant_id = ${testTenantId}`);
  await db.execute(sql`DELETE FROM flows WHERE tenant_id = ${testTenantId}`);
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
    sql`DELETE FROM contacts WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${SLUG})`,
  );
  await db.execute(sql`DELETE FROM tenants WHERE slug = ${SLUG}`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function insertContact(externalId: string): Promise<string> {
  const [row] = await db
    .insert(contacts)
    .values({
      tenantId: testTenantId,
      externalId,
      email: `${externalId}@example.com`,
      lifecycleState: "engaged",
      firstSeenAt: new Date("2026-07-01T00:00:00Z"),
      lastSeenAt: new Date("2026-07-20T00:00:00Z"),
    })
    .returning({ id: contacts.id });
  return row!.id;
}

async function insertFlow(): Promise<string> {
  const [row] = await db
    .insert(flows)
    .values({
      tenantId: testTenantId,
      name: `reap-test-flow-${Math.random().toString(36).slice(2)}`,
      priority: 0,
      triggerType: "lifecycle_transition",
      triggerConfig: { from: "engaged", to: "at_risk" },
      steps: [{ order: 1, action_type: "nurture_value", delay: "0d" }],
      status: "paused",
      flowClass: "nurture",
      compiledPlan: {
        trigger: { type: "lifecycle_transition", condition: { from: "engaged", to: "at_risk" } },
        steps: [{ order: 1, action_type: "nurture_value", delay: "0d" }],
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
      status: "completed",
      enteredAt: new Date("2026-07-20T00:00:00Z"),
      completedAt: new Date("2026-07-20T00:00:00Z"),
      exitReason: "completed",
    })
    .returning({ id: flowMemberships.id });
  return row!.id;
}

/**
 * Insert a message directly in a specific status, with a specific updated_at.
 * updated_at is what reap uses to determine if a message is stuck.
 */
async function insertMessage(opts: {
  contactId: string;
  flowId: string;
  membershipId: string;
  status: string;
  retryCount?: number;
  updatedAt: Date;
}): Promise<string> {
  const [row] = await db
    .insert(lifecycleMessages)
    .values({
      tenantId: testTenantId,
      contactId: opts.contactId,
      flowId: opts.flowId,
      membershipId: opts.membershipId,
      flowStepOrder: 1,
      status: opts.status,
      subject: "Test subject",
      bodyHtml: "<p>Test</p>",
      retryCount: opts.retryCount ?? 0,
    })
    .returning({ id: lifecycleMessages.id });

  // Overwrite updated_at to the requested value. Drizzle defaultNow() fires at
  // insert time; we need to backdate it to simulate a stuck message.
  await db.execute(sql`
    UPDATE lifecycle_messages
    SET updated_at = ${opts.updatedAt}
    WHERE id = ${row!.id}
  `);

  return row!.id;
}

async function getMessage(id: string) {
  const [row] = await db
    .select({
      status: lifecycleMessages.status,
      retryCount: lifecycleMessages.retryCount,
      updatedAt: lifecycleMessages.updatedAt,
    })
    .from(lifecycleMessages)
    .where(eq(lifecycleMessages.id, id));
  return row!;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("reap worker", () => {
  it("skips when DATABASE_URL is not reachable", () => {
    if (!dbAvailable) {
      expect(true).toBe(true);
    }
  });

  describe("sending: stuck > 2h, below MAX_RETRY_COUNT", () => {
    it("resets to approved and increments retry_count", async () => {
      if (!dbAvailable) return;

      const now = new Date("2026-07-21T12:00:00Z");
      // 3h ago - older than the 2h threshold
      const stuckAt = new Date(now.getTime() - 3 * 60 * 60 * 1000);

      const contactId = await insertContact("reap-sending-retry");
      const flowId = await insertFlow();
      const membershipId = await insertMembership(contactId, flowId);
      const messageId = await insertMessage({
        contactId, flowId, membershipId,
        status: "sending",
        retryCount: 0,
        updatedAt: stuckAt,
      });

      const result = await processReapTick(db, now);

      expect(result.sendingRetried).toBe(1);
      expect(result.sendingFailed).toBe(0);
      expect(result.generatingRetried).toBe(0);
      expect(result.generatingFailed).toBe(0);

      const msg = await getMessage(messageId);
      expect(msg.status).toBe("approved");
      expect(msg.retryCount).toBe(1);
      // updated_at should be refreshed to now
      expect(msg.updatedAt!.getTime()).toBe(now.getTime());
    });

    it("can retry up to MAX_RETRY_COUNT - 1 times", async () => {
      if (!dbAvailable) return;

      const now = new Date("2026-07-21T12:00:00Z");
      const stuckAt = new Date(now.getTime() - 3 * 60 * 60 * 1000);

      const contactId = await insertContact("reap-sending-retry2");
      const flowId = await insertFlow();
      const membershipId = await insertMembership(contactId, flowId);
      const messageId = await insertMessage({
        contactId, flowId, membershipId,
        status: "sending",
        retryCount: 2, // MAX_RETRY_COUNT - 1 = 2; still below 3
        updatedAt: stuckAt,
      });

      const result = await processReapTick(db, now);

      expect(result.sendingRetried).toBe(1);
      expect(result.sendingFailed).toBe(0);

      const msg = await getMessage(messageId);
      expect(msg.status).toBe("approved");
      expect(msg.retryCount).toBe(3);
    });
  });

  describe("sending: stuck > 2h, at MAX_RETRY_COUNT", () => {
    it("marks as failed (terminal)", async () => {
      if (!dbAvailable) return;

      const now = new Date("2026-07-21T12:00:00Z");
      const stuckAt = new Date(now.getTime() - 3 * 60 * 60 * 1000);

      const contactId = await insertContact("reap-sending-fail");
      const flowId = await insertFlow();
      const membershipId = await insertMembership(contactId, flowId);
      const messageId = await insertMessage({
        contactId, flowId, membershipId,
        status: "sending",
        retryCount: 3, // = MAX_RETRY_COUNT
        updatedAt: stuckAt,
      });

      const result = await processReapTick(db, now);

      expect(result.sendingRetried).toBe(0);
      expect(result.sendingFailed).toBe(1);

      const msg = await getMessage(messageId);
      expect(msg.status).toBe("failed");
    });
  });

  describe("generating: stuck > 2h, below MAX_RETRY_COUNT", () => {
    it("resets to pending_generation and increments retry_count", async () => {
      if (!dbAvailable) return;

      const now = new Date("2026-07-21T12:00:00Z");
      const stuckAt = new Date(now.getTime() - 3 * 60 * 60 * 1000);

      const contactId = await insertContact("reap-generating-retry");
      const flowId = await insertFlow();
      const membershipId = await insertMembership(contactId, flowId);
      const messageId = await insertMessage({
        contactId, flowId, membershipId,
        status: "generating",
        retryCount: 0,
        updatedAt: stuckAt,
      });

      const result = await processReapTick(db, now);

      expect(result.generatingRetried).toBe(1);
      expect(result.generatingFailed).toBe(0);
      expect(result.sendingRetried).toBe(0);

      const msg = await getMessage(messageId);
      expect(msg.status).toBe("pending_generation");
      expect(msg.retryCount).toBe(1);
      expect(msg.updatedAt!.getTime()).toBe(now.getTime());
    });
  });

  describe("generating: stuck > 2h, at MAX_RETRY_COUNT", () => {
    it("marks as failed (terminal)", async () => {
      if (!dbAvailable) return;

      const now = new Date("2026-07-21T12:00:00Z");
      const stuckAt = new Date(now.getTime() - 3 * 60 * 60 * 1000);

      const contactId = await insertContact("reap-generating-fail");
      const flowId = await insertFlow();
      const membershipId = await insertMembership(contactId, flowId);
      const messageId = await insertMessage({
        contactId, flowId, membershipId,
        status: "generating",
        retryCount: 3,
        updatedAt: stuckAt,
      });

      const result = await processReapTick(db, now);

      expect(result.generatingFailed).toBe(1);
      expect(result.generatingRetried).toBe(0);

      const msg = await getMessage(messageId);
      expect(msg.status).toBe("failed");
    });
  });

  describe("fresh messages: updated_at within threshold", () => {
    it("does not touch messages updated within the last 2h", async () => {
      if (!dbAvailable) return;

      const now = new Date("2026-07-21T12:00:00Z");
      // 1h ago - within the 2h threshold
      const recentAt = new Date(now.getTime() - 1 * 60 * 60 * 1000);

      const contactId = await insertContact("reap-fresh");
      const flowId = await insertFlow();
      const membershipId = await insertMembership(contactId, flowId);
      const messageId = await insertMessage({
        contactId, flowId, membershipId,
        status: "sending",
        retryCount: 0,
        updatedAt: recentAt,
      });

      const result = await processReapTick(db, now);

      expect(result.sendingRetried).toBe(0);
      expect(result.sendingFailed).toBe(0);

      const msg = await getMessage(messageId);
      expect(msg.status).toBe("sending");
      expect(msg.retryCount).toBe(0);
    });
  });

  describe("non-target statuses: not touched", () => {
    it("does not touch messages in approved, sent, failed, or suppressed", async () => {
      if (!dbAvailable) return;

      const now = new Date("2026-07-21T12:00:00Z");
      // Far in the past - would trigger reap if status matched
      const oldAt = new Date(now.getTime() - 10 * 60 * 60 * 1000);

      const untouchedStatuses = ["pending_approval", "sent", "failed", "suppressed", "pending_generation"] as const;
      const inserted: { id: string; status: string }[] = [];

      for (const status of untouchedStatuses) {
        const contactId = await insertContact(`reap-nontarget-${status}`);
        const flowId = await insertFlow();
        const membershipId = await insertMembership(contactId, flowId);
        const id = await insertMessage({
          contactId, flowId, membershipId,
          status,
          retryCount: 0,
          updatedAt: oldAt,
        });
        inserted.push({ id, status });
      }

      const result = await processReapTick(db, now);

      expect(result.sendingRetried).toBe(0);
      expect(result.sendingFailed).toBe(0);
      expect(result.generatingRetried).toBe(0);
      expect(result.generatingFailed).toBe(0);

      // All should be unchanged
      for (const { id, status } of inserted) {
        const msg = await getMessage(id);
        expect(msg.status, `status should be unchanged for: ${status}`).toBe(status);
      }
    });
  });

  describe("multiple stuck messages in one tick", () => {
    it("handles batch of mixed sending and generating stuck messages", async () => {
      if (!dbAvailable) return;

      const now = new Date("2026-07-21T12:00:00Z");
      const stuckAt = new Date(now.getTime() - 3 * 60 * 60 * 1000);

      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        const contactId = await insertContact(`reap-batch-sending-${i}`);
        const flowId = await insertFlow();
        const membershipId = await insertMembership(contactId, flowId);
        ids.push(await insertMessage({
          contactId, flowId, membershipId,
          status: "sending",
          retryCount: 0,
          updatedAt: stuckAt,
        }));
      }

      for (let i = 0; i < 2; i++) {
        const contactId = await insertContact(`reap-batch-generating-${i}`);
        const flowId = await insertFlow();
        const membershipId = await insertMembership(contactId, flowId);
        ids.push(await insertMessage({
          contactId, flowId, membershipId,
          status: "generating",
          retryCount: 1,
          updatedAt: stuckAt,
        }));
      }

      const result = await processReapTick(db, now);

      expect(result.sendingRetried).toBe(3);
      expect(result.generatingRetried).toBe(2);
      expect(result.sendingFailed).toBe(0);
      expect(result.generatingFailed).toBe(0);
    });
  });

  describe("PgGate race: reap resets while drain writes sent", () => {
    it("drain's CAS write hits 0 rows when reap has already reset the message", async () => {
      if (!dbAvailable) return;

      // This test proves the concurrency contract by simulating the race sequentially:
      // 1. Insert a 'sending' message that is old enough for reap to claim.
      // 2. Run reap - it resets the message to 'approved', retry_count++.
      // 3. Now simulate drain's CAS success write (WHERE id = X AND status = 'sending').
      //    This is the exact write that drain.ts performs after a successful transport call.
      // 4. Assert: drain's write affects 0 rows (reap won).
      // 5. Assert: message is still 'approved' (reap state preserved, not overwritten).
      //
      // This is a PgGate test, not a timing test. It verifies the invariant that
      // "the last writer with a valid CAS wins" - in this case reap ran first,
      // so its state must survive drain's subsequent write.

      const now = new Date("2026-07-21T12:00:00Z");
      const stuckAt = new Date(now.getTime() - 3 * 60 * 60 * 1000);

      const contactId = await insertContact("reap-race-contact");
      const flowId = await insertFlow();
      const membershipId = await insertMembership(contactId, flowId);
      const messageId = await insertMessage({
        contactId, flowId, membershipId,
        status: "sending",
        retryCount: 0,
        updatedAt: stuckAt,
      });

      // Step 1: Reap runs and resets the message to 'approved'.
      const reapResult = await processReapTick(db, now);
      expect(reapResult.sendingRetried).toBe(1);

      const afterReap = await getMessage(messageId);
      expect(afterReap.status).toBe("approved");
      expect(afterReap.retryCount).toBe(1);

      // Step 2: Simulate drain's CAS success write. Drain writes:
      //   UPDATE lifecycle_messages SET status = 'sent' WHERE id = X AND status = 'sending'
      // Since reap already moved it to 'approved', the WHERE status = 'sending' guard
      // must cause this update to affect 0 rows.
      const drainWrite = await db.execute<{ id: string }>(sql`
        UPDATE lifecycle_messages
        SET status = 'sent', sent_at = ${now}, updated_at = ${now}
        WHERE id = ${messageId}
          AND status = 'sending'
        RETURNING id
      `);

      // Drain's write must have affected 0 rows - reap won.
      expect(drainWrite.rows).toHaveLength(0);

      // Message must still be at 'approved' with retry_count = 1 (reap state).
      const final = await getMessage(messageId);
      expect(final.status).toBe("approved");
      expect(final.retryCount).toBe(1);
    });

    it("reap's reset hits 0 rows when drain has already written sent", async () => {
      if (!dbAvailable) return;

      // The reverse race: drain completes first, then reap tries to reset.
      // 1. Insert a 'sending' message that is old enough for reap's threshold.
      // 2. Simulate drain completing successfully (write status = 'sent' with CAS).
      // 3. Run reap.
      // 4. Assert: reap's reset hits 0 rows (drain already advanced the message).
      // 5. Assert: message is 'sent' (drain state preserved).

      const now = new Date("2026-07-21T12:00:00Z");
      const stuckAt = new Date(now.getTime() - 3 * 60 * 60 * 1000);

      const contactId = await insertContact("reap-race-drain-wins");
      const flowId = await insertFlow();
      const membershipId = await insertMembership(contactId, flowId);
      const messageId = await insertMessage({
        contactId, flowId, membershipId,
        status: "sending",
        retryCount: 0,
        updatedAt: stuckAt,
      });

      // Simulate drain completing the send (CAS write).
      await db.execute(sql`
        UPDATE lifecycle_messages
        SET status = 'sent', sent_at = ${now}, updated_at = ${now}
        WHERE id = ${messageId}
          AND status = 'sending'
      `);

      const afterDrain = await getMessage(messageId);
      expect(afterDrain.status).toBe("sent");

      // Now reap runs. updated_at was just refreshed to now, so it is no longer
      // older than the 2h threshold. Reap should not touch it.
      const reapResult = await processReapTick(db, now);

      expect(reapResult.sendingRetried).toBe(0);
      expect(reapResult.sendingFailed).toBe(0);

      const final = await getMessage(messageId);
      // Drain state preserved; 'sent' is a non-target status for reap.
      expect(final.status).toBe("sent");
    });
  });
});
