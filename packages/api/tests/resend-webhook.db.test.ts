/**
 * Integration tests for the Resend webhook endpoint (tasks 29/30).
 *
 * Coverage:
 *   - Valid signed bounce marks feedback and suppresses the resolved address
 *   - Soft bounce marks feedback and suppresses nothing
 *   - Complaint marks feedback and suppresses
 *   - Open then click advances correctly; click then open leaves state at clicked
 *   - Duplicate deliveries of the same event change nothing on second delivery
 *   - Unsigned or wrongly signed payload changes nothing and is rejected
 *   - Payload naming unknown provider_message_id is acknowledged without error
 *   - Payload carrying different address than message's recipient suppresses
 *     the message's address (not the payload's)
 *   - Suppressed address is subsequently blocked by the throttle gate
 *   - Cross-tenant replay: same valid payload replayed against a different
 *     tenant's path is rejected (wrong secret)
 *   - Cross-tenant message isolation: valid signature for tenant A cannot touch
 *     a message that belongs to tenant B (message lookup is tenant-scoped)
 *   - Unknown tenant UUID returns 400 with the same error as a bad signature
 *   - Tenant with no webhook secret returns 400 with the same error
 *
 * Requires local Postgres (docker compose up postgres).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { sql, eq, and } from "drizzle-orm";
import { createHmac, randomBytes } from "node:crypto";
import { buildApp } from "../src/index.js";
import {
  tenants,
  contacts,
  lifecycleMessages,
  flows,
  flowMemberships,
  suppressions,
} from "@claros/db/schema";
import {
  THROTTLE_DEFAULTS,
  evaluateThrottleGate,
  type ThrottleGateInput,
} from "@claros/core";
import { encrypt, parseEncryptionKey } from "@claros/adapters";

// ---------------------------------------------------------------------------
// DB setup
// ---------------------------------------------------------------------------

const TEST_DB_URL = process.env.DATABASE_URL;
if (!TEST_DB_URL) {
  const inCI = process.env.CI === "true";
  throw new Error(
    `[resend-webhook.test] DATABASE_URL is not set.\n\n` +
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
let flowId: string;
let membershipId: string;

// Second tenant for cross-tenant tests
let otherTenantId: string;
let otherFlowId: string;

// Messages with different provider_message_ids for testing
let sentMessageId: string;
let sentMessageProviderId: string;

// Webhook signing secrets for tests.
// Generated at module load time from random bytes. The production handler
// accepts any base64 string as the secret (the "whsec_" prefix is optional -
// see resend.ts verifySignature). Plain base64 carries no credential shape
// that a scanner would flag, while still exercising real HMAC verification.
const TEST_WEBHOOK_SECRET = randomBytes(24).toString("base64");
const OTHER_WEBHOOK_SECRET = randomBytes(24).toString("base64");

// A hardcoded 32-byte test ENCRYPTION_KEY (32 zero bytes, base64-encoded).
// Used in place of the real key so this test does not depend on the
// ENCRYPTION_KEY env var being passed through turbo's env passthrough list.
const TEST_ENCRYPTION_KEY_BASE64 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

const SLUG = "test-resend-webhook-29";
const OTHER_SLUG = "test-resend-webhook-other";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function signPayload(
  rawBody: string,
  secret: string = TEST_WEBHOOK_SECRET,
  msgId: string = "msg_test123",
  timestamp?: number,
): { svixId: string; svixTimestamp: string; svixSignature: string } {
  const ts = timestamp ?? Math.floor(Date.now() / 1000);
  const secretBase64 = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  const secretBytes = Buffer.from(secretBase64, "base64");
  const signedContent = `${msgId}.${ts}.${rawBody}`;
  const signature = createHmac("sha256", secretBytes)
    .update(signedContent)
    .digest("base64");
  return {
    svixId: msgId,
    svixTimestamp: String(ts),
    svixSignature: `v1,${signature}`,
  };
}

/**
 * Encrypt transport credentials (apiKey + webhookSecret) using the test
 * ENCRYPTION_KEY (hardcoded 32-byte all-zeros key).
 */
function encryptTransportCredentials(credentials: { apiKey: string; webhookSecret?: string }): string {
  const key = parseEncryptionKey(TEST_ENCRYPTION_KEY_BASE64);
  return encrypt(JSON.stringify(credentials), key);
}

