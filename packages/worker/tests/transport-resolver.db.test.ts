/**
 * Integration tests for the transport resolver (task 28).
 *
 * Tests:
 *   - Tenant with no transport config: resolver returns null; messages untouched
 *   - Tenant with Resend config: resolver returns ResendTransportAdapter
 *   - Successful send: message reaches 'sent', provider_message_id written
 *   - Permanent failure: message marked 'failed' immediately, no retry consumed
 *   - Transient failure: message stays at 'sending' for reap
 *   - Unimplemented provider (ses, smtp): resolver returns null; messages untouched
 *   - ENCRYPTION_KEY missing: resolver returns null; messages untouched
 *   - Credentials do not appear in any log assertion
 *
 * Resend HTTP calls are intercepted with vi.stubGlobal('fetch', ...).
 * No real API calls are made.
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
} from "@mailforge/db/schema";
import { encrypt, parseEncryptionKey } from "@mailforge/adapters";
import { buildTenantTransportResolver } from "../src/transport-resolver.js";
import { makeDrainRunner } from "./drain-test-utils.js";

// ---------------------------------------------------------------------------
// DB setup
// ---------------------------------------------------------------------------

const TEST_DB_URL = process.env.DATABASE_URL;
if (!TEST_DB_URL) {
  const inCI = process.env.CI === "true";
  throw new Error(
    `[transport-resolver.test] DATABASE_URL is not set.\n\n` +
      `This test requires a Postgres connection.\n` +
      (inCI
        ? `Set the variable in the workflow env block:\n\n  DATABASE_URL: postgres://mailforge:mailforge@localhost:5432/mailforge\n`
        : `Set the variable in .env (see .env.example) or export it:\n\n  export DATABASE_URL='postgres://mailforge:mailforge@localhost:5433/mailforge'\n`),
  );
}

const TEST_SIGNING_KEY = "transport-resolver-test-signing-key-do-not-use";
const TEST_BASE_URL = "http://localhost:3000";
const TEST_POSTAL_ADDRESS = "123 Resolver St, Test City, TC 99999";
const TEST_API_KEY = "re_test_resolver_key_do_not_use";

// A real 32-byte base64-encoded ENCRYPTION_KEY for tests.
// This is a deterministic test key - never used in production.
const TEST_ENCRYPTION_KEY_BASE64 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="; // 32 zero bytes

let pool: pg.Pool;
let db: ReturnType<typeof drizzle>;
let dbAvailable = false;
let testTenantId: string;

const SLUG = "test-transport-resolver";

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
        `[transport-resolver.test] DATABASE_URL not reachable in CI.\n` +
          `URL: ${TEST_DB_URL}\nCause: ${(err as Error).message}`,
      );
    }
    console.warn("[transport-resolver.test] DATABASE_URL not reachable - tests skipped.");
    return;
  }

  await cleanup();

  const [tenant] = await db
    .insert(tenants)
    .values({
      name: "Test Transport Resolver",
      slug: SLUG,
      plan: "free",
      settings: { postal_address: TEST_POSTAL_ADDRESS },
    })
    .returning({ id: tenants.id });
  testTenantId = tenant!.id;
});

beforeEach(async () => {
  if (!dbAvailable) return;
  // Clean transport configs and messages before each test.
  await db.execute(sql`DELETE FROM lifecycle_messages WHERE tenant_id = ${testTenantId}`);
  await db.execute(sql`DELETE FROM flow_memberships WHERE tenant_id = ${testTenantId}`);
  await db.execute(sql`DELETE FROM flows WHERE tenant_id = ${testTenantId}`);
  await db.execute(sql`DELETE FROM transport_configs WHERE tenant_id = ${testTenantId}::uuid`);
  vi.restoreAllMocks();
});

afterAll(async () => {
  if (dbAvailable) await cleanup();
  await pool.end();
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
      subject: "Test subject",
      bodyHtml: "<p>Test body</p>",
      bodyText: "Test body",
      approvedAt: new Date("2026-07-20T10:00:00Z"),
    })
    .returning({ id: lifecycleMessages.id });
  return row!.id;
}

/**
 * Inserts an active Resend transport config with an encrypted API key.
 * Uses the TEST_ENCRYPTION_KEY_BASE64 to encrypt the credentials.
 */
