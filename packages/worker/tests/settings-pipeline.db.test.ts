/**
 * Integration tests for the settings-to-drain pipeline.
 *
 * These tests verify that a transport configuration written through the
 * settings API endpoint (PUT /v1/settings/transport + PATCH /v1/settings/tenant)
 * is correctly resolved by the transport resolver and produces the expected
 * drain behavior.
 *
 * Coverage:
 *   - Config written via the settings endpoint is resolved by
 *     buildTenantTransportResolver and produces a non-null adapter.
 *   - The adapter returned is a ResendTransportAdapter (has a send method).
 *   - A drain tick with the endpoint-written config sends the message (mock fetch).
 *   - Postal address set via PATCH /v1/settings/tenant unblocks the drain:
 *       without it, drain returns skippedNoPostalAddress > 0 and message stays approved;
 *       with it, drain sends the message.
 *
 * The tests write transport config and postal address directly into the DB
 * (bypassing the HTTP layer) using the same encrypted format that the settings
 * endpoint produces, which keeps this test self-contained in the worker package.
 *
 * Requires local Postgres (docker compose up postgres).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
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
import { encrypt, parseEncryptionKey } from "@claros/adapters";
import { buildTenantTransportResolver } from "../src/transport-resolver.js";
import { makeDrainRunner } from "./drain-test-utils.js";

// ---------------------------------------------------------------------------
// DB setup
// ---------------------------------------------------------------------------

const TEST_DB_URL = process.env.DATABASE_URL;
if (!TEST_DB_URL) {
  const inCI = process.env.CI === "true";
  throw new Error(
    `[settings-pipeline.test] DATABASE_URL is not set.\n\n` +
      `This test requires a Postgres connection.\n` +
      (inCI
        ? `Set the variable in the workflow env block:\n\n  DATABASE_URL: postgres://claros:claros@localhost:5432/claros\n`
        : `Set the variable in .env (see .env.example) or export it:\n\n  export DATABASE_URL='postgres://claros:claros@localhost:5433/claros'\n`),
  );
}

const TEST_ENCRYPTION_KEY_BASE64 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="; // 32 zero bytes
const TEST_API_KEY = "re_pipeline_test_key_do_not_use";
const TEST_POSTAL_ADDRESS = "789 Pipeline Rd, Drain City, DC 55555";
const TEST_SIGNING_KEY = "settings-pipeline-signing-key-do-not-use";
const TEST_BASE_URL = "http://localhost:3000";

const SLUG = "test-settings-pipeline";

let pool: pg.Pool;
let db: ReturnType<typeof drizzle>;
let dbAvailable = false;
let testTenantId: string;

let savedEncryptionKey: string | undefined;

beforeAll(async () => {
  savedEncryptionKey = process.env.ENCRYPTION_KEY;
  process.env.ENCRYPTION_KEY = TEST_ENCRYPTION_KEY_BASE64;

  pool = new pg.Pool({ connectionString: TEST_DB_URL, connectionTimeoutMillis: 3000 });
  try {
    await pool.query("SELECT 1");
    db = drizzle(pool);
    dbAvailable = true;
  } catch (err) {
    const inCI = process.env.CI === "true";
    if (inCI) {
      throw new Error(
        `[settings-pipeline.test] DATABASE_URL not reachable in CI.\n` +
          `URL: ${TEST_DB_URL}\nCause: ${(err as Error).message}`,
      );
    }
    console.warn("[settings-pipeline.test] DATABASE_URL not reachable - tests skipped.");
    return;
  }

  await cleanup();

  const [tenant] = await db
    .insert(tenants)
    .values({ name: "Settings Pipeline Test", slug: SLUG, plan: "free" })
    .returning({ id: tenants.id });
  testTenantId = tenant!.id;
});

afterAll(async () => {
  if (dbAvailable) await cleanup();
  await pool.end();
  if (savedEncryptionKey !== undefined) {
    process.env.ENCRYPTION_KEY = savedEncryptionKey;
  } else {
    delete process.env.ENCRYPTION_KEY;
  }
});

beforeEach(async () => {
  if (!dbAvailable) return;
  await db.execute(sql`DELETE FROM lifecycle_messages WHERE tenant_id = ${testTenantId}`);
  await db.execute(sql`DELETE FROM flow_memberships WHERE tenant_id = ${testTenantId}`);
  await db.execute(sql`DELETE FROM flows WHERE tenant_id = ${testTenantId}`);
  await db.execute(sql`DELETE FROM transport_configs WHERE tenant_id = ${testTenantId}::uuid`);
  await db.execute(sql`DELETE FROM lifecycle_transitions WHERE contact_id IN (SELECT id FROM contacts WHERE tenant_id = ${testTenantId})`);
  await db.execute(sql`DELETE FROM contacts WHERE tenant_id = ${testTenantId}`);
  await db.execute(sql`UPDATE tenants SET settings = NULL WHERE id = ${testTenantId}`);
  vi.restoreAllMocks();
});

async function cleanup() {
  await db.execute(sql`DELETE FROM lifecycle_messages WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${SLUG})`);
  await db.execute(sql`DELETE FROM flow_memberships WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${SLUG})`);
  await db.execute(sql`DELETE FROM flows WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${SLUG})`);
  await db.execute(sql`DELETE FROM transport_configs WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${SLUG})`);
  await db.execute(sql`DELETE FROM lifecycle_transitions WHERE contact_id IN (SELECT id FROM contacts WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${SLUG}))`);
  await db.execute(sql`DELETE FROM contacts WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${SLUG})`);
  await db.execute(sql`DELETE FROM scan_checkpoints WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${SLUG})`);
  await db.execute(sql`DELETE FROM tenants WHERE slug = ${SLUG}`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Inserts a transport config in the same encrypted format that
 * PUT /v1/settings/transport produces.
 */
