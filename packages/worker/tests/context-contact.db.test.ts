/**
 * Integration tests for context-contact.ts (slice 18.1).
 *
 * Tests the contact, lifecycle, tenure, and prior-contact sections of the
 * context packet builder. All tests run against a real Postgres database.
 * No LLM calls are involved.
 *
 * Test coverage:
 *   - Full data: contact with all fields produces every expected field.
 *   - Sparse data: null email, missing company, no plan property -> absent
 *     values rather than fabricated defaults.
 *   - Tenure categories: correct category on each side of every boundary.
 *   - No prior messages: firstContact = true, zero counts.
 *   - Mixed message states: correct counts for sent / opened / clicked.
 *   - Tenant isolation: messages or contacts from another tenant never leak.
 *   - Contact isolation: messages from another contact (same tenant) never leak.
 *   - Unknown contact: buildContactSections returns null.
 *
 * Requires local Postgres (docker compose up postgres).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { sql } from "drizzle-orm";
import {
  tenants,
  contacts,
  flows,
  flowMemberships,
  lifecycleMessages,
} from "@claros/db/schema";
import {
  buildContactSections,
  tenureCategory,
  TENURE_THRESHOLDS,
} from "../src/context-contact.js";

// ---------------------------------------------------------------------------
// DB setup
// ---------------------------------------------------------------------------

const TEST_DB_URL = process.env.DATABASE_URL;
if (!TEST_DB_URL) {
  const inCI = process.env.CI === "true";
  throw new Error(
    `[context-contact.test] DATABASE_URL is not set.\n\n` +
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

const SLUG = "test-ctx-contact";
const SLUG_OTHER = "test-ctx-contact-other";

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
        `[context-contact.test] DATABASE_URL not reachable in CI.\n` +
          `URL: ${TEST_DB_URL}\nCause: ${(err as Error).message}`,
      );
    }
    console.warn("[context-contact.test] DATABASE_URL not reachable - tests skipped.");
    return;
  }

  await cleanup();

  const [tenant] = await db
    .insert(tenants)
    .values({ name: "Test Context Contact", slug: SLUG, plan: "free" })
    .returning({ id: tenants.id });
  testTenantId = tenant!.id;

  const [other] = await db
    .insert(tenants)
    .values({ name: "Test Context Contact Other", slug: SLUG_OTHER, plan: "free" })
    .returning({ id: tenants.id });
  otherTenantId = other!.id;
});

beforeEach(async () => {
  if (!dbAvailable) return;
  await db.execute(sql`DELETE FROM lifecycle_messages WHERE tenant_id = ${testTenantId}`);
  await db.execute(sql`DELETE FROM lifecycle_messages WHERE tenant_id = ${otherTenantId}`);
  await db.execute(sql`DELETE FROM flow_memberships WHERE tenant_id = ${testTenantId}`);
  await db.execute(sql`DELETE FROM flow_memberships WHERE tenant_id = ${otherTenantId}`);
  await db.execute(sql`DELETE FROM flows WHERE tenant_id = ${testTenantId}`);
  await db.execute(sql`DELETE FROM flows WHERE tenant_id = ${otherTenantId}`);
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
      sql`DELETE FROM lifecycle_messages WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${slug})`,
    );
    await db.execute(
      sql`DELETE FROM flow_memberships WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${slug})`,
    );
    await db.execute(
      sql`DELETE FROM flows WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${slug})`,
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

/** Insert a minimal flow (required as FK by lifecycle_messages). */
async function insertFlow(name: string, tenantId: string = testTenantId): Promise<string> {
  const [row] = await db
    .insert(flows)
    .values({
      tenantId,
      name,
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

/** Insert a minimal membership (required as FK by lifecycle_messages). */
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
      enteredAt: new Date("2026-01-01T00:00:00Z"),
      completedAt: new Date("2026-01-01T00:00:00Z"),
      exitReason: "completed",
    })
    .returning({ id: flowMemberships.id });
  return row!.id;
}

