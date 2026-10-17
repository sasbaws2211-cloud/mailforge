/**
 * POST /v1/contacts/import integration tests.
 *
 *   - creates new contacts and updates existing ones, reporting each count
 *   - reserved traits land in their columns, other traits in properties
 *   - a row with only an email is keyed by the lowercased email
 *   - a repeated person later in the file updates the earlier row
 *   - one bad row (no id, bad email, oversized trait name) fails alone
 *   - an email already held by another contact is not applied (the contact itself is still saved)
 *   - an empty trait set never clears what the contact already has
 *   - more than 500 rows, or no rows, is a 400
 *   - no session is a 401; another tenant's contacts are never touched
 *
 * Requires local Postgres (DATABASE_URL).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { sql } from "drizzle-orm";
import { buildApp } from "../src/index.js";
import { tenants, users, sessions, contacts } from "@loomail/db/schema";

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) throw new Error("[contacts-import.test] DATABASE_URL is not set.");

let pool: pg.Pool;
let db: ReturnType<typeof drizzle>;
let dbAvailable = false;
let app: Awaited<ReturnType<typeof buildApp>>;
let tenantA = "";
let tenantB = "";
let cookieA = "";

const SLUGS = ["test-import-a", "test-import-b"];

async function importRows(rows: unknown[], cookie: string | null = cookieA) {
  const res = await app.inject({
    method: "POST",
    url: "/v1/contacts/import",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    payload: { rows },
  });
  return { status: res.statusCode, body: res.json() };
}

const contactsOf = async (tenantId: string) =>
  (await db.execute(sql`SELECT external_id, email, name, company, payment_status, properties FROM contacts WHERE tenant_id = ${tenantId} ORDER BY external_id`)).rows as Array<Record<string, any>>;

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: DB_URL, connectionTimeoutMillis: 3000 });
  try {
    await pool.query("SELECT 1");
    db = drizzle(pool);
    dbAvailable = true;
  } catch (err) {
    if (process.env.CI === "true") throw err;
    console.warn("[contacts-import.test] DATABASE_URL not reachable - skipped.");
    return;
  }
  for (const slug of SLUGS) {
    const t = sql`(SELECT id FROM tenants WHERE slug = ${slug})`;
    for (const table of ["contact_conflicts", "lifecycle_transitions", "events", "contacts", "sessions", "users"]) {
      await db.execute(sql`DELETE FROM ${sql.raw(table)} WHERE tenant_id IN ${t}`);
    }
    await db.execute(sql`DELETE FROM tenants WHERE slug = ${slug}`);
  }
  const make = async (slug: string) => {
    const [t] = await db.insert(tenants).values({ name: slug, slug, plan: "free" }).returning({ id: tenants.id });
    const [u] = await db.insert(users).values({ tenantId: t!.id, email: `owner@${slug}.test`, role: "owner" }).returning({ id: users.id });
    const [s] = await db.insert(sessions).values({ tenantId: t!.id, userId: u!.id, expiresAt: new Date(Date.now() + 86400_000) }).returning({ id: sessions.id });
    return { id: t!.id, cookie: `loomail_session=${s!.id}` };
  };
  const a = await make(SLUGS[0]!);
  const b = await make(SLUGS[1]!);
  tenantA = a.id;
  cookieA = a.cookie;
  tenantB = b.id;
  await db.insert(contacts).values({ tenantId: tenantB, externalId: "u1", email: "other@tenant-b.test", name: "Untouched", lifecycleState: "signed_up" });
  app = await buildApp({ db, logger: false });
  await app.ready();
});

afterAll(async () => {
  if (app) await app.close();
  if (pool) await pool.end();
});

describe("POST /v1/contacts/import", () => {
  it("creates, then updates, and maps traits", async () => {
    if (!dbAvailable) return;
    const first = await importRows([
      { user_id: "u1", email: "Ada@Example.com", traits: { name: "Ada", company: "Engines", payment_status: "paid", seats: 4, vip: true, city: "London" } },
      { email: "grace@example.com", traits: { name: "Grace" } },
    ]);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ created: 2, updated: 0, failed: 0 });

    const rows = await contactsOf(tenantA);
    expect(rows.map((r) => r.external_id)).toEqual(["grace@example.com", "u1"]);
    const ada = rows.find((r) => r.external_id === "u1")!;
    expect(ada).toMatchObject({ email: "ada@example.com", name: "Ada", company: "Engines", payment_status: "paid" });
    expect(ada.properties).toMatchObject({ seats: 4, vip: true, city: "London" });

    const second = await importRows([{ user_id: "u1", traits: { company: "Analytical Engines" } }]);
    expect(second.body).toMatchObject({ created: 0, updated: 1, failed: 0 });
    const after = (await contactsOf(tenantA)).find((r) => r.external_id === "u1")!;
    // Updated field changed; everything not mentioned stayed.
    expect(after).toMatchObject({ company: "Analytical Engines", name: "Ada", email: "ada@example.com", payment_status: "paid" });
    expect(after.properties).toMatchObject({ seats: 4, city: "London" });
  });

  it("a repeated person later in the file updates the earlier row", async () => {
    if (!dbAvailable) return;
    const res = await importRows([
      { user_id: "dup", traits: { name: "First" } },
      { user_id: "dup", traits: { name: "Second" } },
    ]);
    expect(res.body).toMatchObject({ created: 1, updated: 1, failed: 0 });
    expect((await contactsOf(tenantA)).find((r) => r.external_id === "dup")!.name).toBe("Second");
  });

  it("one bad row fails alone, reported by its position", async () => {
    if (!dbAvailable) return;
    const res = await importRows([
      { user_id: "ok-1" },
      { traits: { name: "No id" } },
      { email: "not-an-email" },
      { user_id: "bad-trait", traits: { ["x".repeat(65)]: "v" } },
      { user_id: "ok-2" },
    ]);
    expect(res.status).toBe(200);
    expect(res.body.created).toBe(2);
    expect(res.body.failed).toBe(3);
    expect(res.body.errors.map((e: { index: number }) => e.index)).toEqual([1, 2, 3]);
    const ids = (await contactsOf(tenantA)).map((r) => r.external_id);
    expect(ids).toContain("ok-1");
    expect(ids).toContain("ok-2");
    expect(ids).not.toContain("bad-trait");
  });

  it("does not apply an email another contact already holds, but still saves the contact", async () => {
    if (!dbAvailable) return;
    await importRows([{ user_id: "owner-1", email: "shared@example.com" }]);
    const res = await importRows([{ user_id: "owner-2", email: "shared@example.com", traits: { name: "Second owner" } }]);
    expect(res.body).toMatchObject({ created: 1, failed: 0 });
    const rows = await contactsOf(tenantA);
    expect(rows.find((r) => r.external_id === "owner-1")!.email).toBe("shared@example.com");
    const second = rows.find((r) => r.external_id === "owner-2")!;
    expect(second.email).toBeNull();
    expect(second.name).toBe("Second owner");
  });

  it("rejects an empty or oversized request", async () => {
    if (!dbAvailable) return;
    expect((await importRows([])).status).toBe(400);
    expect((await importRows(Array.from({ length: 501 }, (_, i) => ({ user_id: `many-${i}` })))).status).toBe(400);
  });

  it("requires a session and never touches another tenant", async () => {
    if (!dbAvailable) return;
    expect((await importRows([{ user_id: "u1" }], null)).status).toBe(401);
    const b = await contactsOf(tenantB);
    expect(b).toHaveLength(1);
    expect(b[0]).toMatchObject({ external_id: "u1", name: "Untouched", email: "other@tenant-b.test" });
  });
});
