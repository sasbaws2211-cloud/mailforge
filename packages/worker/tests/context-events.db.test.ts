/**
 * Integration tests for context-events.ts (slice 18.2).
 *
 * Tests the cadence and behavior sections of the context packet builder.
 * All tests run against a real Postgres database; the events table is
 * partitioned by received_at so several cases specifically test that
 * month-boundary events are counted correctly.
 *
 * Coverage:
 *   cadence:
 *     - Contact with events across both 7-day windows produces correct counts
 *     - Declining trend exactly at the boundary condition (both sides)
 *     - Contact with no events yields zero counts and stable trend
 *     - Events outside 14-day window are excluded from cadence
 *
 *   behavior:
 *     - last_action is the most recent event (event_name + timestamp, no properties)
 *     - recent_events returns the ten most recent in DESC order
 *     - recent_events is absent when there are no events
 *     - most_used_features returns the five most frequent in the correct order
 *     - most_used_features tie-break is alphabetical ascending
 *     - events outside the 30-day window are excluded from most_used_features
 *     - null event_name (identify events) excluded from most_used_features
 *
 *   isolation:
 *     - events belonging to another tenant never appear
 *     - events belonging to another contact (same tenant) never appear
 *
 *   partitioning:
 *     - events spanning a month boundary are counted correctly
 *     - an event whose timestamp is inside the window but received_at is slightly
 *       earlier than the window bound is still counted (clock-skew slack)
 *     - an event whose timestamp is outside the window on both columns is excluded
 *     - EXPLAIN output confirms partition pruning actually occurs
 *
 * Requires local Postgres with the partitioned events table (docker compose up).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { sql } from "drizzle-orm";
import { tenants, contacts } from "@claros/db/schema";
import {
  buildEventSections,
  computeTrend,
  CADENCE_RECEIVED_AT_SLACK_MS,
  CADENCE_WINDOW_DAYS,
  FEATURES_WINDOW_DAYS,
  MOST_USED_FEATURES_COUNT,
  RECENT_EVENTS_COUNT,
} from "../src/context-events.js";

// ---------------------------------------------------------------------------
// Re-export pure function for unit tests (no DB needed)
// ---------------------------------------------------------------------------

// computeTrend is exported from context-events so we can unit-test the formula
// without a DB connection.

// ---------------------------------------------------------------------------
// DB setup
// ---------------------------------------------------------------------------

const TEST_DB_URL = process.env.DATABASE_URL;
if (!TEST_DB_URL) {
  const inCI = process.env.CI === "true";
  throw new Error(
    `[context-events.test] DATABASE_URL is not set.\n\n` +
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
let otherTenantId: string;

const SLUG = "test-ctx-events";
const SLUG_OTHER = "test-ctx-events-other";

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
        `[context-events.test] DATABASE_URL not reachable in CI.\n` +
          `URL: ${TEST_DB_URL}\nCause: ${(err as Error).message}`,
      );
    }
    console.warn("[context-events.test] DATABASE_URL not reachable - tests skipped.");
    return;
  }

  await cleanup();

  const [tenant] = await db
    .insert(tenants)
    .values({ name: "Test Ctx Events", slug: SLUG, plan: "free" })
    .returning({ id: tenants.id });
  testTenantId = tenant!.id;

  const [other] = await db
    .insert(tenants)
    .values({ name: "Test Ctx Events Other", slug: SLUG_OTHER, plan: "free" })
    .returning({ id: tenants.id });
  otherTenantId = other!.id;
});

beforeEach(async () => {
  if (!dbAvailable) return;
  // Delete events first (FK from events -> contacts), then contacts.
  await db.execute(sql`DELETE FROM events WHERE tenant_id = ${testTenantId}`);
  await db.execute(sql`DELETE FROM events WHERE tenant_id = ${otherTenantId}`);
  await db.execute(sql`DELETE FROM lifecycle_transitions WHERE contact_id IN (SELECT id FROM contacts WHERE tenant_id = ${testTenantId})`);
  await db.execute(sql`DELETE FROM lifecycle_transitions WHERE contact_id IN (SELECT id FROM contacts WHERE tenant_id = ${otherTenantId})`);
  await db.execute(sql`DELETE FROM contacts WHERE tenant_id = ${testTenantId}`);
  await db.execute(sql`DELETE FROM contacts WHERE tenant_id = ${otherTenantId}`);
});

afterAll(async () => {
  if (dbAvailable) await cleanup();
  await pool.end();
});

async function cleanup() {
  for (const slug of [SLUG, SLUG_OTHER]) {
    await db.execute(
      sql`DELETE FROM events WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${slug})`,
    );
    await db.execute(
      sql`DELETE FROM lifecycle_transitions WHERE contact_id IN (SELECT id FROM contacts WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${slug}))`,
    );
    await db.execute(
      sql`DELETE FROM contacts WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${slug})`,
    );
    await db.execute(sql`DELETE FROM tenants WHERE slug = ${slug}`);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function insertContact(
  externalId: string,
  tenantId: string = testTenantId,
): Promise<string> {
  const [row] = await db
    .insert(contacts)
    .values({
      tenantId,
      externalId,
      lifecycleState: "engaged",
      firstSeenAt: new Date("2026-01-01T00:00:00Z"),
    })
    .returning({ id: contacts.id });
  return row!.id;
}

/**
 * Insert an event with explicit timestamp and received_at.
 *
 * The events table is partitioned by received_at. If received_at falls
 * outside an existing partition range, the insert will fail. The test
 * Postgres instance has partitions for 2026-07 through 2026-12 (from
 * migration 0010). Events with received_at in prior months require a
 * partition to exist; for cross-partition tests we create them on demand.
 */
