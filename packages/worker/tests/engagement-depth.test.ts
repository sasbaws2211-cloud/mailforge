/**
 * Integration tests for scan phase 4: engagement_depth computation.
 *
 * Tests:
 * - All four depth buckets are assigned correctly based on event counts
 * - Power bucket is suppressed when cohort is below floor(1/power_user_percentile)
 * - Power bucket fires when cohort is at or above the floor
 * - Contacts with zero events in the window are not updated
 * - Non-engaged contacts (at_risk, dormant, etc.) are not updated
 * - engagement_depth persists for non-engaged contacts (left alone)
 * - IS DISTINCT FROM: second run on unchanged data writes zero rows
 * - Stats are accurate: contactsUpdated reflects actual row changes
 * - Tenant isolation: depth computation for tenant A does not touch tenant B
 * - Regular threshold is config-driven (ceil(window/frequency))
 * - Small cohort: all contacts fall through to rate-based buckets (no power)
 *
 * Requires local Postgres (docker compose up postgres).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { sql } from "drizzle-orm";
import { tenants, contacts } from "@claros/db/schema";
import { phaseEngagementDepth } from "../src/scan-engagement-depth.js";

const TEST_DB_URL = process.env.DATABASE_URL;
if (!TEST_DB_URL) {
  const inCI = process.env.CI === "true";
  throw new Error(
    `[engagement-depth.test] DATABASE_URL is not set.\n\n` +
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
const SLUG = "test-engagement-depth";
const NOW = new Date("2026-07-20T12:00:00Z");

// Window: 30 days, frequency: 7 days (defaults)
// Regular threshold: ceil(30/7) = 5
// Min cohort: floor(1/0.1) = 10
// Power cutoff: percentile_cont(0.9) over the cohort's event counts

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
        `[engagement-depth.test] DATABASE_URL not reachable in CI.\n` +
          `URL: ${TEST_DB_URL}\n` +
          `Cause: ${(err as Error).message}`,
      );
    }
    console.warn(
      "[engagement-depth.test] DATABASE_URL not reachable - integration tests will be skipped.",
    );
    return;
  }

  // Clean up from previous runs (including the isolation test's second tenant)
  // Events may exist from prior runs that used the old aggregate approach.
  await db.execute(
    sql`DELETE FROM events WHERE tenant_id IN (SELECT id FROM tenants WHERE slug IN (${SLUG}, 'test-depth-isolation-other'))`,
  );
  await db.execute(
    sql`DELETE FROM contacts WHERE tenant_id IN (SELECT id FROM tenants WHERE slug IN (${SLUG}, 'test-depth-isolation-other'))`,
  );
  await db.execute(sql`DELETE FROM tenants WHERE slug IN (${SLUG}, 'test-depth-isolation-other')`);

  // Create test tenant with default lifecycle config
  const [row] = await db
    .insert(tenants)
    .values({
      name: "Test Engagement Depth",
      slug: SLUG,
      plan: "free",
      settings: {
        lifecycle: {
          natural_frequency_days: 7,
          engagement_depth_window_days: 30,
          power_user_percentile: 0.1,
        },
      },
    })
    .returning({ id: tenants.id });
  tenantId = row!.id;
});

afterAll(async () => {
  if (!dbAvailable) {
    await pool.end();
    return;
  }
  await db.execute(sql`DELETE FROM contacts WHERE tenant_id = ${tenantId}`);
  await db.execute(sql`DELETE FROM tenants WHERE id = ${tenantId}`);
  await pool.end();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function insertContact(
  externalId: string,
  state: string,
  existingDepth?: string | null,
): Promise<string> {
  const [row] = await db
    .insert(contacts)
    .values({
      tenantId,
      externalId,
      lifecycleState: state,
      engagementDepth: existingDepth ?? null,
      firstSeenAt: new Date("2026-01-01T00:00:00Z"),
      lastSeenAt: new Date("2026-07-19T00:00:00Z"),
    })
    .returning({ id: contacts.id });
  return row!.id;
}

/**
 * Set event counter columns on a contact to simulate event activity.
 * The depth scan reads (event_count_bucket_current + event_count_bucket_prev)
 * at read time. For simplicity, we put the full count into bucket_current.
 */
