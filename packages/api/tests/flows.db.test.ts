/**
 * Flow CRUD integration tests.
 *
 * Coverage:
 *
 * Happy paths:
 *   - POST /v1/flows creates a flow; status = draft; compiled_plan = null
 *   - GET  /v1/flows lists flows, excludes archived by default
 *   - GET  /v1/flows?include_archived=true includes archived flows
 *   - GET  /v1/flows/:id returns the full flow
 *   - PATCH /v1/flows/:id updates metadata
 *   - PATCH /v1/flows/:id updates status draft -> active
 *   - PATCH /v1/flows/:id updates status active -> paused
 *   - PATCH /v1/flows/:id updates status paused -> active (re-activate)
 *   - PATCH /v1/flows/:id updates prompt_source on draft flow; clears compiled_plan
 *   - PATCH /v1/flows/:id updates prompt_source on paused flow; clears compiled_plan
 *   - DELETE /v1/flows/:id archives the flow; compiled_plan is preserved
 *   - DELETE /v1/flows/:id is idempotent when already archived
 *
 * Failure paths:
 *   - POST with missing required field (name): 400
 *   - POST with invalid trigger_type: 400
 *   - POST with invalid flow_class: 400
 *   - POST with invalid reentry_policy: 400
 *   - POST with step missing order: 400
 *   - POST with step missing action_type: 400
 *   - POST with step invalid window_policy: 400
 *   - POST with step invalid delay format: 400
 *   - POST with duplicate step orders: 400
 *   - PATCH status transition: archived -> active: 422
 *   - PATCH status transition: draft -> paused: 422 (message says why)
 *   - PATCH prompt_source on active flow: 422 (message says to pause first)
 *   - GET /v1/flows/:id for non-existent id: 404
 *   - PATCH /v1/flows/:id for non-existent id: 404
 *   - DELETE /v1/flows/:id for non-existent id: 404
 *
 * Isolation:
 *   - GET /v1/flows/:id for a flow owned by another tenant returns 404
 *   - PATCH /v1/flows/:id for a flow owned by another tenant returns 404
 *   - DELETE /v1/flows/:id for a flow owned by another tenant returns 404
 *   - POST /v1/flows without session cookie returns 401
 *   - Bearer key on flows endpoint returns 401 (wrong scope)
 *
 * Additional:
 *   - A flow archived with a non-null compiled_plan keeps its plan
 *
 * Requires local Postgres (docker compose up postgres).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { eq, sql } from "drizzle-orm";
import { buildApp } from "../src/index.js";
import { tenants, users, sessions, flows, apiKeys } from "@claros/db/schema";
import { randomBytes, createHash } from "node:crypto";

const TEST_DB_URL = process.env.DATABASE_URL;
if (!TEST_DB_URL) {
  const inCI = process.env.CI === "true";
  throw new Error(
    `[flows.test] DATABASE_URL is not set.\n\n` +
      `This test requires a Postgres connection.\n` +
      (inCI
        ? `Set the variable in the workflow env block:\n\n  DATABASE_URL: postgres://claros:claros@localhost:5432/claros\n`
        : `Set the variable in .env (see .env.example) or export it:\n\n  export DATABASE_URL='postgres://claros:claros@localhost:5433/claros'\n`),
  );
}

let pool: pg.Pool;
let db: ReturnType<typeof drizzle>;
let dbAvailable = false;

/** Tenant A: the primary test tenant */
let tenantAId: string;
let sessionAId: string;
let cookieA: string;

/** Tenant B: used only for cross-tenant isolation tests */
let tenantBId: string;
let sessionBId: string;

/** A raw API key for the bearer-scope test */
let rawApiKey: string;

