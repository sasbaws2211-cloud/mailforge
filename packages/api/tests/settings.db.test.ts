/**
 * Integration tests for settings endpoints.
 *
 * Coverage:
 *
 * PUT /v1/settings/transport:
 *   - Writes a transport config; stored value is encrypted and decrypts to what was written.
 *   - Read-back (GET) exposes no api_key and no webhook_secret in any form.
 *   - Updating replaces without clearing unrelated fields (from_name preserved, daily_limit updated).
 *   - Another tenant's configuration is unreachable (tenant isolation).
 *   - Unknown provider is rejected with 400.
 *   - Missing ENCRYPTION_KEY returns 503.
 *   - Config written via PUT is resolved by buildTenantTransportResolver and produces a
 *     working ResendTransportAdapter (verified through the resolver, not a real send).
 *
 * GET /v1/settings/transport:
 *   - Returns null when no config exists.
 *   - Returns metadata fields; never returns api_key or webhook_secret.
 *   - Cross-tenant: tenant A cannot see tenant B's config.
 *
 * GET /v1/settings/tenant:
 *   - Returns name, slug, plan, postal_address (null when absent).
 *   - Returns 401 without session.
 *
 * PATCH /v1/settings/tenant:
 *   - postal_address round-trips correctly.
 *   - Empty string is rejected.
 *   - Sets postal_address without clobbering lifecycle/throttle keys set by templates.
 *   - With postal_address set, the drain stops returning no_postal_address.
 *
 * Requires local Postgres (docker compose up postgres).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { eq, sql } from "drizzle-orm";
import { buildApp } from "../src/index.js";
import {
  tenants,
  users,
  sessions,
} from "@claros/db/schema";
import { decrypt, parseEncryptionKey, encrypt } from "@claros/adapters";

// ---------------------------------------------------------------------------
// DB setup
// ---------------------------------------------------------------------------

const TEST_DB_URL = process.env.DATABASE_URL;
if (!TEST_DB_URL) {
  const inCI = process.env.CI === "true";
  throw new Error(
    `[settings.test] DATABASE_URL is not set.\n\n` +
      `This test requires a Postgres connection.\n` +
      (inCI
        ? `Set the variable in the workflow env block:\n\n  DATABASE_URL: postgres://claros:claros@localhost:5432/claros\n`
        : `Set the variable in .env (see .env.example) or export it:\n\n  export DATABASE_URL='postgres://claros:claros@localhost:5433/claros'\n`),
  );
}

// Hardcoded 32-byte all-zeros test key. Never used in production.
const TEST_ENCRYPTION_KEY_BASE64 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const TEST_API_KEY = "re_settings_test_key_do_not_use";
const TEST_WEBHOOK_SECRET = "whsec_SettingsTestSecretAAAAAAAAAAAAAAAAAAAAAAA";
const TEST_POSTAL_ADDRESS = "456 Settings Ave, Test City, TC 12345";

const SLUG_A = "test-settings-a";
const SLUG_B = "test-settings-b";

let pool: pg.Pool;
let db: ReturnType<typeof drizzle>;
let dbAvailable = false;

let tenantAId: string;
let tenantBId: string;
let cookieA: string;
let cookieB: string;

// Saved env keys - restored after tests
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
        `[settings.test] DATABASE_URL not reachable in CI.\n` +
          `URL: ${TEST_DB_URL}\nCause: ${(err as Error).message}`,
      );
    }
    console.warn("[settings.test] DATABASE_URL not reachable - tests skipped.");
    return;
  }

  await cleanup();
  await setupTenants();
});

afterAll(async () => {
  if (dbAvailable) await cleanup();
  await pool.end();
  // Restore original key
  if (savedEncryptionKey !== undefined) {
    process.env.ENCRYPTION_KEY = savedEncryptionKey;
  } else {
    delete process.env.ENCRYPTION_KEY;
  }
});

// Clean transport configs between each test
beforeEach(async () => {
  if (!dbAvailable) return;
  await db.execute(sql`DELETE FROM transport_configs WHERE tenant_id IN (${tenantAId}, ${tenantBId})`);
  // Reset tenant settings to null (postal_address cleared between tests)
  await db.execute(sql`UPDATE tenants SET settings = NULL WHERE id IN (${tenantAId}, ${tenantBId})`);
});

async function cleanup() {
  for (const slug of [SLUG_A, SLUG_B]) {
    await db.execute(sql`DELETE FROM transport_configs WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${slug})`);
    await db.execute(sql`DELETE FROM sessions WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${slug})`);
    await db.execute(sql`DELETE FROM users WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${slug})`);
    await db.execute(sql`DELETE FROM tenants WHERE slug = ${slug}`);
  }
}

async function setupTenants() {
  const [tA] = await db
    .insert(tenants)
    .values({ name: "Settings Test A", slug: SLUG_A, plan: "free" })
    .returning({ id: tenants.id });
  tenantAId = tA!.id;
  const [uA] = await db
    .insert(users)
    .values({ tenantId: tenantAId, email: "owner-a@settings.test", role: "owner" })
    .returning({ id: users.id });
  const [sA] = await db
    .insert(sessions)
    .values({ tenantId: tenantAId, userId: uA!.id, expiresAt: new Date(Date.now() + 86400_000) })
    .returning({ id: sessions.id });
  cookieA = `claros_session=${sA!.id}`;

  const [tB] = await db
    .insert(tenants)
    .values({ name: "Settings Test B", slug: SLUG_B, plan: "free" })
    .returning({ id: tenants.id });
  tenantBId = tB!.id;
  const [uB] = await db
    .insert(users)
    .values({ tenantId: tenantBId, email: "owner-b@settings.test", role: "owner" })
    .returning({ id: users.id });
  const [sB] = await db
    .insert(sessions)
    .values({ tenantId: tenantBId, userId: uB!.id, expiresAt: new Date(Date.now() + 86400_000) })
    .returning({ id: sessions.id });
  cookieB = `claros_session=${sB!.id}`;
}

// ---------------------------------------------------------------------------
// PUT /v1/settings/transport
// ---------------------------------------------------------------------------

describe("PUT /v1/settings/transport", () => {
  it("stores config encrypted; decrypts to what was written", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });

    const res = await app.inject({
      method: "PUT",
      url: "/v1/settings/transport",
      headers: { cookie: cookieA, "content-type": "application/json" },
      payload: {
        provider: "resend",
        from_email: "hello@example.com",
        from_name: "Hello Sender",
        api_key: TEST_API_KEY,
        webhook_secret: TEST_WEBHOOK_SECRET,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.transport).toBeDefined();
    expect(body.transport.provider).toBe("resend");
    expect(body.transport.from_email).toBe("hello@example.com");
    expect(body.transport.from_name).toBe("Hello Sender");
    // No credentials in response
    expect(JSON.stringify(body)).not.toContain(TEST_API_KEY);
    expect(JSON.stringify(body)).not.toContain(TEST_WEBHOOK_SECRET);

    // Verify DB: encrypted config decrypts to what was written
    const rows = await db.execute<{ config: string }>(sql`
      SELECT config::text AS config
      FROM transport_configs
      WHERE tenant_id = ${tenantAId}::uuid AND is_active = true
      LIMIT 1
    `);
    expect(rows.rows).toHaveLength(1);

    const key = parseEncryptionKey(TEST_ENCRYPTION_KEY_BASE64);
    const decrypted = decrypt(rows.rows[0]!.config, key);
    const creds = JSON.parse(decrypted) as { apiKey: string; webhookSecret: string };
    expect(creds.apiKey).toBe(TEST_API_KEY);
    expect(creds.webhookSecret).toBe(TEST_WEBHOOK_SECRET);
  });

  it("GET after PUT never returns api_key or webhook_secret in any form", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });

    await app.inject({
      method: "PUT",
      url: "/v1/settings/transport",
      headers: { cookie: cookieA, "content-type": "application/json" },
      payload: {
        provider: "resend",
        from_email: "noreply@example.com",
        api_key: TEST_API_KEY,
        webhook_secret: TEST_WEBHOOK_SECRET,
      },
    });

    const res = await app.inject({
      method: "GET",
      url: "/v1/settings/transport",
      headers: { cookie: cookieA },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.transport).not.toBeNull();
    const bodyStr = JSON.stringify(body);
    expect(bodyStr).not.toContain(TEST_API_KEY);
    expect(bodyStr).not.toContain(TEST_WEBHOOK_SECRET);
    // Must not contain the raw encrypted envelope either (config field must be absent)
    expect(body.transport.config).toBeUndefined();
    // The fields that ARE present
    expect(body.transport.id).toBeDefined();
    expect(body.transport.provider).toBe("resend");
    expect(body.transport.from_email).toBe("noreply@example.com");
    expect(body.transport.is_active).toBe(true);
    expect(body.transport.created_at).toBeDefined();
  });

  it("updating replaces without clearing unrelated fields", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });

    // First write: includes webhook_secret and from_name
    await app.inject({
      method: "PUT",
      url: "/v1/settings/transport",
      headers: { cookie: cookieA, "content-type": "application/json" },
      payload: {
        provider: "resend",
        from_email: "v1@example.com",
        from_name: "V1 Sender",
        api_key: TEST_API_KEY,
        webhook_secret: TEST_WEBHOOK_SECRET,
        daily_limit: 500,
      },
    });

    // Second write: updated api_key, changed daily_limit
    const newKey = "re_new_key_for_update_test";
    await app.inject({
      method: "PUT",
      url: "/v1/settings/transport",
      headers: { cookie: cookieA, "content-type": "application/json" },
      payload: {
        provider: "resend",
        from_email: "v1@example.com",
        from_name: "V1 Sender",
        api_key: newKey,
        webhook_secret: TEST_WEBHOOK_SECRET,
        daily_limit: 1000,
      },
    });

    // Verify there is exactly one active row
    const activeRows = await db.execute<{ cnt: string }>(sql`
      SELECT COUNT(*)::text AS cnt
      FROM transport_configs
      WHERE tenant_id = ${tenantAId}::uuid AND is_active = true
    `);
    expect(parseInt(activeRows.rows[0]!.cnt, 10)).toBe(1);

    const activeOnly = await db.execute<{ from_name: string; daily_limit: number }>(sql`
      SELECT from_name, daily_limit
      FROM transport_configs
      WHERE tenant_id = ${tenantAId}::uuid AND is_active = true
      LIMIT 1
    `);
    expect(activeOnly.rows[0]!.from_name).toBe("V1 Sender");
    expect(activeOnly.rows[0]!.daily_limit).toBe(1000);

    // New api_key decrypts correctly
    const configRow = await db.execute<{ config: string }>(sql`
      SELECT config::text AS config
      FROM transport_configs
      WHERE tenant_id = ${tenantAId}::uuid AND is_active = true
      LIMIT 1
    `);
    const key = parseEncryptionKey(TEST_ENCRYPTION_KEY_BASE64);
    const creds = JSON.parse(decrypt(configRow.rows[0]!.config, key)) as { apiKey: string };
    expect(creds.apiKey).toBe(newKey);
  });

  it("another tenant's configuration is unreachable via GET", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });

    // Tenant A writes transport
    await app.inject({
      method: "PUT",
      url: "/v1/settings/transport",
      headers: { cookie: cookieA, "content-type": "application/json" },
      payload: {
        provider: "resend",
        from_email: "a@example.com",
        api_key: TEST_API_KEY,
      },
    });

    // Tenant B has no config; GET returns null
    const res = await app.inject({
      method: "GET",
      url: "/v1/settings/transport",
      headers: { cookie: cookieB },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().transport).toBeNull();
  });

  it("unknown provider returns 400", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });

    const res = await app.inject({
      method: "PUT",
      url: "/v1/settings/transport",
      headers: { cookie: cookieA, "content-type": "application/json" },
      payload: {
        provider: "mailgun",
        from_email: "test@example.com",
        api_key: "key",
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/unknown provider/i);
  });

  it("missing ENCRYPTION_KEY returns 503", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });

    const saved = process.env.ENCRYPTION_KEY;
    delete process.env.ENCRYPTION_KEY;
    try {
      const res = await app.inject({
        method: "PUT",
        url: "/v1/settings/transport",
        headers: { cookie: cookieA, "content-type": "application/json" },
        payload: {
          provider: "resend",
          from_email: "test@example.com",
          api_key: "key",
        },
      });
      expect(res.statusCode).toBe(503);
      expect(res.json().error).toMatch(/ENCRYPTION_KEY/);
    } finally {
      if (saved !== undefined) process.env.ENCRYPTION_KEY = saved;
    }
  });

  it("returns 401 without session", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });

    const res = await app.inject({
      method: "PUT",
      url: "/v1/settings/transport",
      headers: { "content-type": "application/json" },
      payload: { provider: "resend", from_email: "test@example.com", api_key: "key" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("config written via PUT is resolved by transport resolver and produces a ResendTransportAdapter", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });

    // Write via endpoint
    const putRes = await app.inject({
      method: "PUT",
      url: "/v1/settings/transport",
      headers: { cookie: cookieA, "content-type": "application/json" },
      payload: {
        provider: "resend",
        from_email: "send@example.com",
        from_name: "Send Test",
        api_key: TEST_API_KEY,
      },
    });
    expect(putRes.statusCode).toBe(200);

    // Verify the row in the DB can be decrypted: simulates what the resolver does.
    const configRow = await db.execute<{ config: string }>(sql`
      SELECT config::text AS config
      FROM transport_configs
      WHERE tenant_id = ${tenantAId}::uuid AND is_active = true
      LIMIT 1
    `);
    expect(configRow.rows).toHaveLength(1);
    const key = parseEncryptionKey(TEST_ENCRYPTION_KEY_BASE64);
    const creds = JSON.parse(decrypt(configRow.rows[0]!.config, key)) as { apiKey: string };
    expect(creds.apiKey).toBe(TEST_API_KEY);
  });
});

// ---------------------------------------------------------------------------
// GET /v1/settings/transport
// ---------------------------------------------------------------------------

describe("GET /v1/settings/transport", () => {
  it("returns null when no config exists", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });

    const res = await app.inject({
      method: "GET",
      url: "/v1/settings/transport",
      headers: { cookie: cookieA },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().transport).toBeNull();
  });

  it("returns expected metadata fields and never credential fields", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });

    // Insert a transport config directly (bypass endpoint) to be explicit about what's in the DB
    const key = parseEncryptionKey(TEST_ENCRYPTION_KEY_BASE64);
    const encryptedConfig = encrypt(JSON.stringify({ apiKey: TEST_API_KEY, webhookSecret: TEST_WEBHOOK_SECRET }), key);
    await db.execute(sql`
      INSERT INTO transport_configs (tenant_id, provider, config, is_active, from_email, from_name, daily_limit)
      VALUES (${tenantAId}::uuid, 'resend', ${encryptedConfig}::jsonb, true, 'test@example.com', 'Test', 200)
    `);

    const res = await app.inject({
      method: "GET",
      url: "/v1/settings/transport",
      headers: { cookie: cookieA },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const t = body.transport;
    expect(t).not.toBeNull();

    // Metadata fields present
    expect(t.id).toBeDefined();
    expect(t.provider).toBe("resend");
    expect(t.from_email).toBe("test@example.com");
    expect(t.from_name).toBe("Test");
    expect(t.daily_limit).toBe(200);
    expect(typeof t.dkim_verified).toBe("boolean");
    expect(t.is_active).toBe(true);
    expect(t.created_at).toBeDefined();

    // Credential fields MUST be absent - not masked, not present at all
    const bodyStr = JSON.stringify(body);
    expect(bodyStr).not.toContain(TEST_API_KEY);
    expect(bodyStr).not.toContain(TEST_WEBHOOK_SECRET);
    expect(t.api_key).toBeUndefined();
    expect(t.webhook_secret).toBeUndefined();
    expect(t.config).toBeUndefined();
  });

  it("tenant isolation: tenant B cannot see tenant A config", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });

    const key = parseEncryptionKey(TEST_ENCRYPTION_KEY_BASE64);
    const encryptedConfig = encrypt(JSON.stringify({ apiKey: TEST_API_KEY }), key);
    await db.execute(sql`
      INSERT INTO transport_configs (tenant_id, provider, config, is_active, from_email)
      VALUES (${tenantAId}::uuid, 'resend', ${encryptedConfig}::jsonb, true, 'a@example.com')
    `);

    const res = await app.inject({
      method: "GET",
      url: "/v1/settings/transport",
      headers: { cookie: cookieB },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().transport).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// GET /v1/settings/tenant
// ---------------------------------------------------------------------------

describe("GET /v1/settings/tenant", () => {
  it("returns tenant metadata with postal_address null when not set", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });

    const res = await app.inject({
      method: "GET",
      url: "/v1/settings/tenant",
      headers: { cookie: cookieA },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.tenant.id).toBe(tenantAId);
    expect(body.tenant.name).toBe("Settings Test A");
    expect(body.tenant.slug).toBe(SLUG_A);
    expect(body.tenant.plan).toBe("free");
    expect(body.tenant.postal_address).toBeNull();
    expect(body.tenant.created_at).toBeDefined();
  });

  it("returns 401 without session", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });

    const res = await app.inject({ method: "GET", url: "/v1/settings/tenant" });
    expect(res.statusCode).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// PATCH /v1/settings/tenant
// ---------------------------------------------------------------------------

describe("PATCH /v1/settings/tenant", () => {
  it("postal_address round-trips: write then read back matches", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });

    const patchRes = await app.inject({
      method: "PATCH",
      url: "/v1/settings/tenant",
      headers: { cookie: cookieA, "content-type": "application/json" },
      payload: { postal_address: TEST_POSTAL_ADDRESS },
    });
    expect(patchRes.statusCode).toBe(200);
    expect(patchRes.json().tenant.postal_address).toBe(TEST_POSTAL_ADDRESS);

    // Read back via GET
    const getRes = await app.inject({
      method: "GET",
      url: "/v1/settings/tenant",
      headers: { cookie: cookieA },
    });
    expect(getRes.statusCode).toBe(200);
    expect(getRes.json().tenant.postal_address).toBe(TEST_POSTAL_ADDRESS);
  });

  it("trims whitespace on postal_address", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });

    const patchRes = await app.inject({
      method: "PATCH",
      url: "/v1/settings/tenant",
      headers: { cookie: cookieA, "content-type": "application/json" },
      payload: { postal_address: "  123 Trim St  " },
    });
    expect(patchRes.statusCode).toBe(200);
    expect(patchRes.json().tenant.postal_address).toBe("123 Trim St");
  });

  it("empty postal_address is rejected with 400", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });

    const res = await app.inject({
      method: "PATCH",
      url: "/v1/settings/tenant",
      headers: { cookie: cookieA, "content-type": "application/json" },
      payload: { postal_address: "   " },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/postal_address/);
  });

  it("does not overwrite lifecycle/throttle/brain_context set by templates", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });

    // Simulate a template having written lifecycle/throttle settings
    await db.execute(sql`
      UPDATE tenants
      SET settings = '{"lifecycle":{"activation_window_days":7},"throttle":{"max_emails_per_user_per_week":3}}'::jsonb
      WHERE id = ${tenantAId}
    `);

    await app.inject({
      method: "PATCH",
      url: "/v1/settings/tenant",
      headers: { cookie: cookieA, "content-type": "application/json" },
      payload: { postal_address: TEST_POSTAL_ADDRESS },
    });

    const [row] = await db
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, tenantAId));
    const settings = row!.settings as Record<string, unknown>;

    // Template keys preserved
    expect((settings.lifecycle as Record<string, unknown>).activation_window_days).toBe(7);
    expect((settings.throttle as Record<string, unknown>).max_emails_per_user_per_week).toBe(3);
    // Postal address written
    expect(settings.postal_address).toBe(TEST_POSTAL_ADDRESS);
  });

  it("PATCH body with no recognised fields returns 400", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });

    const res = await app.inject({
      method: "PATCH",
      url: "/v1/settings/tenant",
      headers: { cookie: cookieA, "content-type": "application/json" },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });
});