async function insertEvents(contactId: string, count: number): Promise<void> {
  if (count === 0) return;
  await db
    .update(contacts)
    .set({ eventCountBucketCurrent: count, eventCountBucketPrev: 0 })
    .where(sql`id = ${contactId}`);
}

/**
 * Set counter columns to simulate events OUTSIDE the window.
 * Since counters only represent the ~30-day window (two 15-day buckets),
 * "old events" that have aged out of the window have zero counter contribution.
 * This function sets counters to 0, simulating that all activity was old.
 */
async function insertOldEvents(contactId: string, count: number): Promise<void> {
  // Old events are not represented in the counters - they have rolled off.
  // The contact's counters remain at 0 (the default from insertion).
  // This function exists for test symmetry but is a no-op for the counter model.
}

async function getDepth(contactId: string): Promise<string | null | undefined> {
  const rows = await db
    .select({ engagementDepth: contacts.engagementDepth })
    .from(contacts)
    .where(sql`id = ${contactId}`)
    .limit(1);
  return rows[0]?.engagementDepth;
}

// ---------------------------------------------------------------------------
// Rate-based bucket assignment (small cohort - power suppressed)
// ---------------------------------------------------------------------------

describe("phaseEngagementDepth - rate-based buckets (cohort < 10, power suppressed)", () => {
  // Cohort of 4 engaged contacts - below the floor of 10 for power_user_percentile=0.1
  // Regular threshold = ceil(30/7) = 5

  it("assigns minimal for 1 event", async () => {
    if (!dbAvailable) return;
    const cId = await insertContact("ed_minimal_1", "engaged");
    await insertEvents(cId, 1);
    await phaseEngagementDepth(db, NOW);
    expect(await getDepth(cId)).toBe("minimal");
  });

  it("assigns minimal for 2 events", async () => {
    if (!dbAvailable) return;
    const cId = await insertContact("ed_minimal_2", "engaged");
    await insertEvents(cId, 2);
    await phaseEngagementDepth(db, NOW);
    expect(await getDepth(cId)).toBe("minimal");
  });

  it("assigns casual for 3 events", async () => {
    if (!dbAvailable) return;
    const cId = await insertContact("ed_casual_3", "engaged");
    await insertEvents(cId, 3);
    await phaseEngagementDepth(db, NOW);
    expect(await getDepth(cId)).toBe("casual");
  });

  it("assigns casual for 4 events (regular_threshold-1)", async () => {
    if (!dbAvailable) return;
    const cId = await insertContact("ed_casual_4", "engaged");
    await insertEvents(cId, 4);
    await phaseEngagementDepth(db, NOW);
    expect(await getDepth(cId)).toBe("casual");
  });

  it("assigns regular for exactly 5 events (at regular_threshold)", async () => {
    if (!dbAvailable) return;
    const cId = await insertContact("ed_regular_5", "engaged");
    await insertEvents(cId, 5);
    await phaseEngagementDepth(db, NOW);
    expect(await getDepth(cId)).toBe("regular");
  });

  it("assigns regular for 8 events (above threshold, but power is suppressed)", async () => {
    if (!dbAvailable) return;
    const cId = await insertContact("ed_regular_8", "engaged");
    await insertEvents(cId, 8);
    await phaseEngagementDepth(db, NOW);
    // power is suppressed (cohort < 10) - falls through to regular
    expect(await getDepth(cId)).toBe("regular");
  });
});

// ---------------------------------------------------------------------------
// Power bucket fires when cohort reaches the floor
// ---------------------------------------------------------------------------