const TEST_SLUG_A = "test-flows-a";
const TEST_SLUG_B = "test-flows-b";

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
        `[flows.test] DATABASE_URL not reachable in CI.\nURL: ${TEST_DB_URL}\nCause: ${(err as Error).message}`,
      );
    }
    console.warn("[flows.test] DATABASE_URL not reachable - integration tests will be skipped.");
    return;
  }

  // Clean up from previous runs (reverse dependency order)
  await db.execute(sql`DELETE FROM templates WHERE tenant_id IN (SELECT id FROM tenants WHERE slug IN (${TEST_SLUG_A}, ${TEST_SLUG_B}))`);
  await db.execute(sql`DELETE FROM flows WHERE tenant_id IN (SELECT id FROM tenants WHERE slug IN (${TEST_SLUG_A}, ${TEST_SLUG_B}))`);
  await db.execute(sql`DELETE FROM api_keys WHERE tenant_id IN (SELECT id FROM tenants WHERE slug IN (${TEST_SLUG_A}, ${TEST_SLUG_B}))`);
  await db.execute(sql`DELETE FROM sessions WHERE tenant_id IN (SELECT id FROM tenants WHERE slug IN (${TEST_SLUG_A}, ${TEST_SLUG_B}))`);
  await db.execute(sql`DELETE FROM users WHERE tenant_id IN (SELECT id FROM tenants WHERE slug IN (${TEST_SLUG_A}, ${TEST_SLUG_B}))`);
  await db.execute(sql`DELETE FROM tenants WHERE slug IN (${TEST_SLUG_A}, ${TEST_SLUG_B})`);

  // Tenant A
  const [tA] = await db
    .insert(tenants)
    .values({ name: "Test Flows A", slug: TEST_SLUG_A, plan: "free" })
    .returning({ id: tenants.id });
  tenantAId = tA!.id;

  const [uA] = await db
    .insert(users)
    .values({ tenantId: tenantAId, email: "owner-a@flows.test", role: "owner" })
    .returning({ id: users.id });

  const [sA] = await db
    .insert(sessions)
    .values({
      tenantId: tenantAId,
      userId: uA!.id,
      expiresAt: new Date(Date.now() + 86400 * 1000),
    })
    .returning({ id: sessions.id });
  sessionAId = sA!.id;
  cookieA = `claros_session=${sessionAId}`;

  // API key for wrong-scope test
  rawApiKey = randomBytes(24).toString("base64url");
  const keyHash = createHash("sha256").update(rawApiKey).digest("hex");
  await db.insert(apiKeys).values({
    tenantId: tenantAId,
    keyHash,
    prefix: rawApiKey.slice(0, 8),
    label: "test key",
  });

  // Tenant B (cross-tenant isolation)
  const [tB] = await db
    .insert(tenants)
    .values({ name: "Test Flows B", slug: TEST_SLUG_B, plan: "free" })
    .returning({ id: tenants.id });
  tenantBId = tB!.id;

  const [uB] = await db
    .insert(users)
    .values({ tenantId: tenantBId, email: "owner-b@flows.test", role: "owner" })
    .returning({ id: users.id });

  const [sB] = await db
    .insert(sessions)
    .values({
      tenantId: tenantBId,
      userId: uB!.id,
      expiresAt: new Date(Date.now() + 86400 * 1000),
    })
    .returning({ id: sessions.id });
  sessionBId = sB!.id;
});