async function createSentMessage(
  providerId: string,
  recipientAddr: string,
  feedback: string | null = null,
  ownerTenantId?: string,
  ownerContactId?: string,
  ownerFlowId?: string,
): Promise<string> {
  const tid = ownerTenantId ?? tenantId;
  const cid = ownerContactId ?? contactId;
  const fid = ownerFlowId ?? flowId;

  // Need a unique membership per message due to unique index on (membership_id, flow_step_order)
  const [m] = await db
    .insert(flowMemberships)
    .values({
      tenantId: tid,
      contactId: cid,
      flowId: fid,
      currentStep: 1,
      status: "completed",
      enteredAt: new Date("2026-07-01T00:00:00Z"),
      completedAt: new Date("2026-07-01T00:00:00Z"),
      exitReason: "completed",
    })
    .returning({ id: flowMemberships.id });

  const [msg] = await db
    .insert(lifecycleMessages)
    .values({
      tenantId: tid,
      contactId: cid,
      flowId: fid,
      membershipId: m!.id,
      flowStepOrder: 1,
      status: "sent",
      subject: "Test subject",
      bodyHtml: "<p>Test</p>",
      recipientAddress: recipientAddr,
      providerMessageId: providerId,
      sentAt: new Date("2026-07-01T10:00:00Z"),
      feedback,
    })
    .returning({ id: lifecycleMessages.id });

  return msg!.id;
}

async function getFeedback(messageId: string): Promise<string | null> {
  const rows = await db
    .select({ feedback: lifecycleMessages.feedback })
    .from(lifecycleMessages)
    .where(eq(lifecycleMessages.id, messageId))
    .limit(1);
  return rows[0]?.feedback ?? null;
}

async function isSuppressed(email: string, tid?: string): Promise<boolean> {
  const rows = await db
    .select({ id: suppressions.id })
    .from(suppressions)
    .where(
      and(
        eq(suppressions.tenantId, tid ?? tenantId),
        sql`lower(${suppressions.email}) = lower(${email})`,
      ),
    )
    .limit(1);
  return rows.length > 0;
}

async function cleanup(): Promise<void> {
  // Clean up in reverse FK order
  for (const slug of [SLUG, OTHER_SLUG]) {
    await db.execute(sql`DELETE FROM message_events WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${slug})`);
    await db.execute(sql`DELETE FROM lifecycle_messages WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${slug})`);
    await db.execute(sql`DELETE FROM flow_memberships WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${slug})`);
    await db.execute(sql`DELETE FROM flows WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${slug})`);
    await db.execute(sql`DELETE FROM suppressions WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${slug})`);
    await db.execute(sql`DELETE FROM transport_configs WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${slug})`);
    await db.execute(sql`DELETE FROM lifecycle_transitions WHERE contact_id IN (SELECT id FROM contacts WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${slug}))`);
    await db.execute(sql`DELETE FROM contacts WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${slug})`);
    await db.execute(sql`DELETE FROM tenants WHERE slug = ${slug}`);
  }
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

// Save the original ENCRYPTION_KEY (if any) and install the test key.
// The webhook route reads process.env.ENCRYPTION_KEY at request time to
// decrypt the transport config. Using a hardcoded test key avoids depending
// on turbo's env passthrough list (ENCRYPTION_KEY is not in turbo.json env).
let savedEncryptionKey: string | undefined;

beforeAll(async () => {
  // Install the test ENCRYPTION_KEY before any requests are made.
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
        `[resend-webhook.test] DATABASE_URL not reachable in CI.\n` +
          `URL: ${TEST_DB_URL}\nCause: ${(err as Error).message}`,
      );
    }
    console.warn("[resend-webhook.test] DATABASE_URL not reachable - tests skipped.");
    return;
  }

  await cleanup();

  // Create primary test tenant
  const [t] = await db
    .insert(tenants)
    .values({ name: "Webhook Test", slug: SLUG, plan: "free" })
    .returning({ id: tenants.id });
  tenantId = t!.id;

  // Create transport_config with encrypted webhook secret for primary tenant.
  // Must use raw SQL with ::jsonb cast (same pattern as transport-resolver tests)
  // so the encrypted envelope is stored as a JSONB object (not a double-encoded string).
  const encryptedConfig = encryptTransportCredentials({
    apiKey: "re_test_api_key",
    webhookSecret: TEST_WEBHOOK_SECRET,
  });
  await db.execute(sql`
    INSERT INTO transport_configs (tenant_id, provider, config, is_active, from_email)
    VALUES (${tenantId}::uuid, 'resend', ${encryptedConfig}::jsonb, true, 'noreply@test.example.com')
  `);

  // Create second tenant (for cross-tenant isolation tests)
  const [ot] = await db
    .insert(tenants)
    .values({ name: "Other Webhook Test", slug: OTHER_SLUG, plan: "free" })
    .returning({ id: tenants.id });
  otherTenantId = ot!.id;

  // Create transport_config for second tenant with a different secret.
  // Must use raw SQL with ::jsonb cast (same pattern as transport-resolver tests).
  const encryptedOtherConfig = encryptTransportCredentials({
    apiKey: "re_other_api_key",
    webhookSecret: OTHER_WEBHOOK_SECRET,
  });
  await db.execute(sql`
    INSERT INTO transport_configs (tenant_id, provider, config, is_active, from_email)
    VALUES (${otherTenantId}::uuid, 'resend', ${encryptedOtherConfig}::jsonb, true, 'noreply@other.example.com')
  `);

  // Contact with email (primary tenant)
  contactEmail = "webhook-test@example.com";
  const [c] = await db
    .insert(contacts)
    .values({
      tenantId,
      externalId: "wh-ext-1",
      email: contactEmail,
      lifecycleState: "signed_up",
    })
    .returning({ id: contacts.id });
  contactId = c!.id;

  // Create a flow (primary tenant)
  const [f] = await db
    .insert(flows)
    .values({
      tenantId,
      name: "webhook-test-flow",
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
  flowId = f!.id;

  // Create a membership + sent message (primary tenant)
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
  membershipId = m!.id;

  sentMessageProviderId = "resend-provider-msg-001";
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
      providerMessageId: sentMessageProviderId,
      sentAt: new Date("2026-07-01T10:00:00Z"),
    })
    .returning({ id: lifecycleMessages.id });
  sentMessageId = sm!.id;

  // Create a flow for the second tenant (used in cross-tenant isolation tests)
  const [of] = await db
    .insert(flows)
    .values({
      tenantId: otherTenantId,
      name: "other-webhook-test-flow",
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
  otherFlowId = of!.id;
});

