/**
 * Events route integration tests (GET /v1/events/names).
 *
 * Coverage:
 *   - returns distinct track event names, most frequent first
 *   - identify-type rows and null event names are excluded
 *   - alphabetical order breaks a frequency tie
 *   - 401 without a session cookie
 *   - tenant isolation: a second tenant sees only its own event names
 *
 * Requires local Postgres (docker compose up postgres).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { sql } from "drizzle-orm";
import { buildApp } from "../src/index.js";
import { tenants, users, sessions, contacts, events } from "@claros/db/schema";

const TEST_DB_URL = process.env.DATABASE_URL;
if (!TEST_DB_URL) {
  throw new Error(
    `[events.test] DATABASE_URL is not set. Set it in .env or export it.`,
  );
}

let pool: pg.Pool;
let db: ReturnType<typeof drizzle>;
let dbAvailable = false;

let tenantAId: string;
let cookieA: string;
let cookieB: string;

const TEST_SLUG_A = "test-events-a";
const TEST_SLUG_B = "test-events-b";

const now = Date.now();

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: TEST_DB_URL, connectionTimeoutMillis: 3000 });
  try {
    await pool.query("SELECT 1");
    db = drizzle(pool);
    dbAvailable = true;
  } catch (err) {
    if (process.env.CI === "true") {
      throw new Error(`[events.test] DATABASE_URL not reachable in CI: ${(err as Error).message}`);
    }
    console.warn("[events.test] DATABASE_URL not reachable - integration tests will be skipped.");
    return;
  }

  for (const slug of [TEST_SLUG_A, TEST_SLUG_B]) {
    await db.execute(sql`DELETE FROM events WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${slug})`);
    await db.execute(sql`DELETE FROM contacts WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${slug})`);
    await db.execute(sql`DELETE FROM sessions WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${slug})`);
    await db.execute(sql`DELETE FROM users WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${slug})`);
    await db.execute(sql`DELETE FROM tenants WHERE slug = ${slug}`);
  }

  async function makeTenant(slug: string, email: string) {
    const [t] = await db
      .insert(tenants)
      .values({ name: slug, slug, plan: "free" })
      .returning({ id: tenants.id });
    const [u] = await db
      .insert(users)
      .values({ tenantId: t!.id, email, role: "owner" })
      .returning({ id: users.id });
    const [s] = await db
      .insert(sessions)
      .values({ tenantId: t!.id, userId: u!.id, expiresAt: new Date(now + 86400_000) })
      .returning({ id: sessions.id });
    return { tenantId: t!.id, cookie: `claros_session=${s!.id}` };
  }

  const a = await makeTenant(TEST_SLUG_A, "owner-a@events.test");
  tenantAId = a.tenantId;
  cookieA = a.cookie;
  const b = await makeTenant(TEST_SLUG_B, "owner-b@events.test");
  cookieB = b.cookie;

  const [contactA] = await db
    .insert(contacts)
    .values({ tenantId: tenantAId, externalId: "a1", email: "a1@x.dev", lifecycleState: "signed_up" })
    .returning({ id: contacts.id });
  const [contactB] = await db
    .insert(contacts)
    .values({ tenantId: b.tenantId, externalId: "b1", email: "b1@x.dev", lifecycleState: "signed_up" })
    .returning({ id: contacts.id });

  // Tenant A: plan_upgraded x3, signed_in x2, project_created x1,
  // aardvark_event x1 (frequency tie, alphabetical first), plus an identify
  // row and a null-name track row that must not appear.
  const ts = new Date(now);
  await db.insert(events).values([
    { tenantId: tenantAId, contactId: contactA!.id, type: "track", eventName: "plan_upgraded", timestamp: ts },
    { tenantId: tenantAId, contactId: contactA!.id, type: "track", eventName: "plan_upgraded", timestamp: ts },
    { tenantId: tenantAId, contactId: contactA!.id, type: "track", eventName: "plan_upgraded", timestamp: ts },
    { tenantId: tenantAId, contactId: contactA!.id, type: "track", eventName: "signed_in", timestamp: ts },
    { tenantId: tenantAId, contactId: contactA!.id, type: "track", eventName: "signed_in", timestamp: ts },
    { tenantId: tenantAId, contactId: contactA!.id, type: "track", eventName: "project_created", timestamp: ts },
    { tenantId: tenantAId, contactId: contactA!.id, type: "track", eventName: "aardvark_event", timestamp: ts },
    { tenantId: tenantAId, contactId: contactA!.id, type: "identify", eventName: null, timestamp: ts },
    { tenantId: tenantAId, contactId: contactA!.id, type: "track", eventName: null, timestamp: ts },
  ]);

  // Tenant B: one event that must never leak into tenant A's list.
  await db.insert(events).values({
    tenantId: b.tenantId,
    contactId: contactB!.id,
    type: "track",
    eventName: "tenant_b_only_event",
    timestamp: ts,
  });
});

afterAll(async () => {
  if (pool) await pool.end();
});

describe("GET /v1/events/names", () => {
  it("returns 401 without a session cookie", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db });
    const res = await app.inject({ method: "GET", url: "/v1/events/names" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("returns distinct track event names, most frequent first", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db });
    const res = await app.inject({
      method: "GET",
      url: "/v1/events/names",
      headers: { cookie: cookieA },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { event_names: string[] };
    expect(body.event_names).toEqual([
      "plan_upgraded",
      "signed_in",
      "aardvark_event",
      "project_created",
    ]);
    await app.close();
  });

  it("does not leak another tenant's event names", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db });
    const res = await app.inject({
      method: "GET",
      url: "/v1/events/names",
      headers: { cookie: cookieB },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { event_names: string[] };
    expect(body.event_names).toEqual(["tenant_b_only_event"]);
    await app.close();
  });
});
