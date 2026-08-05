/**
 * Contact model integration tests (task 8).
 *
 * Tests:
 * - Reserved trait mapping (email, name, company, payment_status/plan -> columns)
 * - Properties JSONB shallow merge (non-reserved traits)
 * - Null-means-unset: removes key from properties JSONB / sets column to NULL
 * - Email conflict detection and recording
 * - Invalid payment_status conflict recording
 * - Concurrency: two simultaneous identifies for same contact preserve both traits
 * - Concurrency: email conflict during concurrent identify does not lose the non-conflicting write
 *
 * Requires local Postgres (docker compose up postgres).
 *
 * Concurrency tests use the PgGate pattern from seed.test.ts: a Postgres advisory
 * lock gate ensures N callers are blocked inside Postgres and released simultaneously,
 * making overlap a property of the test rather than relying on timing.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { eq, and, sql } from "drizzle-orm";
import { buildApp, hashApiKey } from "../src/index.js";
import {
  tenants,
  apiKeys,
  contacts,
  events,
  contactConflicts,
} from "@claros/db/schema";

const TEST_DB_URL = process.env.DATABASE_URL;
if (!TEST_DB_URL) {
  const inCI = process.env.CI === "true";
  throw new Error(
    `[contact-model.test] DATABASE_URL is not set.\n\n` +
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
let rawApiKey: string;

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
        `[contact-model.test] DATABASE_URL not reachable in CI.\n` +
          `URL: ${TEST_DB_URL}\n` +
          `Cause: ${(err as Error).message}`,
      );
    }
    console.warn(
      "[contact-model.test] DATABASE_URL not reachable - integration tests will be skipped.",
    );
    return;
  }

  // Clean up test data from previous runs
  await db.execute(
    sql`DELETE FROM contact_conflicts WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = 'test-contact-model')`,
  );
  await db.execute(
    sql`DELETE FROM events WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = 'test-contact-model')`,
  );
  await db.execute(
    sql`DELETE FROM lifecycle_transitions WHERE contact_id IN (SELECT id FROM contacts WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = 'test-contact-model'))`,
  );
  await db.execute(
    sql`DELETE FROM contacts WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = 'test-contact-model')`,
  );
  await db.execute(
    sql`DELETE FROM api_keys WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = 'test-contact-model')`,
  );
  await db.execute(sql`DELETE FROM tenants WHERE slug = 'test-contact-model'`);

  // Create test tenant
  const [tenant] = await db
    .insert(tenants)
    .values({ name: "Test Contact Model", slug: "test-contact-model", plan: "free" })
    .returning({ id: tenants.id });
  testTenantId = tenant!.id;

  // Create test API key
  rawApiKey = `cl_live_${randomBytes(32).toString("base64url")}`;
  const keyHash = hashApiKey(rawApiKey);
  const prefix = rawApiKey.slice(0, 8);
  await db
    .insert(apiKeys)
    .values({ tenantId: testTenantId, keyHash, prefix, label: "contact model test key" });
});

afterAll(async () => {
  if (!dbAvailable) {
    await pool.end();
    return;
  }
  await db.execute(sql`DELETE FROM contact_conflicts WHERE tenant_id = ${testTenantId}`);
  await db.execute(sql`DELETE FROM events WHERE tenant_id = ${testTenantId}`);
  await db.execute(sql`DELETE FROM lifecycle_transitions WHERE contact_id IN (SELECT id FROM contacts WHERE tenant_id = ${testTenantId})`);
  await db.execute(sql`DELETE FROM contacts WHERE tenant_id = ${testTenantId}`);
  await db.execute(sql`DELETE FROM api_keys WHERE tenant_id = ${testTenantId}`);
  await db.execute(sql`DELETE FROM tenants WHERE id = ${testTenantId}`);
  await pool.end();
});

// --- Helpers ---

async function identify(
  app: Awaited<ReturnType<typeof buildApp>>,
  userId: string,
  traits?: Record<string, unknown>,
) {
  return app.inject({
    method: "POST",
    url: "/v1/identify",
    headers: { authorization: `Bearer ${rawApiKey}` },
    payload: { userId, traits },
  });
}

async function getContact(externalId: string) {
  const [contact] = await db
    .select()
    .from(contacts)
    .where(
      and(eq(contacts.tenantId, testTenantId), eq(contacts.externalId, externalId)),
    );
  return contact;
}

async function getConflicts(contactId: string) {
  return db
    .select()
    .from(contactConflicts)
    .where(
      and(
        eq(contactConflicts.tenantId, testTenantId),
        eq(contactConflicts.contactId, contactId),
      ),
    );
}

// --- Tests ---

describe("database availability sentinel", () => {
  it("database unavailable: integration tests skipped", () => {
    if (dbAvailable) return;
    console.warn("[contact-model.test] All DB integration tests skipped.");
    expect(true).toBe(true);
  });
});

describe("reserved trait mapping", () => {
  it("maps email, name, company to their dedicated columns", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ logger: false, db, baseUrl: "http://localhost:3000" });

    const res = await identify(app, "user_reserved_1", {
      email: "reserved@example.com",
      name: "Jane Reserved",
      company: "Acme Corp",
    });

    expect(res.statusCode).toBe(200);

    const contact = await getContact("user_reserved_1");
    expect(contact).toBeDefined();
    expect(contact!.email).toBe("reserved@example.com");
    expect(contact!.name).toBe("Jane Reserved");
    expect(contact!.company).toBe("Acme Corp");
    // Reserved traits should NOT appear in properties
    expect(contact!.properties).toBeNull();

    await app.close();
  });

  it("maps payment_status to dedicated column with valid value", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ logger: false, db, baseUrl: "http://localhost:3000" });

    await identify(app, "user_payment_1", { payment_status: "paid" });
    const contact = await getContact("user_payment_1");
    expect(contact!.paymentStatus).toBe("paid");

    await app.close();
  });

  it("maps plan trait as alias for payment_status", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ logger: false, db, baseUrl: "http://localhost:3000" });

    await identify(app, "user_plan_alias", { plan: "trial" });
    const contact = await getContact("user_plan_alias");
    expect(contact!.paymentStatus).toBe("trial");

    await app.close();
  });

  it("new contact starts with lifecycle_state = signed_up", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ logger: false, db, baseUrl: "http://localhost:3000" });

    await identify(app, "user_lifecycle_init", { name: "New User" });
    const contact = await getContact("user_lifecycle_init");
    expect(contact!.lifecycleState).toBe("signed_up");

    await app.close();
  });
});

describe("properties JSONB shallow merge", () => {
  it("stores non-reserved traits in properties JSONB", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ logger: false, db, baseUrl: "http://localhost:3000" });

    await identify(app, "user_props_1", {
      role: "admin",
      team_size: 5,
      features_used: ["billing", "reports"],
    });

    const contact = await getContact("user_props_1");
    const props = contact!.properties as Record<string, unknown>;
    expect(props.role).toBe("admin");
    expect(props.team_size).toBe(5);
    expect(props.features_used).toEqual(["billing", "reports"]);

    await app.close();
  });

  it("shallow merges: second identify preserves keys from first", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ logger: false, db, baseUrl: "http://localhost:3000" });

    await identify(app, "user_merge_1", { role: "admin", locale: "en" });
    await identify(app, "user_merge_1", { team_size: 10 });

    const contact = await getContact("user_merge_1");
    const props = contact!.properties as Record<string, unknown>;
    expect(props.role).toBe("admin");
    expect(props.locale).toBe("en");
    expect(props.team_size).toBe(10);

    await app.close();
  });

  it("shallow merges: overlapping key is overwritten by latest identify", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ logger: false, db, baseUrl: "http://localhost:3000" });

    await identify(app, "user_overwrite_1", { role: "member" });
    await identify(app, "user_overwrite_1", { role: "admin" });

    const contact = await getContact("user_overwrite_1");
    const props = contact!.properties as Record<string, unknown>;
    expect(props.role).toBe("admin");

    await app.close();
  });

  it("does NOT deep merge nested objects - replaces them wholesale", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ logger: false, db, baseUrl: "http://localhost:3000" });

    await identify(app, "user_nodeep_1", {
      prefs: { theme: "dark", lang: "en" },
    });
    await identify(app, "user_nodeep_1", {
      prefs: { theme: "light" },
    });

    const contact = await getContact("user_nodeep_1");
    const props = contact!.properties as Record<string, unknown>;
    // Shallow merge: prefs is replaced entirely, not deep-merged
    expect(props.prefs).toEqual({ theme: "light" });

    await app.close();
  });
});

describe("null means unset", () => {
  it("null removes a key from properties JSONB", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ logger: false, db, baseUrl: "http://localhost:3000" });

    await identify(app, "user_unset_1", { role: "admin", locale: "en" });
    await identify(app, "user_unset_1", { role: null });

    const contact = await getContact("user_unset_1");
    const props = contact!.properties as Record<string, unknown>;
    expect(props.role).toBeUndefined();
    expect(props.locale).toBe("en");

    await app.close();
  });

  it("null sets a reserved column to NULL", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ logger: false, db, baseUrl: "http://localhost:3000" });

    await identify(app, "user_unset_col_1", {
      email: "unset@example.com",
      name: "To Be Unset",
    });
    // Verify they are set first
    let contact = await getContact("user_unset_col_1");
    expect(contact!.email).toBe("unset@example.com");
    expect(contact!.name).toBe("To Be Unset");

    // Unset email and name
    await identify(app, "user_unset_col_1", { email: null, name: null });
    contact = await getContact("user_unset_col_1");
    expect(contact!.email).toBeNull();
    expect(contact!.name).toBeNull();

    await app.close();
  });

  it("null does not remove nested nulls from other properties (no jsonb_strip_nulls)", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ logger: false, db, baseUrl: "http://localhost:3000" });

    // Store a nested object that contains null values legitimately
    await identify(app, "user_nested_null", {
      settings: { notifications: null, theme: "dark" },
      locale: "en",
    });
    // Unset locale (top-level null) but settings.notifications should remain null
    await identify(app, "user_nested_null", { locale: null });

    const contact = await getContact("user_nested_null");
    const props = contact!.properties as Record<string, unknown>;
    expect(props.locale).toBeUndefined();
    const settings = props.settings as Record<string, unknown>;
    expect(settings.notifications).toBeNull(); // Preserved - not stripped
    expect(settings.theme).toBe("dark");

    await app.close();
  });
});

describe("email conflict detection", () => {
  it("rejects email already owned by another contact, records conflict", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ logger: false, db, baseUrl: "http://localhost:3000" });

    // First contact claims the email
    await identify(app, "user_email_owner", { email: "claimed@example.com" });

    // Second contact tries to claim the same email
    const res = await identify(app, "user_email_thief", {
      email: "claimed@example.com",
      name: "The Thief",
    });

    // Request still succeeds (event is kept, only email is rejected)
    expect(res.statusCode).toBe(200);

    // The second contact should NOT have the email
    const thief = await getContact("user_email_thief");
    expect(thief!.email).toBeNull();
    // But name should still be applied
    expect(thief!.name).toBe("The Thief");

    // Conflict should be recorded
    const conflicts = await getConflicts(thief!.id);
    expect(conflicts.length).toBe(1);
    expect(conflicts[0]!.field).toBe("email");
    expect(conflicts[0]!.rejectedValue).toBe("claimed@example.com");

    // The original owner still has the email
    const owner = await getContact("user_email_owner");
    expect(owner!.email).toBe("claimed@example.com");

    await app.close();
  });

  it("allows same contact to re-identify with its own email (no conflict)", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ logger: false, db, baseUrl: "http://localhost:3000" });

    await identify(app, "user_same_email", { email: "mine@example.com" });
    // Re-identify with the same email - no conflict
    await identify(app, "user_same_email", { email: "mine@example.com", name: "Updated" });

    const contact = await getContact("user_same_email");
    expect(contact!.email).toBe("mine@example.com");
    expect(contact!.name).toBe("Updated");

    const conflicts = await getConflicts(contact!.id);
    expect(conflicts.length).toBe(0);

    await app.close();
  });

  it("allows updating email when no conflict exists", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ logger: false, db, baseUrl: "http://localhost:3000" });

    await identify(app, "user_email_change", { email: "old@example.com" });
    await identify(app, "user_email_change", { email: "new-unique@example.com" });

    const contact = await getContact("user_email_change");
    expect(contact!.email).toBe("new-unique@example.com");

    await app.close();
  });
});

describe("invalid payment_status conflict recording", () => {
  it("rejects invalid payment_status and records conflict", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ logger: false, db, baseUrl: "http://localhost:3000" });

    const res = await identify(app, "user_bad_ps", {
      payment_status: "premium_ultra",
      name: "Bad Status User",
    });

    expect(res.statusCode).toBe(200);

    const contact = await getContact("user_bad_ps");
    // payment_status should remain at default (free), not updated to invalid value
    expect(contact!.paymentStatus).toBe("free");
    // But name should still be applied
    expect(contact!.name).toBe("Bad Status User");

    // Conflict should be recorded
    const conflicts = await getConflicts(contact!.id);
    expect(conflicts.length).toBe(1);
    expect(conflicts[0]!.field).toBe("payment_status");
    expect(conflicts[0]!.rejectedValue).toBe("premium_ultra");

    await app.close();
  });

  it("rejects invalid plan alias and records as payment_status conflict", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ logger: false, db, baseUrl: "http://localhost:3000" });

    await identify(app, "user_bad_plan", { plan: "gold_tier" });

    const contact = await getContact("user_bad_plan");
    expect(contact!.paymentStatus).toBe("free");

    const conflicts = await getConflicts(contact!.id);
    expect(conflicts.length).toBe(1);
    expect(conflicts[0]!.field).toBe("payment_status");
    expect(conflicts[0]!.rejectedValue).toBe("gold_tier");

    await app.close();
  });
});

describe("identify event is always kept", () => {
  it("event is stored even when email conflicts", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ logger: false, db, baseUrl: "http://localhost:3000" });

    // Owner claims email
    await identify(app, "user_evt_owner", { email: "event-kept@example.com" });

    // Thief tries - event should still be recorded with the full traits payload
    await identify(app, "user_evt_thief", {
      email: "event-kept@example.com",
      name: "Thief Name",
    });

    const thief = await getContact("user_evt_thief");
    const evts = await db
      .select()
      .from(events)
      .where(
        and(eq(events.contactId, thief!.id), eq(events.type, "identify")),
      );
    expect(evts.length).toBe(1);
    const props = evts[0]!.properties as Record<string, unknown>;
    expect(props.email).toBe("event-kept@example.com");
    expect(props.name).toBe("Thief Name");

    await app.close();
  });
});

// --- Concurrency Tests (PgGate pattern) ---

const GATE_LOCK_ID = 799_308; // unique within the test DB, different from seed.test

class PgGate {
  private controlClient: pg.Client;
  private url: string;
  private n: number;

  constructor(url: string, n: number) {
    this.url = url;
    this.n = n;
    this.controlClient = new pg.Client({ connectionString: url });
  }

  async lock(): Promise<void> {
    await this.controlClient.connect();
    await this.controlClient.query("SELECT pg_advisory_lock($1)", [GATE_LOCK_ID]);
  }

  async waitForAllBlocked(): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const result = await this.controlClient.query(
        `SELECT count(*)::int AS n
         FROM pg_stat_activity
         WHERE wait_event_type = 'Lock'
           AND wait_event = 'advisory'
           AND datname = current_database()
           AND pid != pg_backend_pid()`,
      );
      if (result.rows[0].n >= this.n) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(
      `PgGate: timed out waiting for ${this.n} callers to block on advisory lock`,
    );
  }

  async release(): Promise<void> {
    await this.controlClient.query("SELECT pg_advisory_unlock($1)", [GATE_LOCK_ID]);
  }

  async close(): Promise<void> {
    await this.controlClient.end();
  }

  /**
   * Returns a function that blocks at the gate, then executes workFn
   * on a dedicated connection. Records clock_timestamp() at unblock.
   */
  callerFn<T>(workFn: (client: pg.Client) => Promise<T>) {
    return async (): Promise<{ result: T; unblockTime: Date }> => {
      const client = new pg.Client({ connectionString: this.url });
      await client.connect();
      await client.query("SELECT pg_advisory_lock_shared($1)", [GATE_LOCK_ID]);
      const tsResult = await client.query("SELECT clock_timestamp() AS ts");
      const unblockTime = tsResult.rows[0].ts as Date;
      try {
        const result = await workFn(client);
        return { result, unblockTime };
      } finally {
        await client.query("SELECT pg_advisory_unlock_shared($1)", [GATE_LOCK_ID]);
        await client.end();
      }
    };
  }
}