/**
 * Insert a lifecycle_message directly at a given status and set sent_at and
 * feedback via a raw UPDATE (the Drizzle schema doesn't always expose them
 * through the insert path for testing purposes).
 */
async function insertMessage(opts: {
  contactId: string;
  flowId: string;
  membershipId: string;
  tenantId?: string;
  status: string;
  brainActionType?: string;
  sentAt?: Date;
  feedback?: string;
  stepOrder?: number;
}): Promise<string> {
  const tenantId = opts.tenantId ?? testTenantId;
  const stepOrder = opts.stepOrder ?? 1;
  const [row] = await db
    .insert(lifecycleMessages)
    .values({
      tenantId,
      contactId: opts.contactId,
      flowId: opts.flowId,
      membershipId: opts.membershipId,
      flowStepOrder: stepOrder,
      status: opts.status,
      brainActionType: opts.brainActionType ?? "nurture_value",
    })
    .returning({ id: lifecycleMessages.id });

  const id = row!.id;

  // Apply sentAt and feedback via raw update (not always available through
  // the typed insert because they are optional and often null by default).
  if (opts.sentAt != null || opts.feedback != null) {
    await db.execute(sql`
      UPDATE lifecycle_messages
      SET
        sent_at  = ${opts.sentAt ?? null},
        feedback = ${opts.feedback ?? null}
      WHERE id = ${id}
    `);
  }

  return id;
}

// ---------------------------------------------------------------------------
// Unit tests for tenureCategory (pure function, no DB)
// ---------------------------------------------------------------------------

describe("tenureCategory", () => {
  it("returns 'new' for 0 days", () => {
    expect(tenureCategory(0)).toBe("new");
  });

  it("returns 'new' for 29 days (one day before growing threshold)", () => {
    expect(tenureCategory(TENURE_THRESHOLDS.GROWING_DAYS - 1)).toBe("new");
  });

  it("returns 'growing' at exactly the growing threshold (30 days)", () => {
    expect(tenureCategory(TENURE_THRESHOLDS.GROWING_DAYS)).toBe("growing");
  });

  it("returns 'growing' for 89 days (one day before established threshold)", () => {
    expect(tenureCategory(TENURE_THRESHOLDS.ESTABLISHED_DAYS - 1)).toBe("growing");
  });

  it("returns 'established' at exactly the established threshold (90 days)", () => {
    expect(tenureCategory(TENURE_THRESHOLDS.ESTABLISHED_DAYS)).toBe("established");
  });

  it("returns 'established' for 179 days (one day before loyal threshold)", () => {
    expect(tenureCategory(TENURE_THRESHOLDS.LOYAL_DAYS - 1)).toBe("established");
  });

  it("returns 'loyal' at exactly the loyal threshold (180 days)", () => {
    expect(tenureCategory(TENURE_THRESHOLDS.LOYAL_DAYS)).toBe("loyal");
  });

  it("returns 'loyal' for a large value (365 days)", () => {
    expect(tenureCategory(365)).toBe("loyal");
  });
});

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------

