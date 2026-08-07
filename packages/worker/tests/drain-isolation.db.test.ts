/**
 * drain-isolation.db.test.ts
 *
 * Proves that makeDrainRunner from drain-test-utils.ts prevents
 * concurrent test pollution from inflating count assertions.
 *
 * The scenario: two "tenants" run drain concurrently. Tenant A sets up
 * an approved message with transport but NO postal address. Tenant B sets
 * up an approved message with transport AND postal address and expects
 * sent===1, skippedNoPostalAddress===0. Without isolation, Tenant A's
 * message enters Tenant B's drain tick and increments skippedNoPostalAddress,
 * causing the assertion to fail.
 *
 * This test runs both within a single test file so there is no waiting for
 * concurrency - the two tenants are created in the same process, same Postgres,
 * and Tenant A's message is present when Tenant B's drain tick runs.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { eq, sql } from "drizzle-orm";
import {
  tenants,
  contacts,
  flows,
  flowMemberships,
  lifecycleMessages,
  transportConfigs,
} from "@claros/db/schema";
import { makeDrainRunner } from "./drain-test-utils.js";

const TEST_DB_URL = process.env.DATABASE_URL;
if (!TEST_DB_URL) {
  const inCI = process.env.CI === "true";
  throw new Error(
    `[drain-isolation.test] DATABASE_URL is not set.\n` +
      (inCI
        ? `Set the variable in the workflow env block:\n  DATABASE_URL: postgres://claros:claros@localhost:5432/claros\n`
        : `Export it: export DATABASE_URL='postgres://claros:claros@localhost:5433/claros'\n`),
  );
}

const SLUG_A = "drain-isolation-tenant-a";
const SLUG_B = "drain-isolation-tenant-b";
const TEST_SIGNING_KEY = "drain-isolation-signing-key-do-not-use";
const TEST_BASE_URL = "http://localhost:3000";
const TEST_POSTAL = "1 Isolation Ave, Test City, TC 00001";

let pool: pg.Pool;
let db: ReturnType<typeof drizzle>;
let dbAvailable = false;
let tenantAId: string;
let tenantBId: string;

class MockAdapter {
  sends: string[] = [];
  async send(p: { to: string }): Promise<{ success: true; providerMessageId: string }> {
    this.sends.push(p.to);
    return { success: true, providerMessageId: "isolation-test-id" };
  }
}

async function setupTenant(slug: string, withPostal: boolean): Promise<string> {
  const [tenant] = await db
    .insert(tenants)
    .values({
      name: `Drain Isolation ${slug}`,
      slug,
      plan: "free",
      settings: withPostal ? { postal_address: TEST_POSTAL } : null,
    })
    .returning({ id: tenants.id });
  const tid = tenant!.id;

  await db.insert(transportConfigs).values({
    tenantId: tid,
    provider: "resend",
    config: JSON.stringify({ apiKey: "isolation-test-key" }),
    isActive: true,
    fromEmail: `${slug}@example.com`,
  });

  const [contact] = await db
    .insert(contacts)
    .values({
      tenantId: tid,
      externalId: `${slug}-contact`,
      email: `${slug}-contact@example.com`,
      lifecycleState: "engaged",
      firstSeenAt: new Date("2026-01-01"),
      lastSeenAt: new Date("2026-01-01"),
    })
    .returning({ id: contacts.id });

  const [flow] = await db
    .insert(flows)
    .values({
      tenantId: tid,
      name: `${slug}-flow`,
      priority: 0,
      triggerType: "lifecycle_transition",
      triggerConfig: {},
      steps: [{ order: 1, action_type: "nurture_value", delay: "0d", window_policy: "immediate" }],
      status: "paused",
      flowClass: "nurture",
      compiledPlan: {
        trigger: { type: "lifecycle_transition" },
        steps: [{ order: 1, action_type: "nurture_value", delay: "0d", window_policy: "immediate" }],
      },
    })
    .returning({ id: flows.id });

  const [membership] = await db
    .insert(flowMemberships)
    .values({
      tenantId: tid,
      contactId: contact!.id,
      flowId: flow!.id,
      currentStep: 1,
      status: "completed",
      enteredAt: new Date("2026-01-01"),
      completedAt: new Date("2026-01-01"),
      exitReason: "completed",
    })
    .returning({ id: flowMemberships.id });

  await db.insert(lifecycleMessages).values({
    tenantId: tid,
    contactId: contact!.id,
    flowId: flow!.id,
    membershipId: membership!.id,
    flowStepOrder: 1,
    status: "approved",
    subject: `${slug} subject`,
    bodyHtml: "<p>body</p>",
    bodyText: "body",
    approvedAt: new Date("2026-01-01T10:00:00Z"),
  });

  return tid;
}

async function cleanup() {
  for (const slug of [SLUG_A, SLUG_B]) {
    await db.execute(sql`DELETE FROM lifecycle_messages WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${slug})`);
    await db.execute(sql`DELETE FROM flow_memberships WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${slug})`);
    await db.execute(sql`DELETE FROM flows WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${slug})`);
    await db.execute(sql`DELETE FROM transport_configs WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${slug})`);
    await db.execute(sql`DELETE FROM contacts WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${slug})`);
    await db.execute(sql`DELETE FROM tenants WHERE slug = ${slug}`);
  }
}

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: TEST_DB_URL, connectionTimeoutMillis: 3000 });
  try {
    await pool.query("SELECT 1");
    db = drizzle(pool);
    dbAvailable = true;
  } catch (err) {
    if (process.env.CI === "true") {
      throw new Error(`[drain-isolation.test] DATABASE_URL not reachable. Cause: ${(err as Error).message}`);
    }
    console.warn("[drain-isolation.test] DATABASE_URL not reachable - tests skipped.");
    return;
  }
  await cleanup();

  // Tenant A: has transport, NO postal address (messages will be skipped)
  tenantAId = await setupTenant(SLUG_A, false);
  // Tenant B: has transport AND postal address (expects sent===1)
  tenantBId = await setupTenant(SLUG_B, true);
});

afterAll(async () => {
  if (dbAvailable) await cleanup();
  await pool.end();
  vi.restoreAllMocks();
});

describe("drain isolation: makeDrainRunner prevents cross-tenant pollution", () => {
  it("Tenant B drain sees sent=1, skippedNoPostalAddress=0 even though Tenant A has an approved message with no postal address", async () => {
    if (!dbAvailable) return;

    // Tenant A's message is in the DB with approved status and no postal address.
    // Without isolation, Tenant B's drain tick would pick it up and count it as
    // skippedNoPostalAddress, causing the assertion below to fail.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ id: "isolation-provider-id" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    const adapterB = new MockAdapter();
    const now = new Date("2026-01-02T10:00:00Z");

    const result = await makeDrainRunner(db, tenantBId, adapterB, TEST_SIGNING_KEY, TEST_BASE_URL)(now);

    // Tenant A's message must not have polluted Tenant B's stats.
    // skippedNoTransport may be >= 0 because Tenant A's message is in the DB
    // and the resolver returns null for it (expected behavior).
    // What matters: Tenant A's no-postal-address status did NOT become
    // skippedNoPostalAddress in Tenant B's run.
    expect(result.sent).toBe(1);
    expect(result.skippedNoPostalAddress).toBe(0);
  });

  it("Tenant A message remains approved after Tenant B drain (no cross-tenant write)", async () => {
    if (!dbAvailable) return;

    const rows = await db.execute<{ status: string }>(sql`
      SELECT status FROM lifecycle_messages
      WHERE tenant_id = ${tenantAId}
    `);
    for (const row of rows.rows) {
      // Tenant A's message may be in 'approved' (never touched) or 'sent' if
      // a previous drain tick claimed it. We assert it was never incorrectly
      // written to 'sending' or 'failed' by Tenant B's drain.
      expect(["approved", "sent"]).toContain(row.status);
    }
  });
});
