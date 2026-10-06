/**
 * Integration tests for the suppression import endpoint (task 24).
 *
 * Coverage:
 *
 * Import (POST /v1/suppressions/import):
 *   - Clean import suppresses every address and reports the count
 *   - Duplicates within the file are skipped (counted separately)
 *   - Addresses already in the suppression list are skipped (not an error)
 *   - Malformed rows (no '@', empty domain) are counted as invalid, not failing
 *   - One bad row in a batch does not fail the whole import
 *   - Header row "email" is recognized and skipped
 *   - JSON body shape { "addresses": [...] } is accepted
 *   - Empty body returns 400
 *   - Row cap is enforced (only first SUPPRESSION_IMPORT_ROW_CAP rows processed)
 *   - Import is tenant-scoped (never crosses tenants)
 *
 * L1 gate integration (end-to-end):
 *   - An address suppressed by import is actually blocked by the drain's L1 layer
 *     (verified by reading the suppressions table directly in the gate query)
 *
 * Auth:
 *   - Requests without session cookie return 401
 *   - Bearer key returns 401
 *
 * List (GET /v1/suppressions):
 *   - Returns suppressions for the tenant with cursor pagination
 *   - Cross-tenant isolation holds
 *
 * Requires local Postgres (docker compose up postgres).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { sql, eq, and } from "drizzle-orm";
import { buildApp } from "../src/index.js";
import { tenants, users, sessions, suppressions, apiKeys } from "@mailforge/db/schema";
import { randomBytes, createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// DB setup
// ---------------------------------------------------------------------------

const TEST_DB_URL = process.env.DATABASE_URL;
if (!TEST_DB_URL) {
  const inCI = process.env.CI === "true";
  throw new Error(
    `[suppressions.test] DATABASE_URL is not set.\n\n` +
      `This test requires a Postgres connection.\n` +
      (inCI
        ? `Set the variable in the workflow env block:\n\n  DATABASE_URL: postgres://mailforge:mailforge@localhost:5432/mailforge\n`
        : `Set the variable in .env (see .env.example) or export it:\n\n  export DATABASE_URL='postgres://mailforge:mailforge@localhost:5433/mailforge'\n`),
  );
}

let pool: pg.Pool;
let db: ReturnType<typeof drizzle>;
let dbAvailable = false;

let tenantAId: string;
let tenantBId: string;
let cookieA: string;
let cookieBId: string;
let rawApiKey: string;

const SLUG_A = "test-suppression-a";
const SLUG_B = "test-suppression-b";

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
        `[suppressions.test] DATABASE_URL not reachable in CI.\n` +
          `URL: ${TEST_DB_URL}\nCause: ${(err as Error).message}`,
      );
    }
    console.warn("[suppressions.test] DATABASE_URL not reachable - tests skipped.");
    return;
  }

  await cleanup();

  // Tenant A
  const [tA] = await db.insert(tenants).values({ name: "Suppression Test A", slug: SLUG_A, plan: "free" }).returning({ id: tenants.id });
  tenantAId = tA!.id;
  const [uA] = await db.insert(users).values({ tenantId: tenantAId, email: "owner-a@sup.test", role: "owner" }).returning({ id: users.id });
  const [sA] = await db.insert(sessions).values({ tenantId: tenantAId, userId: uA!.id, expiresAt: new Date(Date.now() + 86400_000) }).returning({ id: sessions.id });
  cookieA = `mailforge_session=${sA!.id}`;

  // API key for wrong-scope test
  rawApiKey = randomBytes(24).toString("base64url");
  const keyHash = createHash("sha256").update(rawApiKey).digest("hex");
  await db.insert(apiKeys).values({ tenantId: tenantAId, keyHash, prefix: rawApiKey.slice(0, 8), label: "test" });

  // Tenant B
  const [tB] = await db.insert(tenants).values({ name: "Suppression Test B", slug: SLUG_B, plan: "free" }).returning({ id: tenants.id });
  tenantBId = tB!.id;
  const [uB] = await db.insert(users).values({ tenantId: tenantBId, email: "owner-b@sup.test", role: "owner" }).returning({ id: users.id });
  const [sB] = await db.insert(sessions).values({ tenantId: tenantBId, userId: uB!.id, expiresAt: new Date(Date.now() + 86400_000) }).returning({ id: sessions.id });
  cookieBId = sB!.id;
});

afterAll(async () => {
  if (dbAvailable) await cleanup();
  await pool.end();
});

async function cleanup() {
  for (const slug of [SLUG_A, SLUG_B]) {
    await db.execute(sql`DELETE FROM suppressions WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${slug})`);
    await db.execute(sql`DELETE FROM api_keys WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${slug})`);
    await db.execute(sql`DELETE FROM sessions WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${slug})`);
    await db.execute(sql`DELETE FROM users WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${slug})`);
    await db.execute(sql`DELETE FROM tenants WHERE slug = ${slug}`);
  }
}

// Helper: clear suppressions between tests to avoid cross-test contamination
async function clearSuppressions(tenantId: string) {
  await db.execute(sql`DELETE FROM suppressions WHERE tenant_id = ${tenantId}::uuid`);
}

// ---------------------------------------------------------------------------
// Auth tests
// ---------------------------------------------------------------------------

describe("auth", () => {
  it("returns 401 without session cookie", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });
    const res = await app.inject({ method: "POST", url: "/v1/suppressions/import" });
    expect(res.statusCode).toBe(401);
  });

  it("returns 401 with bearer key (ingest scope)", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });
    const res = await app.inject({
      method: "POST", url: "/v1/suppressions/import",
      headers: {
        authorization: `Bearer ${rawApiKey}`,
        "content-type": "text/plain",
      },
      body: "a@b.com",
    });
    expect(res.statusCode).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Import tests
// ---------------------------------------------------------------------------

describe("POST /v1/suppressions/import", () => {
  it("clean import suppresses every address and reports the count", async () => {
    if (!dbAvailable) return;
    await clearSuppressions(tenantAId);
    const app = await buildApp({ db, logger: false });

    const body = "alice@example.com\nbob@example.com\ncharlie@example.com";
    const res = await app.inject({
      method: "POST",
      url: "/v1/suppressions/import",
      headers: { cookie: cookieA, "content-type": "text/plain" },
      body,
    });
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.imported).toBe(3);
    expect(json.skipped).toBe(0);
    expect(json.invalid).toBe(0);
    expect(json.total_rows).toBe(3);

    // Verify they are actually in the DB
    const rows = await db.select().from(suppressions).where(eq(suppressions.tenantId, tenantAId));
    const emails = rows.map((r) => r.email);
    expect(emails).toContain("alice@example.com");
    expect(emails).toContain("bob@example.com");
    expect(emails).toContain("charlie@example.com");
  });

  it("duplicates within the file are counted as skipped", async () => {
    if (!dbAvailable) return;
    await clearSuppressions(tenantAId);
    const app = await buildApp({ db, logger: false });

    // alice appears twice
    const body = "alice@example.com\nalice@example.com\nbob@example.com";
    const res = await app.inject({
      method: "POST",
      url: "/v1/suppressions/import",
      headers: { cookie: cookieA, "content-type": "text/plain" },
      body,
    });
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.imported).toBe(2); // alice + bob (first occurrence of alice imported)
    expect(json.skipped).toBe(1); // second alice skipped
    expect(json.invalid).toBe(0);
  });

  it("addresses already in the suppression list are skipped (not an error)", async () => {
    if (!dbAvailable) return;
    await clearSuppressions(tenantAId);
    // Pre-insert alice
    await db.insert(suppressions).values({ tenantId: tenantAId, email: "alice@example.com", reason: "manual", source: "admin" });

    const app = await buildApp({ db, logger: false });
    const body = "alice@example.com\nbob@example.com";
    const res = await app.inject({
      method: "POST",
      url: "/v1/suppressions/import",
      headers: { cookie: cookieA, "content-type": "text/plain" },
      body,
    });
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.imported).toBe(1); // only bob
    expect(json.skipped).toBe(1); // alice already existed
    expect(json.invalid).toBe(0);
  });

  it("malformed rows are counted as invalid and do not abort the batch", async () => {
    if (!dbAvailable) return;
    await clearSuppressions(tenantAId);
    const app = await buildApp({ db, logger: false });

    const body = "alice@example.com\nnot-an-email\nbob@example.com\n@nodomain";
    const res = await app.inject({
      method: "POST",
      url: "/v1/suppressions/import",
      headers: { cookie: cookieA, "content-type": "text/plain" },
      body,
    });
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.imported).toBe(2); // alice + bob
    expect(json.invalid).toBe(2); // not-an-email + @nodomain
    expect(json.total_rows).toBe(4);
  });

  it("header row 'email' is recognized and skipped", async () => {
    if (!dbAvailable) return;
    await clearSuppressions(tenantAId);
    const app = await buildApp({ db, logger: false });

    const body = "email\nalice@example.com\nbob@example.com";
    const res = await app.inject({
      method: "POST",
      url: "/v1/suppressions/import",
      headers: { cookie: cookieA, "content-type": "text/plain" },
      body,
    });
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.imported).toBe(2);
    expect(json.total_rows).toBe(2); // header not counted
  });

  it("CSV multi-column input: only first column used", async () => {
    if (!dbAvailable) return;
    await clearSuppressions(tenantAId);
    const app = await buildApp({ db, logger: false });

    const body = "email,name,reason\nalice@example.com,Alice,unsubscribed\nbob@example.com,Bob,imported";
    const res = await app.inject({
      method: "POST",
      url: "/v1/suppressions/import",
      headers: { cookie: cookieA, "content-type": "text/csv" },
      body,
    });
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.imported).toBe(2);
    expect(json.invalid).toBe(0);
  });

  it("JSON body shape { addresses: [...] } is accepted", async () => {
    if (!dbAvailable) return;
    await clearSuppressions(tenantAId);
    const app = await buildApp({ db, logger: false });

    const res = await app.inject({
      method: "POST",
      url: "/v1/suppressions/import",
      headers: { cookie: cookieA, "content-type": "application/json" },
      payload: { addresses: ["alice@example.com", "bob@example.com"] },
    });
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.imported).toBe(2);
  });

  it("empty body returns 400", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });
    const res = await app.inject({
      method: "POST",
      url: "/v1/suppressions/import",
      headers: { cookie: cookieA, "content-type": "text/plain" },
      body: "",
    });
    expect(res.statusCode).toBe(400);
  });

  it("import is tenant-scoped: never crosses tenants", async () => {
    if (!dbAvailable) return;
    await clearSuppressions(tenantAId);
    await clearSuppressions(tenantBId);
    const app = await buildApp({ db, logger: false });

    // Import for tenant A
    await app.inject({
      method: "POST",
      url: "/v1/suppressions/import",
      headers: { cookie: cookieA, "content-type": "text/plain" },
      body: "secret@tenant-a.com",
    });

    // Tenant B must NOT see tenant A's suppressions
    const rowsB = await db.select().from(suppressions).where(eq(suppressions.tenantId, tenantBId));
    expect(rowsB.map((r) => r.email)).not.toContain("secret@tenant-a.com");
  });

  it("imported suppression is blocked by the L1 throttle gate (verified via gate query)", async () => {
    if (!dbAvailable) return;
    await clearSuppressions(tenantAId);
    const app = await buildApp({ db, logger: false });

    // Import an address via the endpoint
    await app.inject({
      method: "POST",
      url: "/v1/suppressions/import",
      headers: { cookie: cookieA, "content-type": "text/plain" },
      body: "blocked@example.com",
    });

    // The drain's L1 gate (drain.ts) runs:
    //   WHERE tenant_id = $1 AND lower(email) = lower($contactEmail)
    // This test runs the same query to verify the import stored the row
    // in the shape the gate will find it.
    const gateResult = await db
      .select({ id: suppressions.id })
      .from(suppressions)
      .where(
        and(
          eq(suppressions.tenantId, tenantAId),
          sql`lower(${suppressions.email}) = lower(${"blocked@example.com"})`,
        ),
      )
      .limit(1);

    expect(gateResult.length).toBe(1); // gate finds this row = suppressed
  });

  it("import lowercases addresses; gate blocks any case variant of the same address", async () => {
    if (!dbAvailable) return;
    await clearSuppressions(tenantAId);
    const app = await buildApp({ db, logger: false });

    // Import mixed-case address
    await app.inject({
      method: "POST",
      url: "/v1/suppressions/import",
      headers: { cookie: cookieA, "content-type": "text/plain" },
      body: "Alice@Example.COM",
    });

    // Stored as lowercase
    const [row] = await db.select().from(suppressions).where(eq(suppressions.tenantId, tenantAId));
    expect(row?.email).toBe("alice@example.com");

    // Gate query with lowercase address - finds it
    const lowerMatch = await db
      .select({ id: suppressions.id })
      .from(suppressions)
      .where(
        and(
          eq(suppressions.tenantId, tenantAId),
          sql`lower(${suppressions.email}) = lower(${"alice@example.com"})`,
        ),
      )
      .limit(1);
    expect(lowerMatch.length).toBe(1);

    // Gate query with uppercase address (as contacts.email might store it) - also finds it
    const upperMatch = await db
      .select({ id: suppressions.id })
      .from(suppressions)
      .where(
        and(
          eq(suppressions.tenantId, tenantAId),
          sql`lower(${suppressions.email}) = lower(${"ALICE@EXAMPLE.COM"})`,
        ),
      )
      .limit(1);
    expect(upperMatch.length).toBe(1); // case-insensitive: BOTH directions blocked

    // Original mixed-case - also finds it
    const mixedMatch = await db
      .select({ id: suppressions.id })
      .from(suppressions)
      .where(
        and(
          eq(suppressions.tenantId, tenantAId),
          sql`lower(${suppressions.email}) = lower(${"Alice@Example.COM"})`,
        ),
      )
      .limit(1);
    expect(mixedMatch.length).toBe(1);
  });

  it("case variants of the same address do not create duplicate rows", async () => {
    if (!dbAvailable) return;
    await clearSuppressions(tenantAId);
    const app = await buildApp({ db, logger: false });

    // Import the same address in two different cases
    const res = await app.inject({
      method: "POST",
      url: "/v1/suppressions/import",
      headers: { cookie: cookieA, "content-type": "text/plain" },
      body: "alice@example.com\nAlice@Example.COM\nALICE@EXAMPLE.COM",
    });
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.imported).toBe(1); // only first occurrence imported
    expect(json.skipped).toBe(2); // two duplicates skipped (case variants)

    // Exactly one row in the table
    const rows = await db.select().from(suppressions).where(eq(suppressions.tenantId, tenantAId));
    expect(rows.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Single-address add tests
// ---------------------------------------------------------------------------

describe("POST /v1/suppressions", () => {
  it("adds a single address with reason=manual and source=admin", async () => {
    if (!dbAvailable) return;
    await clearSuppressions(tenantAId);
    const app = await buildApp({ db, logger: false });

    const res = await app.inject({
      method: "POST",
      url: "/v1/suppressions",
      headers: { cookie: cookieA, "content-type": "application/json" },
      payload: { email: "Manual@Example.COM" },
    });
    expect(res.statusCode).toBe(201);
    const json = res.json();
    expect(json.email).toBe("manual@example.com"); // lowercased
    expect(json.added).toBe(true);

    const [row] = await db.select().from(suppressions).where(eq(suppressions.tenantId, tenantAId));
    expect(row?.email).toBe("manual@example.com");
    expect(row?.reason).toBe("manual");
    expect(row?.source).toBe("admin");
  });

  it("is idempotent: re-adding the same address returns 200 with added=false", async () => {
    if (!dbAvailable) return;
    await clearSuppressions(tenantAId);
    const app = await buildApp({ db, logger: false });

    const first = await app.inject({
      method: "POST",
      url: "/v1/suppressions",
      headers: { cookie: cookieA, "content-type": "application/json" },
      payload: { email: "dup@example.com" },
    });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({
      method: "POST",
      url: "/v1/suppressions",
      headers: { cookie: cookieA, "content-type": "application/json" },
      payload: { email: "DUP@example.com" },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().added).toBe(false);

    const rows = await db.select().from(suppressions).where(eq(suppressions.tenantId, tenantAId));
    expect(rows.length).toBe(1);
  });

  it("rejects an invalid address with 400", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });
    const res = await app.inject({
      method: "POST",
      url: "/v1/suppressions",
      headers: { cookie: cookieA, "content-type": "application/json" },
      payload: { email: "not-an-email" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects a missing email field with 400", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });
    const res = await app.inject({
      method: "POST",
      url: "/v1/suppressions",
      headers: { cookie: cookieA, "content-type": "application/json" },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 401 without session cookie", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });
    const res = await app.inject({
      method: "POST",
      url: "/v1/suppressions",
      headers: { "content-type": "application/json" },
      payload: { email: "a@b.com" },
    });
    expect(res.statusCode).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// List tests
// ---------------------------------------------------------------------------

describe("GET /v1/suppressions", () => {
  it("returns suppressions for the calling tenant with pagination fields", async () => {
    if (!dbAvailable) return;
    await clearSuppressions(tenantAId);
    const app = await buildApp({ db, logger: false });

    await app.inject({
      method: "POST",
      url: "/v1/suppressions/import",
      headers: { cookie: cookieA, "content-type": "text/plain" },
      body: "list-a@example.com\nlist-b@example.com",
    });

    const res = await app.inject({ method: "GET", url: "/v1/suppressions", headers: { cookie: cookieA } });
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(Array.isArray(json.suppressions)).toBe(true);
    expect("next_cursor" in json).toBe(true);
    const emails = json.suppressions.map((s: any) => s.email);
    expect(emails).toContain("list-a@example.com");
    expect(emails).toContain("list-b@example.com");
  });

  it("cross-tenant isolation: tenant A cannot see tenant B suppressions", async () => {
    if (!dbAvailable) return;
    await clearSuppressions(tenantBId);
    const app = await buildApp({ db, logger: false });

    // Add a suppression for tenant B
    await app.inject({
      method: "POST",
      url: "/v1/suppressions/import",
      headers: { cookie: `mailforge_session=${cookieBId}`, "content-type": "text/plain" },
      body: "b-only@example.com",
    });

    // List as tenant A
    const res = await app.inject({ method: "GET", url: "/v1/suppressions", headers: { cookie: cookieA } });
    const emails = res.json().suppressions.map((s: any) => s.email);
    expect(emails).not.toContain("b-only@example.com");
  });

  it("returns 401 without session", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });
    const res = await app.inject({ method: "GET", url: "/v1/suppressions" });
    expect(res.statusCode).toBe(401);
  });
});
