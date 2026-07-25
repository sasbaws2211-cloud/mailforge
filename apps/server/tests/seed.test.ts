/**
 * bootstrapSeed concurrency test.
 *
 * Uses a dedicated database (claros_seed_test) that no other test suite touches.
 * This eliminates all shared-state collisions: the DB is always empty at the
 * start of each test and the results are authoritative regardless of what other
 * packages are running in parallel under turbo.
 *
 * Database setup:
 *   Local (docker-compose): created and migrated automatically by the initdb
 *   script (docker/initdb/01-seed-test-db.sh) on first container start.
 *   No manual steps needed. After schema changes: docker compose down -v && up -d.
 *
 *   CI: created by the workflow step "Create seed test database" (createdb + migrate).
 *
 * The SEED_TEST_DATABASE_URL env var controls which database is used.
 * When neither it nor the fallback host is reachable, the tests skip and print
 * a visible message - a skip is only acceptable when the DB is genuinely absent.
 *
 * Concurrency model:
 *   Overlap is achieved deterministically using a Postgres advisory lock gate.
 *   A control connection holds an exclusive advisory lock. N callers each open
 *   their own connection and attempt to acquire the same lock in shared mode,
 *   which blocks them at the Postgres server level. The harness polls
 *   pg_stat_activity to confirm all N callers are waiting, then releases the
 *   exclusive lock. All N unblock simultaneously within Postgres's lock
 *   scheduling, regardless of Node event loop or CPU count. Each caller records
 *   clock_timestamp() immediately after unblocking; the harness asserts the
 *   spread is tight enough to confirm real overlap occurred.
 *
 *   This makes overlap a property of the test, not of the hardware.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { eq, count, sql } from "drizzle-orm";
import { tenants, users } from "@claros/db/schema";

// ---------------------------------------------------------------------------
// PgGate: Postgres-level synchronization via advisory locks.
//
// Guarantees that N callers are blocked inside Postgres (not in Node) and
// released simultaneously, regardless of CPU count or event loop scheduling.
// ---------------------------------------------------------------------------

const GATE_LOCK_ID = 799_301; // arbitrary, unique within the test DB

class PgGate {
  private controlClient: pg.Client;
  private url: string;
  private n: number;

  constructor(url: string, n: number) {
    this.url = url;
    this.n = n;
    this.controlClient = new pg.Client({ connectionString: url });
  }

  /** Acquire the exclusive gate lock. Call before spawning callers. */
  async lock(): Promise<void> {
    await this.controlClient.connect();
    await this.controlClient.query("SELECT pg_advisory_lock($1)", [GATE_LOCK_ID]);
  }

  /**
   * Wait until all N callers are blocked on the advisory lock in Postgres.
   * Polls pg_stat_activity for sessions waiting on advisory lock with our key.
   * Times out after 10 s (should take < 1 s in practice).
   */
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

  /** Release the gate. All blocked callers proceed simultaneously. */
  async release(): Promise<void> {
    await this.controlClient.query("SELECT pg_advisory_unlock($1)", [GATE_LOCK_ID]);
  }

  /** Clean up the control connection. */
  async close(): Promise<void> {
    await this.controlClient.end();
  }

  /**
   * Returns a function that a caller should invoke to block at the gate.
   * The caller will:
   *   1. Open its own connection
   *   2. Acquire shared advisory lock (blocks until gate releases)
   *   3. Record clock_timestamp() immediately after unblocking
   *   4. Execute the provided work function
   *   5. Release the shared lock and close the connection
   *
   * Returns { result, unblockTime } for overlap verification.
   */
  callerFn<T>(workFn: (db: ReturnType<typeof drizzle>) => Promise<T>) {
    return async (): Promise<{ result: T; unblockTime: Date }> => {
      const client = new pg.Client({ connectionString: this.url });
      await client.connect();
      // Block here until control releases the exclusive lock.
      await client.query("SELECT pg_advisory_lock_shared($1)", [GATE_LOCK_ID]);
      // Record the instant we unblocked - for overlap verification.
      const tsResult = await client.query("SELECT clock_timestamp() AS ts");
      const unblockTime = tsResult.rows[0].ts as Date;
      // Execute the actual work on a drizzle instance backed by this connection.
      const connDb = drizzle(client);
      try {
        const result = await workFn(connDb);
        return { result, unblockTime };
      } finally {
        await client.query("SELECT pg_advisory_unlock_shared($1)", [GATE_LOCK_ID]);
        await client.end();
      }
    };
  }
}