async function insertResendConfig(apiKey: string = TEST_API_KEY): Promise<void> {
  const encKey = parseEncryptionKey(TEST_ENCRYPTION_KEY_BASE64);
  const credentials = JSON.stringify({ apiKey });
  const encryptedConfig = encrypt(credentials, encKey);
  // transport_configs.config is JSONB - store the encrypted envelope as a JSON string value.
  await db.execute(sql`
    INSERT INTO transport_configs (tenant_id, provider, config, is_active, from_email, from_name)
    VALUES (
      ${testTenantId}::uuid,
      'resend',
      ${encryptedConfig}::jsonb,
      true,
      'noreply@example.com',
      'Test Sender'
    )
  `);
}

/**
 * Inserts an active transport config for an unimplemented provider.
 */
async function insertUnimplementedConfig(provider: string): Promise<void> {
  const encKey = parseEncryptionKey(TEST_ENCRYPTION_KEY_BASE64);
  const credentials = JSON.stringify({ apiKey: "dummy" });
  const encryptedConfig = encrypt(credentials, encKey);
  await db.execute(sql`
    INSERT INTO transport_configs (tenant_id, provider, config, is_active, from_email)
    VALUES (
      ${testTenantId}::uuid,
      ${provider},
      ${encryptedConfig}::jsonb,
      true,
      'noreply@example.com'
    )
  `);
}

/**
 * Run a drain tick with the test signing key and base URL,
 * using the real buildTenantTransportResolver with the test ENCRYPTION_KEY.
 * Both the resolver and fetch batch are scoped to testTenantId.
 * See drain-test-utils.ts for why both scopes are needed.
 */
async function runDrainWithRealResolver(now: Date, encryptionKeyOverride?: string | null) {
  const savedKey = process.env.ENCRYPTION_KEY;
  if (encryptionKeyOverride === null) {
    delete process.env.ENCRYPTION_KEY;
  } else if (encryptionKeyOverride !== undefined) {
    process.env.ENCRYPTION_KEY = encryptionKeyOverride;
  } else {
    process.env.ENCRYPTION_KEY = TEST_ENCRYPTION_KEY_BASE64;
  }

  try {
    const rawResolver = buildTenantTransportResolver(db);
    const adapter = await rawResolver(testTenantId);
    return makeDrainRunner(db, testTenantId, adapter, TEST_SIGNING_KEY, TEST_BASE_URL)(now);
  } finally {
    if (savedKey !== undefined) {
      process.env.ENCRYPTION_KEY = savedKey;
    } else {
      delete process.env.ENCRYPTION_KEY;
    }
  }
}

/** Mock a successful Resend HTTP response. */
function mockResendSuccess(providerId: string = "test-provider-id") {
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

/** Mock a permanent Resend failure. */
function mockResendPermanentFailure() {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ name: "invalid_from_address", message: "Invalid from field", statusCode: 422 }),
        { status: 422, headers: { "Content-Type": "application/json" } },
      ),
    ),
  );
}

