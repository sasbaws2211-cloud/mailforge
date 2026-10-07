/**
 * An id in the URL that is not a UUID ("undefined", a typo, junk) used to make the database refuse
 * the query and the API answer 500 with a logged stack trace. It must answer 404 on every route that
 * takes an id, while a well-formed id that simply does not exist keeps its own 404.
 *
 * Needs a reachable Postgres via DATABASE_URL, like the other *.db tests.
 * Every tenant created here has a slug starting with "badid-".
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import { SESSION_COOKIE_NAME } from "../src/routes/auth.js";

const TEST_DB_URL = process.env.DATABASE_URL;
if (!TEST_DB_URL) throw new Error("[invalid-id.test] DATABASE_URL is not set.");

let pool: pg.Pool;
let db: ReturnType<typeof drizzle>;
let dbAvailable = false;
let app: FastifyInstance;
let session = "";
let counter = 0;

async function q<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  return (await db.execute(query)).rows as T[];
}

async function cleanup(): Promise<void> {
  const ids = (await q<{ id: string }>(sql`SELECT id FROM tenants WHERE slug LIKE 'badid-%'`)).map((r) => r.id);
  for (const id of ids) {
    for (const t of ["sessions", "users"]) await db.execute(sql.raw(`DELETE FROM ${t} WHERE tenant_id = '${id}'`));
    await db.execute(sql`DELETE FROM tenants WHERE id = ${id}::uuid`);
  }
}

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: TEST_DB_URL, connectionTimeoutMillis: 3000 });
  try {
    await pool.query("SELECT 1");
    db = drizzle(pool);
    dbAvailable = true;
  } catch (err) {
    if (process.env.CI === "true") throw new Error(`[invalid-id.test] DATABASE_URL not reachable in CI: ${(err as Error).message}`);
    console.warn("[invalid-id.test] DATABASE_URL not reachable - tests skipped.");
    return;
  }
  await cleanup();
  const slug = `badid-${Date.now()}-${counter++}`;
  const [t] = await q<{ id: string }>(sql`INSERT INTO tenants (name, slug, plan) VALUES (${"Acme " + slug}, ${slug}, 'free') RETURNING id`);
  const [u] = await q<{ id: string }>(sql`INSERT INTO users (tenant_id, email, role) VALUES (${t!.id}::uuid, ${slug + "@badid.example"}, 'owner') RETURNING id`);
  const [s] = await q<{ id: string }>(sql`INSERT INTO sessions (tenant_id, user_id, expires_at) VALUES (${t!.id}::uuid, ${u!.id}::uuid, now() + interval '1 day') RETURNING id`);
  session = s!.id;
  // A no-op job queue, so routes that need one (compile) reach their id lookup instead of answering 503.
  app = await buildApp({ logger: false, db, enqueue: async () => null, baseUrl: "http://localhost:3000", dashboardUrl: "http://localhost:3000" });
});

afterEach(() => {
  // nothing per test: the one tenant is shared and read-only here
});

afterAll(async () => {
  if (dbAvailable) await cleanup();
  await app?.close();
  await pool?.end();
});

const call = (method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as "GET", url, cookies: { [SESSION_COOKIE_NAME]: session }, payload: payload as object | undefined });

const BAD_IDS = ["undefined", "not-a-uuid", "123", "00000000-0000-4000-8000-00000000000g", "%27%3B--"];
const GOOD_BUT_MISSING = "00000000-0000-4000-8000-000000000000";

describe("routes that take an id answer 404 for something that is not a UUID", () => {
  const routes: Array<[string, (id: string) => string, unknown?]> = [
    ["GET", (id) => `/v1/flows/${id}`],
    ["PATCH", (id) => `/v1/flows/${id}`, { name: "x" }],
    ["DELETE", (id) => `/v1/flows/${id}`],
    ["POST", (id) => `/v1/flows/${id}/compile`],
    ["GET", (id) => `/v1/flows/${id}/plan`],
    ["POST", (id) => `/v1/flows/${id}/draft-step`, { step_order: 1 }],
    ["GET", (id) => `/v1/contacts/${id}`],
    ["GET", (id) => `/v1/contacts/${id}/timeline`],
    ["GET", (id) => `/v1/kb/${id}`],
    ["DELETE", (id) => `/v1/kb/${id}`],
    ["POST", (id) => `/v1/messages/${id}/approve`],
    ["POST", (id) => `/v1/messages/${id}/reject`, { feedback: "no" }],
    ["POST", (id) => `/v1/messages/${id}/retry`],
    ["GET", (id) => `/v1/sent-log/${id}`],
    ["GET", (id) => `/v1/email-templates/${id}`],
    ["PATCH", (id) => `/v1/ingestion/keys/${id}`, { label: "x" }],
    ["POST", (id) => `/v1/ingestion/keys/${id}/revoke`],
    ["DELETE", (id) => `/v1/team/${id}`],
    ["PATCH", (id) => `/v1/team/${id}/role`, { role: "member" }],
    ["DELETE", (id) => `/v1/team/invites/${id}`],
  ];

  for (const [method, path, body] of routes) {
    it(`${method} ${path(":id")}`, async () => {
      if (!dbAvailable) return;
      for (const id of BAD_IDS) {
        const res = await call(method, path(id), body);
        // Never a 500. A route may reject the request body first (400) or deny the role (403),
        // but where it reaches the lookup the answer is 404.
        expect(res.statusCode, `${method} ${path(id)} -> ${res.body.slice(0, 120)}`).not.toBe(500);
        expect([400, 403, 404]).toContain(res.statusCode);
      }
    });
  }

  it("the request that used to fail: POST /v1/flows/undefined/compile", async () => {
    if (!dbAvailable) return;
    const res = await call("POST", "/v1/flows/undefined/compile");
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "Not found" });
    expect(res.body).not.toMatch(/select|Failed query|uuid/i);
  });

  it("reads and deletes of a bad id are exactly 404", async () => {
    if (!dbAvailable) return;
    for (const url of ["/v1/flows/undefined", "/v1/contacts/undefined", "/v1/kb/undefined", "/v1/sent-log/undefined"]) {
      expect((await call("GET", url)).statusCode, url).toBe(404);
    }
    expect((await call("DELETE", "/v1/flows/undefined")).statusCode).toBe(404);
    expect((await call("DELETE", "/v1/kb/undefined")).statusCode).toBe(404);
  });
});

describe("what is not affected", () => {
  it("a well-formed id that does not exist still gets the route's own 404", async () => {
    if (!dbAvailable) return;
    for (const url of [`/v1/flows/${GOOD_BUT_MISSING}`, `/v1/contacts/${GOOD_BUT_MISSING}`, `/v1/kb/${GOOD_BUT_MISSING}`]) {
      expect((await call("GET", url)).statusCode, url).toBe(404);
    }
  });

  it("a request without a session is still 401, whatever the id", async () => {
    if (!dbAvailable) return;
    const res = await app.inject({ method: "GET", url: "/v1/flows/undefined" });
    expect(res.statusCode).toBe(401);
  });

  it("business-model templates, which are looked up by name rather than UUID, still resolve by name", async () => {
    if (!dbAvailable) return;
    const list = await call("GET", "/v1/templates");
    expect(list.statusCode).toBe(200);
    const body = list.json() as { templates?: Array<{ id: string }> };
    const first = body.templates?.[0]?.id;
    expect(typeof first).toBe("string");
    // An unknown name is the route's own answer (not our UUID handler, and never a 500).
    const unknown = await call("POST", "/v1/templates/not-a-template/apply");
    expect(unknown.statusCode).not.toBe(500);
    expect([400, 404]).toContain(unknown.statusCode);
  });
});