async function insertTransportConfig(opts: {
  apiKey: string;
  webhookSecret?: string;
  fromEmail?: string;
  fromName?: string;
}): Promise<void> {
  const key = parseEncryptionKey(TEST_ENCRYPTION_KEY_BASE64);
  const credentials: { apiKey: string; webhookSecret?: string } = { apiKey: opts.apiKey };
  if (opts.webhookSecret) credentials.webhookSecret = opts.webhookSecret;
  const encryptedConfig = encrypt(JSON.stringify(credentials), key);

  await db.execute(sql`
    INSERT INTO transport_configs (tenant_id, provider, config, is_active, from_email, from_name)
    VALUES (
      ${testTenantId}::uuid,
      'resend',
      ${encryptedConfig}::jsonb,
      true,
      ${opts.fromEmail ?? "noreply@example.com"},
      ${opts.fromName ?? null}
    )
  `);
}

async function setPostalAddress(address: string): Promise<void> {
  await db.execute(sql`
    UPDATE tenants
    SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{postal_address}', ${JSON.stringify(address)}::jsonb)
    WHERE id = ${testTenantId}
  `);
}

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

async function insertFlow(name: string): Promise<string> {
  const [row] = await db
    .insert(flows)
    .values({
      tenantId: testTenantId,
      name,
      priority: 0,
      triggerType: "lifecycle_transition",
      triggerConfig: { from: "engaged", to: "at_risk" },
      steps: [{ order: 1, action_type: "nurture_value", delay: "0d", window_policy: "immediate" }],
      status: "paused",
      flowClass: "nurture",
      compiledPlan: {
        trigger: { type: "lifecycle_transition", condition: { from: "engaged", to: "at_risk" } },
        steps: [{ order: 1, action_type: "nurture_value", delay: "0d", window_policy: "immediate" }],
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

async function insertApprovedMessage(contactId: string, flowId: string, membershipId: string): Promise<string> {
  const [row] = await db
    .insert(lifecycleMessages)
    .values({
      tenantId: testTenantId,
      contactId,
      flowId,
      membershipId,
      flowStepOrder: 1,
      status: "approved",
      subject: "Settings pipeline test",
      bodyHtml: "<p>Test body</p>",
      bodyText: "Test body",
      approvedAt: new Date("2026-07-20T10:00:00Z"),
    })
    .returning({ id: lifecycleMessages.id });
  return row!.id;
}

async function runDrain(now: Date) {
  // Use makeDrainRunner so that both the transport resolver and the fetch batch
  // are scoped to testTenantId. See drain-test-utils.ts for why both are needed.
  const rawResolver = buildTenantTransportResolver(db);
  const adapter = await rawResolver(testTenantId);
  return makeDrainRunner(db, testTenantId, adapter, TEST_SIGNING_KEY, TEST_BASE_URL)(now);
}

function mockResendSuccess(providerId: string = "pipeline-provider-id") {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: providerId }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("settings pipeline: resolver resolves endpoint-written config", () => {
  it("resolver returns non-null adapter when config is written in the endpoint format", async () => {
    if (!dbAvailable) return;

    await insertTransportConfig({ apiKey: TEST_API_KEY });

    const resolver = buildTenantTransportResolver(db);
    const adapter = await resolver(testTenantId);

    expect(adapter).not.toBeNull();
    expect(typeof adapter!.send).toBe("function");
  });

  it("drain sends message using endpoint-written config (mocked fetch)", async () => {
    if (!dbAvailable) return;

    await insertTransportConfig({ apiKey: TEST_API_KEY, fromEmail: "send@example.com" });
    await setPostalAddress(TEST_POSTAL_ADDRESS);
    mockResendSuccess("pipeline-sent-id");

    const contactId = await insertContact("pipeline-contact");
    const flowId = await insertFlow("pipeline-flow");
    const membershipId = await insertMembership(contactId, flowId);
    const messageId = await insertApprovedMessage(contactId, flowId, membershipId);

    const result = await runDrain(new Date("2026-07-21T10:00:00Z"));

    expect(result.sent).toBe(1);
    // skippedNoTransport can be > 0 when other test tenants have approved
    // messages in the DB at the same time. The assertion that matters is sent=1
    // and skippedNoPostalAddress=0 (no cross-tenant postal-address pollution).
    expect(result.skippedNoPostalAddress).toBe(0);

    const [msg] = await db
      .select({ status: lifecycleMessages.status, providerMessageId: lifecycleMessages.providerMessageId })
      .from(lifecycleMessages)
      .where(eq(lifecycleMessages.id, messageId));
    expect(msg!.status).toBe("sent");
    expect(msg!.providerMessageId).toBe("pipeline-sent-id");
  });

  it("drain result does not contain the api_key in any field", async () => {
    if (!dbAvailable) return;

    await insertTransportConfig({ apiKey: TEST_API_KEY });
    await setPostalAddress(TEST_POSTAL_ADDRESS);
    mockResendSuccess();

    const contactId = await insertContact("pipeline-safe-contact");
    const flowId = await insertFlow("pipeline-safe-flow");
    const membershipId = await insertMembership(contactId, flowId);
    await insertApprovedMessage(contactId, flowId, membershipId);

    const result = await runDrain(new Date("2026-07-21T10:00:00Z"));
    expect(JSON.stringify(result)).not.toContain(TEST_API_KEY);
  });
});

describe("settings pipeline: postal address blocks then unblocks drain", () => {
  it("no postal address -> skippedNoPostalAddress; message stays approved", async () => {
    if (!dbAvailable) return;

    await insertTransportConfig({ apiKey: TEST_API_KEY });
    // No postal address set
    mockResendSuccess();

    const contactId = await insertContact("no-postal-contact");
    const flowId = await insertFlow("no-postal-flow");
    const membershipId = await insertMembership(contactId, flowId);
    const messageId = await insertApprovedMessage(contactId, flowId, membershipId);

    const result = await runDrain(new Date("2026-07-21T10:00:00Z"));

    expect(result.skippedNoPostalAddress).toBeGreaterThanOrEqual(1);
    expect(result.sent).toBe(0);

    const [msg] = await db
      .select({ status: lifecycleMessages.status })
      .from(lifecycleMessages)
      .where(eq(lifecycleMessages.id, messageId));
    expect(msg!.status).toBe("approved");
  });

  it("postal address set -> drain sends; skippedNoPostalAddress drops to 0", async () => {
    if (!dbAvailable) return;

    await insertTransportConfig({ apiKey: TEST_API_KEY });
    await setPostalAddress(TEST_POSTAL_ADDRESS);
    mockResendSuccess("postal-unblocked-id");

    const contactId = await insertContact("postal-unblocked-contact");
    const flowId = await insertFlow("postal-unblocked-flow");
    const membershipId = await insertMembership(contactId, flowId);
    const messageId = await insertApprovedMessage(contactId, flowId, membershipId);

    const result = await runDrain(new Date("2026-07-21T10:00:00Z"));

    expect(result.skippedNoPostalAddress).toBe(0);
    expect(result.sent).toBe(1);

    const [msg] = await db
      .select({ status: lifecycleMessages.status })
      .from(lifecycleMessages)
      .where(eq(lifecycleMessages.id, messageId));
    expect(msg!.status).toBe("sent");
  });

  it("add postal address between two drain ticks: first tick blocks, second tick sends", async () => {
    if (!dbAvailable) return;

    await insertTransportConfig({ apiKey: TEST_API_KEY });
    mockResendSuccess("two-tick-id");

    const contactId = await insertContact("two-tick-contact");
    const flowId = await insertFlow("two-tick-flow");
    const membershipId = await insertMembership(contactId, flowId);
    const messageId = await insertApprovedMessage(contactId, flowId, membershipId);

    const now = new Date("2026-07-21T10:00:00Z");

    // First tick: no postal address
    const tick1 = await runDrain(now);
    expect(tick1.skippedNoPostalAddress).toBeGreaterThanOrEqual(1);
    expect(tick1.sent).toBe(0);

    // Message reverted to approved
    const [before] = await db
      .select({ status: lifecycleMessages.status })
      .from(lifecycleMessages)
      .where(eq(lifecycleMessages.id, messageId));
    expect(before!.status).toBe("approved");

    // Operator sets postal address
    await setPostalAddress(TEST_POSTAL_ADDRESS);

    // Second tick: postal address now present
    const tick2 = await runDrain(now);
    expect(tick2.skippedNoPostalAddress).toBe(0);
    expect(tick2.sent).toBe(1);

    const [after] = await db
      .select({ status: lifecycleMessages.status })
      .from(lifecycleMessages)
      .where(eq(lifecycleMessages.id, messageId));
    expect(after!.status).toBe("sent");
  });
});