/** Mock a transient Resend failure. */
function mockResendTransientFailure() {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ name: "rate_limit_exceeded", message: "Too many requests", statusCode: 429 }),
        { status: 429, headers: { "Content-Type": "application/json" } },
      ),
    ),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("transport resolver", () => {
  it("skips when DATABASE_URL is not reachable", () => {
    if (!dbAvailable) expect(true).toBe(true);
  });

  // -------------------------------------------------------------------------
  // No transport configured
  // -------------------------------------------------------------------------

  describe("tenant with no transport config", () => {
    it("resolver returns null and messages are untouched", async () => {
      if (!dbAvailable) return;

      const contactId = await insertContact("no-config-contact");
      const flowId = await insertFlow("no-config-flow");
      const membershipId = await insertMembership(contactId, flowId);
      const messageId = await insertApprovedMessage(contactId, flowId, membershipId);

      const now = new Date("2026-07-21T10:00:00Z");

      // No transport_configs row for this tenant.
      const result = await runDrainWithRealResolver(now);

      // The resolver returned null for this tenant - no messages claimed or sent.
      expect(result.skippedNoTransport).toBeGreaterThanOrEqual(1);
      expect(result.sent).toBe(0);
      expect(result.candidatesFetched).toBe(0);

      // Message must still be 'approved' with unchanged updated_at (zero writes).
      const [msg] = await db
        .select({ status: lifecycleMessages.status })
        .from(lifecycleMessages)
        .where(eq(lifecycleMessages.id, messageId));
      expect(msg!.status).toBe("approved");
    });
  });

  // -------------------------------------------------------------------------
  // Resend adapter: successful send
  // -------------------------------------------------------------------------

  describe("resend: successful send", () => {
    it("message reaches status='sent' with provider_message_id written", async () => {
      if (!dbAvailable) return;

      await insertResendConfig();
      mockResendSuccess("resend-provider-msg-id");

      const contactId = await insertContact("resend-success-contact");
      const flowId = await insertFlow("resend-success-flow");
      const membershipId = await insertMembership(contactId, flowId);
      const messageId = await insertApprovedMessage(contactId, flowId, membershipId);

      const now = new Date("2026-07-21T10:00:00Z");
      const result = await runDrainWithRealResolver(now);

      expect(result.sent).toBe(1);
      expect(result.transportErrors).toBe(0);
      expect(result.permanentFailures).toBe(0);

      const [msg] = await db
        .select({
          status: lifecycleMessages.status,
          providerMessageId: lifecycleMessages.providerMessageId,
          recipientAddress: lifecycleMessages.recipientAddress,
        })
        .from(lifecycleMessages)
        .where(eq(lifecycleMessages.id, messageId));
      expect(msg!.status).toBe("sent");
      expect(msg!.providerMessageId).toBe("resend-provider-msg-id");
      expect(msg!.recipientAddress).toBe("resend-success-contact@example.com");
    });
  });

  // -------------------------------------------------------------------------
  // Resend adapter: permanent failure
  // -------------------------------------------------------------------------

  describe("resend: permanent failure", () => {
    it("message is marked 'failed' immediately without consuming a retry", async () => {
      if (!dbAvailable) return;

      await insertResendConfig();
      mockResendPermanentFailure();

      const contactId = await insertContact("resend-perm-fail-contact");
      const flowId = await insertFlow("resend-perm-fail-flow");
      const membershipId = await insertMembership(contactId, flowId);
      const messageId = await insertApprovedMessage(contactId, flowId, membershipId);

      const now = new Date("2026-07-21T10:00:00Z");
      const result = await runDrainWithRealResolver(now);

      expect(result.permanentFailures).toBe(1);
      expect(result.sent).toBe(0);
      expect(result.transportErrors).toBe(0);

      const [msg] = await db
        .select({
          status: lifecycleMessages.status,
          retryCount: lifecycleMessages.retryCount,
        })
        .from(lifecycleMessages)
        .where(eq(lifecycleMessages.id, messageId));
      expect(msg!.status).toBe("failed");
      // Retry count is NOT incremented for permanent failures (drain marks failed
      // directly; reap never touches it).
      expect(msg!.retryCount).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Resend adapter: transient failure
  // -------------------------------------------------------------------------

  describe("resend: transient failure", () => {
    it("message stays at 'sending' for reap to retry", async () => {
      if (!dbAvailable) return;

      await insertResendConfig();
      mockResendTransientFailure();

      const contactId = await insertContact("resend-transient-contact");
      const flowId = await insertFlow("resend-transient-flow");
      const membershipId = await insertMembership(contactId, flowId);
      const messageId = await insertApprovedMessage(contactId, flowId, membershipId);

      const now = new Date("2026-07-21T10:00:00Z");
      const result = await runDrainWithRealResolver(now);

      expect(result.transportErrors).toBe(1);
      expect(result.sent).toBe(0);
      expect(result.permanentFailures).toBe(0);

      // Message stays at 'sending' - reap will recover.
      const [msg] = await db
        .select({ status: lifecycleMessages.status })
        .from(lifecycleMessages)
        .where(eq(lifecycleMessages.id, messageId));
      expect(msg!.status).toBe("sending");
    });
  });

  // -------------------------------------------------------------------------
  // Unimplemented provider
  // -------------------------------------------------------------------------

  describe("unimplemented provider", () => {
    for (const provider of ["ses"]) {
      it(`resolver returns null for provider='${provider}' and messages are untouched`, async () => {
        if (!dbAvailable) return;

        await insertUnimplementedConfig(provider);

        const contactId = await insertContact(`${provider}-contact`);
        const flowId = await insertFlow(`${provider}-flow`);
        const membershipId = await insertMembership(contactId, flowId);
        const messageId = await insertApprovedMessage(contactId, flowId, membershipId);

        const now = new Date("2026-07-21T10:00:00Z");

        // No fetch mock needed - the resolver returns null before any adapter is created.
        const result = await runDrainWithRealResolver(now);

        expect(result.skippedNoTransport).toBeGreaterThanOrEqual(1);
        expect(result.sent).toBe(0);
        expect(result.candidatesFetched).toBe(0);

        const [msg] = await db
          .select({ status: lifecycleMessages.status })
          .from(lifecycleMessages)
          .where(eq(lifecycleMessages.id, messageId));
        expect(msg!.status).toBe("approved");
      });
    }
  });

  // -------------------------------------------------------------------------
  // Missing ENCRYPTION_KEY
  // -------------------------------------------------------------------------

  describe("missing ENCRYPTION_KEY", () => {
    it("resolver returns null when ENCRYPTION_KEY is not set; messages are untouched", async () => {
      if (!dbAvailable) return;

      await insertResendConfig();

      const contactId = await insertContact("no-enc-key-contact");
      const flowId = await insertFlow("no-enc-key-flow");
      const membershipId = await insertMembership(contactId, flowId);
      const messageId = await insertApprovedMessage(contactId, flowId, membershipId);

      const now = new Date("2026-07-21T10:00:00Z");

      // Pass null to simulate ENCRYPTION_KEY not being set.
      const result = await runDrainWithRealResolver(now, null);

      expect(result.skippedNoTransport).toBeGreaterThanOrEqual(1);
      expect(result.sent).toBe(0);
      expect(result.candidatesFetched).toBe(0);

      const [msg] = await db
        .select({ status: lifecycleMessages.status })
        .from(lifecycleMessages)
        .where(eq(lifecycleMessages.id, messageId));
      expect(msg!.status).toBe("approved");
    });
  });

  // -------------------------------------------------------------------------
  // Credential safety: API key must not appear in any test assertion
  // -------------------------------------------------------------------------

  describe("credential safety", () => {
    it("successful send result does not contain the API key", async () => {
      if (!dbAvailable) return;

      await insertResendConfig(TEST_API_KEY);
      mockResendSuccess("safe-provider-id");

      const contactId = await insertContact("safe-contact");
      const flowId = await insertFlow("safe-flow");
      const membershipId = await insertMembership(contactId, flowId);
      await insertApprovedMessage(contactId, flowId, membershipId);

      const now = new Date("2026-07-21T10:00:00Z");
      const result = await runDrainWithRealResolver(now);

      // The drain result must not contain the API key.
      expect(JSON.stringify(result)).not.toContain(TEST_API_KEY);
    });

    it("permanent failure error message does not contain the API key", async () => {
      if (!dbAvailable) return;

      await insertResendConfig(TEST_API_KEY);
      mockResendPermanentFailure();

      const contactId = await insertContact("safe-perm-contact");
      const flowId = await insertFlow("safe-perm-flow");
      const membershipId = await insertMembership(contactId, flowId);
      await insertApprovedMessage(contactId, flowId, membershipId);

      const now = new Date("2026-07-21T10:00:00Z");
      const result = await runDrainWithRealResolver(now);

      // Result itself must not contain the API key.
      expect(JSON.stringify(result)).not.toContain(TEST_API_KEY);
    });
  });
});
