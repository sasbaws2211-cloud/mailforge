/**
 * Event ingestion integration tests.
 *
 * Tests:
 * - POST /v1/track and POST /v1/identify happy paths
 * - Zod validation error responses
 * - Auth isolation: bearer token cannot reach dashboard, session cookie cannot reach ingest
 * - Revoked key rejection
 * - Missing/malformed Authorization header
 * - Contact upsert (find-or-create, last_seen_at update)
 *
 * Requires local Postgres (docker compose up postgres).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes, createHash } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { eq, sql, and } from "drizzle-orm";
import { buildApp, hashApiKey, SESSION_COOKIE_NAME, createIngestAuthPlugin } from "../src/index.js";
import {
  tenants,
  users,
  sessions,
  apiKeys,
  contacts,
  events,
} from "@mailforge/db/schema";

const TEST_DB_URL = process.env.DATABASE_URL;
if (!TEST_DB_URL) {
  const inCI = process.env.CI === "true";
  throw new Error(
    `[ingest.test] DATABASE_URL is not set.\n\n` +
    `This test requires a Postgres connection.\n` +
    (inCI
      ? `Set the variable in the workflow env block:\n\n  DATABASE_URL: postgres://mailforge:mailforge@localhost:5432/mailforge\n`
      : `Set the variable in .env (see .env.example) or export it:\n\n  export DATABASE_URL='postgres://mailforge:mailforge@localhost:5433/mailforge'\n`),
  );
}

let pool: pg.Pool;
let db: ReturnType<typeof drizzle>;
let dbAvailable = false;

let testTenantId: string;
let testUserId: string;
let rawApiKey: string;
let testApiKeyId: string;

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
        `[ingest.test] DATABASE_URL not reachable in CI.\n` +
          `URL: ${TEST_DB_URL}\n` +
          `Cause: ${(err as Error).message}`,
      );
    }
    console.warn(
      "[ingest.test] DATABASE_URL not reachable - integration tests will be skipped.",
    );
    return;
  }

  // Clean up test data from previous runs
  await db.execute(
    sql`DELETE FROM contact_conflicts WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = 'test-ingest')`,
  );
  await db.execute(
    sql`DELETE FROM events WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = 'test-ingest')`,
  );
  await db.execute(
    sql`DELETE FROM lifecycle_transitions WHERE contact_id IN (SELECT id FROM contacts WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = 'test-ingest'))`,
  );
  await db.execute(
    sql`DELETE FROM contacts WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = 'test-ingest')`,
  );
  await db.execute(
    sql`DELETE FROM api_keys WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = 'test-ingest')`,
  );
  await db.execute(
    sql`DELETE FROM sessions WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = 'test-ingest')`,
  );
  await db.execute(
    sql`DELETE FROM users WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = 'test-ingest')`,
  );
  await db.execute(sql`DELETE FROM tenants WHERE slug = 'test-ingest'`);

  // Create test tenant
  const [tenant] = await db
    .insert(tenants)
    .values({ name: "Test Ingest", slug: "test-ingest", plan: "free" })
    .returning({ id: tenants.id });
  testTenantId = tenant!.id;

  // Create test user (for session cookie tests)
  const [user] = await db
    .insert(users)
    .values({ tenantId: testTenantId, email: "ingest-test@example.com", role: "owner" })
    .returning({ id: users.id });
  testUserId = user!.id;

  // Create test API key
  rawApiKey = `mf_live_${randomBytes(32).toString("base64url")}`;
  const keyHash = hashApiKey(rawApiKey);
  const prefix = rawApiKey.slice(0, 8);
  const [apiKey] = await db
    .insert(apiKeys)
    .values({ tenantId: testTenantId, keyHash, prefix, label: "test key" })
    .returning({ id: apiKeys.id });
  testApiKeyId = apiKey!.id;
});

afterAll(async () => {
  if (!dbAvailable) {
    await pool.end();
    return;
  }
  // Clean up
  await db.execute(sql`DELETE FROM contact_conflicts WHERE tenant_id = ${testTenantId}`);
  await db.execute(sql`DELETE FROM events WHERE tenant_id = ${testTenantId}`);
  await db.execute(sql`DELETE FROM lifecycle_transitions WHERE contact_id IN (SELECT id FROM contacts WHERE tenant_id = ${testTenantId})`);
  await db.execute(sql`DELETE FROM contacts WHERE tenant_id = ${testTenantId}`);
  await db.execute(sql`DELETE FROM api_keys WHERE tenant_id = ${testTenantId}`);
  await db.execute(sql`DELETE FROM sessions WHERE tenant_id = ${testTenantId}`);
  await db.execute(sql`DELETE FROM users WHERE tenant_id = ${testTenantId}`);
  await db.execute(sql`DELETE FROM tenants WHERE id = ${testTenantId}`);
  await pool.end();
});

describe("database availability sentinel", () => {
  it("database unavailable: integration tests skipped", () => {
    if (dbAvailable) return;
    console.warn("[ingest.test] All DB integration tests skipped.");
    expect(true).toBe(true);
  });
});

describe("POST /v1/track", () => {
  it("returns 200 and inserts event for valid request", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ logger: false, db, baseUrl: "http://localhost:3000" });

    const res = await app.inject({
      method: "POST",
      url: "/v1/track",
      headers: { authorization: `Bearer ${rawApiKey}` },
      payload: {
        userId: "user_track_1",
        event: "project_created",
        properties: { project_name: "My App" },
        timestamp: "2026-07-23T10:00:00Z",
        context: { ip: "1.2.3.4" },
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);

    // Verify event was inserted
    const evts = await db
      .select()
      .from(events)
      .where(
        and(eq(events.tenantId, testTenantId), eq(events.eventName, "project_created")),
      );
    expect(evts.length).toBe(1);
    expect(evts[0]!.type).toBe("track");
    expect((evts[0]!.properties as Record<string, unknown>).project_name).toBe("My App");

    // Verify contact was created
    const cts = await db
      .select()
      .from(contacts)
      .where(
        and(eq(contacts.tenantId, testTenantId), eq(contacts.externalId, "user_track_1")),
      );
    expect(cts.length).toBe(1);
    expect(cts[0]!.lifecycleState).toBe("signed_up");

    await app.close();
  });

  it("defaults timestamp to now when not provided", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ logger: false, db, baseUrl: "http://localhost:3000" });
    const before = new Date();

    const res = await app.inject({
      method: "POST",
      url: "/v1/track",
      headers: { authorization: `Bearer ${rawApiKey}` },
      payload: { userId: "user_track_ts", event: "no_timestamp_event" },
    });

    expect(res.statusCode).toBe(200);
    const after = new Date();

    const evts = await db
      .select()
      .from(events)
      .where(
        and(
          eq(events.tenantId, testTenantId),
          eq(events.eventName, "no_timestamp_event"),
        ),
      );
    expect(evts.length).toBe(1);
    const ts = evts[0]!.timestamp;
    expect(ts.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
    expect(ts.getTime()).toBeLessThanOrEqual(after.getTime() + 1000);

    await app.close();
  });

  it("updates last_seen_at on subsequent events for the same contact", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ logger: false, db, baseUrl: "http://localhost:3000" });

    // First event creates contact
    await app.inject({
      method: "POST",
      url: "/v1/track",
      headers: { authorization: `Bearer ${rawApiKey}` },
      payload: { userId: "user_lastseen", event: "first_event" },
    });

    const [first] = await db
      .select({ lastSeenAt: contacts.lastSeenAt })
      .from(contacts)
      .where(
        and(
          eq(contacts.tenantId, testTenantId),
          eq(contacts.externalId, "user_lastseen"),
        ),
      );

    // Small delay to ensure timestamp differs
    await new Promise((r) => setTimeout(r, 50));

    // Second event updates last_seen_at
    await app.inject({
      method: "POST",
      url: "/v1/track",
      headers: { authorization: `Bearer ${rawApiKey}` },
      payload: { userId: "user_lastseen", event: "second_event" },
    });

    const [second] = await db
      .select({ lastSeenAt: contacts.lastSeenAt })
      .from(contacts)
      .where(
        and(
          eq(contacts.tenantId, testTenantId),
          eq(contacts.externalId, "user_lastseen"),
        ),
      );

    expect(second!.lastSeenAt!.getTime()).toBeGreaterThanOrEqual(
      first!.lastSeenAt!.getTime(),
    );

    await app.close();
  });

  it("repeated track for same userId creates one contact and multiple events", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ logger: false, db, baseUrl: "http://localhost:3000" });
    const userId = "user_repeated_track";

    // Send three track events for the same userId
    for (const eventName of ["evt_a", "evt_b", "evt_c"]) {
      const res = await app.inject({
        method: "POST",
        url: "/v1/track",
        headers: { authorization: `Bearer ${rawApiKey}` },
        payload: { userId, event: eventName },
      });
      expect(res.statusCode).toBe(200);
    }

    // Exactly one contact
    const cts = await db
      .select()
      .from(contacts)
      .where(
        and(eq(contacts.tenantId, testTenantId), eq(contacts.externalId, userId)),
      );
    expect(cts.length).toBe(1);

    // Exactly three events
    const evts = await db
      .select()
      .from(events)
      .where(and(eq(events.tenantId, testTenantId), eq(events.contactId, cts[0]!.id)));
    expect(evts.length).toBe(3);
    const names = evts.map((e) => e.eventName).sort();
    expect(names).toEqual(["evt_a", "evt_b", "evt_c"]);

    await app.close();
  });

  it("returns 400 for missing userId", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ logger: false, db, baseUrl: "http://localhost:3000" });

    const res = await app.inject({
      method: "POST",
      url: "/v1/track",
      headers: { authorization: `Bearer ${rawApiKey}` },
      payload: { event: "missing_user" },
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toBe("Validation failed");
    expect(body.issues.length).toBeGreaterThan(0);

    await app.close();
  });

  it("returns 400 for missing event name", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ logger: false, db, baseUrl: "http://localhost:3000" });

    const res = await app.inject({
      method: "POST",
      url: "/v1/track",
      headers: { authorization: `Bearer ${rawApiKey}` },
      payload: { userId: "user_no_event" },
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toBe("Validation failed");

    await app.close();
  });

  it("returns 400 for invalid timestamp format", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ logger: false, db, baseUrl: "http://localhost:3000" });

    const res = await app.inject({
      method: "POST",
      url: "/v1/track",
      headers: { authorization: `Bearer ${rawApiKey}` },
      payload: {
        userId: "user_bad_ts",
        event: "test",
        timestamp: "not-a-date",
      },
    });

    expect(res.statusCode).toBe(400);

    await app.close();
  });
});

describe("POST /v1/identify", () => {
  it("returns 200 and inserts identify event", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ logger: false, db, baseUrl: "http://localhost:3000" });

    const res = await app.inject({
      method: "POST",
      url: "/v1/identify",
      headers: { authorization: `Bearer ${rawApiKey}` },
      payload: {
        userId: "user_identify_1",
        traits: { email: "jane@example.com", name: "Jane Doe", plan: "pro" },
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);

    // Verify event was inserted as type=identify
    const evts = await db
      .select()
      .from(events)
      .where(and(eq(events.tenantId, testTenantId), eq(events.type, "identify")));
    expect(evts.length).toBeGreaterThanOrEqual(1);
    const latest = evts.find(
      (e) => (e.properties as Record<string, unknown>)?.email === "jane@example.com",
    );
    expect(latest).toBeDefined();
    expect(latest!.eventName).toBeNull();

    // Verify contact was created
    const cts = await db
      .select()
      .from(contacts)
      .where(
        and(
          eq(contacts.tenantId, testTenantId),
          eq(contacts.externalId, "user_identify_1"),
        ),
      );
    expect(cts.length).toBe(1);

    await app.close();
  });

  it("returns 400 for missing userId", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ logger: false, db, baseUrl: "http://localhost:3000" });

    const res = await app.inject({
      method: "POST",
      url: "/v1/identify",
      headers: { authorization: `Bearer ${rawApiKey}` },
      payload: { traits: { email: "no-user@example.com" } },
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toBe("Validation failed");

    await app.close();
  });

  it("accepts identify without traits (just userId)", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ logger: false, db, baseUrl: "http://localhost:3000" });

    const res = await app.inject({
      method: "POST",
      url: "/v1/identify",
      headers: { authorization: `Bearer ${rawApiKey}` },
      payload: { userId: "user_no_traits" },
    });

    expect(res.statusCode).toBe(200);

    await app.close();
  });
});

describe("authentication", () => {
  it("updates last_used_at on first request (throttled - once per 60s)", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ logger: false, db, baseUrl: "http://localhost:3000" });

    // Clear any existing last_used_at
    await db
      .update(apiKeys)
      .set({ lastUsedAt: null })
      .where(eq(apiKeys.id, testApiKeyId));

    await app.inject({
      method: "POST",
      url: "/v1/track",
      headers: { authorization: `Bearer ${rawApiKey}` },
      payload: { userId: "user_lastused", event: "check_lastused" },
    });

    // The update is fire-and-forget, give it a moment to settle
    await new Promise((r) => setTimeout(r, 100));

    const [after] = await db
      .select({ lastUsedAt: apiKeys.lastUsedAt })
      .from(apiKeys)
      .where(eq(apiKeys.id, testApiKeyId));

    expect(after!.lastUsedAt).not.toBeNull();

    await app.close();
  });

  it("throttles last_used_at writes - N rapid requests produce at most one write", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ logger: false, db, baseUrl: "http://localhost:3000" });

    // Set last_used_at to a known old value
    const oldTimestamp = new Date("2026-01-01T00:00:00Z");
    await db
      .update(apiKeys)
      .set({ lastUsedAt: oldTimestamp })
      .where(eq(apiKeys.id, testApiKeyId));

    // Send 10 rapid requests
    for (let i = 0; i < 10; i++) {
      await app.inject({
        method: "POST",
        url: "/v1/track",
        headers: { authorization: `Bearer ${rawApiKey}` },
        payload: { userId: "user_throttle", event: `rapid_${i}` },
      });
    }

    // Wait for fire-and-forget write to settle
    await new Promise((r) => setTimeout(r, 100));

    // last_used_at should have been updated exactly once (the first request
    // saw oldTimestamp which is >60s old, so it wrote; subsequent requests
    // within the same 60s window should NOT write)
    const [result] = await db
      .select({ lastUsedAt: apiKeys.lastUsedAt })
      .from(apiKeys)
      .where(eq(apiKeys.id, testApiKeyId));

    // It was updated from the old value
    expect(result!.lastUsedAt!.getTime()).toBeGreaterThan(oldTimestamp.getTime());

    // Record the timestamp after the burst
    const afterBurst = result!.lastUsedAt!;

    // Send 10 more rapid requests - these should NOT produce another write
    // because the in-memory cache says we wrote <60s ago
    for (let i = 0; i < 10; i++) {
      await app.inject({
        method: "POST",
        url: "/v1/track",
        headers: { authorization: `Bearer ${rawApiKey}` },
        payload: { userId: "user_throttle", event: `rapid2_${i}` },
      });
    }

    await new Promise((r) => setTimeout(r, 100));

    const [result2] = await db
      .select({ lastUsedAt: apiKeys.lastUsedAt })
      .from(apiKeys)
      .where(eq(apiKeys.id, testApiKeyId));

    // Timestamp should be unchanged - no second write occurred
    expect(result2!.lastUsedAt!.getTime()).toBe(afterBurst.getTime());

    await app.close();
  });

  it("returns 401 without Authorization header", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ logger: false, db, baseUrl: "http://localhost:3000" });

    const res = await app.inject({
      method: "POST",
      url: "/v1/track",
      payload: { userId: "u", event: "e" },
    });

    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.error).toContain("Authorization");

    await app.close();
  });

  it("returns 401 for invalid bearer token", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ logger: false, db, baseUrl: "http://localhost:3000" });

    const res = await app.inject({
      method: "POST",
      url: "/v1/track",
      headers: { authorization: "Bearer completely_invalid_key_here" },
      payload: { userId: "u", event: "e" },
    });

    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.error).toContain("Invalid or revoked");

    await app.close();
  });

  it("returns 401 for revoked API key", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ logger: false, db, baseUrl: "http://localhost:3000" });

    // Create a key and then revoke it
    const revokedRaw = `mf_live_${randomBytes(32).toString("base64url")}`;
    const revokedHash = hashApiKey(revokedRaw);
    await db.insert(apiKeys).values({
      tenantId: testTenantId,
      keyHash: revokedHash,
      prefix: revokedRaw.slice(0, 8),
      label: "revoked key",
      revokedAt: new Date(),
    });

    const res = await app.inject({
      method: "POST",
      url: "/v1/track",
      headers: { authorization: `Bearer ${revokedRaw}` },
      payload: { userId: "u", event: "e" },
    });

    expect(res.statusCode).toBe(401);

    await app.close();
  });

  it("returns 401 for 'Bearer ' with empty value", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ logger: false, db, baseUrl: "http://localhost:3000" });

    const res = await app.inject({
      method: "POST",
      url: "/v1/track",
      headers: { authorization: "Bearer " },
      payload: { userId: "u", event: "e" },
    });

    expect(res.statusCode).toBe(401);

    await app.close();
  });
});

describe("auth isolation", () => {
  it("session cookie CANNOT reach ingest routes", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ logger: false, db, baseUrl: "http://localhost:3000" });

    // Create a valid session
    const futureExpiry = new Date(Date.now() + 86400000);
    const [session] = await db
      .insert(sessions)
      .values({ tenantId: testTenantId, userId: testUserId, expiresAt: futureExpiry })
      .returning({ id: sessions.id });

    // Try to reach /v1/track with only a session cookie (no Bearer token)
    const res = await app.inject({
      method: "POST",
      url: "/v1/track",
      cookies: { [SESSION_COOKIE_NAME]: session!.id },
      payload: { userId: "u", event: "e" },
    });

    // Should be rejected - ingest requires Bearer token, not cookie
    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.error).toContain("Authorization");

    // Clean up
    await db.delete(sessions).where(eq(sessions.id, session!.id));
    await app.close();
  });

  it("bearer token CANNOT reach dashboard routes (cookie-auth scope)", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ logger: false, db, baseUrl: "http://localhost:3000" });

    // Try to reach /auth/me with only a Bearer token
    const res = await app.inject({
      method: "GET",
      url: "/auth/me",
      headers: { authorization: `Bearer ${rawApiKey}` },
    });

    // /auth/me requires a session cookie. Bearer token is irrelevant here.
    expect(res.statusCode).toBe(401);

    await app.close();
  });
});