async function insertEvent(opts: {
  contactId: string;
  tenantId?: string;
  eventName: string | null;
  timestamp: Date;
  receivedAt?: Date;
}): Promise<string> {
  const tenantId = opts.tenantId ?? testTenantId;
  const receivedAt = opts.receivedAt ?? opts.timestamp;

  // Raw INSERT so we can set received_at explicitly (Drizzle's defaultNow() would override)
  const result = await db.execute<{ id: string }>(sql`
    INSERT INTO events (tenant_id, contact_id, type, event_name, timestamp, received_at)
    VALUES (
      ${tenantId}::uuid,
      ${opts.contactId}::uuid,
      'track',
      ${opts.eventName},
      ${opts.timestamp.toISOString()}::timestamptz,
      ${receivedAt.toISOString()}::timestamptz
    )
    RETURNING id
  `);
  return result.rows[0]!.id;
}

/**
 * Ensure a monthly partition exists for a given year+month on the events table.
 * Idempotent: CREATE TABLE IF NOT EXISTS.
 */
async function ensurePartition(year: number, month: number): Promise<void> {
  const mm = month.toString().padStart(2, "0");
  const name = `events_y${year}m${mm}`;
  let nextYear = year;
  let nextMonth = month + 1;
  if (nextMonth > 12) { nextMonth = 1; nextYear++; }
  const nmm = nextMonth.toString().padStart(2, "0");
  await db.execute(
    sql.raw(
      `CREATE TABLE IF NOT EXISTS ${name} PARTITION OF events ` +
        `FOR VALUES FROM ('${year}-${mm}-01') TO ('${nextYear}-${nmm}-01')`,
    ),
  );
}

// ---------------------------------------------------------------------------
// Unit tests for computeTrend (pure function, no DB)
// ---------------------------------------------------------------------------

describe("computeTrend", () => {
  it("returns 'stable' when previous_7d < 3 (floor condition not met)", () => {
    // previous_7d = 2, current_7d = 0: formula requires previous_7d >= 3
    expect(computeTrend(0, 2)).toBe("stable");
  });

  it("returns 'stable' when previous_7d = 3 and current_7d > previous*0.5", () => {
    // previous=3, current=2: 2 > 1.5, so NOT declining
    expect(computeTrend(2, 3)).toBe("stable");
  });

  it("returns 'declining' when previous_7d = 3 and current_7d = 1 (exactly half)", () => {
    // previous=3 (>= 3), current=1 (<= 3*0.5=1.5). 1 <= 1.5 -> declining
    expect(computeTrend(1, 3)).toBe("declining");
  });

  it("returns 'declining' when exactly at boundary: current = floor(previous*0.5)", () => {
    // previous=4, current=2: 2 <= 4*0.5=2, and previous >= 3 -> declining
    expect(computeTrend(2, 4)).toBe("declining");
  });

  it("returns 'stable' one above boundary: current = previous*0.5 + 1", () => {
    // previous=4, current=3: 3 > 4*0.5=2 -> stable
    expect(computeTrend(3, 4)).toBe("stable");
  });

  it("returns 'declining' with large values well inside boundary", () => {
    // previous=10, current=2: 2 <= 5 and 10>=3 -> declining
    expect(computeTrend(2, 10)).toBe("declining");
  });

  it("returns 'stable' when both are zero", () => {
    expect(computeTrend(0, 0)).toBe("stable");
  });

  it("returns 'stable' when current equals previous (no decline)", () => {
    expect(computeTrend(5, 5)).toBe("stable");
  });

  it("returns 'declining' at the minimum qualifying previous value (3) with current=0", () => {
    // previous=3, current=0: 0 <= 1.5 and 3>=3 -> declining
    expect(computeTrend(0, 3)).toBe("declining");
  });

  it("returns 'stable' at previous=2 (below floor) even with zero current", () => {
    // previous=2, current=0: previous < 3 -> stable (floor not met)
    expect(computeTrend(0, 2)).toBe("stable");
  });
});

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------

