/**
 * Integration tests for the grid snapshot worker (processGridSnapshotTick).
 *
 * Tests:
 * - Writes 16 zero-filled rows per tenant for the UTC day of `now`
 * - Buckets contacts exactly like the retention-grid read model, with paying counts
 * - Idempotent: a second run on the same day overwrites, never duplicates
 * - A run on a later day writes a separate day's rows (history accumulates)
 * - Tenant isolation: each tenant gets only its own counts
 *
 * Requires local Postgres (docker compose up postgres).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { sql } from "drizzle-orm";
import { tenants, contacts, retentionGridSnapshots } from "@claros/db/schema";
import { processGridSnapshotTick } from "../src/snapshot-retention-grid.js";

const TEST_DB_URL = process.env.DATABASE_URL;
if (!TEST_DB_URL) {
  const inCI = process.env.CI === "true";
  throw new Error(
    `[grid-snapshot.test] DATABASE_URL is not set.\n\n` +
      `This test requires a Postgres connection.\n` +
      (inCI
        ? `Set the variable in the workflow env block:\n\n  DATABASE_URL: postgres://claros:claros@localhost:5432/claros\n`
        : `Set the variable in .env (see .env.example) or export it:\n\n  export DATABASE_URL='postgres://claros:claros@localhost:5433/claros'\n`),
  );
}

let pool: pg.Pool;
let db: ReturnType<typeof drizzle>;
let dbAvailable = false;
let tenantAId: string;
let tenantBId: string;

const SLUG_A = "test-grid-snapshot-a";
const SLUG_B = "test-grid-snapshot-b";
const DAY_MS = 24 * 60 * 60 * 1000;

// Bucketing inside the handler uses the database clock, so fixture
// timestamps are relative to real now.
function daysAgo(n: number): Date {
  return new Date(Date.now() - n * DAY_MS);
}

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
        `[grid-snapshot.test] DATABASE_URL not reachable in CI.\n` +
          `URL: ${TEST_DB_URL}\nCause: ${(err as Error).message}`,
      );
    }
    console.warn("[grid-snapshot.test] DATABASE_URL not reachable - tests skipped.");
    return;
  }

  await cleanup();

  const [a] = await db
    .insert(tenants)
    .values({ name: "Test Grid Snapshot A", slug: SLUG_A, plan: "free" })
    .returning({ id: tenants.id });
  tenantAId = a!.id;
  const [b] = await db
    .insert(tenants)
    .values({ name: "Test Grid Snapshot B", slug: SLUG_B, plan: "free" })
    .returning({ id: tenants.id });
  tenantBId = b!.id;
});

beforeEach(async () => {
  if (!dbAvailable) return;
  await db.execute(sql`DELETE FROM retention_grid_snapshots WHERE tenant_id IN (${tenantAId}, ${tenantBId})`);
  await db.execute(sql`DELETE FROM contacts WHERE tenant_id IN (${tenantAId}, ${tenantBId})`);
});

afterAll(async () => {
  if (dbAvailable) {
    await cleanup();
  }
  await pool.end();
});

async function cleanup() {
  await db.execute(
    sql`DELETE FROM retention_grid_snapshots WHERE tenant_id IN (SELECT id FROM tenants WHERE slug IN (${SLUG_A}, ${SLUG_B}))`,
  );
  await db.execute(
    sql`DELETE FROM contacts WHERE tenant_id IN (SELECT id FROM tenants WHERE slug IN (${SLUG_A}, ${SLUG_B}))`,
  );
  await db.execute(sql`DELETE FROM tenants WHERE slug IN (${SLUG_A}, ${SLUG_B})`);
}

async function snapshotRows(tenantId: string) {
  return (
    await db.execute<{
      snapshot_date: string;
      tenure_bucket: string;
      recency_bucket: string;
      contact_count: number;
      paying_count: number;
    }>(sql`
      SELECT snapshot_date::text, tenure_bucket, recency_bucket, contact_count, paying_count
      FROM retention_grid_snapshots
      WHERE tenant_id = ${tenantId}
      ORDER BY snapshot_date, tenure_bucket, recency_bucket
    `)
  ).rows;
}

describe("processGridSnapshotTick", () => {
  it("writes 16 zero-filled rows for a tenant with no contacts", async () => {
    if (!dbAvailable) return;
    const now = new Date();
    const result = await processGridSnapshotTick(db, now, [tenantAId]);

    expect(result.tenantsProcessed).toBe(1);
    expect(result.rowsWritten).toBe(16);
    expect(result.snapshotDate).toBe(now.toISOString().slice(0, 10));

    const rows = await snapshotRows(tenantAId);
    expect(rows.length).toBe(16);
    expect(rows.every((r) => r.contact_count === 0 && r.paying_count === 0)).toBe(true);
    expect(rows.every((r) => r.snapshot_date === result.snapshotDate)).toBe(true);
  });

  it("buckets contacts like the read model, with paying counts", async () => {
    if (!dbAvailable) return;
    // Default rhythm (7d): active <7d, cooling 7-13d, idle 14-27d, dormant 28d+.
    await db.insert(contacts).values([
      // new + active, paying
      { tenantId: tenantAId, externalId: "s1", email: "s1@x.dev", lifecycleState: "engaged",
        firstSeenAt: daysAgo(10), lastSeenAt: daysAgo(2), paymentStatus: "paid" },
      // new + active, free
      { tenantId: tenantAId, externalId: "s2", email: "s2@x.dev", lifecycleState: "engaged",
        firstSeenAt: daysAgo(5), lastSeenAt: daysAgo(1), paymentStatus: "free" },
      // loyal + dormant, past_due counts as paying
      { tenantId: tenantAId, externalId: "s3", email: "s3@x.dev", lifecycleState: "dormant",
        firstSeenAt: daysAgo(200), lastSeenAt: daysAgo(40), paymentStatus: "past_due" },
    ]);
    // Tenant B: one growing + cooling contact (isolation check)
    await db.insert(contacts).values({
      tenantId: tenantBId, externalId: "sb1", email: "sb1@x.dev", lifecycleState: "engaged",
      firstSeenAt: daysAgo(50), lastSeenAt: daysAgo(10), paymentStatus: "free",
    });

    const now = new Date();
    // Scope to the test tenants: an unscoped tick snapshots every tenant in
    // the database, which other suites' fixtures cannot tolerate.
    await processGridSnapshotTick(db, now, [tenantAId, tenantBId]);

    const rowsA = await snapshotRows(tenantAId);
    const cell = (t: string, r: string) =>
      rowsA.find((row) => row.tenure_bucket === t && row.recency_bucket === r);

    expect(cell("new", "active")?.contact_count).toBe(2);
    expect(cell("new", "active")?.paying_count).toBe(1);
    expect(cell("loyal", "dormant")?.contact_count).toBe(1);
    expect(cell("loyal", "dormant")?.paying_count).toBe(1);
    expect(cell("growing", "cooling")?.contact_count).toBe(0);

    const rowsB = await snapshotRows(tenantBId);
    expect(
      rowsB.find((r) => r.tenure_bucket === "growing" && r.recency_bucket === "cooling")
        ?.contact_count,
    ).toBe(1);
    expect(rowsB.reduce((acc, r) => acc + r.contact_count, 0)).toBe(1);
  });

  it("is idempotent within a day and accumulates history across days", async () => {
    if (!dbAvailable) return;
    await db.insert(contacts).values({
      tenantId: tenantAId, externalId: "s1", email: "s1@x.dev", lifecycleState: "engaged",
      firstSeenAt: daysAgo(3), lastSeenAt: daysAgo(1), paymentStatus: "free",
    });

    const now = new Date();
    await processGridSnapshotTick(db, now, [tenantAId]);
    // Second run same day: overwrite, not duplicate.
    await processGridSnapshotTick(db, now, [tenantAId]);

    let rows = await snapshotRows(tenantAId);
    expect(rows.length).toBe(16);

    // Simulate a contact leaving the cell, then re-run: same-day row updates.
    await db.execute(
      sql`UPDATE contacts SET last_seen_at = ${daysAgo(30)} WHERE tenant_id = ${tenantAId}`,
    );
    await processGridSnapshotTick(db, now, [tenantAId]);
    rows = await snapshotRows(tenantAId);
    expect(rows.length).toBe(16);
    expect(
      rows.find((r) => r.tenure_bucket === "new" && r.recency_bucket === "active")
        ?.contact_count,
    ).toBe(0);
    expect(
      rows.find((r) => r.tenure_bucket === "new" && r.recency_bucket === "dormant")
        ?.contact_count,
    ).toBe(1);

    // Next day: a separate set of 16 rows.
    await processGridSnapshotTick(db, new Date(now.getTime() + DAY_MS), [tenantAId]);
    rows = await snapshotRows(tenantAId);
    expect(rows.length).toBe(32);
    expect(new Set(rows.map((r) => r.snapshot_date)).size).toBe(2);
  });
});