describe("buildContactSections", () => {
  it("skips when DATABASE_URL is not reachable", () => {
    if (!dbAvailable) {
      expect(true).toBe(true);
    }
  });

  // -------------------------------------------------------------------------
  // Full data
  // -------------------------------------------------------------------------

  describe("contact with full data produces every field", () => {
    it("maps all populated columns and computes correct sections", async () => {
      if (!dbAvailable) return;

      const firstSeenAt = new Date("2026-01-01T00:00:00Z");
      const lastSeenAt = new Date("2026-07-01T00:00:00Z");

      const [row] = await db
        .insert(contacts)
        .values({
          tenantId: testTenantId,
          externalId: "ctx-full-001",
          email: "alice@example.com",
          name: "Alice Smith",
          company: "Acme Corp",
          properties: { plan: "pro", custom: "value" },
          lifecycleState: "engaged",
          engagementDepth: "regular",
          paymentStatus: "paid",
          firstSeenAt,
          lastSeenAt,
        })
        .returning({ id: contacts.id });
      const contactId = row!.id;

      // Insert a sent message so prior_contact is non-trivial
      const flowId = await insertFlow("ctx-full-flow");
      const membershipId = await insertMembership(contactId, flowId);
      await insertMessage({
        contactId,
        flowId,
        membershipId,
        status: "sent",
        brainActionType: "nurture_value",
        sentAt: new Date("2026-06-15T10:00:00Z"),
        feedback: "opened",
      });

      // now = 181 days after firstSeenAt -> "loyal"
      const now = new Date("2026-07-01T00:00:00Z");
      const msElapsed = now.getTime() - firstSeenAt.getTime();
      const expectedDays = Math.floor(msElapsed / (1000 * 60 * 60 * 24));

      const result = await buildContactSections(db, testTenantId, contactId, now);
      expect(result).not.toBeNull();

      // Contact section
      expect(result!.contact.name).toBe("Alice Smith");
      expect(result!.contact.email).toBe("alice@example.com");
      expect(result!.contact.company).toBe("Acme Corp");
      expect(result!.contact.plan).toBe("pro");
      expect(result!.contact.signupDate).toBe(firstSeenAt.toISOString());
      expect(result!.contact.lastSeen).toBe(lastSeenAt.toISOString());

      // Lifecycle section
      expect(result!.lifecycle.state).toBe("engaged");
      expect(result!.lifecycle.tenureDays).toBe(expectedDays);
      expect(result!.lifecycle.engagementDepth).toBe("regular");
      expect(result!.lifecycle.paymentStatus).toBe("paid");

      // Tenure section
      expect(result!.tenure).toBeDefined();
      expect(result!.tenure!.days).toBe(expectedDays);
      expect(result!.tenure!.category).toBe(tenureCategory(expectedDays));

      // Prior contact section
      expect(result!.priorContact.totalMessagesSent).toBe(1);
      expect(result!.priorContact.messagesOpened).toBe(1);
      expect(result!.priorContact.messagesClicked).toBe(0);
      expect(result!.priorContact.lastMessageDate).toBe(
        new Date("2026-06-15T10:00:00Z").toISOString(),
      );
      expect(result!.priorContact.lastMessageType).toBe("nurture_value");

      // First contact flag
      expect(result!.firstContact).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Sparse / null data
  // -------------------------------------------------------------------------

  describe("absent data stays absent rather than fabricated", () => {
    it("null email, missing company, no plan property -> absent from contact section", async () => {
      if (!dbAvailable) return;

      const [row] = await db
        .insert(contacts)
        .values({
          tenantId: testTenantId,
          externalId: "ctx-sparse-001",
          email: null, // explicitly null
          // name, company omitted -> null
          properties: { unrelated: "stuff" }, // no 'plan' key
          lifecycleState: "signed_up",
          firstSeenAt: new Date("2026-07-01T00:00:00Z"),
        })
        .returning({ id: contacts.id });
      const contactId = row!.id;

      const now = new Date("2026-07-10T00:00:00Z");
      const result = await buildContactSections(db, testTenantId, contactId, now);
      expect(result).not.toBeNull();

      // email absent
      expect(result!.contact.email).toBeUndefined();
      // name absent
      expect(result!.contact.name).toBeUndefined();
      // company absent
      expect(result!.contact.company).toBeUndefined();
      // plan absent (property not set)
      expect(result!.contact.plan).toBeUndefined();

      // lifecycle state is always present
      expect(result!.lifecycle.state).toBe("signed_up");
      // engagementDepth absent (null in DB)
      expect(result!.lifecycle.engagementDepth).toBeUndefined();
    });

    it("null paymentStatus column is not coerced to a default string", async () => {
      if (!dbAvailable) return;

      // Insert contact with explicitly null payment_status (override default)
      const [row] = await db
        .insert(contacts)
        .values({
          tenantId: testTenantId,
          externalId: "ctx-null-payment",
          lifecycleState: "signed_up",
        })
        .returning({ id: contacts.id });
      const contactId = row!.id;

      // Force payment_status to NULL via raw SQL (the schema default is 'free')
      await db.execute(sql`
        UPDATE contacts SET payment_status = NULL WHERE id = ${contactId}
      `);

      const now = new Date("2026-07-10T00:00:00Z");
      const result = await buildContactSections(db, testTenantId, contactId, now);
      expect(result).not.toBeNull();

      // Should be absent, not 'free' or empty string
      expect(result!.lifecycle.paymentStatus).toBeUndefined();
    });

    it("null first_seen_at -> tenure section absent, tenureDays absent from lifecycle", async () => {
      if (!dbAvailable) return;

      const [row] = await db
        .insert(contacts)
        .values({
          tenantId: testTenantId,
          externalId: "ctx-no-firstseen",
          lifecycleState: "signed_up",
          // firstSeenAt not set -> null
        })
        .returning({ id: contacts.id });
      const contactId = row!.id;

      const now = new Date("2026-07-10T00:00:00Z");
      const result = await buildContactSections(db, testTenantId, contactId, now);
      expect(result).not.toBeNull();

      expect(result!.tenure).toBeUndefined();
      expect(result!.lifecycle.tenureDays).toBeUndefined();
    });

    it("null properties column -> plan absent (no crash)", async () => {
      if (!dbAvailable) return;

      const [row] = await db
        .insert(contacts)
        .values({
          tenantId: testTenantId,
          externalId: "ctx-null-props",
          lifecycleState: "signed_up",
          properties: null,
        })
        .returning({ id: contacts.id });
      const contactId = row!.id;

      const now = new Date("2026-07-10T00:00:00Z");
      const result = await buildContactSections(db, testTenantId, contactId, now);
      expect(result).not.toBeNull();
      expect(result!.contact.plan).toBeUndefined();
    });

    it("plan property set to a non-string value -> plan absent", async () => {
      if (!dbAvailable) return;

      const [row] = await db
        .insert(contacts)
        .values({
          tenantId: testTenantId,
          externalId: "ctx-numeric-plan",
          lifecycleState: "signed_up",
          properties: { plan: 42 }, // number, not string
        })
        .returning({ id: contacts.id });
      const contactId = row!.id;

      const now = new Date("2026-07-10T00:00:00Z");
      const result = await buildContactSections(db, testTenantId, contactId, now);
      expect(result).not.toBeNull();
      // Non-string plan property is not coerced to a string
      expect(result!.contact.plan).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Tenure categories on boundary days
  // -------------------------------------------------------------------------

  describe("tenure category is correct on each side of every boundary", () => {
    // Helper: create a contact with a specific first_seen_at, then query with
    // 'now' set such that exactly N days have elapsed.
    async function contactWithTenure(externalId: string, days: number) {
      const firstSeenAt = new Date("2026-01-01T00:00:00Z");
      const now = new Date(firstSeenAt.getTime() + days * 24 * 60 * 60 * 1000);
      const [row] = await db
        .insert(contacts)
        .values({
          tenantId: testTenantId,
          externalId,
          lifecycleState: "engaged",
          firstSeenAt,
        })
        .returning({ id: contacts.id });
      return { contactId: row!.id, now };
    }

    it("29 days -> 'new'", async () => {
      if (!dbAvailable) return;
      const { contactId, now } = await contactWithTenure("tenure-29", 29);
      const result = await buildContactSections(db, testTenantId, contactId, now);
      expect(result!.tenure!.category).toBe("new");
      expect(result!.tenure!.days).toBe(29);
    });

    it("30 days -> 'growing' (growing threshold)", async () => {
      if (!dbAvailable) return;
      const { contactId, now } = await contactWithTenure("tenure-30", 30);
      const result = await buildContactSections(db, testTenantId, contactId, now);
      expect(result!.tenure!.category).toBe("growing");
      expect(result!.tenure!.days).toBe(30);
    });

    it("89 days -> 'growing' (last day before established)", async () => {
      if (!dbAvailable) return;
      const { contactId, now } = await contactWithTenure("tenure-89", 89);
      const result = await buildContactSections(db, testTenantId, contactId, now);
      expect(result!.tenure!.category).toBe("growing");
      expect(result!.tenure!.days).toBe(89);
    });

    it("90 days -> 'established' (established threshold)", async () => {
      if (!dbAvailable) return;
      const { contactId, now } = await contactWithTenure("tenure-90", 90);
      const result = await buildContactSections(db, testTenantId, contactId, now);
      expect(result!.tenure!.category).toBe("established");
      expect(result!.tenure!.days).toBe(90);
    });

    it("179 days -> 'established' (last day before loyal)", async () => {
      if (!dbAvailable) return;
      const { contactId, now } = await contactWithTenure("tenure-179", 179);
      const result = await buildContactSections(db, testTenantId, contactId, now);
      expect(result!.tenure!.category).toBe("established");
      expect(result!.tenure!.days).toBe(179);
    });

    it("180 days -> 'loyal' (loyal threshold)", async () => {
      if (!dbAvailable) return;
      const { contactId, now } = await contactWithTenure("tenure-180", 180);
      const result = await buildContactSections(db, testTenantId, contactId, now);
      expect(result!.tenure!.category).toBe("loyal");
      expect(result!.tenure!.days).toBe(180);
    });

    it("365 days -> 'loyal'", async () => {
      if (!dbAvailable) return;
      const { contactId, now } = await contactWithTenure("tenure-365", 365);
      const result = await buildContactSections(db, testTenantId, contactId, now);
      expect(result!.tenure!.category).toBe("loyal");
      expect(result!.tenure!.days).toBe(365);
    });
  });

  // -------------------------------------------------------------------------
  // No prior messages
  // -------------------------------------------------------------------------

  describe("contact with no prior messages", () => {
    it("yields firstContact = true and zero counts", async () => {
      if (!dbAvailable) return;

      const [row] = await db
        .insert(contacts)
        .values({
          tenantId: testTenantId,
          externalId: "ctx-no-msgs",
          email: "fresh@example.com",
          lifecycleState: "signed_up",
          firstSeenAt: new Date("2026-07-01T00:00:00Z"),
        })
        .returning({ id: contacts.id });
      const contactId = row!.id;

      const now = new Date("2026-07-10T00:00:00Z");
      const result = await buildContactSections(db, testTenantId, contactId, now);
      expect(result).not.toBeNull();

      expect(result!.firstContact).toBe(true);
      expect(result!.priorContact.totalMessagesSent).toBe(0);
      expect(result!.priorContact.messagesOpened).toBe(0);
      expect(result!.priorContact.messagesClicked).toBe(0);
      expect(result!.priorContact.lastMessageDate).toBeUndefined();
      expect(result!.priorContact.lastMessageType).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Mixed message states
  // -------------------------------------------------------------------------

  describe("contact with a mix of sent, opened, and clicked messages", () => {
    it("counts only 'sent' status for totalMessagesSent, feedback for opened/clicked", async () => {
      if (!dbAvailable) return;

      const [row] = await db
        .insert(contacts)
        .values({
          tenantId: testTenantId,
          externalId: "ctx-mixed-msgs",
          email: "mixed@example.com",
          lifecycleState: "engaged",
          firstSeenAt: new Date("2026-01-01T00:00:00Z"),
        })
        .returning({ id: contacts.id });
      const contactId = row!.id;

      const flowId = await insertFlow("ctx-mixed-flow");
      const mem1 = await insertMembership(contactId, flowId);

      // Need a second membership for additional messages (unique constraint on membership+step)
      // Use a second flow to allow separate memberships
      const flow2Id = await insertFlow("ctx-mixed-flow-2");
      const mem2 = await insertMembership(contactId, flow2Id);

      const flow3Id = await insertFlow("ctx-mixed-flow-3");
      const mem3 = await insertMembership(contactId, flow3Id);

      const flow4Id = await insertFlow("ctx-mixed-flow-4");
      const mem4 = await insertMembership(contactId, flow4Id);

      const flow5Id = await insertFlow("ctx-mixed-flow-5");
      const mem5 = await insertMembership(contactId, flow5Id);

      // sent + no feedback (counts as sent, not opened/clicked)
      await insertMessage({
        contactId,
        flowId,
        membershipId: mem1,
        status: "sent",
        brainActionType: "nurture_tip",
        sentAt: new Date("2026-03-01T10:00:00Z"),
      });

      // sent + opened only (contact opened but did not click)
      await insertMessage({
        contactId,
        flowId: flow2Id,
        membershipId: mem2,
        status: "sent",
        brainActionType: "nurture_value",
        sentAt: new Date("2026-04-01T10:00:00Z"),
        feedback: "opened",
      });

      // sent + clicked (feedback advanced past 'opened' to 'clicked')
      // feedback is a single advancing column: this row now has feedback='clicked',
      // not feedback='opened'. It MUST count toward messagesOpened because clicked
      // implies the contact engaged at least as much as opening.
      await insertMessage({
        contactId,
        flowId: flow3Id,
        membershipId: mem3,
        status: "sent",
        brainActionType: "upgrade_soft",
        sentAt: new Date("2026-05-01T10:00:00Z"),
        feedback: "clicked",
      });

      // non-sent statuses don't count toward totalMessagesSent
      await insertMessage({
        contactId,
        flowId: flow4Id,
        membershipId: mem4,
        status: "skipped",
      });

      await insertMessage({
        contactId,
        flowId: flow5Id,
        membershipId: mem5,
        status: "failed",
      });

      const now = new Date("2026-07-10T00:00:00Z");
      const result = await buildContactSections(db, testTenantId, contactId, now);
      expect(result).not.toBeNull();

      // 3 sent messages (feedback values don't affect totalMessagesSent)
      expect(result!.priorContact.totalMessagesSent).toBe(3);
      // messagesOpened = feedback IN ('opened','clicked') = 2
      // (the opened-only message + the clicked message, since clicked implies opened)
      expect(result!.priorContact.messagesOpened).toBe(2);
      // messagesClicked = feedback = 'clicked' = 1
      expect(result!.priorContact.messagesClicked).toBe(1);
      // lastMessageDate = the most recent sent_at
      expect(result!.priorContact.lastMessageDate).toBe(
        new Date("2026-05-01T10:00:00Z").toISOString(),
      );
      // lastMessageType = brain_action_type of the most recent sent message
      expect(result!.priorContact.lastMessageType).toBe("upgrade_soft");
      // firstContact = false (there are sent messages)
      expect(result!.firstContact).toBe(false);
    });

    it("opened count includes messages that advanced to clicked (advance-only column invariant)", async () => {
      if (!dbAvailable) return;

      // This test is the direct specification of the counting invariant:
      //   feedback is a single advancing column (opened -> clicked).
      //   A message stored as feedback='clicked' was necessarily engaged with
      //   at least as much as an open, so it MUST be counted in messagesOpened.
      //   Counting only feedback='opened' would report 0 opens for a contact
      //   who clicked every message they received - the opposite of the truth.

      const [row] = await db
        .insert(contacts)
        .values({
          tenantId: testTenantId,
          externalId: "ctx-clicked-only-contact",
          email: "clicker@example.com",
          lifecycleState: "engaged",
          firstSeenAt: new Date("2026-01-01T00:00:00Z"),
        })
        .returning({ id: contacts.id });
      const contactId = row!.id;

      // Three messages: all ended at feedback='clicked' (opened then clicked,
      // so the 'opened' value was overwritten). Zero messages at feedback='opened'.
      const flowA = await insertFlow("ctx-clicker-flow-a");
      const flowB = await insertFlow("ctx-clicker-flow-b");
      const flowC = await insertFlow("ctx-clicker-flow-c");
      const memA = await insertMembership(contactId, flowA);
      const memB = await insertMembership(contactId, flowB);
      const memC = await insertMembership(contactId, flowC);

      await insertMessage({
        contactId, flowId: flowA, membershipId: memA,
        status: "sent", sentAt: new Date("2026-04-01T10:00:00Z"), feedback: "clicked",
      });
      await insertMessage({
        contactId, flowId: flowB, membershipId: memB,
        status: "sent", sentAt: new Date("2026-05-01T10:00:00Z"), feedback: "clicked",
      });
      await insertMessage({
        contactId, flowId: flowC, membershipId: memC,
        status: "sent", sentAt: new Date("2026-06-01T10:00:00Z"), feedback: "clicked",
      });

      const now = new Date("2026-07-10T00:00:00Z");
      const result = await buildContactSections(db, testTenantId, contactId, now);
      expect(result).not.toBeNull();

      // All 3 sent and all 3 clicked
      expect(result!.priorContact.totalMessagesSent).toBe(3);
      expect(result!.priorContact.messagesClicked).toBe(3);
      // messagesOpened must also be 3 - every clicked message was (at minimum)
      // as engaged as an open. feedback='opened' alone would yield 0 here,
      // reporting this highly-engaged contact as having opened nothing.
      expect(result!.priorContact.messagesOpened).toBe(3);
    });

    it("bounced and complained messages do not count as opened", async () => {
      if (!dbAvailable) return;

      // bounced = email not delivered (never read)
      // complained = spam report (not an engagement signal)
      // Neither counts toward messagesOpened.

      const [row] = await db
        .insert(contacts)
        .values({
          tenantId: testTenantId,
          externalId: "ctx-bounced-complained",
          email: "bad@example.com",
          lifecycleState: "signed_up",
          firstSeenAt: new Date("2026-01-01T00:00:00Z"),
        })
        .returning({ id: contacts.id });
      const contactId = row!.id;

      const flowA = await insertFlow("ctx-bc-flow-a");
      const flowB = await insertFlow("ctx-bc-flow-b");
      const memA = await insertMembership(contactId, flowA);
      const memB = await insertMembership(contactId, flowB);

      await insertMessage({
        contactId, flowId: flowA, membershipId: memA,
        status: "sent", sentAt: new Date("2026-04-01T10:00:00Z"), feedback: "bounced",
      });
      await insertMessage({
        contactId, flowId: flowB, membershipId: memB,
        status: "sent", sentAt: new Date("2026-05-01T10:00:00Z"), feedback: "complained",
      });

      const now = new Date("2026-07-10T00:00:00Z");
      const result = await buildContactSections(db, testTenantId, contactId, now);
      expect(result).not.toBeNull();

      expect(result!.priorContact.totalMessagesSent).toBe(2);
      // bounced and complained do not count as opened
      expect(result!.priorContact.messagesOpened).toBe(0);
      expect(result!.priorContact.messagesClicked).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Tenant isolation
  // -------------------------------------------------------------------------

  describe("tenant isolation", () => {
    it("messages belonging to another tenant do not leak into the result", async () => {
      if (!dbAvailable) return;

      // Contact in testTenant with no messages
      const [testRow] = await db
        .insert(contacts)
        .values({
          tenantId: testTenantId,
          externalId: "ctx-tenant-iso-main",
          email: "main@example.com",
          lifecycleState: "engaged",
          firstSeenAt: new Date("2026-01-01T00:00:00Z"),
        })
        .returning({ id: contacts.id });
      const testContactId = testRow!.id;

      // Contact in otherTenant with sent messages
      const [otherRow] = await db
        .insert(contacts)
        .values({
          tenantId: otherTenantId,
          externalId: "ctx-tenant-iso-other",
          email: "other@example.com",
          lifecycleState: "engaged",
          firstSeenAt: new Date("2026-01-01T00:00:00Z"),
        })
        .returning({ id: contacts.id });
      const otherContactId = otherRow!.id;

      const otherFlowId = await insertFlow("ctx-iso-other-flow", otherTenantId);
      const otherMem = await insertMembership(otherContactId, otherFlowId, otherTenantId);
      await insertMessage({
        contactId: otherContactId,
        flowId: otherFlowId,
        membershipId: otherMem,
        tenantId: otherTenantId,
        status: "sent",
        sentAt: new Date("2026-06-01T10:00:00Z"),
        feedback: "clicked",
      });

      const now = new Date("2026-07-10T00:00:00Z");
      // Query for testContactId scoped to testTenantId - must not see otherTenant's messages
      const result = await buildContactSections(db, testTenantId, testContactId, now);
      expect(result).not.toBeNull();

      expect(result!.priorContact.totalMessagesSent).toBe(0);
      expect(result!.priorContact.messagesOpened).toBe(0);
      expect(result!.priorContact.messagesClicked).toBe(0);
      expect(result!.priorContact.lastMessageDate).toBeUndefined();
      expect(result!.firstContact).toBe(true);
    });

    it("returns null when contactId exists but belongs to a different tenant", async () => {
      if (!dbAvailable) return;

      // Contact in otherTenant
      const [row] = await db
        .insert(contacts)
        .values({
          tenantId: otherTenantId,
          externalId: "ctx-cross-tenant",
          lifecycleState: "engaged",
        })
        .returning({ id: contacts.id });
      const otherContactId = row!.id;

      const now = new Date("2026-07-10T00:00:00Z");
      // Query with wrong tenantId
      const result = await buildContactSections(db, testTenantId, otherContactId, now);
      expect(result).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Contact isolation (same tenant, different contact)
  // -------------------------------------------------------------------------

  describe("contact isolation within the same tenant", () => {
    it("messages from another contact in the same tenant do not appear in the result", async () => {
      if (!dbAvailable) return;

      // Contact A: no messages
      const [rowA] = await db
        .insert(contacts)
        .values({
          tenantId: testTenantId,
          externalId: "ctx-contact-iso-a",
          email: "a@example.com",
          lifecycleState: "engaged",
          firstSeenAt: new Date("2026-01-01T00:00:00Z"),
        })
        .returning({ id: contacts.id });
      const contactAId = rowA!.id;

      // Contact B: has sent messages
      const [rowB] = await db
        .insert(contacts)
        .values({
          tenantId: testTenantId,
          externalId: "ctx-contact-iso-b",
          email: "b@example.com",
          lifecycleState: "engaged",
          firstSeenAt: new Date("2026-01-01T00:00:00Z"),
        })
        .returning({ id: contacts.id });
      const contactBId = rowB!.id;

      const flowB = await insertFlow("ctx-contact-iso-b-flow");
      const memB = await insertMembership(contactBId, flowB);
      await insertMessage({
        contactId: contactBId,
        flowId: flowB,
        membershipId: memB,
        status: "sent",
        sentAt: new Date("2026-06-01T10:00:00Z"),
        feedback: "opened",
      });

      const now = new Date("2026-07-10T00:00:00Z");
      // Query for contact A - should not see B's messages
      const resultA = await buildContactSections(db, testTenantId, contactAId, now);
      expect(resultA).not.toBeNull();

      expect(resultA!.priorContact.totalMessagesSent).toBe(0);
      expect(resultA!.priorContact.messagesOpened).toBe(0);
      expect(resultA!.firstContact).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Unknown contact
  // -------------------------------------------------------------------------

  describe("unknown contact", () => {
    it("returns null when the contact does not exist", async () => {
      if (!dbAvailable) return;

      const fakeId = "00000000-0000-0000-0000-000000000001";
      const now = new Date("2026-07-10T00:00:00Z");
      const result = await buildContactSections(db, testTenantId, fakeId, now);
      expect(result).toBeNull();
    });
  });
});