afterAll(async () => {
  if (dbAvailable) {
    await db.execute(sql`DELETE FROM templates WHERE tenant_id IN (SELECT id FROM tenants WHERE slug IN (${TEST_SLUG_A}, ${TEST_SLUG_B}))`);
    await db.execute(sql`DELETE FROM flows WHERE tenant_id IN (SELECT id FROM tenants WHERE slug IN (${TEST_SLUG_A}, ${TEST_SLUG_B}))`);
    await db.execute(sql`DELETE FROM api_keys WHERE tenant_id IN (SELECT id FROM tenants WHERE slug IN (${TEST_SLUG_A}, ${TEST_SLUG_B}))`);
    await db.execute(sql`DELETE FROM sessions WHERE tenant_id IN (SELECT id FROM tenants WHERE slug IN (${TEST_SLUG_A}, ${TEST_SLUG_B}))`);
    await db.execute(sql`DELETE FROM users WHERE tenant_id IN (SELECT id FROM tenants WHERE slug IN (${TEST_SLUG_A}, ${TEST_SLUG_B}))`);
    await db.execute(sql`DELETE FROM tenants WHERE slug IN (${TEST_SLUG_A}, ${TEST_SLUG_B})`);
  }
  await pool.end();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function minimalFlow(overrides: Record<string, unknown> = {}) {
  return {
    name: "Test Flow",
    trigger_type: "lifecycle_transition",
    trigger_config: { from: "engaged", to: "at_risk" },
    steps: [
      {
        order: 1,
        action_type: "nurture_value",
        delay: "0m",
        window_policy: "immediate",
      },
    ],
    ...overrides,
  };
}

/**
 * Simulate a successful compilation by setting compile_status='ready' and a
 * compiled_plan directly in the DB. Required before activating a flow (task 12b
 * [impl] guard: API refuses draft->active without a compiled plan).
 */
async function simulateCompilation(flowId: string): Promise<void> {
  await db
    .update(flows)
    .set({
      compileStatus: "ready",
      compiledPlan: { steps: [{ order: 1, action_type: "nurture_value" }] },
      compiledAt: new Date("2026-07-01T00:00:00Z"),
    })
    .where(eq(flows.id, flowId));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("flow CRUD", () => {
  describe("auth isolation", () => {
    it("returns 401 with no session cookie", async () => {
      if (!dbAvailable) return;
      const app = await buildApp({ db, logger: false });
      const res = await app.inject({ method: "POST", url: "/v1/flows", payload: minimalFlow() });
      expect(res.statusCode).toBe(401);
    });

    it("returns 401 when using a bearer key on the dashboard scope", async () => {
      if (!dbAvailable) return;
      const app = await buildApp({ db, logger: false });
      const res = await app.inject({
        method: "POST",
        url: "/v1/flows",
        headers: { authorization: `Bearer ${rawApiKey}` },
        payload: minimalFlow(),
      });
      // Bearer key does not set request.tenant, so the /v1 preHandler rejects with 401
      expect(res.statusCode).toBe(401);
    });
  });

  describe("POST /v1/flows", () => {
    it("creates a flow and returns 201 with status = draft, compiled_plan = null", async () => {
      if (!dbAvailable) return;
      const app = await buildApp({ db, logger: false });
      const res = await app.inject({
        method: "POST",
        url: "/v1/flows",
        headers: { cookie: cookieA },
        payload: minimalFlow({ name: "Win-back", prompt_source: "When user goes at risk, send win-back" }),
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.status).toBe("draft");
      expect(body.compiled_plan).toBeNull();
      expect(body.compiled_at).toBeNull();
      expect(body.name).toBe("Win-back");
      expect(body.tenant_id).toBe(tenantAId);
      expect(typeof body.id).toBe("string");
      expect(body.prompt_source).toBe("When user goes at risk, send win-back");
    });

    it("applies defaults: priority=0, source=manual, approval_mode=require, flow_class=nurture, reentry_policy=cooldown", async () => {
      if (!dbAvailable) return;
      const app = await buildApp({ db, logger: false });
      const res = await app.inject({
        method: "POST",
        url: "/v1/flows",
        headers: { cookie: cookieA },
        payload: minimalFlow({ name: "Defaults Test" }),
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.priority).toBe(0);
      expect(body.source).toBe("manual");
      expect(body.approval_mode).toBe("require");
      expect(body.flow_class).toBe("nurture");
      expect(body.reentry_policy).toBe("cooldown");
      expect(body.reentry_cooldown_days).toBe(30);
    });

    it("accepts all optional fields", async () => {
      if (!dbAvailable) return;
      const app = await buildApp({ db, logger: false });
      const res = await app.inject({
        method: "POST",
        url: "/v1/flows",
        headers: { cookie: cookieA },
        payload: {
          name: "Full Flow",
          description: "Full description",
          priority: 10,
          trigger_type: "event",
          trigger_config: { event: "plan_upgraded" },
          steps: [
            { order: 1, action_type: "nurture_value", delay: "2h", window_policy: "respect_window" },
            { order: 2, action_type: "nurture_tip",   delay: "3d", window_policy: "immediate" },
          ],
          source: "library",
          approval_mode: "auto",
          flow_class: "critical",
          reentry_policy: "every_time",
          reentry_cooldown_days: 14,
          prompt_source: "Describe the flow here",
        },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.priority).toBe(10);
      expect(body.flow_class).toBe("critical");
      expect(body.reentry_policy).toBe("every_time");
      expect(body.reentry_cooldown_days).toBe(14);
      expect(body.steps).toHaveLength(2);
    });

    // --- validation failures ---

    it("400 when name is missing", async () => {
      if (!dbAvailable) return;
      const app = await buildApp({ db, logger: false });
      const payload = minimalFlow();
      delete (payload as any).name;
      const res = await app.inject({
        method: "POST", url: "/v1/flows", headers: { cookie: cookieA }, payload,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().issues.some((i: any) => i.path === "name")).toBe(true);
    });

    it("400 when trigger_type is invalid", async () => {
      if (!dbAvailable) return;
      const app = await buildApp({ db, logger: false });
      const res = await app.inject({
        method: "POST", url: "/v1/flows", headers: { cookie: cookieA },
        payload: minimalFlow({ trigger_type: "webhook" }),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().issues.some((i: any) => i.path === "trigger_type")).toBe(true);
    });

    it("400 when flow_class is invalid", async () => {
      if (!dbAvailable) return;
      const app = await buildApp({ db, logger: false });
      const res = await app.inject({
        method: "POST", url: "/v1/flows", headers: { cookie: cookieA },
        payload: minimalFlow({ flow_class: "low_priority" }),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().issues.some((i: any) => i.path === "flow_class")).toBe(true);
    });

    it("400 when reentry_policy is invalid", async () => {
      if (!dbAvailable) return;
      const app = await buildApp({ db, logger: false });
      const res = await app.inject({
        method: "POST", url: "/v1/flows", headers: { cookie: cookieA },
        payload: minimalFlow({ reentry_policy: "always" }),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().issues.some((i: any) => i.path === "reentry_policy")).toBe(true);
    });

    it("400 when step is missing order", async () => {
      if (!dbAvailable) return;
      const app = await buildApp({ db, logger: false });
      const res = await app.inject({
        method: "POST", url: "/v1/flows", headers: { cookie: cookieA },
        payload: minimalFlow({
          steps: [{ action_type: "nurture_value", delay: "0m", window_policy: "immediate" }],
        }),
      });
      expect(res.statusCode).toBe(400);
    });

    it("400 when step is missing action_type", async () => {
      if (!dbAvailable) return;
      const app = await buildApp({ db, logger: false });
      const res = await app.inject({
        method: "POST", url: "/v1/flows", headers: { cookie: cookieA },
        payload: minimalFlow({
          steps: [{ order: 1, delay: "0m", window_policy: "immediate" }],
        }),
      });
      expect(res.statusCode).toBe(400);
    });

    it("400 when step has invalid window_policy", async () => {
      if (!dbAvailable) return;
      const app = await buildApp({ db, logger: false });
      const res = await app.inject({
        method: "POST", url: "/v1/flows", headers: { cookie: cookieA },
        payload: minimalFlow({
          steps: [{ order: 1, action_type: "nurture_value", delay: "0m", window_policy: "whenever" }],
        }),
      });
      expect(res.statusCode).toBe(400);
    });

    it("400 when step has invalid delay format", async () => {
      if (!dbAvailable) return;
      const app = await buildApp({ db, logger: false });
      // Test several invalid formats
      for (const badDelay of ["3", "3days", "1.5h", "h3", "3 d", "-1d"]) {
        const res = await app.inject({
          method: "POST", url: "/v1/flows", headers: { cookie: cookieA },
          payload: minimalFlow({
            steps: [{ order: 1, action_type: "nurture_value", delay: badDelay, window_policy: "immediate" }],
          }),
        });
        expect(res.statusCode, `expected 400 for delay '${badDelay}'`).toBe(400);
      }
    });

    it("accepts valid delay formats: 0m, 30m, 2h, 3d", async () => {
      if (!dbAvailable) return;
      const app = await buildApp({ db, logger: false });
      for (const goodDelay of ["0m", "30m", "2h", "3d", "100d"]) {
        const res = await app.inject({
          method: "POST", url: "/v1/flows", headers: { cookie: cookieA },
          payload: minimalFlow({
            name: `Delay test ${goodDelay}`,
            steps: [{ order: 1, action_type: "nurture_value", delay: goodDelay, window_policy: "immediate" }],
          }),
        });
        expect(res.statusCode, `expected 201 for delay '${goodDelay}'`).toBe(201);
      }
    });

    it("400 when steps have duplicate orders", async () => {
      if (!dbAvailable) return;
      const app = await buildApp({ db, logger: false });
      const res = await app.inject({
        method: "POST", url: "/v1/flows", headers: { cookie: cookieA },
        payload: minimalFlow({
          steps: [
            { order: 1, action_type: "nurture_value", delay: "0m", window_policy: "immediate" },
            { order: 1, action_type: "nurture_tip",   delay: "1d", window_policy: "respect_window" },
          ],
        }),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/[Dd]uplicate/);
    });
  });

  describe("GET /v1/flows", () => {
    it("lists only non-archived flows by default", async () => {
      if (!dbAvailable) return;
      const app = await buildApp({ db, logger: false });

      // Create a draft and an archived flow
      const r1 = await app.inject({
        method: "POST", url: "/v1/flows", headers: { cookie: cookieA },
        payload: minimalFlow({ name: "List Draft" }),
      });
      const draftId = r1.json().id;

      const r2 = await app.inject({
        method: "POST", url: "/v1/flows", headers: { cookie: cookieA },
        payload: minimalFlow({ name: "List Archived" }),
      });
      const archivedId = r2.json().id;
      await app.inject({
        method: "DELETE", url: `/v1/flows/${archivedId}`, headers: { cookie: cookieA },
      });

      const res = await app.inject({
        method: "GET", url: "/v1/flows", headers: { cookie: cookieA },
      });
      expect(res.statusCode).toBe(200);
      const ids = res.json().flows.map((f: any) => f.id);
      expect(ids).toContain(draftId);
      expect(ids).not.toContain(archivedId);
    });

    it("includes archived flows when include_archived=true", async () => {
      if (!dbAvailable) return;
      const app = await buildApp({ db, logger: false });

      const r1 = await app.inject({
        method: "POST", url: "/v1/flows", headers: { cookie: cookieA },
        payload: minimalFlow({ name: "Include Archived Test" }),
      });
      const id = r1.json().id;
      await app.inject({
        method: "DELETE", url: `/v1/flows/${id}`, headers: { cookie: cookieA },
      });

      const res = await app.inject({
        method: "GET", url: "/v1/flows?include_archived=true", headers: { cookie: cookieA },
      });
      expect(res.statusCode).toBe(200);
      const ids = res.json().flows.map((f: any) => f.id);
      expect(ids).toContain(id);
    });

    it("returns 401 without session", async () => {
      if (!dbAvailable) return;
      const app = await buildApp({ db, logger: false });
      const res = await app.inject({ method: "GET", url: "/v1/flows" });
      expect(res.statusCode).toBe(401);
    });
  });

  describe("GET /v1/flows/:id", () => {
    it("returns the full flow row", async () => {
      if (!dbAvailable) return;
      const app = await buildApp({ db, logger: false });
      const created = await app.inject({
        method: "POST", url: "/v1/flows", headers: { cookie: cookieA },
        payload: minimalFlow({ name: "Get By Id" }),
      });
      const id = created.json().id;

      const res = await app.inject({
        method: "GET", url: `/v1/flows/${id}`, headers: { cookie: cookieA },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.id).toBe(id);
      expect(body.name).toBe("Get By Id");
      expect(body.steps).toHaveLength(1);
    });

    it("returns 404 for a non-existent id", async () => {
      if (!dbAvailable) return;
      const app = await buildApp({ db, logger: false });
      const res = await app.inject({
        method: "GET",
        url: "/v1/flows/00000000-0000-0000-0000-000000000000",
        headers: { cookie: cookieA },
      });
      expect(res.statusCode).toBe(404);
    });

    it("returns 404 for a flow owned by another tenant (no info leak)", async () => {
      if (!dbAvailable) return;
      const app = await buildApp({ db, logger: false });
      // Create under tenant B
      const created = await app.inject({
        method: "POST", url: "/v1/flows",
        headers: { cookie: `claros_session=${sessionBId}` },
        payload: minimalFlow({ name: "Tenant B Flow" }),
      });
      const idB = created.json().id;

      // Attempt to read as tenant A
      const res = await app.inject({
        method: "GET", url: `/v1/flows/${idB}`, headers: { cookie: cookieA },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("PATCH /v1/flows/:id", () => {
    it("updates metadata fields", async () => {
      if (!dbAvailable) return;
      const app = await buildApp({ db, logger: false });
      const created = await app.inject({
        method: "POST", url: "/v1/flows", headers: { cookie: cookieA },
        payload: minimalFlow({ name: "Before Update" }),
      });
      const id = created.json().id;

      const res = await app.inject({
        method: "PATCH", url: `/v1/flows/${id}`, headers: { cookie: cookieA },
        payload: { name: "After Update", priority: 5, description: "New desc" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.name).toBe("After Update");
      expect(body.priority).toBe(5);
      expect(body.description).toBe("New desc");
    });

    it("status transition draft -> active succeeds", async () => {
      if (!dbAvailable) return;
      const app = await buildApp({ db, logger: false });
      const created = await app.inject({
        method: "POST", url: "/v1/flows", headers: { cookie: cookieA },
        payload: minimalFlow({ name: "Activate Flow" }),
      });
      const id = created.json().id;

      // Simulate compilation (required before activation)
      await simulateCompilation(id);

      const res = await app.inject({
        method: "PATCH", url: `/v1/flows/${id}`, headers: { cookie: cookieA },
        payload: { status: "active" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe("active");
    });

    it("status transition active -> paused succeeds", async () => {
      if (!dbAvailable) return;
      const app = await buildApp({ db, logger: false });
      const created = await app.inject({
        method: "POST", url: "/v1/flows", headers: { cookie: cookieA },
        payload: minimalFlow({ name: "Pause Flow" }),
      });
      const id = created.json().id;
      await simulateCompilation(id);
      await app.inject({
        method: "PATCH", url: `/v1/flows/${id}`, headers: { cookie: cookieA },
        payload: { status: "active" },
      });

      const res = await app.inject({
        method: "PATCH", url: `/v1/flows/${id}`, headers: { cookie: cookieA },
        payload: { status: "paused" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe("paused");
    });

    it("status transition paused -> active succeeds", async () => {
      if (!dbAvailable) return;
      const app = await buildApp({ db, logger: false });
      const created = await app.inject({
        method: "POST", url: "/v1/flows", headers: { cookie: cookieA },
        payload: minimalFlow({ name: "Re-activate Flow" }),
      });
      const id = created.json().id;
      await simulateCompilation(id);
      await app.inject({ method: "PATCH", url: `/v1/flows/${id}`, headers: { cookie: cookieA }, payload: { status: "active" } });
      await app.inject({ method: "PATCH", url: `/v1/flows/${id}`, headers: { cookie: cookieA }, payload: { status: "paused" } });

      const res = await app.inject({
        method: "PATCH", url: `/v1/flows/${id}`, headers: { cookie: cookieA },
        payload: { status: "active" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe("active");
    });

    it("422 on status transition archived -> active (terminal)", async () => {
      if (!dbAvailable) return;
      const app = await buildApp({ db, logger: false });
      const created = await app.inject({
        method: "POST", url: "/v1/flows", headers: { cookie: cookieA },
        payload: minimalFlow({ name: "Archived Transition Test" }),
      });
      const id = created.json().id;
      await app.inject({ method: "DELETE", url: `/v1/flows/${id}`, headers: { cookie: cookieA } });

      const res = await app.inject({
        method: "PATCH", url: `/v1/flows/${id}`, headers: { cookie: cookieA },
        payload: { status: "active" },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().error).toMatch(/archived/);
    });

    it("422 on status transition draft -> paused with informative message", async () => {
      if (!dbAvailable) return;
      const app = await buildApp({ db, logger: false });
      const created = await app.inject({
        method: "POST", url: "/v1/flows", headers: { cookie: cookieA },
        payload: minimalFlow({ name: "Draft to Paused" }),
      });
      const id = created.json().id;

      const res = await app.inject({
        method: "PATCH", url: `/v1/flows/${id}`, headers: { cookie: cookieA },
        payload: { status: "paused" },
      });
      expect(res.statusCode).toBe(422);
      // Message must explain that the flow must be active first
      expect(res.json().error).toMatch(/active/);
      expect(res.json().error).toMatch(/draft/);
    });

    it("422 when activating a flow without a compiled plan", async () => {
      if (!dbAvailable) return;
      const app = await buildApp({ db, logger: false });
      const created = await app.inject({
        method: "POST", url: "/v1/flows", headers: { cookie: cookieA },
        payload: minimalFlow({ name: "Uncompiled Activation" }),
      });
      const id = created.json().id;

      // Do NOT simulate compilation - leave compile_status = null, compiled_plan = null
      const res = await app.inject({
        method: "PATCH", url: `/v1/flows/${id}`, headers: { cookie: cookieA },
        payload: { status: "active" },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().error).toMatch(/compiled plan/i);
      expect(res.json().error).toMatch(/compile/i);
    });

    it("422 when editing prompt_source on an active flow", async () => {
      if (!dbAvailable) return;
      const app = await buildApp({ db, logger: false });
      const created = await app.inject({
        method: "POST", url: "/v1/flows", headers: { cookie: cookieA },
        payload: minimalFlow({ name: "Active Prompt Edit", prompt_source: "original prompt" }),
      });
      const id = created.json().id;
      await simulateCompilation(id);
      await app.inject({ method: "PATCH", url: `/v1/flows/${id}`, headers: { cookie: cookieA }, payload: { status: "active" } });

      const res = await app.inject({
        method: "PATCH", url: `/v1/flows/${id}`, headers: { cookie: cookieA },
        payload: { prompt_source: "modified prompt" },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().error).toMatch(/pause/i);
    });

    it("updating prompt_source on draft clears compiled_plan and compiled_at", async () => {
      if (!dbAvailable) return;

      // Manually write a compiled_plan into the DB to simulate a prior compilation
      const app = await buildApp({ db, logger: false });
      const created = await app.inject({
        method: "POST", url: "/v1/flows", headers: { cookie: cookieA },
        payload: minimalFlow({ name: "Clear Plan Draft", prompt_source: "original" }),
      });
      const id = created.json().id;

      await db.update(flows).set({
        compiledPlan: { steps: [{ order: 1 }] },
        compiledAt: new Date("2025-01-01T00:00:00Z"),
      }).where(eq(flows.id, id));

      const res = await app.inject({
        method: "PATCH", url: `/v1/flows/${id}`, headers: { cookie: cookieA },
        payload: { prompt_source: "updated prompt" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.prompt_source).toBe("updated prompt");
      expect(body.compiled_plan).toBeNull();
      expect(body.compiled_at).toBeNull();
    });

    it("updating prompt_source on paused flow clears compiled_plan", async () => {
      if (!dbAvailable) return;
      const app = await buildApp({ db, logger: false });
      const created = await app.inject({
        method: "POST", url: "/v1/flows", headers: { cookie: cookieA },
        payload: minimalFlow({ name: "Clear Plan Paused", prompt_source: "original" }),
      });
      const id = created.json().id;
      await simulateCompilation(id);
      await app.inject({ method: "PATCH", url: `/v1/flows/${id}`, headers: { cookie: cookieA }, payload: { status: "active" } });
      await app.inject({ method: "PATCH", url: `/v1/flows/${id}`, headers: { cookie: cookieA }, payload: { status: "paused" } });

      await db.update(flows).set({
        compiledPlan: { steps: [] },
        compiledAt: new Date("2025-01-01T00:00:00Z"),
      }).where(eq(flows.id, id));

      const res = await app.inject({
        method: "PATCH", url: `/v1/flows/${id}`, headers: { cookie: cookieA },
        payload: { prompt_source: "new prompt for recompile" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().compiled_plan).toBeNull();
      expect(res.json().compiled_at).toBeNull();
    });

    it("setting prompt_source to the same value does NOT clear compiled_plan", async () => {
      if (!dbAvailable) return;
      const app = await buildApp({ db, logger: false });
      const created = await app.inject({
        method: "POST", url: "/v1/flows", headers: { cookie: cookieA },
        payload: minimalFlow({ name: "No-op Prompt", prompt_source: "same prompt" }),
      });
      const id = created.json().id;

      const fakeplan = { steps: [{ order: 1, action_type: "nurture_value" }] };
      await db.update(flows).set({ compiledPlan: fakeplan, compiledAt: new Date("2025-01-01") }).where(eq(flows.id, id));

      const res = await app.inject({
        method: "PATCH", url: `/v1/flows/${id}`, headers: { cookie: cookieA },
        payload: { prompt_source: "same prompt" }, // same value
      });
      expect(res.statusCode).toBe(200);
      // Plan should NOT be cleared because the value did not change
      expect(res.json().compiled_plan).not.toBeNull();
    });

    it("returns 404 for a non-existent id", async () => {
      if (!dbAvailable) return;
      const app = await buildApp({ db, logger: false });
      const res = await app.inject({
        method: "PATCH",
        url: "/v1/flows/00000000-0000-0000-0000-000000000000",
        headers: { cookie: cookieA },
        payload: { name: "Ghost" },
      });
      expect(res.statusCode).toBe(404);
    });

    it("returns 404 for a flow owned by another tenant", async () => {
      if (!dbAvailable) return;
      const app = await buildApp({ db, logger: false });
      const created = await app.inject({
        method: "POST", url: "/v1/flows",
        headers: { cookie: `claros_session=${sessionBId}` },
        payload: minimalFlow({ name: "Tenant B Only" }),
      });
      const idB = created.json().id;

      const res = await app.inject({
        method: "PATCH", url: `/v1/flows/${idB}`, headers: { cookie: cookieA },
        payload: { name: "Hijack" },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("DELETE /v1/flows/:id", () => {
    it("archives the flow and returns the updated row", async () => {
      if (!dbAvailable) return;
      const app = await buildApp({ db, logger: false });
      const created = await app.inject({
        method: "POST", url: "/v1/flows", headers: { cookie: cookieA },
        payload: minimalFlow({ name: "To Archive" }),
      });
      const id = created.json().id;

      const res = await app.inject({
        method: "DELETE", url: `/v1/flows/${id}`, headers: { cookie: cookieA },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe("archived");
    });

    it("preserves compiled_plan when archiving", async () => {
      if (!dbAvailable) return;
      const app = await buildApp({ db, logger: false });
      const created = await app.inject({
        method: "POST", url: "/v1/flows", headers: { cookie: cookieA },
        payload: minimalFlow({ name: "Archive With Plan" }),
      });
      const id = created.json().id;

      const fakeplan = { steps: [{ order: 1, action_type: "nurture_value" }] };
      await db.update(flows).set({ compiledPlan: fakeplan, compiledAt: new Date("2025-06-01") }).where(eq(flows.id, id));

      const res = await app.inject({
        method: "DELETE", url: `/v1/flows/${id}`, headers: { cookie: cookieA },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.status).toBe("archived");
      // The compiled plan must be preserved
      expect(body.compiled_plan).not.toBeNull();
      expect(body.compiled_plan).toEqual(fakeplan);
    });

    it("is idempotent when already archived", async () => {
      if (!dbAvailable) return;
      const app = await buildApp({ db, logger: false });
      const created = await app.inject({
        method: "POST", url: "/v1/flows", headers: { cookie: cookieA },
        payload: minimalFlow({ name: "Idempotent Archive" }),
      });
      const id = created.json().id;

      await app.inject({ method: "DELETE", url: `/v1/flows/${id}`, headers: { cookie: cookieA } });
      const res = await app.inject({
        method: "DELETE", url: `/v1/flows/${id}`, headers: { cookie: cookieA },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe("archived");
    });

    it("returns 404 for a non-existent id", async () => {
      if (!dbAvailable) return;
      const app = await buildApp({ db, logger: false });
      const res = await app.inject({
        method: "DELETE",
        url: "/v1/flows/00000000-0000-0000-0000-000000000000",
        headers: { cookie: cookieA },
      });
      expect(res.statusCode).toBe(404);
    });

    it("returns 404 for a flow owned by another tenant", async () => {
      if (!dbAvailable) return;
      const app = await buildApp({ db, logger: false });
      const created = await app.inject({
        method: "POST", url: "/v1/flows",
        headers: { cookie: `claros_session=${sessionBId}` },
        payload: minimalFlow({ name: "B Private Flow" }),
      });
      const idB = created.json().id;

      const res = await app.inject({
        method: "DELETE", url: `/v1/flows/${idB}`, headers: { cookie: cookieA },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // POST /v1/flows/:id/plan (person-written fixed_content flow)
  // -------------------------------------------------------------------------

  describe("POST /v1/flows/:id/plan", () => {
    it("saves a plan for a fixed_content flow and creates templates", async () => {
      if (!dbAvailable) return;
      const app = await buildApp({ db, logger: false });

      // Create a fixed_content flow
      const created = await app.inject({
        method: "POST",
        url: "/v1/flows",
        headers: { cookie: cookieA },
        payload: {
          ...minimalFlow({ name: "Person Written Test" }),
          content_mode: "fixed_content",
        },
      });
      expect(created.statusCode).toBe(201);
      const flow = created.json();
      expect(flow.content_mode).toBe("fixed_content");
      expect(flow.approval_mode).toBe("auto"); // default for fixed_content

      // Save a plan with step content
      const planRes = await app.inject({
        method: "POST",
        url: `/v1/flows/${flow.id}/plan`,
        headers: { cookie: cookieA },
        payload: {
          steps: [
            {
              order: 1,
              delay: "0m",
              action_type: "onboard_welcome",
              window_policy: "immediate",
              subject: "Welcome {{contact.first_name|there}}!",
              body_html: "<p>Hi {{contact.first_name|there}}, welcome to our product.</p>",
            },
            {
              order: 2,
              delay: "3d",
              action_type: "nurture_value",
              window_policy: "respect_window",
              subject: "Getting started with {{tenant.name}}",
              body_html: "<p>Here are some tips to get the most out of {{tenant.name}}.</p>",
              body_text: "Here are some tips to get the most out of {{tenant.name}}.",
            },
          ],
        },
      });
      expect(planRes.statusCode).toBe(200);
      const updated = planRes.json();
      expect(updated.compile_status).toBe("ready");
      expect(updated.compiled_plan).not.toBeNull();
      expect(updated.compiled_plan.steps).toHaveLength(2);
      expect(updated.compiled_plan.steps[0].template_ref).toMatch(/^flow-.*-step-1$/);
      expect(updated.compiled_plan.steps[1].template_ref).toMatch(/^flow-.*-step-2$/);

      // The flow can now be activated
      const activateRes = await app.inject({
        method: "PATCH",
        url: `/v1/flows/${flow.id}`,
        headers: { cookie: cookieA },
        payload: { status: "active" },
      });
      expect(activateRes.statusCode).toBe(200);
      expect(activateRes.json().status).toBe("active");
    });

    it("rejects plan for ai_drafted flow", async () => {
      if (!dbAvailable) return;
      const app = await buildApp({ db, logger: false });

      const created = await app.inject({
        method: "POST",
        url: "/v1/flows",
        headers: { cookie: cookieA },
        payload: minimalFlow({ name: "AI Flow No Plan" }),
      });
      const flow = created.json();

      const res = await app.inject({
        method: "POST",
        url: `/v1/flows/${flow.id}/plan`,
        headers: { cookie: cookieA },
        payload: { steps: [{ order: 1, delay: "0m", action_type: "x", window_policy: "immediate", subject: "s", body_html: "b" }] },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().error).toContain("fixed_content");
    });

    it("rejects plan with empty steps", async () => {
      if (!dbAvailable) return;
      const app = await buildApp({ db, logger: false });

      const created = await app.inject({
        method: "POST",
        url: "/v1/flows",
        headers: { cookie: cookieA },
        payload: { ...minimalFlow({ name: "Empty Plan" }), content_mode: "fixed_content" },
      });
      const flow = created.json();

      const res = await app.inject({
        method: "POST",
        url: `/v1/flows/${flow.id}/plan`,
        headers: { cookie: cookieA },
        payload: { steps: [] },
      });
      expect(res.statusCode).toBe(400);
    });

    it("rejects plan with missing subject", async () => {
      if (!dbAvailable) return;
      const app = await buildApp({ db, logger: false });

      const created = await app.inject({
        method: "POST",
        url: "/v1/flows",
        headers: { cookie: cookieA },
        payload: { ...minimalFlow({ name: "No Subject" }), content_mode: "fixed_content" },
      });
      const flow = created.json();

      const res = await app.inject({
        method: "POST",
        url: `/v1/flows/${flow.id}/plan`,
        headers: { cookie: cookieA },
        payload: { steps: [{ order: 1, delay: "0m", action_type: "x", window_policy: "immediate", subject: "", body_html: "b" }] },
      });
      expect(res.statusCode).toBe(400);
    });
  });
});