function assertOverlap(times: Date[], label: string): void {
  const sorted = times.map((t) => t.getTime()).sort((a, b) => a - b);
  const spreadMs = sorted[sorted.length - 1]! - sorted[0]!;
  if (spreadMs > 200) {
    throw new Error(
      `[${label}] Overlap not achieved: spread=${spreadMs}ms (threshold=200ms).`,
    );
  }
}

describe("concurrency: properties merge", () => {
  it("two simultaneous identifies with different traits preserves both", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ logger: false, db, baseUrl: "http://localhost:3000" });

    // Pre-create the contact so both identifies hit the UPDATE path
    await identify(app, "user_concurrent_1", { seed_trait: "initial" });

    const gate = new PgGate(TEST_DB_URL, 2);
    await gate.lock();

    // Caller A sends trait_a, Caller B sends trait_b - simultaneously
    const callerA = gate.callerFn(async () => {
      const res = await app.inject({
        method: "POST",
        url: "/v1/identify",
        headers: { authorization: `Bearer ${rawApiKey}` },
        payload: { userId: "user_concurrent_1", traits: { trait_a: "from_a" } },
      });
      return res.statusCode;
    });

    const callerB = gate.callerFn(async () => {
      const res = await app.inject({
        method: "POST",
        url: "/v1/identify",
        headers: { authorization: `Bearer ${rawApiKey}` },
        payload: { userId: "user_concurrent_1", traits: { trait_b: "from_b" } },
      });
      return res.statusCode;
    });

    const promises = [callerA(), callerB()];
    await gate.waitForAllBlocked();
    await gate.release();

    const results = await Promise.all(promises);
    assertOverlap(
      results.map((r) => r.unblockTime),
      "concurrent traits",
    );

    // Both should succeed
    expect(results[0]!.result).toBe(200);
    expect(results[1]!.result).toBe(200);

    // The contact should have BOTH traits (neither lost to a race)
    const contact = await getContact("user_concurrent_1");
    const props = contact!.properties as Record<string, unknown>;
    expect(props.seed_trait).toBe("initial");
    expect(props.trait_a).toBe("from_a");
    expect(props.trait_b).toBe("from_b");

    await gate.close();
    await app.close();
  });

  it("two simultaneous identifies with same key: last write wins, no corruption", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ logger: false, db, baseUrl: "http://localhost:3000" });

    await identify(app, "user_concurrent_2", { initial: true });

    const gate = new PgGate(TEST_DB_URL, 2);
    await gate.lock();

    const callerA = gate.callerFn(async () => {
      const res = await app.inject({
        method: "POST",
        url: "/v1/identify",
        headers: { authorization: `Bearer ${rawApiKey}` },
        payload: { userId: "user_concurrent_2", traits: { role: "value_a" } },
      });
      return res.statusCode;
    });

    const callerB = gate.callerFn(async () => {
      const res = await app.inject({
        method: "POST",
        url: "/v1/identify",
        headers: { authorization: `Bearer ${rawApiKey}` },
        payload: { userId: "user_concurrent_2", traits: { role: "value_b" } },
      });
      return res.statusCode;
    });

    const promises = [callerA(), callerB()];
    await gate.waitForAllBlocked();
    await gate.release();

    const results = await Promise.all(promises);
    assertOverlap(
      results.map((r) => r.unblockTime),
      "same key race",
    );

    expect(results[0]!.result).toBe(200);
    expect(results[1]!.result).toBe(200);

    // One of the two values should win - the important thing is no corruption
    const contact = await getContact("user_concurrent_2");
    const props = contact!.properties as Record<string, unknown>;
    expect(["value_a", "value_b"]).toContain(props.role);
    // Initial trait should be preserved
    expect(props.initial).toBe(true);

    await gate.close();
    await app.close();
  });

  it("concurrent identify with email conflict does not lose non-conflicting write", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ logger: false, db, baseUrl: "http://localhost:3000" });

    // Pre-create owner of the email
    await identify(app, "user_email_holder", { email: "held-concurrent@example.com" });
    // Pre-create the target contact
    await identify(app, "user_concurrent_conflict", { base_trait: "exists" });

    const gate = new PgGate(TEST_DB_URL, 2);
    await gate.lock();

    // Caller A: tries to set a conflicting email + a valid trait
    const callerA = gate.callerFn(async () => {
      const res = await app.inject({
        method: "POST",
        url: "/v1/identify",
        headers: { authorization: `Bearer ${rawApiKey}` },
        payload: {
          userId: "user_concurrent_conflict",
          traits: {
            email: "held-concurrent@example.com", // conflict!
            trait_from_a: "survived",
          },
        },
      });
      return res.statusCode;
    });

    // Caller B: sends a non-conflicting trait
    const callerB = gate.callerFn(async () => {
      const res = await app.inject({
        method: "POST",
        url: "/v1/identify",
        headers: { authorization: `Bearer ${rawApiKey}` },
        payload: {
          userId: "user_concurrent_conflict",
          traits: { trait_from_b: "also_survived" },
        },
      });
      return res.statusCode;
    });

    const promises = [callerA(), callerB()];
    await gate.waitForAllBlocked();
    await gate.release();

    const results = await Promise.all(promises);
    assertOverlap(
      results.map((r) => r.unblockTime),
      "email conflict concurrent",
    );

    expect(results[0]!.result).toBe(200);
    expect(results[1]!.result).toBe(200);

    // Contact should:
    // - NOT have the conflicting email
    // - HAVE trait_from_a (the non-email part of caller A's identify was applied)
    // - HAVE trait_from_b (caller B's write was not lost)
    // - HAVE base_trait (pre-existing)
    const contact = await getContact("user_concurrent_conflict");
    expect(contact!.email).toBeNull();
    const props = contact!.properties as Record<string, unknown>;
    expect(props.base_trait).toBe("exists");
    expect(props.trait_from_a).toBe("survived");
    expect(props.trait_from_b).toBe("also_survived");

    // Conflict was recorded
    const conflicts = await getConflicts(contact!.id);
    const emailConflicts = conflicts.filter((c) => c.field === "email");
    expect(emailConflicts.length).toBe(1);
    expect(emailConflicts[0]!.rejectedValue).toBe("held-concurrent@example.com");

    await gate.close();
    await app.close();
  });

  it("two different contacts racing for the same email: one wins, one gets conflict, both succeed", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ logger: false, db, baseUrl: "http://localhost:3000" });

    // Pre-create both contacts (no email yet) so the race is purely about
    // the email UPDATE, not about contact creation.
    await identify(app, "user_race_a", { name: "Racer A" });
    await identify(app, "user_race_b", { name: "Racer B" });

    const gate = new PgGate(TEST_DB_URL, 2);
    await gate.lock();

    const raceEmail = "race-target@example.com";

    // Both callers try to claim the same email for different contacts.
    // The pre-check SELECT will pass for both (no one owns the email yet).
    // One UPDATE will succeed; the other hits uq_contacts_tenant_email (23505).
    // The loser should: retry without email, record a conflict, return 200.
    const callerA = gate.callerFn(async () => {
      const res = await app.inject({
        method: "POST",
        url: "/v1/identify",
        headers: { authorization: `Bearer ${rawApiKey}` },
        payload: {
          userId: "user_race_a",
          traits: { email: raceEmail, from_a: true },
        },
      });
      return res.statusCode;
    });

    const callerB = gate.callerFn(async () => {
      const res = await app.inject({
        method: "POST",
        url: "/v1/identify",
        headers: { authorization: `Bearer ${rawApiKey}` },
        payload: {
          userId: "user_race_b",
          traits: { email: raceEmail, from_b: true },
        },
      });
      return res.statusCode;
    });

    const promises = [callerA(), callerB()];
    await gate.waitForAllBlocked();
    await gate.release();

    const results = await Promise.all(promises);
    assertOverlap(
      results.map((r) => r.unblockTime),
      "email race two contacts",
    );

    // Both requests must succeed (200) - neither returns a 500
    expect(results[0]!.result).toBe(200);
    expect(results[1]!.result).toBe(200);

    // Exactly one contact should have the email
    const contactA = await getContact("user_race_a");
    const contactB = await getContact("user_race_b");
    const aHasEmail = contactA!.email === raceEmail;
    const bHasEmail = contactB!.email === raceEmail;
    expect(aHasEmail || bHasEmail).toBe(true);
    expect(aHasEmail && bHasEmail).toBe(false); // not both

    // The winner has no conflict; the loser has a conflict recorded
    const winner = aHasEmail ? contactA! : contactB!;
    const loser = aHasEmail ? contactB! : contactA!;

    const winnerConflicts = await getConflicts(winner.id);
    const loserConflicts = await getConflicts(loser.id);
    expect(winnerConflicts.filter((c) => c.field === "email").length).toBe(0);
    expect(loserConflicts.filter((c) => c.field === "email").length).toBe(1);
    expect(loserConflicts[0]!.rejectedValue).toBe(raceEmail);

    // Non-email traits were still applied for both (not lost to the retry)
    const propsA = contactA!.properties as Record<string, unknown>;
    const propsB = contactB!.properties as Record<string, unknown>;
    expect(propsA.from_a).toBe(true);
    expect(propsB.from_b).toBe(true);

    await gate.close();
    await app.close();
  });
});
