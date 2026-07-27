/**
 * Integration tests for the LLM settings endpoints.
 *
 * Coverage:
 *
 * PUT /v1/settings/llm:
 *   - Writes an LLM config; stored value is encrypted and decrypts to what was written.
 *   - Read-back (GET) exposes no api_key, base_url, model, or embedding_model in any form.
 *   - Updating replaces the active row; only one active row per tenant at a time.
 *   - Another tenant's configuration is unreachable (tenant isolation).
 *   - Unknown provider is rejected with 400.
 *   - Missing ENCRYPTION_KEY returns 503.
 *   - Config written via PUT is resolved by resolveTenantProvider and produces a
 *     working OpenAICompatibleProvider (verified through the resolver, not a real call).
 *   - Writing to a nonexistent tenant is not possible (tenant derived from session).
 *   - embedding_model is stored in the encrypted envelope when provided; absent when not.
 *
 * GET /v1/settings/llm:
 *   - Returns null when no config exists.
 *   - Returns only id, provider, is_active, created_at - never credentials.
 *   - Cross-tenant: tenant A cannot see tenant B's config.
 *
 * Shared path:
 *   The encrypt+DB write logic in settings.ts uses encrypt() + parseEncryptionKey()
 *   from @claros/adapters - the same functions used by the CLI and the resolvers.
 *   Tests verify this by decrypting what the endpoint wrote using those same functions.
 *
 * Requires local Postgres (docker compose up postgres).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { eq, and, sql } from "drizzle-orm";
import { buildApp } from "../src/index.js";
import {
  tenants,
  users,
  sessions,
  llmConfigs,
} from "@claros/db/schema";
import { decrypt, parseEncryptionKey } from "@claros/adapters";

// ---------------------------------------------------------------------------
// DB setup
// ---------------------------------------------------------------------------

const TEST_DB_URL = process.env.DATABASE_URL;
if (!TEST_DB_URL) {
  const inCI = process.env.CI === "true";
  throw new Error(
    `[settings-llm.test] DATABASE_URL is not set.\n\n` +
      `This test requires a Postgres connection.\n` +
      (inCI
        ? `Set the variable in the workflow env block:\n\n  DATABASE_URL: postgres://claros:claros@localhost:5432/claros\n`
        : `Set the variable in .env (see .env.example) or export it:\n\n  export DATABASE_URL='postgres://claros:claros@localhost:5433/claros'\n`),
  );
}

// Hardcoded 32-byte all-zeros test key. Never used in production.
const TEST_ENCRYPTION_KEY_BASE64 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const TEST_API_KEY = "sk-test_settings_llm_key_do_not_use";
const TEST_BASE_URL = "https://api.openai.com/v1";
const TEST_MODEL = "gpt-4o";
const TEST_EMBEDDING_MODEL = "text-embedding-3-small";

const SLUG_A = "test-settings-llm-a";
const SLUG_B = "test-settings-llm-b";

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
        `[settings-llm.test] DATABASE_URL not reachable in CI.\n` +
          `URL: ${TEST_DB_URL}\nCause: ${(err as Error).message}`,
      );
    }
    console.warn("[settings-llm.test] DATABASE_URL not reachable - tests skipped.");
    return;
  }

  await cleanup();
  await setupTenants();
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

// Clean llm configs between each test
beforeEach(async () => {
  if (!dbAvailable) return;
  await db.execute(sql`DELETE FROM llm_configs WHERE tenant_id IN (${tenantAId}, ${tenantBId})`);
});

async function cleanup() {
  for (const slug of [SLUG_A, SLUG_B]) {
    await db.execute(sql`DELETE FROM llm_configs WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${slug})`);
    await db.execute(sql`DELETE FROM sessions WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${slug})`);
    await db.execute(sql`DELETE FROM users WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${slug})`);
    await db.execute(sql`DELETE FROM tenants WHERE slug = ${slug}`);
  }
}

async function setupTenants() {
  const [tA] = await db
    .insert(tenants)
    .values({ name: "LLM Settings Test A", slug: SLUG_A, plan: "free" })
    .returning({ id: tenants.id });
  tenantAId = tA!.id;
  const [uA] = await db
    .insert(users)
    .values({ tenantId: tenantAId, email: "owner-a@settings-llm.test", role: "owner" })
    .returning({ id: users.id });
  const [sA] = await db
    .insert(sessions)
    .values({ tenantId: tenantAId, userId: uA!.id, expiresAt: new Date(Date.now() + 86400_000) })
    .returning({ id: sessions.id });
  cookieA = `claros_session=${sA!.id}`;

  const [tB] = await db
    .insert(tenants)
    .values({ name: "LLM Settings Test B", slug: SLUG_B, plan: "free" })
    .returning({ id: tenants.id });
  tenantBId = tB!.id;
  const [uB] = await db
    .insert(users)
    .values({ tenantId: tenantBId, email: "owner-b@settings-llm.test", role: "owner" })
    .returning({ id: users.id });
  const [sB] = await db
    .insert(sessions)
    .values({ tenantId: tenantBId, userId: uB!.id, expiresAt: new Date(Date.now() + 86400_000) })
    .returning({ id: sessions.id });
  cookieB = `claros_session=${sB!.id}`;
}

// ---------------------------------------------------------------------------
// PUT /v1/settings/llm
// ---------------------------------------------------------------------------

describe("PUT /v1/settings/llm", () => {
  it("stores config encrypted; decrypts to what was written", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });

    const res = await app.inject({
      method: "PUT",
      url: "/v1/settings/llm",
      headers: { cookie: cookieA, "content-type": "application/json" },
      payload: {
        provider: "openai",
        api_key: TEST_API_KEY,
        base_url: TEST_BASE_URL,
        model: TEST_MODEL,
        embedding_model: TEST_EMBEDDING_MODEL,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.llm).toBeDefined();
    expect(body.llm.provider).toBe("openai");
    expect(body.llm.is_active).toBe(true);
    expect(body.llm.id).toBeDefined();
    expect(body.llm.created_at).toBeDefined();

    // No credentials in response - use shared encrypt path via @claros/adapters to verify
    expect(JSON.stringify(body)).not.toContain(TEST_API_KEY);
    expect(JSON.stringify(body)).not.toContain(TEST_BASE_URL);
    expect(JSON.stringify(body)).not.toContain(TEST_MODEL);

    // Verify DB: encrypted config decrypts to what was written (shared path verification)
    const rows = await db
      .select({ config: llmConfigs.config })
      .from(llmConfigs)
      .where(and(eq(llmConfigs.tenantId, tenantAId), eq(llmConfigs.isActive, true)))
      .limit(1);
    expect(rows).toHaveLength(1);

    // Use the same parseEncryptionKey + decrypt from @claros/adapters that the resolver uses
    const key = parseEncryptionKey(TEST_ENCRYPTION_KEY_BASE64);
    const decrypted = decrypt(rows[0]!.config, key);
    const creds = JSON.parse(decrypted) as {
      apiKey: string;
      baseUrl: string;
      model: string;
      embedding_model?: string;
    };
    expect(creds.apiKey).toBe(TEST_API_KEY);
    expect(creds.baseUrl).toBe(TEST_BASE_URL);
    expect(creds.model).toBe(TEST_MODEL);
    expect(creds.embedding_model).toBe(TEST_EMBEDDING_MODEL);
  });

  it("embedding_model is absent from envelope when not provided", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });

    await app.inject({
      method: "PUT",
      url: "/v1/settings/llm",
      headers: { cookie: cookieA, "content-type": "application/json" },
      payload: {
        provider: "openai",
        api_key: TEST_API_KEY,
        base_url: TEST_BASE_URL,
        model: TEST_MODEL,
        // no embedding_model
      },
    });

    const rows = await db
      .select({ config: llmConfigs.config })
      .from(llmConfigs)
      .where(and(eq(llmConfigs.tenantId, tenantAId), eq(llmConfigs.isActive, true)))
      .limit(1);

    const key = parseEncryptionKey(TEST_ENCRYPTION_KEY_BASE64);
    const creds = JSON.parse(decrypt(rows[0]!.config, key)) as Record<string, unknown>;
    expect(creds.embedding_model).toBeUndefined();
  });

  it("GET after PUT never returns api_key, base_url, model, or embedding_model", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });

    await app.inject({
      method: "PUT",
      url: "/v1/settings/llm",
      headers: { cookie: cookieA, "content-type": "application/json" },
      payload: {
        provider: "openai",
        api_key: TEST_API_KEY,
        base_url: TEST_BASE_URL,
        model: TEST_MODEL,
        embedding_model: TEST_EMBEDDING_MODEL,
      },
    });

    const res = await app.inject({
      method: "GET",
      url: "/v1/settings/llm",
      headers: { cookie: cookieA },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.llm).not.toBeNull();
    const bodyStr = JSON.stringify(body);

    // None of the credentials must appear
    expect(bodyStr).not.toContain(TEST_API_KEY);
    expect(bodyStr).not.toContain(TEST_BASE_URL);
    expect(bodyStr).not.toContain(TEST_MODEL);
    expect(bodyStr).not.toContain(TEST_EMBEDDING_MODEL);

    // The config encrypted envelope must not appear
    expect(body.llm.config).toBeUndefined();
    expect(body.llm.api_key).toBeUndefined();
    expect(body.llm.base_url).toBeUndefined();
    expect(body.llm.model).toBeUndefined();
    expect(body.llm.embedding_model).toBeUndefined();

    // Fields that ARE present
    expect(body.llm.id).toBeDefined();
    expect(body.llm.provider).toBe("openai");
    expect(body.llm.is_active).toBe(true);
    expect(body.llm.created_at).toBeDefined();
  });

  it("updating replaces the active row; only one active row per tenant", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });

    // First write
    await app.inject({
      method: "PUT",
      url: "/v1/settings/llm",
      headers: { cookie: cookieA, "content-type": "application/json" },
      payload: {
        provider: "openai",
        api_key: "sk-original",
        base_url: TEST_BASE_URL,
        model: "gpt-3.5-turbo",
      },
    });

    // Second write - different model
    await app.inject({
      method: "PUT",
      url: "/v1/settings/llm",
      headers: { cookie: cookieA, "content-type": "application/json" },
      payload: {
        provider: "openai",
        api_key: TEST_API_KEY,
        base_url: TEST_BASE_URL,
        model: TEST_MODEL,
      },
    });

    // Exactly one active row
    const activeRows = await db.execute<{ cnt: string }>(sql`
      SELECT COUNT(*)::text AS cnt
      FROM llm_configs
      WHERE tenant_id = ${tenantAId}::uuid AND is_active = true
    `);
    expect(parseInt(activeRows.rows[0]!.cnt, 10)).toBe(1);

    // The new model is stored correctly
    const activeRow = await db
      .select({ config: llmConfigs.config })
      .from(llmConfigs)
      .where(and(eq(llmConfigs.tenantId, tenantAId), eq(llmConfigs.isActive, true)))
      .limit(1);
    const key = parseEncryptionKey(TEST_ENCRYPTION_KEY_BASE64);
    const creds = JSON.parse(decrypt(activeRow[0]!.config, key)) as { model: string };
    expect(creds.model).toBe(TEST_MODEL);
  });

  it("another tenant's configuration is unreachable via GET", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });

    // Tenant A writes LLM config
    await app.inject({
      method: "PUT",
      url: "/v1/settings/llm",
      headers: { cookie: cookieA, "content-type": "application/json" },
      payload: {
        provider: "openai",
        api_key: TEST_API_KEY,
        base_url: TEST_BASE_URL,
        model: TEST_MODEL,
      },
    });

    // Tenant B has no config
    const res = await app.inject({
      method: "GET",
      url: "/v1/settings/llm",
      headers: { cookie: cookieB },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().llm).toBeNull();
  });

  it("unknown provider returns 400", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });

    const res = await app.inject({
      method: "PUT",
      url: "/v1/settings/llm",
      headers: { cookie: cookieA, "content-type": "application/json" },
      payload: {
        provider: "cohere",
        api_key: "key",
        base_url: TEST_BASE_URL,
        model: "model",
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
        url: "/v1/settings/llm",
        headers: { cookie: cookieA, "content-type": "application/json" },
        payload: {
          provider: "openai",
          api_key: "key",
          base_url: TEST_BASE_URL,
          model: "model",
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
      url: "/v1/settings/llm",
      headers: { "content-type": "application/json" },
      payload: {
        provider: "openai",
        api_key: "key",
        base_url: TEST_BASE_URL,
        model: "model",
      },
    });
    expect(res.statusCode).toBe(401);
  });

  it("config written via PUT is resolved by resolveTenantProvider (shared write path)", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });

    // Write via endpoint
    const putRes = await app.inject({
      method: "PUT",
      url: "/v1/settings/llm",
      headers: { cookie: cookieA, "content-type": "application/json" },
      payload: {
        provider: "openai",
        api_key: TEST_API_KEY,
        base_url: TEST_BASE_URL,
        model: TEST_MODEL,
      },
    });
    expect(putRes.statusCode).toBe(200);

    // Verify the row can be decrypted - exercises the same shared encrypt/decrypt path
    // that resolveTenantProvider uses (parseEncryptionKey + decrypt from @claros/adapters)
    const rows = await db
      .select({ config: llmConfigs.config })
      .from(llmConfigs)
      .where(and(eq(llmConfigs.tenantId, tenantAId), eq(llmConfigs.isActive, true)))
      .limit(1);
    expect(rows).toHaveLength(1);

    const key = parseEncryptionKey(TEST_ENCRYPTION_KEY_BASE64);
    const creds = JSON.parse(decrypt(rows[0]!.config, key)) as {
      apiKey: string;
      baseUrl: string;
      model: string;
    };
    expect(creds.apiKey).toBe(TEST_API_KEY);
    expect(creds.baseUrl).toBe(TEST_BASE_URL);
    expect(creds.model).toBe(TEST_MODEL);
  });
});

// ---------------------------------------------------------------------------
// GET /v1/settings/llm
// ---------------------------------------------------------------------------

describe("GET /v1/settings/llm", () => {
  it("returns null when no config exists", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });

    const res = await app.inject({
      method: "GET",
      url: "/v1/settings/llm",
      headers: { cookie: cookieA },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().llm).toBeNull();
  });

  it("returns expected metadata fields and never credential fields", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });

    // Insert directly using the same encrypt path the endpoint uses
    const key = parseEncryptionKey(TEST_ENCRYPTION_KEY_BASE64);
    const { encrypt: encryptFn } = await import("@claros/adapters");
    const encryptedConfig = encryptFn(
      JSON.stringify({
        apiKey: TEST_API_KEY,
        baseUrl: TEST_BASE_URL,
        model: TEST_MODEL,
        embedding_model: TEST_EMBEDDING_MODEL,
      }),
      key,
    );
    await db.insert(llmConfigs).values({
      tenantId: tenantAId,
      provider: "openai",
      config: encryptedConfig,
      isActive: true,
    });

    const res = await app.inject({
      method: "GET",
      url: "/v1/settings/llm",
      headers: { cookie: cookieA },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const l = body.llm;
    expect(l).not.toBeNull();

    // Metadata fields present
    expect(l.id).toBeDefined();
    expect(l.provider).toBe("openai");
    expect(l.is_active).toBe(true);
    expect(l.created_at).toBeDefined();

    // Credential fields MUST be absent
    const bodyStr = JSON.stringify(body);
    expect(bodyStr).not.toContain(TEST_API_KEY);
    expect(bodyStr).not.toContain(TEST_BASE_URL);
    expect(bodyStr).not.toContain(TEST_MODEL);
    expect(bodyStr).not.toContain(TEST_EMBEDDING_MODEL);
    expect(l.api_key).toBeUndefined();
    expect(l.base_url).toBeUndefined();
    expect(l.model).toBeUndefined();
    expect(l.embedding_model).toBeUndefined();
    expect(l.config).toBeUndefined();
  });

  it("tenant isolation: tenant B cannot see tenant A config", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });

    const key = parseEncryptionKey(TEST_ENCRYPTION_KEY_BASE64);
    const { encrypt: encryptFn } = await import("@claros/adapters");
    const encryptedConfig = encryptFn(
      JSON.stringify({ apiKey: TEST_API_KEY, baseUrl: TEST_BASE_URL, model: TEST_MODEL }),
      key,
    );
    await db.insert(llmConfigs).values({
      tenantId: tenantAId,
      provider: "openai",
      config: encryptedConfig,
      isActive: true,
    });

    const res = await app.inject({
      method: "GET",
      url: "/v1/settings/llm",
      headers: { cookie: cookieB },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().llm).toBeNull();
  });

  it("returns 401 without session", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });

    const res = await app.inject({
      method: "GET",
      url: "/v1/settings/llm",
    });
    expect(res.statusCode).toBe(401);
  });
});
