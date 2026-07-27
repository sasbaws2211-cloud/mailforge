/**
 * Integration tests for the unsubscribe endpoints (task 32b).
 *
 * Coverage:
 *
 * Token module:
 *   Tested in packages/adapters/tests/unsubscribe-token.test.ts (pure unit tests).
 *
 * POST /unsubscribe/one-click (RFC 8058):
 *   - valid token suppresses the recipient_address from the message row
 *   - suppression is verified through the throttle gate L1 query
 *   - repeated POST is idempotent (no duplicate row, still returns 200)
 *   - tampered token suppresses nothing and returns 400
 *   - token signed with a different key suppresses nothing and returns 400
 *   - message row with mixed-case recipient_address is normalized correctly
 *   - missing token returns 400
 *   - token for message with null recipient_address returns 400 (never sent)
 *   - token for message at status != 'sent' returns 400 (not delivered)
 *   - token for non-existent message returns 400
 *
 * GET /unsubscribe (confirmation page):
 *   - valid token renders the form (200 HTML) without writing a suppression
 *   - GET NEVER suppresses (link preview / scanner protection)
 *   - invalid token returns 400 HTML error page
 *
 * POST /unsubscribe (browser form):
 *   - valid token suppresses via form body
 *   - valid token suppresses via JSON body
 *   - idempotent: second POST returns 200, no duplicate row
 *   - tampered token returns 400
 *
 * Failure behavior:
 *   - Returns { error: "Invalid unsubscribe link." } (same shape for all failures)
 *
 * Requires local Postgres (docker compose up postgres).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { sql, eq, and } from "drizzle-orm";
import { buildApp } from "../src/index.js";
import { tenants, contacts, lifecycleMessages, flows, flowMemberships, suppressions } from "@claros/db/schema";
import { generateUnsubscribeToken } from "@claros/adapters";
import {
  THROTTLE_DEFAULTS,
  evaluateThrottleGate,
  type ThrottleGateInput,
} from "@claros/core";

// ---------------------------------------------------------------------------
// DB setup
// ---------------------------------------------------------------------------

const TEST_DB_URL = process.env.DATABASE_URL;
if (!TEST_DB_URL) {
  const inCI = process.env.CI === "true";
  throw new Error(
    `[unsubscribe.test] DATABASE_URL is not set.\n\n` +
      `This test requires a Postgres connection.\n` +
      (inCI
        ? `Set the variable in the workflow env block:\n\n  DATABASE_URL: postgres://claros:claros@localhost:5432/claros\n`
        : `Set the variable in .env (see .env.example) or export it:\n\n  export DATABASE_URL='postgres://claros:claros@localhost:5433/claros'\n`),
  );
}

let pool: pg.Pool;
let db: ReturnType<typeof drizzle>;
let dbAvailable = false;

let tenantId: string;
let contactId: string;
let contactEmail: string;
// Message row with status='sent' and recipient_address set (simulates a delivered message)
let sentMessageId: string;
// Message row with status='approved' and recipient_address null (not yet sent)
let unsentMessageId: string;
// Message row with recipient_address set but status='sending' (crash-window case)
let sendingMessageId: string;

// A stable signing key for all tests in this file
const TEST_SIGNING_KEY = "unsubscribe-test-signing-key-do-not-use-outside-tests";

const SLUG = "test-unsubscribe-32b";

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
        `[unsubscribe.test] DATABASE_URL not reachable in CI.\n` +
          `URL: ${TEST_DB_URL}\nCause: ${(err as Error).message}`,
      );
    }
    console.warn("[unsubscribe.test] DATABASE_URL not reachable - tests skipped.");
    return;
  }

  await cleanup();

  // Create tenant
  const [t] = await db
    .insert(tenants)
    .values({ name: "Unsubscribe Test", slug: SLUG, plan: "free" })
    .returning({ id: tenants.id });
  tenantId = t!.id;

  // Contact with email
  contactEmail = "unsub-test@example.com";
  const [c] = await db
    .insert(contacts)
    .values({
      tenantId,
      externalId: "unsub-ext-1",
      email: contactEmail,
      lifecycleState: "signed_up",
    })
    .returning({ id: contacts.id });
  contactId = c!.id;

  // Create a flow and membership so we can insert messages
  const [f] = await db
    .insert(flows)
    .values({
      tenantId,
      name: "unsub-test-flow",
      priority: 0,
      triggerType: "lifecycle_transition",
      triggerConfig: { from: "signed_up", to: "engaged" },
      steps: [{ order: 1, action_type: "nurture_value", delay: "0d", window_policy: "immediate" }],
      status: "paused",
      flowClass: "nurture",
      compiledPlan: {
        trigger: { type: "lifecycle_transition", condition: { from: "signed_up", to: "engaged" } },
        steps: [{ order: 1, action_type: "nurture_value", delay: "0d", window_policy: "immediate" }],
      },
    })
    .returning({ id: flows.id });
  const flowId = f!.id;

  const [m] = await db
    .insert(flowMemberships)
    .values({
      tenantId,
      contactId,
      flowId,
      currentStep: 1,
      status: "completed",
      enteredAt: new Date("2026-07-01T00:00:00Z"),
      completedAt: new Date("2026-07-01T00:00:00Z"),
      exitReason: "completed",
    })
    .returning({ id: flowMemberships.id });
  const membershipId = m!.id;

  // Sent message: status='sent' + recipient_address set (simulates a delivered message)
  const [sm] = await db
    .insert(lifecycleMessages)
    .values({
      tenantId,
      contactId,
      flowId,
      membershipId,
      flowStepOrder: 1,
      status: "sent",
      subject: "Test subject",
      bodyHtml: "<p>Test</p>",
      recipientAddress: contactEmail,
      sentAt: new Date("2026-07-01T10:00:00Z"),
    })
    .returning({ id: lifecycleMessages.id });
  sentMessageId = sm!.id;

  // Second membership for unsent message (unique index on membershipId + flowStepOrder)
  const [m2] = await db
    .insert(flowMemberships)
    .values({
      tenantId,
      contactId,
      flowId,
      currentStep: 1,
      status: "active",
      enteredAt: new Date("2026-07-02T00:00:00Z"),
    })
    .returning({ id: flowMemberships.id });
  const membership2Id = m2!.id;

  // Unsent message: status='approved', recipient_address null (not yet sent)
  const [um] = await db
    .insert(lifecycleMessages)
    .values({
      tenantId,
      contactId,
      flowId,
      membershipId: membership2Id,
      flowStepOrder: 1,
      status: "approved",
      subject: "Approved subject",
      bodyHtml: "<p>Approved</p>",
      // recipientAddress intentionally omitted (null)
    })
    .returning({ id: lifecycleMessages.id });
  unsentMessageId = um!.id;

  // Third membership for crash-window message: use a separate flow to avoid the
  // unique partial index on (contact_id, flow_id) WHERE status = 'active'.
  const [f2] = await db
    .insert(flows)
    .values({
      tenantId,
      name: "unsub-test-flow-2",
      priority: 0,
      triggerType: "lifecycle_transition",
      triggerConfig: { from: "signed_up", to: "engaged" },
      steps: [{ order: 1, action_type: "nurture_value", delay: "0d", window_policy: "immediate" }],
      status: "paused",
      flowClass: "nurture",
      compiledPlan: {
        trigger: { type: "lifecycle_transition", condition: { from: "signed_up", to: "engaged" } },
        steps: [{ order: 1, action_type: "nurture_value", delay: "0d", window_policy: "immediate" }],
      },
    })
    .returning({ id: flows.id });
  const flow2Id = f2!.id;

  const [m3] = await db
    .insert(flowMemberships)
    .values({
      tenantId,
      contactId,
      flowId: flow2Id,
      currentStep: 1,
      status: "active",
      enteredAt: new Date("2026-07-03T00:00:00Z"),
    })
    .returning({ id: flowMemberships.id });
  const membership3Id = m3!.id;

  // Sending message: status='sending' + recipient_address set (crash-window case -
  // drain wrote recipient_address before the send but process died before marking 'sent')
  const [sendm] = await db
    .insert(lifecycleMessages)
    .values({
      tenantId,
      contactId,
      flowId: flow2Id,
      membershipId: membership3Id,
      flowStepOrder: 1,
      status: "sending",
      subject: "Sending subject",
      bodyHtml: "<p>Sending</p>",
      recipientAddress: contactEmail, // written before send
    })
    .returning({ id: lifecycleMessages.id });
  sendingMessageId = sendm!.id;
});

afterAll(async () => {
  if (dbAvailable) await cleanup();
  await pool.end();
});

async function cleanup() {
  await db.execute(sql`DELETE FROM lifecycle_messages WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${SLUG})`);
  await db.execute(sql`DELETE FROM flow_memberships WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${SLUG})`);
  await db.execute(sql`DELETE FROM flows WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${SLUG})`);
  await db.execute(sql`DELETE FROM suppressions WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${SLUG})`);
  await db.execute(sql`DELETE FROM contacts WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${SLUG})`);
  await db.execute(sql`DELETE FROM users WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${SLUG})`);
  await db.execute(sql`DELETE FROM tenants WHERE slug = ${SLUG}`);
}

async function clearSuppressions() {
  await db.execute(sql`DELETE FROM suppressions WHERE tenant_id = ${tenantId}::uuid`);
}

/** Run the throttle gate's L1 query directly - same query the drain uses. */
async function isBlockedByGate(email: string): Promise<boolean> {
  const rows = await db
    .select({ id: suppressions.id })
    .from(suppressions)
    .where(
      and(
        eq(suppressions.tenantId, tenantId),
        sql`lower(${suppressions.email}) = lower(${email})`,
      ),
    )
    .limit(1);

  // Feed the gate (pure function) the same isSuppressed flag the drain would compute
  const isSuppressed = rows.length > 0;
  const verdict = evaluateThrottleGate({
    isSuppressed,
    flowClass: "nurture",
    windowPolicy: "immediate",
    config: { ...THROTTLE_DEFAULTS, send_window_timezone: "tenant_fixed", tenant_timezone: "UTC" },
    recentSends: { countLast24h: 0, countLast7d: 0, lastSentAt: null },
    contactTimezone: null,
    now: new Date(),
  } satisfies ThrottleGateInput);

  return verdict.outcome === "suppress";
}