/**
 * Assert that the recorded unblock timestamps prove real overlap.
 * All N callers should have unblocked within a tight window.
 * On any hardware, after the exclusive lock releases, Postgres grants all
 * shared locks in the same lock-manager pass - spread should be < 50 ms.
 * We use a generous 200 ms threshold to tolerate CI jitter.
 */
function assertOverlap(times: Date[], label: string): void {
  const sorted = times.map((t) => t.getTime()).sort((a, b) => a - b);
  const spreadMs = sorted[sorted.length - 1]! - sorted[0]!;
  console.log(`[${label}] overlap spread: ${spreadMs}ms (threshold=200ms, n=${times.length})`);
  if (spreadMs > 200) {
    throw new Error(
      `[${label}] Overlap not achieved: spread=${spreadMs}ms (threshold=200ms). ` +
      `Timestamps: ${times.map((t) => t.toISOString()).join(", ")}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Inline seed logic - mirrors apps/server/src/main.ts bootstrapSeed exactly,
// minus process.exit(). Kept inline so this file is self-contained and the
// test clearly shows what it is testing.
// ---------------------------------------------------------------------------

type Db = ReturnType<typeof drizzle>;

async function bootstrapSeed(db: Db, seedEmail: string): Promise<void> {
  const normalizedEmail = seedEmail.toLowerCase().trim();
  await db.transaction(async (tx) => {
    const existing = await tx.select({ id: tenants.id }).from(tenants).limit(1);
    if (existing.length > 0) return;

    const inserted = await tx
      .insert(tenants)
      .values({ name: "Default", slug: "default", plan: "free" })
      .onConflictDoNothing()
      .returning({ id: tenants.id });

    const tenantId =
      inserted.length > 0
        ? inserted[0]!.id
        : (
            await tx
              .select({ id: tenants.id })
              .from(tenants)
              .where(eq(tenants.slug, "default"))
              .limit(1)
          )[0]!.id;

    await tx
      .insert(users)
      .values({ tenantId, email: normalizedEmail, role: "owner" })
      .onConflictDoNothing();
  });
}

// ---------------------------------------------------------------------------
// Buggy version used to prove the test catches a real regression.
// Replicates the original count-then-insert without ON CONFLICT protection.
//
// Includes a pg_sleep(0.1) between SELECT and INSERT to widen the race window
// deterministically. This ensures that even with minor scheduling jitter after
// the gate opens, all callers have completed their SELECT (seeing count=0)
// before any INSERT lands. Without this, a fast caller could INSERT before a
// slow caller's SELECT, closing the window.
// ---------------------------------------------------------------------------

async function bootstrapSeedBuggy(db: Db, seedEmail: string): Promise<void> {
  const normalizedEmail = seedEmail.toLowerCase().trim();
  // Deliberately no transaction, no ON CONFLICT - this is the old broken code.
  const [{ tenantCount }] = await db
    .select({ tenantCount: count() })
    .from(tenants);
  if (tenantCount > 0) return;

  // Widen the race window: hold here so all callers see count=0 before any INSERT.
  await db.execute(sql`SELECT pg_sleep(0.1)`);

  const [tenant] = await db
    .insert(tenants)
    .values({ name: "Default", slug: "default", plan: "free" })
    .returning({ id: tenants.id });

  await db.insert(users).values({
    tenantId: tenant!.id,
    email: normalizedEmail,
    role: "owner",
  });
}

// ---------------------------------------------------------------------------
// Test database: isolated from the main claros DB and all other test suites.
// ---------------------------------------------------------------------------

const SEED_TEST_URL = process.env.SEED_TEST_DATABASE_URL;
if (!SEED_TEST_URL) {
  const inCI = process.env.CI === "true";
  throw new Error(
    `[seed.test] SEED_TEST_DATABASE_URL is not set.\n\n` +
    `This test requires a dedicated Postgres database.\n` +
    (inCI
      ? `Set the variable in the workflow env block:\n\n  SEED_TEST_DATABASE_URL: postgres://claros:claros@localhost:5432/claros_seed_test\n`
      : `Set the variable in .env (see .env.example) or export it:\n\n  export SEED_TEST_DATABASE_URL='postgres://claros:claros@localhost:5433/claros_seed_test'\n`),
  );
}
const SEED_EMAIL = "seed-concurrency-test@claros-test.invalid";