describe("buildEventSections", () => {
  it("skips when DATABASE_URL is not reachable", () => {
    if (!dbAvailable) expect(true).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Cadence: correct counts across both windows
  // -------------------------------------------------------------------------

  describe("cadence - event counts across both windows", () => {
    it("produces correct current_7d and previous_7d counts", async () => {
      if (!dbAvailable) return;

      const now = new Date("2026-09-15T12:00:00Z");
      const contactId = await insertContact("ev-cadence-counts");

      // 3 events in current 7-day window (last 7 days)
      for (let i = 1; i <= 3; i++) {
        await insertEvent({
          contactId,
          eventName: "page_view",
          timestamp: new Date(now.getTime() - i * 24 * 60 * 60 * 1000),
        });
      }

      // 5 events in previous 7-day window (8-14 days ago)
      for (let i = 8; i <= 12; i++) {
        await insertEvent({
          contactId,
          eventName: "page_view",
          timestamp: new Date(now.getTime() - i * 24 * 60 * 60 * 1000),
        });
      }

      const result = await buildEventSections(db, testTenantId, contactId, now);
      expect(result.cadence.current7d).toBe(3);
      expect(result.cadence.previous7d).toBe(5);
    });
  });

  // -------------------------------------------------------------------------
  // Cadence: declining trend boundary conditions (both sides)
  // -------------------------------------------------------------------------

  describe("cadence - trend boundary: spec formula is_declining = (prev7>=3) AND (cur7<=prev7*0.5)", () => {
    it("declining: previous=3, current=1 (1 <= 1.5, boundary met)", async () => {
      if (!dbAvailable) return;

      const now = new Date("2026-09-20T12:00:00Z");
      const contactId = await insertContact("ev-trend-declining-a");

      // 3 events in previous window
      for (let i = 8; i <= 10; i++) {
        await insertEvent({
          contactId,
          eventName: "click",
          timestamp: new Date(now.getTime() - i * 24 * 60 * 60 * 1000),
        });
      }
      // 1 event in current window (1 <= 3*0.5=1.5 -> declining)
      await insertEvent({
        contactId,
        eventName: "click",
        timestamp: new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000),
      });

      const result = await buildEventSections(db, testTenantId, contactId, now);
      expect(result.cadence.current7d).toBe(1);
      expect(result.cadence.previous7d).toBe(3);
      expect(result.cadence.trend).toBe("declining");
    });

    it("stable: previous=3, current=2 (2 > 1.5, boundary just above)", async () => {
      if (!dbAvailable) return;

      const now = new Date("2026-09-20T12:00:00Z");
      const contactId = await insertContact("ev-trend-stable-a");

      // 3 events in previous window
      for (let i = 8; i <= 10; i++) {
        await insertEvent({
          contactId,
          eventName: "click",
          timestamp: new Date(now.getTime() - i * 24 * 60 * 60 * 1000),
        });
      }
      // 2 events in current window (2 > 1.5 -> NOT declining)
      for (let i = 1; i <= 2; i++) {
        await insertEvent({
          contactId,
          eventName: "click",
          timestamp: new Date(now.getTime() - i * 24 * 60 * 60 * 1000),
        });
      }

      const result = await buildEventSections(db, testTenantId, contactId, now);
      expect(result.cadence.current7d).toBe(2);
      expect(result.cadence.previous7d).toBe(3);
      expect(result.cadence.trend).toBe("stable");
    });

    it("stable: previous=2 (below floor), current=0 (floor not met)", async () => {
      if (!dbAvailable) return;

      const now = new Date("2026-09-20T12:00:00Z");
      const contactId = await insertContact("ev-trend-stable-b");

      // 2 events in previous window (below the >= 3 floor)
      for (let i = 8; i <= 9; i++) {
        await insertEvent({
          contactId,
          eventName: "click",
          timestamp: new Date(now.getTime() - i * 24 * 60 * 60 * 1000),
        });
      }
      // 0 events in current window

      const result = await buildEventSections(db, testTenantId, contactId, now);
      expect(result.cadence.current7d).toBe(0);
      expect(result.cadence.previous7d).toBe(2);
      expect(result.cadence.trend).toBe("stable");
    });

    it("declining: previous=4, current=2 (exactly at boundary 2 = 4*0.5)", async () => {
      if (!dbAvailable) return;

      const now = new Date("2026-09-20T12:00:00Z");
      const contactId = await insertContact("ev-trend-declining-b");

      // 4 events in previous window
      for (let i = 8; i <= 11; i++) {
        await insertEvent({
          contactId,
          eventName: "click",
          timestamp: new Date(now.getTime() - i * 24 * 60 * 60 * 1000),
        });
      }
      // 2 events in current window (2 <= 4*0.5=2 -> declining)
      for (let i = 1; i <= 2; i++) {
        await insertEvent({
          contactId,
          eventName: "click",
          timestamp: new Date(now.getTime() - i * 24 * 60 * 60 * 1000),
        });
      }

      const result = await buildEventSections(db, testTenantId, contactId, now);
      expect(result.cadence.current7d).toBe(2);
      expect(result.cadence.previous7d).toBe(4);
      expect(result.cadence.trend).toBe("declining");
    });

    it("stable: previous=4, current=3 (3 > 2 -> NOT declining)", async () => {
      if (!dbAvailable) return;

      const now = new Date("2026-09-20T12:00:00Z");
      const contactId = await insertContact("ev-trend-stable-c");

      // 4 events in previous window
      for (let i = 8; i <= 11; i++) {
        await insertEvent({
          contactId,
          eventName: "click",
          timestamp: new Date(now.getTime() - i * 24 * 60 * 60 * 1000),
        });
      }
      // 3 events in current window (3 > 2 -> stable)
      for (let i = 1; i <= 3; i++) {
        await insertEvent({
          contactId,
          eventName: "click",
          timestamp: new Date(now.getTime() - i * 24 * 60 * 60 * 1000),
        });
      }

      const result = await buildEventSections(db, testTenantId, contactId, now);
      expect(result.cadence.current7d).toBe(3);
      expect(result.cadence.previous7d).toBe(4);
      expect(result.cadence.trend).toBe("stable");
    });
  });

  // -------------------------------------------------------------------------
  // No events: zero counts, stable trend, absent behavior fields
  // -------------------------------------------------------------------------

  describe("contact with no events", () => {
    it("yields zero cadence counts, stable trend, and absent behavior fields", async () => {
      if (!dbAvailable) return;

      const contactId = await insertContact("ev-no-events");
      const now = new Date("2026-09-15T12:00:00Z");

      const result = await buildEventSections(db, testTenantId, contactId, now);

      expect(result.cadence.current7d).toBe(0);
      expect(result.cadence.previous7d).toBe(0);
      expect(result.cadence.trend).toBe("stable");
      expect(result.behavior.lastAction).toBeUndefined();
      expect(result.behavior.recentEvents).toBeUndefined();
      expect(result.behavior.mostUsedFeatures).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Events outside the 14-day cadence window are excluded
  // -------------------------------------------------------------------------

  describe("cadence - events outside the 14-day window are excluded", () => {
    it("a 15-day-old event does not appear in either window", async () => {
      if (!dbAvailable) return;

      const now = new Date("2026-09-20T12:00:00Z");
      const contactId = await insertContact("ev-outside-cadence");

      // One event exactly 15 days ago (outside both 7d windows)
      await insertEvent({
        contactId,
        eventName: "old_event",
        timestamp: new Date(now.getTime() - 15 * 24 * 60 * 60 * 1000),
      });

      const result = await buildEventSections(db, testTenantId, contactId, now);
      expect(result.cadence.current7d).toBe(0);
      expect(result.cadence.previous7d).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Behavior: last_action and recent_events
  // -------------------------------------------------------------------------

  describe("behavior - last_action and recent_events", () => {
    it("last_action is the most recent event (event_name + timestamp, no properties)", async () => {
      if (!dbAvailable) return;

      const now = new Date("2026-09-15T12:00:00Z");
      const contactId = await insertContact("ev-behavior-last");

      const earlier = new Date("2026-09-10T10:00:00Z");
      const latest = new Date("2026-09-14T10:00:00Z");

      await insertEvent({ contactId, eventName: "button_click", timestamp: earlier });
      await insertEvent({ contactId, eventName: "feature_used", timestamp: latest });

      const result = await buildEventSections(db, testTenantId, contactId, now);
      expect(result.behavior.lastAction).toBeDefined();
      expect(result.behavior.lastAction!.eventName).toBe("feature_used");
      expect(result.behavior.lastAction!.timestamp).toBe(latest.toISOString());
    });

    it("recent_events returns up to ten most recent in DESC timestamp order", async () => {
      if (!dbAvailable) return;

      const now = new Date("2026-09-20T12:00:00Z");
      const contactId = await insertContact("ev-behavior-recent");

      // Insert 12 events, expect only the 10 most recent
      const timestamps: Date[] = [];
      for (let i = 1; i <= 12; i++) {
        const ts = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
        timestamps.push(ts);
        await insertEvent({ contactId, eventName: `event_${i}`, timestamp: ts });
      }

      const result = await buildEventSections(db, testTenantId, contactId, now);
      expect(result.behavior.recentEvents).toBeDefined();
      expect(result.behavior.recentEvents!.length).toBe(RECENT_EVENTS_COUNT); // 10

      // Most recent first
      expect(result.behavior.recentEvents![0]!.eventName).toBe("event_1");
      expect(result.behavior.recentEvents![9]!.eventName).toBe("event_10");
    });

    it("recent_events carries timestamp ISO string, not properties", async () => {
      if (!dbAvailable) return;

      const now = new Date("2026-09-15T12:00:00Z");
      const contactId = await insertContact("ev-behavior-fields");
      const ts = new Date("2026-09-14T08:00:00Z");

      await insertEvent({ contactId, eventName: "project_created", timestamp: ts });

      const result = await buildEventSections(db, testTenantId, contactId, now);
      const evt = result.behavior.recentEvents![0]!;
      expect(evt.eventName).toBe("project_created");
      expect(evt.timestamp).toBe(ts.toISOString());
      // No properties field on the returned object
      expect((evt as Record<string, unknown>)["properties"]).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Behavior: most_used_features
  // -------------------------------------------------------------------------

  describe("behavior - most_used_features", () => {
    it("returns the five most frequent event names in the last 30 days, most frequent first", async () => {
      if (!dbAvailable) return;

      const now = new Date("2026-09-20T12:00:00Z");
      const contactId = await insertContact("ev-features-order");
      const base = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000);

      // Insert different counts for 6 events (expect only top 5)
      const events_data = [
        { name: "alpha", count: 10 },
        { name: "beta", count: 8 },
        { name: "gamma", count: 6 },
        { name: "delta", count: 4 },
        { name: "epsilon", count: 2 },
        { name: "zeta", count: 1 }, // excluded (rank 6)
      ];

      for (const { name, count } of events_data) {
        for (let i = 0; i < count; i++) {
          await insertEvent({ contactId, eventName: name, timestamp: base });
        }
      }

      const result = await buildEventSections(db, testTenantId, contactId, now);
      expect(result.behavior.mostUsedFeatures).toBeDefined();
      expect(result.behavior.mostUsedFeatures!.length).toBe(MOST_USED_FEATURES_COUNT); // 5
      expect(result.behavior.mostUsedFeatures![0]).toBe("alpha");
      expect(result.behavior.mostUsedFeatures![1]).toBe("beta");
      expect(result.behavior.mostUsedFeatures![2]).toBe("gamma");
      expect(result.behavior.mostUsedFeatures![3]).toBe("delta");
      expect(result.behavior.mostUsedFeatures![4]).toBe("epsilon");
      // "zeta" (rank 6) must not appear
      expect(result.behavior.mostUsedFeatures!).not.toContain("zeta");
    });

    it("tie-break is alphabetical ascending when event counts are equal", async () => {
      if (!dbAvailable) return;

      const now = new Date("2026-09-20T12:00:00Z");
      const contactId = await insertContact("ev-features-tiebreak");
      const base = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000);

      // 6 events all with the same count (3). Tie-break must be alpha ascending.
      const names = ["zebra", "apple", "mango", "banana", "cherry", "date"];
      for (const name of names) {
        for (let i = 0; i < 3; i++) {
          await insertEvent({ contactId, eventName: name, timestamp: base });
        }
      }

      const result = await buildEventSections(db, testTenantId, contactId, now);
      const features = result.behavior.mostUsedFeatures!;
      expect(features.length).toBe(MOST_USED_FEATURES_COUNT); // 5

      // Alpha ascending: apple, banana, cherry, date, mango (zebra excluded)
      expect(features[0]).toBe("apple");
      expect(features[1]).toBe("banana");
      expect(features[2]).toBe("cherry");
      expect(features[3]).toBe("date");
      expect(features[4]).toBe("mango");
      expect(features).not.toContain("zebra");
    });

    it("events outside the 30-day window are excluded from most_used_features", async () => {
      if (!dbAvailable) return;

      const now = new Date("2026-09-20T12:00:00Z");
      const contactId = await insertContact("ev-features-old");

      // 5 events with event_name "old_feature" at 31 days ago (outside window)
      const oldTs = new Date(now.getTime() - 31 * 24 * 60 * 60 * 1000);
      for (let i = 0; i < 5; i++) {
        await insertEvent({
          contactId,
          eventName: "old_feature",
          timestamp: oldTs,
        });
      }

      // 1 event inside window
      await insertEvent({
        contactId,
        eventName: "new_feature",
        timestamp: new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000),
      });

      const result = await buildEventSections(db, testTenantId, contactId, now);
      // old_feature must not appear; new_feature must appear
      expect(result.behavior.mostUsedFeatures).toBeDefined();
      expect(result.behavior.mostUsedFeatures!).not.toContain("old_feature");
      expect(result.behavior.mostUsedFeatures!).toContain("new_feature");
    });

    it("null event_name (identify events) excluded from most_used_features", async () => {
      if (!dbAvailable) return;

      const now = new Date("2026-09-20T12:00:00Z");
      const contactId = await insertContact("ev-features-null-name");
      const base = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000);

      // 10 identify events (event_name = null)
      for (let i = 0; i < 10; i++) {
        await insertEvent({ contactId, eventName: null, timestamp: base });
      }
      // 1 named event
      await insertEvent({ contactId, eventName: "named_event", timestamp: base });

      const result = await buildEventSections(db, testTenantId, contactId, now);
      expect(result.behavior.mostUsedFeatures).toBeDefined();
      // Only named_event should appear; null events must not appear
      expect(result.behavior.mostUsedFeatures!.length).toBe(1);
      expect(result.behavior.mostUsedFeatures![0]).toBe("named_event");
    });
  });

  // -------------------------------------------------------------------------
  // Isolation: tenant and contact
  // -------------------------------------------------------------------------

  describe("isolation - another tenant's events never appear", () => {
    it("events from another tenant produce zero counts in the queried tenant", async () => {
      if (!dbAvailable) return;

      const now = new Date("2026-09-15T12:00:00Z");

      // Contact in testTenant (no events)
      const testContactId = await insertContact("ev-iso-tenant-main");

      // Contact in otherTenant with many events
      const otherContactId = await insertContact("ev-iso-tenant-other", otherTenantId);
      for (let i = 1; i <= 5; i++) {
        await insertEvent({
          contactId: otherContactId,
          tenantId: otherTenantId,
          eventName: "should_not_leak",
          timestamp: new Date(now.getTime() - i * 24 * 60 * 60 * 1000),
        });
      }

      const result = await buildEventSections(db, testTenantId, testContactId, now);
      expect(result.cadence.current7d).toBe(0);
      expect(result.cadence.previous7d).toBe(0);
      expect(result.behavior.recentEvents).toBeUndefined();
      expect(result.behavior.mostUsedFeatures).toBeUndefined();
    });
  });

  describe("isolation - another contact's events (same tenant) never appear", () => {
    it("events from a different contact do not appear in the queried contact's result", async () => {
      if (!dbAvailable) return;

      const now = new Date("2026-09-15T12:00:00Z");
      const contactA = await insertContact("ev-iso-contact-a");
      const contactB = await insertContact("ev-iso-contact-b");

      // Contact B has events; contact A has none
      for (let i = 1; i <= 3; i++) {
        await insertEvent({
          contactId: contactB,
          eventName: "b_event",
          timestamp: new Date(now.getTime() - i * 24 * 60 * 60 * 1000),
        });
      }

      const result = await buildEventSections(db, testTenantId, contactA, now);
      expect(result.cadence.current7d).toBe(0);
      expect(result.behavior.recentEvents).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Partitioning: events spanning a month boundary are counted correctly
  // -------------------------------------------------------------------------

  describe("partitioning - events spanning a month boundary are counted", () => {
    it("events in two different months are both counted when the window spans the boundary", async () => {
      if (!dbAvailable) return;

      // now = 2026-08-04. A 7-day window spans the 2026-07/2026-08 boundary.
      // Event at 2026-07-31 is in the July partition.
      // Event at 2026-08-02 is in the August partition.
      // Both must appear in current_7d.
      const now = new Date("2026-08-04T12:00:00Z");
      const contactId = await insertContact("ev-partition-boundary");

      // July partition (events_y2026m07) - ensure it exists
      await ensurePartition(2026, 7);

      const julEvent = new Date("2026-07-31T10:00:00Z");
      const augEvent = new Date("2026-08-02T10:00:00Z");

      await insertEvent({ contactId, eventName: "cross_month", timestamp: julEvent });
      await insertEvent({ contactId, eventName: "cross_month", timestamp: augEvent });

      const result = await buildEventSections(db, testTenantId, contactId, now);
      // Both events are within 7 days of now (2026-08-04) so both must appear
      expect(result.cadence.current7d).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // Clock-skew slack: event inside window on timestamp, slightly earlier received_at
  // -------------------------------------------------------------------------

  describe("clock-skew slack - received_at slightly earlier than semantic window bound", () => {
    it("event whose timestamp is inside the 7-day window but received_at is slightly earlier is still counted", async () => {
      if (!dbAvailable) return;

      // Scenario: client clock runs 1 hour ahead.
      //   now (server)    = 2026-09-15T12:00:00Z
      //   w7Start         = 2026-09-08T12:00:00Z  (semantic window boundary)
      //   event.timestamp = 2026-09-08T13:00:00Z  (inside semantic window, 1h after boundary)
      //   event.received_at = 2026-09-08T11:30:00Z  (30 min before the semantic boundary)
      //
      // Without the slack, a filter of received_at >= w7Start would exclude this event.
      // With the 72h slack, received_at >= (w7Start - 72h) = 2026-09-05T12:00:00Z
      // so 2026-09-08T11:30:00Z passes the pruning filter.
      // The timestamp filter then correctly includes it (2026-09-08T13:00:00Z >= w7Start).

      const now = new Date("2026-09-15T12:00:00Z");
      const w7Start = new Date(now.getTime() - CADENCE_WINDOW_DAYS * 24 * 60 * 60 * 1000);

      const contactId = await insertContact("ev-skew-inside");

      const eventTimestamp = new Date(w7Start.getTime() + 60 * 60 * 1000); // 1h AFTER semantic boundary
      const eventReceivedAt = new Date(w7Start.getTime() - 30 * 60 * 1000); // 30min BEFORE semantic boundary

      // received_at must be in an existing partition (September 2026)
      await insertEvent({
        contactId,
        eventName: "skew_event",
        timestamp: eventTimestamp,
        receivedAt: eventReceivedAt,
      });

      const result = await buildEventSections(db, testTenantId, contactId, now);
      // Must be counted in current_7d because timestamp is inside the window
      expect(result.cadence.current7d).toBe(1);
    });

    it("event far outside the window on both timestamp and received_at is excluded", async () => {
      if (!dbAvailable) return;

      // An event 20 days ago on both columns - well outside any window.
      const now = new Date("2026-09-20T12:00:00Z");
      const contactId = await insertContact("ev-outside-both");

      const oldTs = new Date(now.getTime() - 20 * 24 * 60 * 60 * 1000);
      await insertEvent({
        contactId,
        eventName: "very_old",
        timestamp: oldTs,
        receivedAt: oldTs, // received_at also old
      });

      const result = await buildEventSections(db, testTenantId, contactId, now);
      expect(result.cadence.current7d).toBe(0);
      expect(result.cadence.previous7d).toBe(0);
      // Should not appear in most_used_features (outside 30-day window? 20d is inside 30d...)
      // 20 days is inside 30-day window, but 20 days IS inside 30-day features window.
      // Correct: it should appear in features (within 30 days) but not cadence (outside 14 days).
    });

    it("event 35 days old on both columns is excluded from most_used_features", async () => {
      if (!dbAvailable) return;

      const now = new Date("2026-09-20T12:00:00Z");
      const contactId = await insertContact("ev-outside-features");

      // 35 days ago - outside the 30-day features window
      const oldTs = new Date(now.getTime() - 35 * 24 * 60 * 60 * 1000);

      // Need August partition for this test (2026-08-16 = 35 days before 2026-09-20)
      await ensurePartition(2026, 8);

      await insertEvent({
        contactId,
        eventName: "excluded_feature",
        timestamp: oldTs,
        receivedAt: oldTs,
      });

      // Also an event inside the window
      await insertEvent({
        contactId,
        eventName: "included_feature",
        timestamp: new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000),
      });

      const result = await buildEventSections(db, testTenantId, contactId, now);
      expect(result.behavior.mostUsedFeatures).toBeDefined();
      expect(result.behavior.mostUsedFeatures!).not.toContain("excluded_feature");
      expect(result.behavior.mostUsedFeatures!).toContain("included_feature");
    });
  });

  // -------------------------------------------------------------------------
  // Partition pruning verification via EXPLAIN
  // -------------------------------------------------------------------------

  describe("partition pruning - EXPLAIN confirms the planner prunes partitions", () => {
    it("EXPLAIN on the cadence query shows partition pruning (not all partitions scanned)", async () => {
      if (!dbAvailable) return;

      // Build the same query shape as buildEventSections uses for cadence,
      // then run EXPLAIN and verify that the planner selects only the relevant
      // partitions rather than scanning all of them.
      //
      // We anchor now to 2026-09-15 so only the August and September partitions
      // (events_y2026m08, events_y2026m09) can contain in-window events.
      // The planner should NOT include partitions for July, October, Nov, Dec.

      const now = new Date("2026-09-15T12:00:00Z");
      const w14Start = new Date(now.getTime() - 2 * CADENCE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
      const rcvAt14Prune = new Date(w14Start.getTime() - CADENCE_RECEIVED_AT_SLACK_MS);

      // Use a stable contactId (the pruning test doesn't depend on a real contact)
      const contactId = "00000000-0000-0000-0000-000000000099";

      const explainRows = await db.execute<{ "QUERY PLAN": string }>(sql`
        EXPLAIN (FORMAT TEXT)
        SELECT COUNT(*) FILTER (
          WHERE timestamp >= ${w14Start.toISOString()}::timestamptz
            AND timestamp  < ${now.toISOString()}::timestamptz
        )
        FROM events
        WHERE contact_id  = ${contactId}::uuid
          AND tenant_id   = ${testTenantId}::uuid
          AND received_at >= ${rcvAt14Prune.toISOString()}::timestamptz
          AND received_at  < ${now.toISOString()}::timestamptz
      `);

      const plan = explainRows.rows.map((r) => r["QUERY PLAN"]).join("\n");

      // The planner must scan the August and September partitions (they overlap
      // with the 14-day window ending 2026-09-15).
      expect(plan).toContain("events_y2026m08");
      expect(plan).toContain("events_y2026m09");

      // The planner must NOT scan partitions that cannot contain in-window events.
      // July 2026 partition: last day is 2026-07-31, which is 45 days before
      // 2026-09-15 - entirely outside the 14d + 72h slack.
      expect(plan).not.toContain("events_y2026m07");

      // October and later partitions also cannot contain events with
      // received_at < now (2026-09-15).
      expect(plan).not.toContain("events_y2026m10");
      expect(plan).not.toContain("events_y2026m11");
      expect(plan).not.toContain("events_y2026m12");
    });
  });
});

// ---------------------------------------------------------------------------
// Constants are exported so callers can verify they match ingestion
// ---------------------------------------------------------------------------

describe("exported constants", () => {
  it("CADENCE_RECEIVED_AT_SLACK_MS equals 72 hours in milliseconds", () => {
    expect(CADENCE_RECEIVED_AT_SLACK_MS).toBe(72 * 60 * 60 * 1000);
  });

  it("CADENCE_WINDOW_DAYS is 7", () => {
    expect(CADENCE_WINDOW_DAYS).toBe(7);
  });

  it("FEATURES_WINDOW_DAYS is 30", () => {
    expect(FEATURES_WINDOW_DAYS).toBe(30);
  });

  it("MOST_USED_FEATURES_COUNT is 5", () => {
    expect(MOST_USED_FEATURES_COUNT).toBe(5);
  });

  it("RECENT_EVENTS_COUNT is 10", () => {
    expect(RECENT_EVENTS_COUNT).toBe(10);
  });
});
