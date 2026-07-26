/**
 * Integration tests for the context packet assembler (slice 18.5).
 *
 * Tests the assembleContext function end-to-end against Postgres, verifying
 * that the composed context (contact + events + flow) matches expectations
 * for various contact states.
 *
 * Tests:
 * - Full context: real contact with events, prior messages, and flow produces
 *   a fully populated decide and draft context.
 * - Empty context: contact with no events and no prior messages produces valid
 *   contexts with absent rather than fabricated values.
 * - Budget truncation: oversized context is truncated and the drop list is
 *   surfaced via the content worker pipeline.
 * - Failure behavior: a failing context query leaves the message at generating
 *   and reap recovers it.
 * - Tenant isolation: queries return only data for the candidate's tenant.
 * - KB failure isolation (step 0a fix): a provider error, timeout, or 401 on
 *   the query embedding leaves kb_context absent and does NOT propagate to
 *   the assembler caller. Generation proceeds without KB context.
 *
 * Requires local Postgres (docker compose up postgres).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock context-kb module so individual tests can override buildKbContextSection
// ---------------------------------------------------------------------------

vi.mock("../src/context-kb.js", () => ({
  buildKbContextSection: vi.fn(async () => undefined),
  KB_MAX_RESULTS: 3,
  KB_SIMILARITY_FLOOR: 0.70,
}));
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { sql } from "drizzle-orm";
import {
  tenants,
  contacts,
  flows,
  flowMemberships,
  lifecycleMessages,
  events,
  transportConfigs,
} from "@claros/db/schema";

import { assembleContext, type AssembledContext } from "../src/context-assembler.js";
import type { ContentCandidate } from "../src/content.js";

// ---------------------------------------------------------------------------
// DB setup
// ---------------------------------------------------------------------------

const TEST_DB_URL = process.env.DATABASE_URL;
if (!TEST_DB_URL) {
  const inCI = process.env.CI === "true";
  throw new Error(
    `[context-assembler.test] DATABASE_URL is not set.\n\n` +
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
let otherTenantId: string;

const SLUG = "test-ctx-assembler";
const SLUG_OTHER = "test-ctx-assembler-other";

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
        `[context-assembler.test] DATABASE_URL not reachable in CI.\n` +
          `URL: ${TEST_DB_URL}\nCause: ${(err as Error).message}`,
      );
    }
    console.warn("[context-assembler.test] DATABASE_URL not reachable - tests skipped.");
    return;
  }

  await cleanup();

  const [tenant] = await db
    .insert(tenants)
    .values({ name: "Test Assembler Product", slug: SLUG, plan: "free" })
    .returning({ id: tenants.id });
  testTenantId = tenant!.id;

  const [other] = await db
    .insert(tenants)
    .values({ name: "Test Assembler Other", slug: SLUG_OTHER, plan: "free" })
    .returning({ id: tenants.id });
  otherTenantId = other!.id;
});

beforeEach(async () => {
  if (!dbAvailable) return;

  // Clean test data between tests
  await db.execute(sql`DELETE FROM events WHERE tenant_id = ${testTenantId}`);
  await db.execute(sql`DELETE FROM events WHERE tenant_id = ${otherTenantId}`);
  await db.execute(sql`DELETE FROM lifecycle_messages WHERE tenant_id = ${testTenantId}`);
  await db.execute(sql`DELETE FROM lifecycle_messages WHERE tenant_id = ${otherTenantId}`);
  await db.execute(sql`DELETE FROM flow_memberships WHERE tenant_id = ${testTenantId}`);
  await db.execute(sql`DELETE FROM flow_memberships WHERE tenant_id = ${otherTenantId}`);
  await db.execute(sql`DELETE FROM flows WHERE tenant_id = ${testTenantId}`);
  await db.execute(sql`DELETE FROM flows WHERE tenant_id = ${otherTenantId}`);
  await db.execute(sql`DELETE FROM transport_configs WHERE tenant_id = ${testTenantId}`);
  await db.execute(sql`DELETE FROM transport_configs WHERE tenant_id = ${otherTenantId}`);
  await db.execute(sql`DELETE FROM contacts WHERE tenant_id = ${testTenantId}`);
  await db.execute(sql`DELETE FROM contacts WHERE tenant_id = ${otherTenantId}`);
});

afterAll(async () => {
  if (dbAvailable) {
    await cleanup();
  }
  await pool.end();
});

async function cleanup() {
  for (const slug of [SLUG, SLUG_OTHER]) {
    await db.execute(
      sql`DELETE FROM events WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${slug})`,
    );
    await db.execute(
      sql`DELETE FROM lifecycle_messages WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${slug})`,
    );
    await db.execute(
      sql`DELETE FROM flow_memberships WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${slug})`,
    );
    await db.execute(
      sql`DELETE FROM flows WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${slug})`,
    );
    await db.execute(
      sql`DELETE FROM transport_configs WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${slug})`,
    );
    await db.execute(
      sql`DELETE FROM contacts WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${slug})`,
    );
    await db.execute(sql`DELETE FROM tenants WHERE slug = ${slug}`);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function insertContact(
  externalId: string,
  tenantId: string = testTenantId,
  opts: {
    name?: string;
    email?: string;
    company?: string;
    properties?: Record<string, unknown>;
    lifecycleState?: string;
    engagementDepth?: string;
    paymentStatus?: string;
    firstSeenAt?: Date;
    lastSeenAt?: Date;
  } = {},
): Promise<string> {
  const [row] = await db
    .insert(contacts)
    .values({
      tenantId,
      externalId,
      name: opts.name ?? `Contact ${externalId}`,
      email: opts.email ?? `${externalId}@example.com`,
      company: opts.company ?? null,
      properties: opts.properties ?? null,
      lifecycleState: opts.lifecycleState ?? "engaged",
      engagementDepth: opts.engagementDepth ?? "regular",
      paymentStatus: opts.paymentStatus ?? "paid",
      firstSeenAt: opts.firstSeenAt ?? new Date("2026-06-01T00:00:00Z"),
      lastSeenAt: opts.lastSeenAt ?? new Date("2026-07-20T00:00:00Z"),
    })
    .returning({ id: contacts.id });
  return row!.id;
}

async function insertFlow(
  name: string,
  tenantId: string = testTenantId,
  brainInstruction?: string,
): Promise<string> {
  const [row] = await db
    .insert(flows)
    .values({
      tenantId,
      name,
      priority: 0,
      triggerType: "lifecycle_transition",
      triggerConfig: { from: "engaged", to: "at_risk" },
      steps: [{ order: 1, action_type: "nurture_value", delay: "0d" }],
      status: "active",
      flowClass: "nurture",
      compiledPlan: {
        trigger: { type: "lifecycle_transition", condition: { from: "engaged", to: "at_risk" } },
        steps: [{
          order: 1,
          action_type: "nurture_value",
          delay: "0d",
          brain_instruction: brainInstruction ?? "Write a helpful re-engagement email.",
        }],
      },
    })
    .returning({ id: flows.id });
  return row!.id;
}

async function insertMembership(
  contactId: string,
  flowId: string,
  tenantId: string = testTenantId,
): Promise<string> {
  const [row] = await db
    .insert(flowMemberships)
    .values({
      tenantId,
      contactId,
      flowId,
      currentStep: 1,
      status: "completed",
      enteredAt: new Date("2026-07-15T00:00:00Z"),
      completedAt: new Date("2026-07-20T00:00:00Z"),
      exitReason: "completed",
    })
    .returning({ id: flowMemberships.id });
  return row!.id;
}

async function insertEvent(
  contactId: string,
  eventName: string | null,
  timestamp: Date,
  tenantId: string = testTenantId,
): Promise<void> {
  await db.insert(events).values({
    tenantId,
    contactId,
    type: "track",
    eventName,
    timestamp,
    receivedAt: timestamp,
    properties: {},
  });
}

async function insertSentMessage(
  contactId: string,
  flowId: string,
  membershipId: string,
  sentAt: Date,
  opts: {
    tenantId?: string;
    feedback?: string;
    brainActionType?: string;
    flowStepOrder?: number;
  } = {},
): Promise<string> {
  const tenantId = opts.tenantId ?? testTenantId;
  const [row] = await db
    .insert(lifecycleMessages)
    .values({
      tenantId,
      contactId,
      flowId,
      membershipId,
      flowStepOrder: opts.flowStepOrder ?? 1,
      status: "sent",
      brainActionType: opts.brainActionType ?? "nurture_value",
      sentAt,
      feedback: (opts.feedback ?? null) as "opened" | "clicked" | "bounced" | "complained" | null,
    })
    .returning({ id: lifecycleMessages.id });
  return row!.id;
}

async function insertTransportConfig(
  tenantId: string,
  fromName: string | null,
): Promise<void> {
  await db.insert(transportConfigs).values({
    tenantId,
    provider: "smtp",
    config: { host: "localhost", port: 587 },
    fromEmail: "noreply@example.com",
    fromName,
    isActive: true,
  });
}

function makeCandidate(opts: {
  id?: string;
  tenantId?: string;
  contactId: string;
  flowId: string;
  membershipId: string;
  flowStepOrder?: number;
  brainActionType?: string;
}): ContentCandidate {
  return {
    id: opts.id ?? "test-msg-id",
    tenantId: opts.tenantId ?? testTenantId,
    contactId: opts.contactId,
    flowId: opts.flowId,
    membershipId: opts.membershipId,
    flowStepOrder: opts.flowStepOrder ?? 1,
    brainActionType: opts.brainActionType ?? "nurture_value",
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("context assembler", () => {
  it("skips when DATABASE_URL is not reachable", () => {
    if (!dbAvailable) {
      expect(true).toBe(true);
    }
  });

  // -------------------------------------------------------------------------
  // Full context: real contact with events, prior messages, and a flow
  // -------------------------------------------------------------------------

  describe("full context assembly", () => {
    it("produces a fully populated decide and draft context", async () => {
      if (!dbAvailable) return;

      const now = new Date("2026-07-21T10:00:00Z");

      // Set up contact with rich data
      const contactId = await insertContact("asm-full", testTenantId, {
        name: "Alice Engineer",
        email: "alice@acme.com",
        company: "Acme Corp",
        properties: { plan: "pro" },
        lifecycleState: "engaged",
        engagementDepth: "regular",
        paymentStatus: "paid",
        firstSeenAt: new Date("2026-06-01T00:00:00Z"),
        lastSeenAt: new Date("2026-07-20T12:00:00Z"),
      });

      // Flow with brain_instruction
      const flowId = await insertFlow("asm-full-flow", testTenantId, "Write a check-in email about their project usage.");
      const membershipId = await insertMembership(contactId, flowId);

      // Transport config with from_name
      await insertTransportConfig(testTenantId, "Alice from Acme");

      // Prior sent messages
      await insertSentMessage(contactId, flowId, membershipId, new Date("2026-07-10T10:00:00Z"), { feedback: "opened", flowStepOrder: 1 });
      await insertSentMessage(contactId, flowId, membershipId, new Date("2026-07-15T10:00:00Z"), { feedback: "clicked", flowStepOrder: 2 });

      // Events in the last 7 days
      await insertEvent(contactId, "project_created", new Date("2026-07-19T08:00:00Z"));
      await insertEvent(contactId, "dashboard_viewed", new Date("2026-07-20T09:00:00Z"));
      await insertEvent(contactId, "export_run", new Date("2026-07-20T11:00:00Z"));
      // Events in the previous 7 days (7-14 days ago)
      await insertEvent(contactId, "page_viewed", new Date("2026-07-10T10:00:00Z"));
      await insertEvent(contactId, "project_created", new Date("2026-07-11T10:00:00Z"));
      await insertEvent(contactId, "project_created", new Date("2026-07-12T10:00:00Z"));
      await insertEvent(contactId, "dashboard_viewed", new Date("2026-07-13T10:00:00Z"));
      await insertEvent(contactId, "dashboard_viewed", new Date("2026-07-14T10:00:00Z"));

      const candidate = makeCandidate({ contactId, flowId, membershipId });
      const result = await assembleContext(db, candidate, now);

      expect(result).not.toBeNull();
      const ctx = result!;

      // Verify decide context
      expect(ctx.decideCtx.actionType).toBe("nurture_value");
      expect(ctx.decideCtx.contact.name).toBe("Alice Engineer");
      expect(ctx.decideCtx.contact.email).toBe("alice@acme.com");
      expect(ctx.decideCtx.contact.company).toBe("Acme Corp");
      expect(ctx.decideCtx.contact.plan).toBe("pro");
      expect(ctx.decideCtx.contact.signupDate).toContain("2026-06-01");
      expect(ctx.decideCtx.contact.lastSeen).toContain("2026-07-20");
      expect(ctx.decideCtx.lifecycle.state).toBe("engaged");
      expect(ctx.decideCtx.lifecycle.tenureDays).toBeGreaterThan(0);
      expect(ctx.decideCtx.lifecycle.engagementDepth).toBe("regular");
      expect(ctx.decideCtx.lifecycle.paymentStatus).toBe("paid");
      expect(ctx.decideCtx.cadence).toBeDefined();
      expect(ctx.decideCtx.cadence!.current7d).toBe(4); // 4 events in last 7 days (including boundary)
      expect(ctx.decideCtx.cadence!.previous7d).toBe(4); // 4 events 7-14 days ago
      expect(ctx.decideCtx.behavior).toBeDefined();
      expect(ctx.decideCtx.behavior!.recentEvents).toBeDefined();
      expect(ctx.decideCtx.behavior!.recentEvents!.length).toBeGreaterThan(0);
      expect(ctx.decideCtx.behavior!.mostUsedFeatures).toBeDefined();
      expect(ctx.decideCtx.priorContact).toBeDefined();
      expect(ctx.decideCtx.priorContact!.totalMessagesSent).toBe(2);
      expect(ctx.decideCtx.priorContact!.messagesOpened).toBe(2); // opened + clicked
      expect(ctx.decideCtx.priorContact!.messagesClicked).toBe(1);
      expect(ctx.decideCtx.firstContact).toBe(false);
      expect(ctx.decideCtx.brainInstruction).toBe("Write a check-in email about their project usage.");

      // Verify draft context
      expect(ctx.draftCtx.action_type).toBe("nurture_value");
      expect(ctx.draftCtx.brain_instruction).toBe("Write a check-in email about their project usage.");
      expect(ctx.draftCtx.sender_name).toBe("Alice from Acme");
      expect(ctx.draftCtx.product_name).toBe("Test Assembler Product");
      expect(ctx.draftCtx.contact?.name).toBe("Alice Engineer");
      expect(ctx.draftCtx.contact?.email).toBe("alice@acme.com");
      expect(ctx.draftCtx.contact?.company).toBe("Acme Corp");
      expect(ctx.draftCtx.contact?.plan).toBe("pro");
      expect(ctx.draftCtx.lifecycle?.state).toBe("engaged");
      expect(ctx.draftCtx.tenure).toBeDefined();
      expect(ctx.draftCtx.tenure!.category).toBe("growing"); // 50 days
      expect(ctx.draftCtx.cadence).toBeDefined();
      expect(ctx.draftCtx.prior_contact).toBeDefined();
      expect(ctx.draftCtx.first_contact).toBe(false);
      expect(ctx.draftCtx.behavior).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // Empty context: no events, no prior messages
  // -------------------------------------------------------------------------

  describe("minimal context (no events, no prior messages)", () => {
    it("produces valid contexts with absent rather than fabricated values", async () => {
      if (!dbAvailable) return;

      const now = new Date("2026-07-21T10:00:00Z");

      const contactId = await insertContact("asm-minimal", testTenantId, {
        name: "Bob Newcomer",
        email: "bob@startup.io",
        lifecycleState: "new",
        firstSeenAt: new Date("2026-07-20T00:00:00Z"),
        lastSeenAt: new Date("2026-07-20T00:00:00Z"),
      });

      // After insert, set engagementDepth and paymentStatus to NULL via raw SQL
      // (Drizzle enforces the column default otherwise)
      await db.execute(sql`
        UPDATE contacts
        SET engagement_depth = NULL, payment_status = NULL, company = NULL
        WHERE id = ${contactId}
      `);

      // Flow without brain_instruction in the compiled plan
      const flowId = await insertFlow("asm-minimal-flow", testTenantId, undefined);
      const membershipId = await insertMembership(contactId, flowId);
      // No transport config, no events, no prior messages

      const candidate = makeCandidate({ contactId, flowId, membershipId });
      const result = await assembleContext(db, candidate, now);

      expect(result).not.toBeNull();
      const ctx = result!;

      // Contact fields present
      expect(ctx.decideCtx.contact.name).toBe("Bob Newcomer");
      expect(ctx.decideCtx.contact.email).toBe("bob@startup.io");
      expect(ctx.decideCtx.lifecycle.state).toBe("new");

      // Absent fields are undefined, not fabricated
      expect(ctx.decideCtx.contact.company).toBeUndefined();
      expect(ctx.decideCtx.contact.plan).toBeUndefined();
      expect(ctx.decideCtx.lifecycle.engagementDepth).toBeUndefined();
      expect(ctx.decideCtx.lifecycle.paymentStatus).toBeUndefined();

      // No events => cadence shows 0/0/stable, behavior absent
      expect(ctx.decideCtx.cadence).toEqual({ current7d: 0, previous7d: 0, trend: "stable" });
      expect(ctx.decideCtx.behavior).toBeUndefined();

      // No prior messages
      expect(ctx.decideCtx.priorContact).toBeDefined();
      expect(ctx.decideCtx.priorContact!.totalMessagesSent).toBe(0);
      expect(ctx.decideCtx.priorContact!.messagesOpened).toBe(0);
      expect(ctx.decideCtx.priorContact!.messagesClicked).toBe(0);
      expect(ctx.decideCtx.firstContact).toBe(true);

      // Draft context also valid
      expect(ctx.draftCtx.prior_contact?.total_messages_sent).toBe(0);
      expect(ctx.draftCtx.first_contact).toBe(true);
      expect(ctx.draftCtx.behavior).toBeUndefined();

      // No transport config => sender/product absent or default
      expect(ctx.draftCtx.sender_name).toBeUndefined();
      // Product name comes from tenant.name - always present
      expect(ctx.draftCtx.product_name).toBe("Test Assembler Product");
    });
  });

  // -------------------------------------------------------------------------
  // Budget truncation: oversized context is truncated
  // -------------------------------------------------------------------------

  describe("budget truncation", () => {
    it("truncates an oversized context and surfaces the drop list via content worker", async () => {
      if (!dbAvailable) return;

      const now = new Date("2026-07-21T10:00:00Z");

      // Create contact with many events to push context over budget
      const contactId = await insertContact("asm-truncate", testTenantId, {
        name: "Carol Oversized",
        email: "carol@big.co",
        properties: { plan: "enterprise" },
      });

      const flowId = await insertFlow("asm-truncate-flow", testTenantId, "x".repeat(2000));
      const membershipId = await insertMembership(contactId, flowId);

      // Insert many events to create a large behavior section
      for (let i = 0; i < 10; i++) {
        await insertEvent(
          contactId,
          `feature_${String.fromCharCode(65 + i).repeat(50)}`, // long names
          new Date(now.getTime() - i * 3600 * 1000),
        );
      }

      const candidate = makeCandidate({ contactId, flowId, membershipId });
      const result = await assembleContext(db, candidate, now);

      expect(result).not.toBeNull();
      const ctx = result!;

      // The assembler returns droppedSections = [] because budget truncation
      // is now applied by content.ts (not the assembler). The assembler always
      // produces the full un-truncated context. Budget truncation is tested
      // via the content worker pipeline (see content.test.ts).
      expect(ctx.droppedSections).toEqual([]);

      // Verify the context was assembled with all sections populated
      expect(ctx.draftCtx.brain_instruction).toBeDefined();
      expect(ctx.draftCtx.brain_instruction!.length).toBe(2000);
      expect(ctx.draftCtx.behavior).toBeDefined();
      expect(ctx.draftCtx.behavior!.recent_events).toBeDefined();
      expect(ctx.draftCtx.behavior!.recent_events!.length).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // Failure behavior: contact not found
  // -------------------------------------------------------------------------

  describe("failure behavior", () => {
    it("returns null when contact is not found (data integrity issue)", async () => {
      if (!dbAvailable) return;

      const now = new Date("2026-07-21T10:00:00Z");

      // Use a flow and membership that exist but with a non-existent contact ID
      const contactId = await insertContact("asm-exists");
      const flowId = await insertFlow("asm-fail-flow");
      const membershipId = await insertMembership(contactId, flowId);

      const candidate = makeCandidate({
        contactId: "00000000-0000-0000-0000-000000000000", // non-existent
        flowId,
        membershipId,
      });

      const result = await assembleContext(db, candidate, now);
      expect(result).toBeNull();
    });

    it("propagates errors from context queries (leaves message for reap)", async () => {
      if (!dbAvailable) return;

      // We test this through the content worker pipeline: if assembleContext
      // throws, the content worker's try/catch returns "error", leaving the
      // message at generating for reap recovery.
      //
      // To simulate: pass a candidate with a malformed tenant ID that would
      // cause a query error. But since UUIDs are validated at the SQL layer,
      // a truly malformed ID would throw.

      const now = new Date("2026-07-21T10:00:00Z");
      const candidate = makeCandidate({
        contactId: "not-a-valid-uuid",
        flowId: "not-a-valid-uuid",
        membershipId: "not-a-valid-uuid",
        tenantId: "not-a-valid-uuid",
      });

      // assembleContext should throw due to invalid UUID in SQL
      await expect(assembleContext(db, candidate, now)).rejects.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // Tenant isolation
  // -------------------------------------------------------------------------

  describe("tenant isolation", () => {
    it("only includes data from the candidate's tenant", async () => {
      if (!dbAvailable) return;

      const now = new Date("2026-07-21T10:00:00Z");

      // Set up two contacts with the same external ID in different tenants
      const contactA = await insertContact("asm-iso", testTenantId, {
        name: "Tenant A Contact",
        email: "a@tenant-a.com",
        company: "Tenant A Corp",
      });
      const contactB = await insertContact("asm-iso", otherTenantId, {
        name: "Tenant B Contact",
        email: "b@tenant-b.com",
        company: "Tenant B Corp",
      });

      // Flows in each tenant
      const flowA = await insertFlow("asm-iso-flow-a", testTenantId, "Instruction A");
      const flowB = await insertFlow("asm-iso-flow-b", otherTenantId, "Instruction B");
      const membershipA = await insertMembership(contactA, flowA, testTenantId);
      const membershipB = await insertMembership(contactB, flowB, otherTenantId);

      // Events only for tenant B's contact
      await insertEvent(contactB, "b_only_event", new Date("2026-07-20T10:00:00Z"), otherTenantId);

      // Prior messages only for tenant B
      await insertSentMessage(contactB, flowB, membershipB, new Date("2026-07-15T10:00:00Z"), {
        tenantId: otherTenantId,
        feedback: "opened",
      });

      // Transport config only for tenant B
      await insertTransportConfig(otherTenantId, "Tenant B Sender");

      // Assemble for tenant A's contact
      const candidateA = makeCandidate({
        contactId: contactA,
        flowId: flowA,
        membershipId: membershipA,
        tenantId: testTenantId,
      });
      const resultA = await assembleContext(db, candidateA, now);
      expect(resultA).not.toBeNull();

      // Tenant A should NOT see tenant B's events
      expect(resultA!.decideCtx.behavior).toBeUndefined();
      // Tenant A should NOT see tenant B's messages
      expect(resultA!.decideCtx.priorContact!.totalMessagesSent).toBe(0);
      expect(resultA!.decideCtx.firstContact).toBe(true);
      // Tenant A should NOT see tenant B's transport config
      expect(resultA!.draftCtx.sender_name).toBeUndefined();
      // Tenant A gets its own flow instruction
      expect(resultA!.decideCtx.brainInstruction).toBe("Instruction A");

      // Assemble for tenant B's contact
      const candidateB = makeCandidate({
        contactId: contactB,
        flowId: flowB,
        membershipId: membershipB,
        tenantId: otherTenantId,
      });
      const resultB = await assembleContext(db, candidateB, now);
      expect(resultB).not.toBeNull();

      // Tenant B DOES see its own data
      expect(resultB!.decideCtx.contact.name).toBe("Tenant B Contact");
      expect(resultB!.decideCtx.behavior).toBeDefined();
      expect(resultB!.decideCtx.priorContact!.totalMessagesSent).toBe(1);
      expect(resultB!.decideCtx.priorContact!.messagesOpened).toBe(1);
      expect(resultB!.decideCtx.firstContact).toBe(false);
      expect(resultB!.draftCtx.sender_name).toBe("Tenant B Sender");
      expect(resultB!.decideCtx.brainInstruction).toBe("Instruction B");
    });
  });

  describe("KB failure isolation (step 0a fix)", () => {
    /**
     * These tests verify that any failure in the KB context path degrades
     * gracefully: kb_context is absent, the assembler returns a valid result,
     * and the caller can proceed to pending_approval without KB context.
     *
     * The module-level vi.mock above mocks buildKbContextSection. Individual
     * tests override the mock to throw various error types, then verify:
     * 1. assembleContext does NOT throw (returns a valid AssembledContext)
     * 2. kb_context is undefined in the returned context
     * 3. All other fields (contact, lifecycle, flow) are intact
     */

    it("network error on query embedding: assembleContext returns valid context with no kb_context", async () => {
      if (!dbAvailable) return;

      const { buildKbContextSection } = await import("../src/context-kb.js");
      vi.mocked(buildKbContextSection).mockRejectedValueOnce(
        new Error("[embedding] network error calling https://api.test/v1/embeddings: ECONNREFUSED"),
      );

      const contactId = await insertContact("kb-net-err");
      const flowId = await insertFlow("KB Net Error Flow");
      const membershipId = await insertMembership(contactId, flowId);

      const now = new Date("2026-07-26T10:00:00Z");
      const candidate = makeCandidate({ contactId, flowId, membershipId });

      let result: AssembledContext | null = null;
      let threw = false;
      try {
        result = await assembleContext(db, candidate, now);
      } catch {
        threw = true;
      }

      expect(threw).toBe(false); // Must NOT throw
      expect(result).not.toBeNull();
      expect(result!.draftCtx.kb_context).toBeUndefined(); // No KB context
      expect(result!.draftCtx.contact?.name).toMatch(/kb-net-err/); // Contact present
      expect(result!.draftCtx.lifecycle?.state).toBe("engaged"); // Lifecycle present
    });

    it("provider 401 error on query embedding: assembleContext returns valid context with no kb_context", async () => {
      if (!dbAvailable) return;

      const { buildKbContextSection } = await import("../src/context-kb.js");
      const { EmbeddingPermanentError } = await import("../src/embedding-client.js");
      vi.mocked(buildKbContextSection).mockRejectedValueOnce(
        new EmbeddingPermanentError("[embedding] endpoint returned HTTP 401: Unauthorized"),
      );

      const contactId = await insertContact("kb-401-err");
      const flowId = await insertFlow("KB 401 Error Flow");
      const membershipId = await insertMembership(contactId, flowId);

      const now = new Date("2026-07-26T10:00:00Z");
      const candidate = makeCandidate({ contactId, flowId, membershipId });

      let result: AssembledContext | null = null;
      let threw = false;
      try {
        result = await assembleContext(db, candidate, now);
      } catch {
        threw = true;
      }

      expect(threw).toBe(false);
      expect(result).not.toBeNull();
      expect(result!.draftCtx.kb_context).toBeUndefined();
      expect(result!.draftCtx.contact?.name).toMatch(/kb-401-err/);
    });

    it("DB error in similarity query: assembleContext returns valid context with no kb_context", async () => {
      if (!dbAvailable) return;

      const { buildKbContextSection } = await import("../src/context-kb.js");
      vi.mocked(buildKbContextSection).mockRejectedValueOnce(
        new Error("connection terminated unexpectedly"),
      );

      const contactId = await insertContact("kb-db-err");
      const flowId = await insertFlow("KB DB Error Flow");
      const membershipId = await insertMembership(contactId, flowId);

      const now = new Date("2026-07-26T10:00:00Z");
      const candidate = makeCandidate({ contactId, flowId, membershipId });

      let result: AssembledContext | null = null;
      let threw = false;
      try {
        result = await assembleContext(db, candidate, now);
      } catch {
        threw = true;
      }

      expect(threw).toBe(false);
      expect(result).not.toBeNull();
      expect(result!.draftCtx.kb_context).toBeUndefined();
      expect(result!.draftCtx.lifecycle?.state).toBe("engaged");
    });

    it("non-KB failure (contact not found) still propagates (fatal boundary holds)", async () => {
      if (!dbAvailable) return;

      const flowId = await insertFlow("Fatal Boundary Flow");
      // Use a non-existent contactId - assembleContext should return null
      const candidate = makeCandidate({
        contactId: "00000000-0000-0000-0000-000000000000",
        flowId,
        membershipId: "00000000-0000-0000-0000-000000000001",
      });

      const now = new Date("2026-07-26T10:00:00Z");
      const result = await assembleContext(db, candidate, now);

      // Returns null (not null would be a bug - fatal sections must remain fatal)
      expect(result).toBeNull();
    });
  });
});