let pool: pg.Pool;
let db: Db;
let dbAvailable = false;

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: SEED_TEST_URL, connectionTimeoutMillis: 3000 });
  try {
    await pool.query("SELECT 1");
    db = drizzle(pool);
    dbAvailable = true;
  } catch (err) {
    const inCI = process.env.CI === "true";
    if (inCI) {
      // In CI, SEED_TEST_DATABASE_URL must be reachable. An unavailable database
      // means the workflow is misconfigured (missing service container or setup step).
      // Fail immediately with a clear message rather than silently skipping.
      throw new Error(
        `[seed.test] SEED_TEST_DATABASE_URL is not reachable in CI.\n` +
        `URL: ${SEED_TEST_URL}\n` +
        `Cause: ${(err as Error).message}\n\n` +
        `The CI workflow must include a Postgres service and a setup step that:\n` +
        `  1. Applies community migrations to the main database\n` +
        `  2. Creates claros_seed_test and applies migrations to it\n` +
        `See .github/workflows/ci.yml for the expected setup.`,
      );
    }
    // Local: warn and skip. A developer without Docker running is expected.
    console.warn("[seed.test] SEED_TEST_DATABASE_URL not reachable - tests will be skipped.");
    console.warn("[seed.test] To run: create claros_seed_test and apply migrations (see file header).");
  }
});

afterAll(async () => {
  await pool.end();
});

/** Wipe the entire tenants table (and cascading FKs) in the isolated test DB. */
async function resetDb(d: Db): Promise<void> {
  // FK order: child tables first. The test DB has no data outside our tests.
  await d.execute(sql`TRUNCATE TABLE
    magic_link_tokens, sessions, transport_configs,
    lifecycle_messages, lifecycle_transitions, flow_memberships,
    events, contacts, suppressions, templates, kb_entries, flows,
    users, tenants
    RESTART IDENTITY CASCADE`);
}

