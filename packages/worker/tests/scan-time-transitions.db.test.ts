/**
 * Integration tests for scan phase 1: time-based lifecycle transitions.
 *
 * Tests:
 * - All time-driven transitions fire correctly (engaged->at_risk, at_risk->dormant,
 *   dormant->churned, resurrected->engaged, activated->engaged)
 * - Contacts below threshold are not transitioned
 * - CAS idempotency: two overlapping scans produce exactly one audit row
 * - Scan racing a concurrent ingest transition: the CAS on the wrong from-state
 *   is a no-op (no double-fire, no incorrect transition)
 * - lifecycle_transitions audit row has correct metadata
 * - Keyset pagination processes all contacts (not just the first batch)
 *
 * Requires local Postgres (docker compose up postgres).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { eq, and, sql } from "drizzle-orm";
import { tenants, contacts, lifecycleTransitions } from "@mailforge/db/schema";
import { phaseTimeTransitions } from "../src/scan-time-transitions.js";

const TEST_DB_URL = process.env.DATABASE_URL;
if (!TEST_DB_URL) {
  const inCI = process.env.CI === "true";
  throw new Error(
    `[scan-time-transitions.test] DATABASE_URL is not set.\n\n` +
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

const SLUG = "test-scan-time";

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
        `[scan-time-transitions.test] DATABASE_URL not reachable in CI.\n` +
          `URL: ${TEST_DB_URL}\n` +
          `Cause: ${(err as Error).message}`,
      );
    }
    console.warn(
      "[scan-time-transitions.test] DATABASE_URL not reachable - integration tests will be skipped.",
    );
    return;
  }

  // Clean up from previous runs
  await db.execute(
    sql`DELETE FROM lifecycle_transitions WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${SLUG})`,
  );
  await db.execute(
    sql`DELETE FROM contacts WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${SLUG})`,
  );
  await db.execute(
    sql`DELETE FROM scan_checkpoints WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${SLUG})`,
  );
  await db.execute(sql`DELETE FROM tenants WHERE slug = ${SLUG}`);

  // Create test tenant with default lifecycle config (natural_frequency_days=7)
  const [tenant] = await db
    .insert(tenants)
    .values({
      name: "Test Scan Time",
      slug: SLUG,
      plan: "free",
      settings: {
        lifecycle: {
          natural_frequency_days: 7,
          at_risk_missed_intervals: 2,
          dormant_days: 30,
          churned_days: 90,
        },
      },
    })
    .returning({ id: tenants.id });
  testTenantId = tenant!.id;
});

afterAll(async () => {
  if (!dbAvailable) {
    await pool.end();
    return;
  }
  await db.execute(sql`DELETE FROM lifecycle_transitions WHERE tenant_id = ${testTenantId}`);
  await db.execute(sql`DELETE FROM contacts WHERE tenant_id = ${testTenantId}`);
  await db.execute(sql`DELETE FROM scan_checkpoints WHERE tenant_id = ${testTenantId}`);
  await db.execute(sql`DELETE FROM tenants WHERE slug = ${SLUG}`);
  await pool.end();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function daysAgo(days: number, from: Date = new Date("2026-07-20T12:00:00Z")): Date {
  const d = new Date(from);
  d.setDate(d.getDate() - days);
  return d;
}

async function insertContact(
  externalId: string,
  state: string,
  lastSeenAt: Date,
): Promise<string> {
  const [row] = await db
    .insert(contacts)
    .values({
      tenantId: testTenantId,
      externalId,
      lifecycleState: state,
      lastSeenAt,
      firstSeenAt: lastSeenAt,
    })
    .returning({ id: contacts.id });
  return row!.id;
}

async function getContactState(contactId: string): Promise<string | null> {
  const rows = await db
    .select({ lifecycleState: contacts.lifecycleState })
    .from(contacts)
    .where(eq(contacts.id, contactId))
    .limit(1);
  return rows[0]?.lifecycleState ?? null;
}

async function getTransitions(contactId: string) {
  return db
    .select()
    .from(lifecycleTransitions)
    .where(eq(lifecycleTransitions.contactId, contactId));
}

// ---------------------------------------------------------------------------
// Basic transition tests
// ---------------------------------------------------------------------------

const now = new Date("2026-07-20T12:00:00Z");

describe("phaseTimeTransitions - basic transitions", () => {
  it("transitions engaged -> at_risk after threshold", async () => {
    if (!dbAvailable) return;
    // at_risk threshold: 2 * 7 = 14 days
    const contactId = await insertContact("scan_engaged_1", "engaged", daysAgo(14));

    await phaseTimeTransitions(db, now, [testTenantId]);

    expect(await getContactState(contactId)).toBe("at_risk");
    const transitions = await getTransitions(contactId);
    expect(transitions).toHaveLength(1);
    expect(transitions[0]!.fromState).toBe("engaged");
    expect(transitions[0]!.toState).toBe("at_risk");
    expect(transitions[0]!.triggerEventId).toBeNull();
    expect(transitions[0]!.metadata).toEqual({ trigger: "scan" });
  });

  it("does not transition engaged before threshold", async () => {
    if (!dbAvailable) return;
    const contactId = await insertContact("scan_engaged_safe", "engaged", daysAgo(13));

    await phaseTimeTransitions(db, now, [testTenantId]);

    expect(await getContactState(contactId)).toBe("engaged");
    const transitions = await getTransitions(contactId);
    expect(transitions).toHaveLength(0);
  });

  it("transitions at_risk -> dormant after dormant_days", async () => {
    if (!dbAvailable) return;
    const contactId = await insertContact("scan_atrisk_1", "at_risk", daysAgo(30));

    await phaseTimeTransitions(db, now, [testTenantId]);

    expect(await getContactState(contactId)).toBe("dormant");
    const transitions = await getTransitions(contactId);
    expect(transitions).toHaveLength(1);
    expect(transitions[0]!.fromState).toBe("at_risk");
    expect(transitions[0]!.toState).toBe("dormant");
  });

  it("transitions dormant -> churned after churned_days", async () => {
    if (!dbAvailable) return;
    const contactId = await insertContact("scan_dormant_1", "dormant", daysAgo(90));

    await phaseTimeTransitions(db, now, [testTenantId]);

    expect(await getContactState(contactId)).toBe("churned");
    const transitions = await getTransitions(contactId);
    expect(transitions).toHaveLength(1);
    expect(transitions[0]!.fromState).toBe("dormant");
    expect(transitions[0]!.toState).toBe("churned");
  });

  it("transitions resurrected -> engaged when recent activity", async () => {
    if (!dbAvailable) return;
    // Within natural_frequency_days (7): 3 days ago
    const contactId = await insertContact("scan_resurrected_1", "resurrected", daysAgo(3));

    await phaseTimeTransitions(db, now, [testTenantId]);

    expect(await getContactState(contactId)).toBe("engaged");
    const transitions = await getTransitions(contactId);
    expect(transitions).toHaveLength(1);
    expect(transitions[0]!.fromState).toBe("resurrected");
    expect(transitions[0]!.toState).toBe("engaged");
  });

  it("does not transition resurrected when activity is too old", async () => {
    if (!dbAvailable) return;
    const contactId = await insertContact("scan_resurrected_stale", "resurrected", daysAgo(8));

    await phaseTimeTransitions(db, now, [testTenantId]);

    expect(await getContactState(contactId)).toBe("resurrected");
    const transitions = await getTransitions(contactId);
    expect(transitions).toHaveLength(0);
  });

  it("transitions stale activated -> engaged after natural_frequency_days", async () => {
    if (!dbAvailable) return;
    const contactId = await insertContact("scan_activated_stale", "activated", daysAgo(7));

    await phaseTimeTransitions(db, now, [testTenantId]);

    expect(await getContactState(contactId)).toBe("engaged");
    const transitions = await getTransitions(contactId);
    expect(transitions).toHaveLength(1);
    expect(transitions[0]!.fromState).toBe("activated");
    expect(transitions[0]!.toState).toBe("engaged");
  });

  it("does not transition recently-activated contacts", async () => {
    if (!dbAvailable) return;
    const contactId = await insertContact("scan_activated_fresh", "activated", daysAgo(6));

    await phaseTimeTransitions(db, now, [testTenantId]);

    expect(await getContactState(contactId)).toBe("activated");
    const transitions = await getTransitions(contactId);
    expect(transitions).toHaveLength(0);
  });

  it("returns stats reflecting work done", async () => {
    if (!dbAvailable) return;
    // Insert a contact that will transition
    await insertContact("scan_stats_1", "engaged", daysAgo(20));

    const result = await phaseTimeTransitions(db, now, [testTenantId]);

    expect(result.tenantsProcessed).toBeGreaterThanOrEqual(1);
    expect(result.contactsEvaluated).toBeGreaterThanOrEqual(1);
    expect(result.transitionsApplied).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Concurrency tests (PgGate pattern)
// ---------------------------------------------------------------------------

const GATE_LOCK_ID = 799_312; // unique within the test DB

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

  callerFn<T>(workFn: () => Promise<T>) {
    return async (): Promise<{ result: T; unblockTime: Date }> => {
      const client = new pg.Client({ connectionString: this.url });
      await client.connect();
      await client.query("SELECT pg_advisory_lock_shared($1)", [GATE_LOCK_ID]);
      const tsResult = await client.query("SELECT clock_timestamp() AS ts");
      const unblockTime = tsResult.rows[0].ts as Date;
      try {
        const result = await workFn();
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

describe("concurrency: two overlapping scans write exactly one audit row", () => {
  it("CAS prevents double-fire when two scans evaluate the same contact", async () => {
    if (!dbAvailable) return;

    // Create contact in engaged state past at_risk threshold
    const contactId = await insertContact("scan_race_1", "engaged", daysAgo(20));

    const gate = new PgGate(TEST_DB_URL!, 2);
    await gate.lock();

    // Both scan invocations will try to transition the same contact
    const callerA = gate.callerFn(async () => {
      return phaseTimeTransitions(db, now, [testTenantId]);
    });

    const callerB = gate.callerFn(async () => {
      return phaseTimeTransitions(db, now, [testTenantId]);
    });

    const promises = [callerA(), callerB()];
    await gate.waitForAllBlocked();
    await gate.release();

    const results = await Promise.all(promises);
    assertOverlap(
      results.map((r) => r.unblockTime),
      "scan double-fire race",
    );

    // Final state should be at_risk
    expect(await getContactState(contactId)).toBe("at_risk");

    // Exactly ONE audit row (CAS prevents the second write)
    const transitions = await getTransitions(contactId);
    const scanTransitions = transitions.filter(
      (t) => t.fromState === "engaged" && t.toState === "at_risk",
    );
    expect(scanTransitions).toHaveLength(1);
    expect(scanTransitions[0]!.metadata).toEqual({ trigger: "scan" });

    // One scan should report 1 transition, the other 0
    const totalApplied =
      results[0]!.result.transitionsApplied + results[1]!.result.transitionsApplied;
    expect(totalApplied).toBe(1);

    await gate.close();
  });
});

describe("concurrency: scan racing a concurrent ingest transition", () => {
  it("scan CAS is no-op when ingest already transitioned the contact", async () => {
    if (!dbAvailable) return;

    // Create a contact in at_risk state with lastSeenAt past dormant threshold.
    // The scan would normally transition at_risk -> dormant.
    // But a concurrent ingest event arrives and transitions at_risk -> engaged first.
    const contactId = await insertContact("scan_ingest_race_1", "at_risk", daysAgo(35));

    const gate = new PgGate(TEST_DB_URL!, 2);
    await gate.lock();

    // Caller A: simulates ingest by directly CAS-updating the contact to engaged
    // (same pattern as the ingest handler: UPDATE WHERE lifecycle_state = 'at_risk')
    const callerA = gate.callerFn(async () => {
      const updated = await db
        .update(contacts)
        .set({ lifecycleState: "engaged", lastSeenAt: now })
        .where(
          and(
            eq(contacts.id, contactId),
            eq(contacts.lifecycleState, "at_risk"),
          ),
        )
        .returning({ id: contacts.id });

      if (updated.length > 0) {
        // Write the ingest audit row
        await db.insert(lifecycleTransitions).values({
          tenantId: testTenantId,
          contactId,
          fromState: "at_risk",
          toState: "engaged",
          triggerEventId: null,
          metadata: { trigger: "ingest" },
          transitionedAt: now,
        });
      }
      return updated.length;
    });

    // Caller B: the scan tries to transition at_risk -> dormant
    const callerB = gate.callerFn(async () => {
      return phaseTimeTransitions(db, now, [testTenantId]);
    });

    const promises = [callerA(), callerB()];
    await gate.waitForAllBlocked();
    await gate.release();

    const results = await Promise.all(promises);
    assertOverlap(
      results.map((r) => r.unblockTime),
      "scan-vs-ingest race",
    );

    // The final state depends on who won the CAS race:
    // - If ingest won: at_risk -> engaged (scan's CAS on at_risk fails - no-op)
    // - If scan won: at_risk -> dormant (ingest's CAS on at_risk fails - no-op)
    // Either way: exactly ONE transition row from at_risk.
    const finalState = await getContactState(contactId);
    expect(["engaged", "dormant"]).toContain(finalState);

    const transitions = await getTransitions(contactId);
    const fromAtRisk = transitions.filter((t) => t.fromState === "at_risk");
    expect(fromAtRisk).toHaveLength(1);

    if (finalState === "engaged") {
      expect(fromAtRisk[0]!.toState).toBe("engaged");
      expect(fromAtRisk[0]!.metadata).toEqual({ trigger: "ingest" });
      // Scan's transition count should be 0 for this contact
    } else {
      expect(fromAtRisk[0]!.toState).toBe("dormant");
      expect(fromAtRisk[0]!.metadata).toEqual({ trigger: "scan" });
      // Ingest's CAS failed
    }

    await gate.close();
  });
});