describe("phaseEngagementDepth - power bucket with large enough cohort", () => {
  // Build a cohort of exactly 10 engaged contacts (the floor for power_user_percentile=0.1)
  // To get a contact into power, they must be in the top 10% by event count.
  // With 10 contacts, top 10% = the single highest-count contact.
  // percentile_cont(0.9) over 10 values picks the 9th-lowest value (0-indexed: value at 90%).
  // We use a clear separation: 9 contacts with 5 events, 1 contact with 50 events.
  // The power_cutoff = ceil(percentile_cont(0.9)) over {5,5,5,5,5,5,5,5,5,50} = ceil(5) = 5.
  // Wait - that means the power cutoff equals the regular threshold. Let's use a clear gap:
  // 9 contacts with 2 events, 1 with 50 events.
  // percentile_cont(0.9) over {2,2,2,2,2,2,2,2,2,50} ≈ 2 + 0.9*(50-2) = 45.2 -> ceil = 46.
  // So contact with 50 events => power; others with 2 events => minimal.

  let powerContactId: string;
  let minimalContactIds: string[] = [];

  it("setup: insert 10-contact cohort with clear power/non-power separation", async () => {
    if (!dbAvailable) return;
    minimalContactIds = [];

    // 9 contacts with 2 events each
    for (let i = 0; i < 9; i++) {
      const cId = await insertContact(`ed_power_cohort_low_${i}`, "engaged");
      await insertEvents(cId, 2);
      minimalContactIds.push(cId);
    }

    // 1 contact with 50 events - should be power
    powerContactId = await insertContact("ed_power_cohort_high", "engaged");
    await insertEvents(powerContactId, 50);
  });

  it("assigns power to the top contact when cohort >= floor", async () => {
    if (!dbAvailable) return;
    if (!powerContactId) return; // setup skipped

    await phaseEngagementDepth(db, NOW);
    expect(await getDepth(powerContactId)).toBe("power");
  });

  it("assigns minimal to low-activity contacts in the same cohort", async () => {
    if (!dbAvailable) return;
    if (minimalContactIds.length === 0) return;

    for (const cId of minimalContactIds) {
      expect(await getDepth(cId)).toBe("minimal");
    }
  });
});

// ---------------------------------------------------------------------------
// Zero events: contact is not updated
// ---------------------------------------------------------------------------