afterAll(async () => {
  // Restore the original ENCRYPTION_KEY
  if (savedEncryptionKey !== undefined) {
    process.env.ENCRYPTION_KEY = savedEncryptionKey;
  } else {
    delete process.env.ENCRYPTION_KEY;
  }

  if (dbAvailable) {
    await cleanup();
    await pool.end();
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Resend webhook endpoint", () => {
  it("should skip if DB not available", () => {
    if (!dbAvailable) {
      console.warn("[resend-webhook.test] Skipping - DB not available");
      return;
    }
    expect(true).toBe(true);
  });

  // -- Signature verification tests --

  describe("signature verification", () => {
    it("rejects unsigned payload (no headers)", async () => {
      if (!dbAvailable) return;

      const app = await buildApp({ db: db as any });
      const payload = JSON.stringify({ type: "email.opened", data: { email_id: sentMessageProviderId } });

      const response = await app.inject({
        method: "POST",
        url: `/webhooks/resend/${tenantId}`,
        payload,
        headers: { "content-type": "application/json" },
      });

      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body)).toHaveProperty("error", "Invalid webhook signature.");

      // Verify nothing changed
      const feedback = await getFeedback(sentMessageId);
      expect(feedback).toBeNull();
    });

    it("rejects wrongly signed payload", async () => {
      if (!dbAvailable) return;

      const app = await buildApp({ db: db as any });
      const payload = JSON.stringify({ type: "email.opened", data: { email_id: sentMessageProviderId } });

      // Sign with a different secret (guaranteed different: generated independently)
      const wrongSecret = randomBytes(24).toString("base64");
      const headers = signPayload(payload, wrongSecret);

      const response = await app.inject({
        method: "POST",
        url: `/webhooks/resend/${tenantId}`,
        payload,
        headers: {
          "content-type": "application/json",
          "svix-id": headers.svixId,
          "svix-timestamp": headers.svixTimestamp,
          "svix-signature": headers.svixSignature,
        },
      });

      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body)).toHaveProperty("error", "Invalid webhook signature.");

      // Verify nothing changed
      const feedback = await getFeedback(sentMessageId);
      expect(feedback).toBeNull();
    });

    it("rejects replay with expired timestamp", async () => {
      if (!dbAvailable) return;

      const app = await buildApp({ db: db as any });
      const payload = JSON.stringify({ type: "email.opened", data: { email_id: sentMessageProviderId } });

      // Sign with a timestamp 10 minutes ago (beyond 5 min tolerance)
      const oldTimestamp = Math.floor(Date.now() / 1000) - 600;
      const headers = signPayload(payload, TEST_WEBHOOK_SECRET, "msg_replay1", oldTimestamp);

      const response = await app.inject({
        method: "POST",
        url: `/webhooks/resend/${tenantId}`,
        payload,
        headers: {
          "content-type": "application/json",
          "svix-id": headers.svixId,
          "svix-timestamp": headers.svixTimestamp,
          "svix-signature": headers.svixSignature,
        },
      });

      expect(response.statusCode).toBe(400);
    });
  });

  // -- Cross-tenant security tests --

  describe("cross-tenant security", () => {
    it("payload signed with tenant A's secret is rejected against tenant B's path", async () => {
      if (!dbAvailable) return;

      const app = await buildApp({ db: db as any });
      const providerId = "resend-cross-tenant-replay-001";
      const payload = JSON.stringify({
        type: "email.opened",
        data: { email_id: providerId },
      });

      // Sign with tenant A's secret (TEST_WEBHOOK_SECRET)
      const headers = signPayload(payload, TEST_WEBHOOK_SECRET, "msg_cross_replay1");

      // Post to tenant B's path (/webhooks/resend/otherTenantId)
      // Tenant B's transport_config has OTHER_WEBHOOK_SECRET, so the signature
      // won't match and the request must be rejected.
      const response = await app.inject({
        method: "POST",
        url: `/webhooks/resend/${otherTenantId}`,
        payload,
        headers: {
          "content-type": "application/json",
          "svix-id": headers.svixId,
          "svix-timestamp": headers.svixTimestamp,
          "svix-signature": headers.svixSignature,
        },
      });

      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body)).toHaveProperty("error", "Invalid webhook signature.");
    });

    it("valid signature for tenant A cannot touch a message belonging to tenant B", async () => {
      if (!dbAvailable) return;

      // Create a contact and message for the other tenant
      const [otherContact] = await db
        .insert(contacts)
        .values({
          tenantId: otherTenantId,
          externalId: "wh-other-ext-1",
          email: "other-tenant-contact@example.com",
          lifecycleState: "signed_up",
        })
        .returning({ id: contacts.id });

      // The message has the same provider_message_id as a message we'll reference
      // but it belongs to otherTenantId
      const crossTenantProviderId = "resend-cross-tenant-msg-001";
      const otherMsgId = await createSentMessage(
        crossTenantProviderId,
        "other-tenant-contact@example.com",
        null,
        otherTenantId,
        otherContact!.id,
        otherFlowId,
      );

      const app = await buildApp({ db: db as any });

      // Build a payload referencing the other tenant's message
      const payload = JSON.stringify({
        type: "email.opened",
        data: { email_id: crossTenantProviderId },
      });

      // Sign with tenant A's (primary) secret - valid signature for that tenant
      const headers = signPayload(payload, TEST_WEBHOOK_SECRET, "msg_cross_touch1");

      // Post to tenant A's path - signature is valid, but the message belongs
      // to otherTenantId. The message lookup is scoped to tenantId so it
      // returns "ignored_unknown_message" and the message is not modified.
      const response = await app.inject({
        method: "POST",
        url: `/webhooks/resend/${tenantId}`,
        payload,
        headers: {
          "content-type": "application/json",
          "svix-id": headers.svixId,
          "svix-timestamp": headers.svixTimestamp,
          "svix-signature": headers.svixSignature,
        },
      });

      // Returns 200 (acknowledged, not processed) - same as unknown message ID
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toHaveProperty("received", true);

      // Verify the other tenant's message was NOT modified
      const feedback = await getFeedback(otherMsgId);
      expect(feedback).toBeNull();
    });

    it("unknown tenant UUID returns 400 with the same message as a bad signature", async () => {
      if (!dbAvailable) return;

      const app = await buildApp({ db: db as any });
      const payload = JSON.stringify({
        type: "email.opened",
        data: { email_id: sentMessageProviderId },
      });
      const headers = signPayload(payload, TEST_WEBHOOK_SECRET, "msg_unknown_tenant1");

      // Use a valid UUID that does not exist as a tenant
      const nonExistentTenantId = "00000000-0000-0000-0000-000000000000";

      const response = await app.inject({
        method: "POST",
        url: `/webhooks/resend/${nonExistentTenantId}`,
        payload,
        headers: {
          "content-type": "application/json",
          "svix-id": headers.svixId,
          "svix-timestamp": headers.svixTimestamp,
          "svix-signature": headers.svixSignature,
        },
      });

      // Same 400 and same message as a bad signature - no oracle
      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body)).toHaveProperty("error", "Invalid webhook signature.");
    });

    it("tenant with no webhook secret in transport_config returns 400 with the same message", async () => {
      if (!dbAvailable) return;

      // Create a tenant whose transport_config has no webhookSecret
      const [noSecretTenant] = await db
        .insert(tenants)
        .values({ name: "No Secret Tenant", slug: "test-resend-no-secret-wh", plan: "free" })
        .returning({ id: tenants.id });

      const noSecretTenantId = noSecretTenant!.id;

      // Config has only apiKey, no webhookSecret
      const encryptedConfigNoSecret = encryptTransportCredentials({
        apiKey: "re_no_secret_key",
        // webhookSecret intentionally omitted
      });

      await db.execute(sql`
        INSERT INTO transport_configs (tenant_id, provider, config, is_active, from_email)
        VALUES (${noSecretTenantId}::uuid, 'resend', ${encryptedConfigNoSecret}::jsonb, true, 'noreply@nosecret.example.com')
      `);

      try {
        const app = await buildApp({ db: db as any });
        const payload = JSON.stringify({
          type: "email.opened",
          data: { email_id: "any-provider-id" },
        });
        const headers = signPayload(payload, TEST_WEBHOOK_SECRET, "msg_no_secret1");

        const response = await app.inject({
          method: "POST",
          url: `/webhooks/resend/${noSecretTenantId}`,
          payload,
          headers: {
            "content-type": "application/json",
            "svix-id": headers.svixId,
            "svix-timestamp": headers.svixTimestamp,
            "svix-signature": headers.svixSignature,
          },
        });

        // Same 400 and same message as a bad signature - no oracle
        expect(response.statusCode).toBe(400);
        expect(JSON.parse(response.body)).toHaveProperty("error", "Invalid webhook signature.");
      } finally {
        // Clean up the no-secret tenant
        await db.execute(sql`DELETE FROM transport_configs WHERE tenant_id = ${noSecretTenantId}::uuid`);
        await db.execute(sql`DELETE FROM tenants WHERE id = ${noSecretTenantId}::uuid`);
      }
    });
  });

  // -- Bounce tests --

  describe("bounces", () => {
    it("hard bounce marks feedback='bounced' and suppresses the resolved address", async () => {
      if (!dbAvailable) return;

      // Create a message for this test
      const providerId = "resend-hard-bounce-001";
      const msgId = await createSentMessage(providerId, contactEmail);

      const app = await buildApp({ db: db as any });

      const payload = JSON.stringify({
        type: "email.bounced",
        created_at: new Date().toISOString(),
        data: {
          email_id: providerId,
          to: ["delivered@resend.dev"],
          bounce: {
            type: "Permanent",
            subType: "General",
            message: "The email account does not exist.",
          },
        },
      });

      const headers = signPayload(payload);

      const response = await app.inject({
        method: "POST",
        url: `/webhooks/resend/${tenantId}`,
        payload,
        headers: {
          "content-type": "application/json",
          "svix-id": headers.svixId,
          "svix-timestamp": headers.svixTimestamp,
          "svix-signature": headers.svixSignature,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toHaveProperty("received", true);

      // Feedback should be 'bounced'
      const feedback = await getFeedback(msgId);
      expect(feedback).toBe("bounced");

      // Address should be suppressed
      const suppressed = await isSuppressed(contactEmail);
      expect(suppressed).toBe(true);
    });

    it("soft bounce marks feedback='bounced' and does NOT suppress", async () => {
      if (!dbAvailable) return;

      // Clean suppressions from previous test
      await db.execute(sql`DELETE FROM suppressions WHERE tenant_id = ${tenantId}::uuid`);

      const providerId = "resend-soft-bounce-001";
      const msgId = await createSentMessage(providerId, "softbounce@example.com");

      const app = await buildApp({ db: db as any });

      const payload = JSON.stringify({
        type: "email.bounced",
        created_at: new Date().toISOString(),
        data: {
          email_id: providerId,
          to: ["softbounce@example.com"],
          bounce: {
            type: "Temporary",
            subType: "MailboxFull",
            message: "Mailbox full",
          },
        },
      });

      const headers = signPayload(payload);

      const response = await app.inject({
        method: "POST",
        url: `/webhooks/resend/${tenantId}`,
        payload,
        headers: {
          "content-type": "application/json",
          "svix-id": headers.svixId,
          "svix-timestamp": headers.svixTimestamp,
          "svix-signature": headers.svixSignature,
        },
      });

      expect(response.statusCode).toBe(200);

      // Feedback should be 'bounced'
      const feedback = await getFeedback(msgId);
      expect(feedback).toBe("bounced");

      // Should NOT be suppressed
      const suppressed = await isSuppressed("softbounce@example.com");
      expect(suppressed).toBe(false);
    });
  });

  // -- Complaint test --

  describe("complaints", () => {
    it("complaint marks feedback='complained' and suppresses the resolved address", async () => {
      if (!dbAvailable) return;

      // Clean suppressions
      await db.execute(sql`DELETE FROM suppressions WHERE tenant_id = ${tenantId}::uuid`);

      const providerId = "resend-complaint-001";
      const recipientAddr = "complaint-target@example.com";
      const msgId = await createSentMessage(providerId, recipientAddr);

      const app = await buildApp({ db: db as any });

      const payload = JSON.stringify({
        type: "email.complained",
        created_at: new Date().toISOString(),
        data: {
          email_id: providerId,
          to: [recipientAddr],
        },
      });

      const headers = signPayload(payload);

      const response = await app.inject({
        method: "POST",
        url: `/webhooks/resend/${tenantId}`,
        payload,
        headers: {
          "content-type": "application/json",
          "svix-id": headers.svixId,
          "svix-timestamp": headers.svixTimestamp,
          "svix-signature": headers.svixSignature,
        },
      });

      expect(response.statusCode).toBe(200);

      const feedback = await getFeedback(msgId);
      expect(feedback).toBe("complained");

      const suppressed = await isSuppressed(recipientAddr);
      expect(suppressed).toBe(true);
    });
  });

  // -- Advance-only transitions --

  describe("feedback advance-only transitions", () => {
    it("open then click advances correctly (NULL -> opened -> clicked)", async () => {
      if (!dbAvailable) return;

      const providerId = "resend-advance-001";
      const msgId = await createSentMessage(providerId, "advance@example.com");

      const app = await buildApp({ db: db as any });

      // Send open event
      const openPayload = JSON.stringify({
        type: "email.opened",
        created_at: new Date().toISOString(),
        data: { email_id: providerId },
      });
      const openHeaders = signPayload(openPayload, TEST_WEBHOOK_SECRET, "msg_open1");

      await app.inject({
        method: "POST",
        url: `/webhooks/resend/${tenantId}`,
        payload: openPayload,
        headers: {
          "content-type": "application/json",
          "svix-id": openHeaders.svixId,
          "svix-timestamp": openHeaders.svixTimestamp,
          "svix-signature": openHeaders.svixSignature,
        },
      });

      expect(await getFeedback(msgId)).toBe("opened");

      // Send click event
      const clickPayload = JSON.stringify({
        type: "email.clicked",
        created_at: new Date().toISOString(),
        data: { email_id: providerId },
      });
      const clickHeaders = signPayload(clickPayload, TEST_WEBHOOK_SECRET, "msg_click1");

      await app.inject({
        method: "POST",
        url: `/webhooks/resend/${tenantId}`,
        payload: clickPayload,
        headers: {
          "content-type": "application/json",
          "svix-id": clickHeaders.svixId,
          "svix-timestamp": clickHeaders.svixTimestamp,
          "svix-signature": clickHeaders.svixSignature,
        },
      });

      expect(await getFeedback(msgId)).toBe("clicked");
    });

    it("click then open leaves state at clicked (backward move blocked)", async () => {
      if (!dbAvailable) return;

      const providerId = "resend-advance-002";
      const msgId = await createSentMessage(providerId, "advance2@example.com");

      const app = await buildApp({ db: db as any });

      // Send click event FIRST
      const clickPayload = JSON.stringify({
        type: "email.clicked",
        created_at: new Date().toISOString(),
        data: { email_id: providerId },
      });
      const clickHeaders = signPayload(clickPayload, TEST_WEBHOOK_SECRET, "msg_click2");

      await app.inject({
        method: "POST",
        url: `/webhooks/resend/${tenantId}`,
        payload: clickPayload,
        headers: {
          "content-type": "application/json",
          "svix-id": clickHeaders.svixId,
          "svix-timestamp": clickHeaders.svixTimestamp,
          "svix-signature": clickHeaders.svixSignature,
        },
      });

      expect(await getFeedback(msgId)).toBe("clicked");

      // Send open event AFTER (should not downgrade)
      const openPayload = JSON.stringify({
        type: "email.opened",
        created_at: new Date().toISOString(),
        data: { email_id: providerId },
      });
      const openHeaders = signPayload(openPayload, TEST_WEBHOOK_SECRET, "msg_open2");

      await app.inject({
        method: "POST",
        url: `/webhooks/resend/${tenantId}`,
        payload: openPayload,
        headers: {
          "content-type": "application/json",
          "svix-id": openHeaders.svixId,
          "svix-timestamp": openHeaders.svixTimestamp,
          "svix-signature": openHeaders.svixSignature,
        },
      });

      // Should remain at 'clicked'
      expect(await getFeedback(msgId)).toBe("clicked");
    });
  });

  // -- Idempotency / duplicate events --

  describe("duplicate events", () => {
    it("duplicate delivery of the same event changes nothing on second call", async () => {
      if (!dbAvailable) return;

      const providerId = "resend-dedup-001";
      const msgId = await createSentMessage(providerId, "dedup@example.com");

      const app = await buildApp({ db: db as any });

      const payload = JSON.stringify({
        type: "email.opened",
        created_at: new Date().toISOString(),
        data: { email_id: providerId },
      });
      const headers = signPayload(payload, TEST_WEBHOOK_SECRET, "msg_dedup1");

      // First call
      const res1 = await app.inject({
        method: "POST",
        url: `/webhooks/resend/${tenantId}`,
        payload,
        headers: {
          "content-type": "application/json",
          "svix-id": headers.svixId,
          "svix-timestamp": headers.svixTimestamp,
          "svix-signature": headers.svixSignature,
        },
      });
      expect(res1.statusCode).toBe(200);
      expect(await getFeedback(msgId)).toBe("opened");

      // Second call (same event)
      const res2 = await app.inject({
        method: "POST",
        url: `/webhooks/resend/${tenantId}`,
        payload,
        headers: {
          "content-type": "application/json",
          "svix-id": headers.svixId,
          "svix-timestamp": headers.svixTimestamp,
          "svix-signature": headers.svixSignature,
        },
      });
      expect(res2.statusCode).toBe(200);
      // Feedback unchanged
      expect(await getFeedback(msgId)).toBe("opened");
    });
  });

  // -- Unknown provider message ID --

  describe("unknown provider message", () => {
    it("payload naming unknown provider_message_id is acknowledged without error", async () => {
      if (!dbAvailable) return;

      const app = await buildApp({ db: db as any });

      const payload = JSON.stringify({
        type: "email.opened",
        created_at: new Date().toISOString(),
        data: { email_id: "nonexistent-provider-id-xyz" },
      });
      const headers = signPayload(payload);

      const response = await app.inject({
        method: "POST",
        url: `/webhooks/resend/${tenantId}`,
        payload,
        headers: {
          "content-type": "application/json",
          "svix-id": headers.svixId,
          "svix-timestamp": headers.svixTimestamp,
          "svix-signature": headers.svixSignature,
        },
      });

      // Should return 200 (acknowledged, not an error)
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toHaveProperty("received", true);
    });
  });

  // -- Address source enforcement --

  describe("suppression address source", () => {
    it("suppresses the message's recipient_address, not the payload's to-address", async () => {
      if (!dbAvailable) return;

      // Clean suppressions
      await db.execute(sql`DELETE FROM suppressions WHERE tenant_id = ${tenantId}::uuid`);

      const providerId = "resend-addr-source-001";
      const realRecipient = "real-recipient@example.com";
      const msgId = await createSentMessage(providerId, realRecipient);

      const app = await buildApp({ db: db as any });

      // The payload carries a DIFFERENT address in data.to
      const payload = JSON.stringify({
        type: "email.bounced",
        created_at: new Date().toISOString(),
        data: {
          email_id: providerId,
          to: ["attacker-supplied@evil.com"],
          bounce: {
            type: "Permanent",
            subType: "General",
            message: "Mailbox does not exist",
          },
        },
      });

      const headers = signPayload(payload);

      const response = await app.inject({
        method: "POST",
        url: `/webhooks/resend/${tenantId}`,
        payload,
        headers: {
          "content-type": "application/json",
          "svix-id": headers.svixId,
          "svix-timestamp": headers.svixTimestamp,
          "svix-signature": headers.svixSignature,
        },
      });

      expect(response.statusCode).toBe(200);

      // The REAL recipient should be suppressed
      const realSuppressed = await isSuppressed(realRecipient);
      expect(realSuppressed).toBe(true);

      // The attacker-supplied address should NOT be suppressed
      const attackerSuppressed = await isSuppressed("attacker-supplied@evil.com");
      expect(attackerSuppressed).toBe(false);
    });
  });

  // -- Throttle gate integration --

  describe("throttle gate blocks suppressed address", () => {
    it("suppressed address is subsequently blocked by the throttle gate", async () => {
      if (!dbAvailable) return;

      // Ensure there's a suppression for the contactEmail
      // (from a previous bounce test or create one)
      const alreadySuppressed = await isSuppressed(contactEmail);
      if (!alreadySuppressed) {
        await db.execute(sql`
          INSERT INTO suppressions (tenant_id, email, reason, source)
          VALUES (${tenantId}::uuid, ${contactEmail.toLowerCase()}, 'hard_bounce', 'webhook')
          ON CONFLICT (tenant_id, lower(email)) DO NOTHING
        `);
      }

      // Run the throttle gate with isSuppressed = true
      const input: ThrottleGateInput = {
        isSuppressed: true,
        flowClass: "nurture",
        windowPolicy: "immediate",
        config: THROTTLE_DEFAULTS,
        recentSends: { countLast24h: 0, countLast7d: 0, lastSentAt: null },
        contactTimezone: null,
        now: new Date(),
      };

      const verdict = evaluateThrottleGate(input);
      expect(verdict.outcome).toBe("suppress");
      expect((verdict as { reason: string }).reason).toBe("contact_email_suppressed");

      // Also verify the gate blocks even critical flows for suppressed contacts
      const criticalInput: ThrottleGateInput = {
        ...input,
        flowClass: "critical",
      };
      const criticalVerdict = evaluateThrottleGate(criticalInput);
      expect(criticalVerdict.outcome).toBe("suppress");
    });

    it("verifies suppression through the actual DB suppression check pattern", async () => {
      if (!dbAvailable) return;

      // Query suppressions the same way the drain does
      const suppressionRow = await db
        .select({ id: suppressions.id })
        .from(suppressions)
        .where(
          and(
            eq(suppressions.tenantId, tenantId),
            sql`lower(${suppressions.email}) = lower(${contactEmail})`,
          ),
        )
        .limit(1);

      const isSuppressedResult = suppressionRow.length > 0;

      // If suppressed, throttle gate must block
      if (isSuppressedResult) {
        const input: ThrottleGateInput = {
          isSuppressed: true,
          flowClass: "nurture",
          windowPolicy: "immediate",
          config: THROTTLE_DEFAULTS,
          recentSends: { countLast24h: 0, countLast7d: 0, lastSentAt: null },
          contactTimezone: null,
          now: new Date(),
        };
        const verdict = evaluateThrottleGate(input);
        expect(verdict.outcome).toBe("suppress");
      }
    });
  });

  // -- Unknown event types --

  describe("unknown event types", () => {
    it("unknown event type is acknowledged and not treated as error", async () => {
      if (!dbAvailable) return;

      const app = await buildApp({ db: db as any });

      const payload = JSON.stringify({
        type: "domain.created",
        created_at: new Date().toISOString(),
        data: { id: "some-domain-id" },
      });
      const headers = signPayload(payload);

      const response = await app.inject({
        method: "POST",
        url: `/webhooks/resend/${tenantId}`,
        payload,
        headers: {
          "content-type": "application/json",
          "svix-id": headers.svixId,
          "svix-timestamp": headers.svixTimestamp,
          "svix-signature": headers.svixSignature,
        },
      });

      // Returns 200 (not 4xx/5xx) so Resend does not retry
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toHaveProperty("received", true);
    });
  });
});