beforeEach(async () => {
  if (!dbAvailable) return;
  await resetDb(db);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("bootstrapSeed - concurrency safety", () => {
  it("database unavailable: skip with visible message", () => {
    if (dbAvailable) return;
    // The beforeAll already printed a warning. This test exists so vitest
    // counts something and the suite is not silently empty.
    console.warn("[seed.test] All seed tests skipped - no database.");
    expect(true).toBe(true);
  });

  it("single call seeds exactly one tenant and one user", async () => {
    if (!dbAvailable) return;

    await bootstrapSeed(db, SEED_EMAIL);

    const [{ tc }] = await db.select({ tc: count() }).from(tenants);
    const [{ uc }] = await db.select({ uc: count() }).from(users);
    expect(tc).toBe(1);
    expect(uc).toBe(1);
  });

  it("second call is a no-op (idempotency)", async () => {
    if (!dbAvailable) return;

    await bootstrapSeed(db, SEED_EMAIL);
    await bootstrapSeed(db, SEED_EMAIL);

    const [{ tc }] = await db.select({ tc: count() }).from(tenants);
    const [{ uc }] = await db.select({ uc: count() }).from(users);
    expect(tc).toBe(1);
    expect(uc).toBe(1);
  });

  it("N concurrent calls with verified overlap: exactly one tenant, zero rejections", async () => {
    if (!dbAvailable) return;

    const N = 10;
    const gate = new PgGate(SEED_TEST_URL, N);
    await gate.lock();

    // Spawn N callers - each opens a connection and blocks at the gate.
    const callerPromises = Array.from({ length: N }, () =>
      gate.callerFn((connDb) => bootstrapSeed(connDb, SEED_EMAIL))(),
    );

    // Wait for all N to be blocked in Postgres.
    await gate.waitForAllBlocked();

    // Release the gate - all N proceed simultaneously.
    await gate.release();

    const results = await Promise.allSettled(callerPromises);
    await gate.close();

    // Verify overlap was achieved.
    const fulfilled = results.filter(
      (r): r is PromiseFulfilledResult<{ result: void; unblockTime: Date }> =>
        r.status === "fulfilled",
    );
    const rejected = results.filter((r) => r.status === "rejected");

    expect(
      rejected,
      `${rejected.length} of ${N} concurrent seeds rejected:\n` +
      rejected.map((r) => (r as PromiseRejectedResult).reason).join("\n"),
    ).toHaveLength(0);

    assertOverlap(
      fulfilled.map((r) => r.value.unblockTime),
      "fixed-code concurrency",
    );

    // Exactly one tenant and one user regardless of how many won the race.
    const [{ tc }] = await db.select({ tc: count() }).from(tenants);
    const [{ uc }] = await db.select({ uc: count() }).from(users);
    expect(tc, "expected exactly 1 tenant after concurrent seed").toBe(1);
    expect(uc, "expected exactly 1 user after concurrent seed").toBe(1);
  }, 30_000);

  it("regression: buggy count-then-insert fails under verified concurrent overlap", async () => {
    if (!dbAvailable) return;

    // This test proves the harness detects a real race condition. The buggy
    // implementation (count-then-insert, no transaction, no ON CONFLICT) is
    // deterministically exposed: the pg_sleep between SELECT and INSERT ensures
    // all callers read count=0 before any INSERT arrives.
    //
    // Expected outcome: Postgres unique constraint on tenants.slug rejects all
    // but the first INSERT, so rejected.length >= 1.
    const N = 8;
    const gate = new PgGate(SEED_TEST_URL, N);
    await gate.lock();

    const callerPromises = Array.from({ length: N }, () =>
      gate.callerFn((connDb) => bootstrapSeedBuggy(connDb, SEED_EMAIL))(),
    );

    await gate.waitForAllBlocked();
    await gate.release();

    const results = await Promise.allSettled(callerPromises);
    await gate.close();

    // Verify overlap was achieved (only from fulfilled results, but we should
    // have at least one fulfilled - the first inserter).
    const fulfilled = results.filter(
      (r): r is PromiseFulfilledResult<{ result: void; unblockTime: Date }> =>
        r.status === "fulfilled",
    );
    const rejected = results.filter((r) => r.status === "rejected");
    if (fulfilled.length >= 2) {
      assertOverlap(
        fulfilled.map((r) => r.value.unblockTime),
        "buggy-code regression",
      );
    }

    const [{ tc }] = await db.select({ tc: count() }).from(tenants);

    // The buggy code either produces duplicates (tc > 1) or some calls throw
    // due to the unique constraint on slug. Both demonstrate a race failure.
    const buggyCodeFailed = Number(tc) > 1 || rejected.length > 0;
    expect(
      buggyCodeFailed,
      `Buggy code did not fail (tc=${tc}, rejections=${rejected.length}). ` +
      `The gate confirmed overlap, so the race window was open. ` +
      `If this fires, the pg_sleep in bootstrapSeedBuggy may need increasing.`,
    ).toBe(true);
  }, 30_000);
});