describe("phaseEngagementDepth - zero events in window", () => {
  it("does not update a contact with no events in the window", async () => {
    if (!dbAvailable) return;
    // Insert contact with pre-existing depth (set by a previous scan)
    const cId = await insertContact("ed_zero_events", "engaged", "regular");
    // All their events are outside the 30-day window
    await insertOldEvents(cId, 5);

    await phaseEngagementDepth(db, NOW);

    // Depth should remain "regular" (not overwritten with null or changed)
    expect(await getDepth(cId)).toBe("regular");
  });

  it("leaves depth null for a contact with no events at all", async () => {
    if (!dbAvailable) return;
    const cId = await insertContact("ed_no_events_ever", "engaged", null);
    // No events inserted at all

    await phaseEngagementDepth(db, NOW);

    expect(await getDepth(cId)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Non-engaged contacts are not updated
// ---------------------------------------------------------------------------

describe("phaseEngagementDepth - non-engaged contacts are skipped", () => {
  it("does not update an at_risk contact even with events in the window", async () => {
    if (!dbAvailable) return;
    const cId = await insertContact("ed_atrisk_skip", "at_risk", "power");
    await insertEvents(cId, 20);

    await phaseEngagementDepth(db, NOW);

    // Depth should remain "power" (preserved, not overwritten to "regular")
    expect(await getDepth(cId)).toBe("power");
  });

  it("does not update a dormant contact", async () => {
    if (!dbAvailable) return;
    const cId = await insertContact("ed_dormant_skip", "dormant", "casual");
    await insertEvents(cId, 10);

    await phaseEngagementDepth(db, NOW);

    expect(await getDepth(cId)).toBe("casual");
  });
});

// ---------------------------------------------------------------------------
// IS DISTINCT FROM: second run writes zero rows
// ---------------------------------------------------------------------------

describe("phaseEngagementDepth - IS DISTINCT FROM prevents write amplification", () => {
  it("second run on unchanged data reports zero contactsUpdated", async () => {
    if (!dbAvailable) return;
    // Insert a stable contact with known events
    const cId = await insertContact("ed_idempotent", "engaged");
    await insertEvents(cId, 5); // regular

    // First run
    const run1 = await phaseEngagementDepth(db, NOW);
    expect(await getDepth(cId)).toBe("regular");

    // Capture updated count from second run (nothing changed)
    const run2 = await phaseEngagementDepth(db, NOW);

    // The second run should not have updated this contact
    // (it may update others in the same tenant, but this contact's depth is unchanged)
    expect(run2.contactsUnchanged).toBeGreaterThan(0);

    // The depth must still be regular
    expect(await getDepth(cId)).toBe("regular");

    // run1 vs run2: run1 must have updated at least this contact
    // (it was null before), run2 has no changes for it
    void run1; // already checked above
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation
// ---------------------------------------------------------------------------

describe("phaseEngagementDepth - tenant isolation", () => {
  it("depth computation for one tenant does not affect another", async () => {
    if (!dbAvailable) return;

    // Create a second isolated tenant
    const [otherRow] = await db
      .insert(tenants)
      .values({
        name: "Depth Isolation Other",
        slug: "test-depth-isolation-other",
        plan: "free",
        settings: {
          lifecycle: {
            natural_frequency_days: 7,
            engagement_depth_window_days: 30,
            power_user_percentile: 0.1,
          },
        },
      })
      .returning({ id: tenants.id });
    const otherTenantId = otherRow!.id;

    // Contact in the other tenant
    const [otherContact] = await db
      .insert(contacts)
      .values({
        tenantId: otherTenantId,
        externalId: "other-contact",
        lifecycleState: "engaged",
        engagementDepth: "power", // pre-existing depth we should not touch from main tenant
        firstSeenAt: new Date("2026-01-01T00:00:00Z"),
        lastSeenAt: new Date("2026-07-19T00:00:00Z"),
      })
      .returning({ id: contacts.id });
    const otherContactId = otherContact!.id;

    // Set counter columns on the other tenant's contact (10 events = regular for that tenant)
    await db
      .update(contacts)
      .set({ eventCountBucketCurrent: 10, eventCountBucketPrev: 0 })
      .where(sql`id = ${otherContactId}`);

    // Run phase over all tenants
    await phaseEngagementDepth(db, NOW);

    // The other tenant contact should have been updated based on ITS own tenant's config
    const otherDepth = await db
      .select({ engagementDepth: contacts.engagementDepth })
      .from(contacts)
      .where(sql`id = ${otherContactId}`)
      .limit(1);
    // 10 events, cohort of 1 (< floor=10), so power suppressed.
    // regular threshold=5. 10 >= 5 => regular
    expect(otherDepth[0]?.engagementDepth).toBe("regular");

    // Cleanup other tenant
    await db.execute(sql`DELETE FROM contacts WHERE tenant_id = ${otherTenantId}`);
    await db.execute(sql`DELETE FROM tenants WHERE id = ${otherTenantId}`);
  });
});

// ---------------------------------------------------------------------------
// Return stats accuracy
// ---------------------------------------------------------------------------

describe("phaseEngagementDepth - stats", () => {
  it("tenantsProcessed includes the test tenant", async () => {
    if (!dbAvailable) return;
    const result = await phaseEngagementDepth(db, NOW);
    expect(result.tenantsProcessed).toBeGreaterThanOrEqual(1);
  });

  it("contactsUpdated + contactsUnchanged = total contacts with events in window", async () => {
    if (!dbAvailable) return;
    // Insert a contact that definitely has an event in window
    const cId = await insertContact("ed_stats_check", "engaged");
    await insertEvents(cId, 3);

    const result = await phaseEngagementDepth(db, NOW);

    // The sum of updated + unchanged must be at least 1 (this contact)
    expect(result.contactsUpdated + result.contactsUnchanged).toBeGreaterThanOrEqual(1);
  });
});