// ---------------------------------------------------------------------------
// POST /unsubscribe/one-click (RFC 8058)
// ---------------------------------------------------------------------------

describe("POST /unsubscribe/one-click", () => {
  it("valid token suppresses the recipient_address from the message row", async () => {
    if (!dbAvailable) return;
    await clearSuppressions();

    const app = await buildApp({ db, logger: false });
    // Token encodes tenantId + sentMessageId (not contactId)
    const token = generateUnsubscribeToken(tenantId, sentMessageId, TEST_SIGNING_KEY);

    // Inject the UNSUBSCRIBE_SIGNING_KEY so the endpoint can verify
    const saved = process.env.UNSUBSCRIBE_SIGNING_KEY;
    process.env.UNSUBSCRIBE_SIGNING_KEY = TEST_SIGNING_KEY;
    try {
      const res = await app.inject({
        method: "POST",
        url: `/unsubscribe/one-click?token=${encodeURIComponent(token)}`,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "List-Unsubscribe=One-Click",
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ unsubscribed: true });
    } finally {
      if (saved !== undefined) process.env.UNSUBSCRIBE_SIGNING_KEY = saved;
      else delete process.env.UNSUBSCRIBE_SIGNING_KEY;
    }

    // Verify through the gate (not by reading the table)
    const blocked = await isBlockedByGate(contactEmail);
    expect(blocked).toBe(true);
  });

  it("suppression is blocked by the throttle gate L1 query (gate verification)", async () => {
    if (!dbAvailable) return;
    await clearSuppressions();

    const app = await buildApp({ db, logger: false });
    const token = generateUnsubscribeToken(tenantId, sentMessageId, TEST_SIGNING_KEY);

    const saved = process.env.UNSUBSCRIBE_SIGNING_KEY;
    process.env.UNSUBSCRIBE_SIGNING_KEY = TEST_SIGNING_KEY;
    try {
      await app.inject({
        method: "POST",
        url: `/unsubscribe/one-click?token=${encodeURIComponent(token)}`,
      });
    } finally {
      if (saved !== undefined) process.env.UNSUBSCRIBE_SIGNING_KEY = saved;
      else delete process.env.UNSUBSCRIBE_SIGNING_KEY;
    }

    // Gate verdict must be "suppress" (not just table presence)
    const gateInput: ThrottleGateInput = {
      isSuppressed: await (async () => {
        const rows = await db
          .select({ id: suppressions.id })
          .from(suppressions)
          .where(
            and(
              eq(suppressions.tenantId, tenantId),
              sql`lower(${suppressions.email}) = lower(${contactEmail})`,
            ),
          )
          .limit(1);
        return rows.length > 0;
      })(),
      flowClass: "nurture",
      windowPolicy: "immediate",
      config: { ...THROTTLE_DEFAULTS, send_window_timezone: "tenant_fixed", tenant_timezone: "UTC" },
      recentSends: { countLast24h: 0, countLast7d: 0, lastSentAt: null },
      contactTimezone: null,
      now: new Date(),
    };
    const verdict = evaluateThrottleGate(gateInput);
    expect(verdict.outcome).toBe("suppress");
  });

  it("repeated POST is idempotent - no duplicate row, still returns 200", async () => {
    if (!dbAvailable) return;
    await clearSuppressions();

    const app = await buildApp({ db, logger: false });
    const token = generateUnsubscribeToken(tenantId, sentMessageId, TEST_SIGNING_KEY);

    const saved = process.env.UNSUBSCRIBE_SIGNING_KEY;
    process.env.UNSUBSCRIBE_SIGNING_KEY = TEST_SIGNING_KEY;
    try {
      // First call
      const r1 = await app.inject({
        method: "POST",
        url: `/unsubscribe/one-click?token=${encodeURIComponent(token)}`,
      });
      expect(r1.statusCode).toBe(200);

      // Second call - must be success, not error
      const r2 = await app.inject({
        method: "POST",
        url: `/unsubscribe/one-click?token=${encodeURIComponent(token)}`,
      });
      expect(r2.statusCode).toBe(200);
      expect(r2.json()).toEqual({ unsubscribed: true });
    } finally {
      if (saved !== undefined) process.env.UNSUBSCRIBE_SIGNING_KEY = saved;
      else delete process.env.UNSUBSCRIBE_SIGNING_KEY;
    }

    // Must not have created a duplicate row
    const rows = await db
      .select()
      .from(suppressions)
      .where(eq(suppressions.tenantId, tenantId));
    expect(rows.length).toBe(1);
  });

  it("tampered token suppresses nothing and returns 400", async () => {
    if (!dbAvailable) return;
    await clearSuppressions();

    const app = await buildApp({ db, logger: false });
    const token = generateUnsubscribeToken(tenantId, sentMessageId, TEST_SIGNING_KEY);

    // Tamper with the payload
    const [payloadB64, sigB64] = token.split(".");
    const payload = JSON.parse(Buffer.from(payloadB64!, "base64url").toString("utf8"));
    payload.messageId = "00000000-0000-0000-0000-000000000099"; // tampered
    const tamperedB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const tamperedToken = `${tamperedB64}.${sigB64}`;

    const saved = process.env.UNSUBSCRIBE_SIGNING_KEY;
    process.env.UNSUBSCRIBE_SIGNING_KEY = TEST_SIGNING_KEY;
    try {
      const res = await app.inject({
        method: "POST",
        url: `/unsubscribe/one-click?token=${encodeURIComponent(tamperedToken)}`,
      });
      expect(res.statusCode).toBe(400);
    } finally {
      if (saved !== undefined) process.env.UNSUBSCRIBE_SIGNING_KEY = saved;
      else delete process.env.UNSUBSCRIBE_SIGNING_KEY;
    }

    // No suppression written
    const rows = await db.select().from(suppressions).where(eq(suppressions.tenantId, tenantId));
    expect(rows.length).toBe(0);
  });

  it("token signed with a different key is rejected and suppresses nothing", async () => {
    if (!dbAvailable) return;
    await clearSuppressions();

    const app = await buildApp({ db, logger: false });

    // Generate with wrong key, verify with correct key
    const wrongToken = generateUnsubscribeToken(tenantId, sentMessageId, "totally-different-key");

    const saved = process.env.UNSUBSCRIBE_SIGNING_KEY;
    process.env.UNSUBSCRIBE_SIGNING_KEY = TEST_SIGNING_KEY;
    try {
      const res = await app.inject({
        method: "POST",
        url: `/unsubscribe/one-click?token=${encodeURIComponent(wrongToken)}`,
      });
      expect(res.statusCode).toBe(400);
    } finally {
      if (saved !== undefined) process.env.UNSUBSCRIBE_SIGNING_KEY = saved;
      else delete process.env.UNSUBSCRIBE_SIGNING_KEY;
    }

    // No suppression written
    const rows = await db.select().from(suppressions).where(eq(suppressions.tenantId, tenantId));
    expect(rows.length).toBe(0);
  });

  it("message row with mixed-case recipient_address is normalized to lowercase", async () => {
    if (!dbAvailable) return;
    await clearSuppressions();

    // Update the message's recipient_address to mixed case
    await db
      .update(lifecycleMessages)
      .set({ recipientAddress: "UNSUB-TEST@Example.COM" })
      .where(eq(lifecycleMessages.id, sentMessageId));

    const app = await buildApp({ db, logger: false });
    const token = generateUnsubscribeToken(tenantId, sentMessageId, TEST_SIGNING_KEY);

    const saved = process.env.UNSUBSCRIBE_SIGNING_KEY;
    process.env.UNSUBSCRIBE_SIGNING_KEY = TEST_SIGNING_KEY;
    try {
      const res = await app.inject({
        method: "POST",
        url: `/unsubscribe/one-click?token=${encodeURIComponent(token)}`,
      });
      expect(res.statusCode).toBe(200);
    } finally {
      if (saved !== undefined) process.env.UNSUBSCRIBE_SIGNING_KEY = saved;
      else delete process.env.UNSUBSCRIBE_SIGNING_KEY;
    }

    // Row must be stored lowercase
    const rows = await db.select().from(suppressions).where(eq(suppressions.tenantId, tenantId));
    expect(rows.length).toBe(1);
    expect(rows[0]!.email).toBe("unsub-test@example.com");

    // Gate blocks the original case too
    const blocked = await isBlockedByGate("UNSUB-TEST@Example.COM");
    expect(blocked).toBe(true);

    // Restore original recipient_address
    await db
      .update(lifecycleMessages)
      .set({ recipientAddress: contactEmail })
      .where(eq(lifecycleMessages.id, sentMessageId));
  });

  it("missing token returns 400", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });
    const res = await app.inject({
      method: "POST",
      url: "/unsubscribe/one-click",
    });
    expect(res.statusCode).toBe(400);
  });

  it("token for message with null recipient_address returns 400 (never processed by drain)", async () => {
    if (!dbAvailable) return;
    await clearSuppressions();

    const app = await buildApp({ db, logger: false });
    // Token uses unsentMessageId (status='approved', recipient_address is null)
    const token = generateUnsubscribeToken(tenantId, unsentMessageId, TEST_SIGNING_KEY);

    const saved = process.env.UNSUBSCRIBE_SIGNING_KEY;
    process.env.UNSUBSCRIBE_SIGNING_KEY = TEST_SIGNING_KEY;
    try {
      const res = await app.inject({
        method: "POST",
        url: `/unsubscribe/one-click?token=${encodeURIComponent(token)}`,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: "Invalid unsubscribe link." });
    } finally {
      if (saved !== undefined) process.env.UNSUBSCRIBE_SIGNING_KEY = saved;
      else delete process.env.UNSUBSCRIBE_SIGNING_KEY;
    }

    // No suppression written
    const rows = await db.select().from(suppressions).where(eq(suppressions.tenantId, tenantId));
    expect(rows.length).toBe(0);
  });

  it("token for message at status='sending' (recipient_address set, not yet sent) returns 400", async () => {
    if (!dbAvailable) return;
    await clearSuppressions();

    const app = await buildApp({ db, logger: false });
    // sendingMessageId: status='sending', recipient_address is set (crash-window scenario)
    // The endpoint must reject this: recipient_address alone is not proof of delivery.
    const token = generateUnsubscribeToken(tenantId, sendingMessageId, TEST_SIGNING_KEY);

    const saved = process.env.UNSUBSCRIBE_SIGNING_KEY;
    process.env.UNSUBSCRIBE_SIGNING_KEY = TEST_SIGNING_KEY;
    try {
      const res = await app.inject({
        method: "POST",
        url: `/unsubscribe/one-click?token=${encodeURIComponent(token)}`,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: "Invalid unsubscribe link." });
    } finally {
      if (saved !== undefined) process.env.UNSUBSCRIBE_SIGNING_KEY = saved;
      else delete process.env.UNSUBSCRIBE_SIGNING_KEY;
    }

    // No suppression written
    const rows = await db.select().from(suppressions).where(eq(suppressions.tenantId, tenantId));
    expect(rows.length).toBe(0);
  });

  it("token for non-existent message returns 400", async () => {
    if (!dbAvailable) return;
    await clearSuppressions();

    const app = await buildApp({ db, logger: false });
    // Use a valid UUID that does not exist in the database
    const nonExistentId = "00000000-0000-0000-0000-deadbeef0001";
    const token = generateUnsubscribeToken(tenantId, nonExistentId, TEST_SIGNING_KEY);

    const saved = process.env.UNSUBSCRIBE_SIGNING_KEY;
    process.env.UNSUBSCRIBE_SIGNING_KEY = TEST_SIGNING_KEY;
    try {
      const res = await app.inject({
        method: "POST",
        url: `/unsubscribe/one-click?token=${encodeURIComponent(token)}`,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: "Invalid unsubscribe link." });
    } finally {
      if (saved !== undefined) process.env.UNSUBSCRIBE_SIGNING_KEY = saved;
      else delete process.env.UNSUBSCRIBE_SIGNING_KEY;
    }

    // No suppression written
    const rows = await db.select().from(suppressions).where(eq(suppressions.tenantId, tenantId));
    expect(rows.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// GET /unsubscribe (confirmation page - must NOT suppress)
// ---------------------------------------------------------------------------

describe("GET /unsubscribe", () => {
  it("renders the confirmation page without suppressing anything", async () => {
    if (!dbAvailable) return;
    await clearSuppressions();

    const app = await buildApp({ db, logger: false });
    const token = generateUnsubscribeToken(tenantId, sentMessageId, TEST_SIGNING_KEY);

    const saved = process.env.UNSUBSCRIBE_SIGNING_KEY;
    process.env.UNSUBSCRIBE_SIGNING_KEY = TEST_SIGNING_KEY;
    try {
      const res = await app.inject({
        method: "GET",
        url: `/unsubscribe?token=${encodeURIComponent(token)}`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toMatch(/text\/html/);
      // Should contain a form submit button, not a "you are unsubscribed" message
      expect(res.body).toContain("<form");
      expect(res.body).toContain('type="submit"');
    } finally {
      if (saved !== undefined) process.env.UNSUBSCRIBE_SIGNING_KEY = saved;
      else delete process.env.UNSUBSCRIBE_SIGNING_KEY;
    }

    // No suppression written by GET
    const rows = await db.select().from(suppressions).where(eq(suppressions.tenantId, tenantId));
    expect(rows.length).toBe(0);
  });

  it("GET does not suppress even if called repeatedly (link preview / scanner protection)", async () => {
    if (!dbAvailable) return;
    await clearSuppressions();

    const app = await buildApp({ db, logger: false });
    const token = generateUnsubscribeToken(tenantId, sentMessageId, TEST_SIGNING_KEY);

    const saved = process.env.UNSUBSCRIBE_SIGNING_KEY;
    process.env.UNSUBSCRIBE_SIGNING_KEY = TEST_SIGNING_KEY;
    try {
      // Simulate a scanner calling the URL multiple times
      for (let i = 0; i < 3; i++) {
        await app.inject({
          method: "GET",
          url: `/unsubscribe?token=${encodeURIComponent(token)}`,
        });
      }
    } finally {
      if (saved !== undefined) process.env.UNSUBSCRIBE_SIGNING_KEY = saved;
      else delete process.env.UNSUBSCRIBE_SIGNING_KEY;
    }

    // Still no suppression
    const rows = await db.select().from(suppressions).where(eq(suppressions.tenantId, tenantId));
    expect(rows.length).toBe(0);
  });

  it("invalid token renders error page with 400", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });

    const saved = process.env.UNSUBSCRIBE_SIGNING_KEY;
    process.env.UNSUBSCRIBE_SIGNING_KEY = TEST_SIGNING_KEY;
    try {
      const res = await app.inject({
        method: "GET",
        url: "/unsubscribe?token=this-is-not-a-valid-token",
      });
      expect(res.statusCode).toBe(400);
      expect(res.headers["content-type"]).toMatch(/text\/html/);
    } finally {
      if (saved !== undefined) process.env.UNSUBSCRIBE_SIGNING_KEY = saved;
      else delete process.env.UNSUBSCRIBE_SIGNING_KEY;
    }
  });
});

// ---------------------------------------------------------------------------
// POST /unsubscribe (browser form submission)
// ---------------------------------------------------------------------------

describe("POST /unsubscribe (browser form)", () => {
  it("valid token suppresses via form body (application/x-www-form-urlencoded)", async () => {
    if (!dbAvailable) return;
    await clearSuppressions();

    const app = await buildApp({ db, logger: false });
    const token = generateUnsubscribeToken(tenantId, sentMessageId, TEST_SIGNING_KEY);

    const saved = process.env.UNSUBSCRIBE_SIGNING_KEY;
    process.env.UNSUBSCRIBE_SIGNING_KEY = TEST_SIGNING_KEY;
    try {
      const res = await app.inject({
        method: "POST",
        url: "/unsubscribe",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: `token=${encodeURIComponent(token)}`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toMatch(/text\/html/);
      // Should show success message
      expect(res.body).toContain("Unsubscribed");
    } finally {
      if (saved !== undefined) process.env.UNSUBSCRIBE_SIGNING_KEY = saved;
      else delete process.env.UNSUBSCRIBE_SIGNING_KEY;
    }

    const blocked = await isBlockedByGate(contactEmail);
    expect(blocked).toBe(true);
  });

  it("valid token suppresses via JSON body", async () => {
    if (!dbAvailable) return;
    await clearSuppressions();

    const app = await buildApp({ db, logger: false });
    const token = generateUnsubscribeToken(tenantId, sentMessageId, TEST_SIGNING_KEY);

    const saved = process.env.UNSUBSCRIBE_SIGNING_KEY;
    process.env.UNSUBSCRIBE_SIGNING_KEY = TEST_SIGNING_KEY;
    try {
      const res = await app.inject({
        method: "POST",
        url: "/unsubscribe",
        headers: { "content-type": "application/json" },
        payload: { token },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ unsubscribed: true });
    } finally {
      if (saved !== undefined) process.env.UNSUBSCRIBE_SIGNING_KEY = saved;
      else delete process.env.UNSUBSCRIBE_SIGNING_KEY;
    }
  });

  it("browser POST is idempotent - second call returns 200, no duplicate row", async () => {
    if (!dbAvailable) return;
    await clearSuppressions();

    const app = await buildApp({ db, logger: false });
    const token = generateUnsubscribeToken(tenantId, sentMessageId, TEST_SIGNING_KEY);

    const saved = process.env.UNSUBSCRIBE_SIGNING_KEY;
    process.env.UNSUBSCRIBE_SIGNING_KEY = TEST_SIGNING_KEY;
    try {
      const r1 = await app.inject({
        method: "POST",
        url: "/unsubscribe",
        headers: { "content-type": "application/json" },
        payload: { token },
      });
      expect(r1.statusCode).toBe(200);

      const r2 = await app.inject({
        method: "POST",
        url: "/unsubscribe",
        headers: { "content-type": "application/json" },
        payload: { token },
      });
      expect(r2.statusCode).toBe(200);
    } finally {
      if (saved !== undefined) process.env.UNSUBSCRIBE_SIGNING_KEY = saved;
      else delete process.env.UNSUBSCRIBE_SIGNING_KEY;
    }

    const rows = await db.select().from(suppressions).where(eq(suppressions.tenantId, tenantId));
    expect(rows.length).toBe(1);
  });

  it("tampered token returns 400 and suppresses nothing", async () => {
    if (!dbAvailable) return;
    await clearSuppressions();

    const app = await buildApp({ db, logger: false });
    const token = generateUnsubscribeToken(tenantId, sentMessageId, TEST_SIGNING_KEY);
    const tamperedToken = token.slice(0, -5) + "XXXXX";

    const saved = process.env.UNSUBSCRIBE_SIGNING_KEY;
    process.env.UNSUBSCRIBE_SIGNING_KEY = TEST_SIGNING_KEY;
    try {
      const res = await app.inject({
        method: "POST",
        url: "/unsubscribe",
        headers: { "content-type": "application/json" },
        payload: { token: tamperedToken },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      if (saved !== undefined) process.env.UNSUBSCRIBE_SIGNING_KEY = saved;
      else delete process.env.UNSUBSCRIBE_SIGNING_KEY;
    }

    const rows = await db.select().from(suppressions).where(eq(suppressions.tenantId, tenantId));
    expect(rows.length).toBe(0);
  });
});
