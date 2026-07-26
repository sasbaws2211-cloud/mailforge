/**
 * Integration tests for business model templates (task 25).
 *
 * Coverage:
 *
 * GET /v1/templates:
 *   - Returns all three templates with id, name, description, flow_count.
 *
 * POST /v1/templates/:id/apply:
 *   - Applies each template successfully, writing lifecycle/throttle/brain_context
 *     settings and creating draft flows.
 *   - Applying writes settings that resolvers read back correctly (verified
 *     through resolveLifecycleConfig and resolveThrottleConfig).
 *   - Flows are created in draft status, not compiled.
 *   - Applying to a tenant with no LLM configuration succeeds.
 *   - A second apply is rejected (409) with the business model unchanged and
 *     no additional flows created.
 *   - Unknown template id returns 400.
 *   - Every template applies cleanly (no errors for any of the three).
 *   - Tenant isolation: applying a template affects only the calling tenant.
 *
 * Requires local Postgres (docker compose up postgres).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { sql, eq } from "drizzle-orm";
import { buildApp } from "../src/index.js";
import { tenants, users, sessions, flows } from "@claros/db/schema";
import { resolveLifecycleConfig, resolveThrottleConfig, BUSINESS_MODEL_TEMPLATE_LIST } from "@claros/core";

const TEST_DB_URL = process.env.DATABASE_URL;
if (!TEST_DB_URL) {
  const inCI = process.env.CI === "true";
  throw new Error(
    `[templates.test] DATABASE_URL is not set.\n\n` +
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
let cookieA: string;
let cookieBId: string;

const SLUG_A = "test-template-a";
const SLUG_B = "test-template-b";

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
        `[templates.test] DATABASE_URL not reachable in CI.\n` +
          `URL: ${TEST_DB_URL}\nCause: ${(err as Error).message}`,
      );
    }
    console.warn("[templates.test] DATABASE_URL not reachable - tests skipped.");
    return;
  }
  await cleanup();
  await setupTenants();
});

afterAll(async () => {
  if (dbAvailable) await cleanup();
  await pool.end();
});

// Reset the tenant state between each test (clear business_model and settings/flows)
beforeEach(async () => {
  if (!dbAvailable) return;
  // Reset business_model and settings for both tenants
  await db.execute(sql`UPDATE tenants SET business_model = NULL, settings = NULL WHERE slug IN (${SLUG_A}, ${SLUG_B})`);
  // Delete all flows created by templates
  await db.execute(sql`DELETE FROM flows WHERE tenant_id IN (SELECT id FROM tenants WHERE slug IN (${SLUG_A}, ${SLUG_B}))`);
});

async function cleanup() {
  for (const slug of [SLUG_A, SLUG_B]) {
    await db.execute(sql`DELETE FROM flows WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${slug})`);
    await db.execute(sql`DELETE FROM sessions WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${slug})`);
    await db.execute(sql`DELETE FROM users WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${slug})`);
    await db.execute(sql`DELETE FROM tenants WHERE slug = ${slug}`);
  }
}

async function setupTenants() {
  const [tA] = await db.insert(tenants).values({ name: "Template Test A", slug: SLUG_A, plan: "free" }).returning({ id: tenants.id });
  tenantAId = tA!.id;
  const [uA] = await db.insert(users).values({ tenantId: tenantAId, email: "owner-a@tmpl.test", role: "owner" }).returning({ id: users.id });
  const [sA] = await db.insert(sessions).values({ tenantId: tenantAId, userId: uA!.id, expiresAt: new Date(Date.now() + 86400_000) }).returning({ id: sessions.id });
  cookieA = `claros_session=${sA!.id}`;

  const [tB] = await db.insert(tenants).values({ name: "Template Test B", slug: SLUG_B, plan: "free" }).returning({ id: tenants.id });
  tenantBId = tB!.id;
  const [uB] = await db.insert(users).values({ tenantId: tenantBId, email: "owner-b@tmpl.test", role: "owner" }).returning({ id: users.id });
  const [sB] = await db.insert(sessions).values({ tenantId: tenantBId, userId: uB!.id, expiresAt: new Date(Date.now() + 86400_000) }).returning({ id: sessions.id });
  cookieBId = sB!.id;
}

describe("GET /v1/templates", () => {
  it("returns all three templates with expected fields", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });
    const res = await app.inject({ method: "GET", url: "/v1/templates", headers: { cookie: cookieA } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.templates)).toBe(true);
    expect(body.templates).toHaveLength(3);

    const ids = body.templates.map((t: any) => t.id);
    expect(ids).toContain("preview_free");
    expect(ids).toContain("freemium");
    expect(ids).toContain("time_limited_trial");

    for (const t of body.templates) {
      expect(typeof t.id).toBe("string");
      expect(typeof t.name).toBe("string");
      expect(typeof t.description).toBe("string");
      expect(typeof t.flow_count).toBe("number");
      expect(t.flow_count).toBeGreaterThan(0);
    }
  });

  it("returns 401 without session", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });
    const res = await app.inject({ method: "GET", url: "/v1/templates" });
    expect(res.statusCode).toBe(401);
  });
});

describe("POST /v1/templates/:id/apply", () => {
  it("applies preview_free template: writes settings, creates draft flows", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });
    const res = await app.inject({
      method: "POST",
      url: "/v1/templates/preview_free/apply",
      headers: { cookie: cookieA },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.business_model).toBe("preview_free");
    expect(Array.isArray(body.flows_created)).toBe(true);
    expect(body.flows_created.length).toBeGreaterThan(0);
    // All flows in draft
    for (const f of body.flows_created) {
      expect(f.status).toBe("draft");
    }

    // Verify tenant row updated
    const [tenantRow] = await db.select({ businessModel: tenants.businessModel, settings: tenants.settings })
      .from(tenants).where(eq(tenants.id, tenantAId));
    expect(tenantRow?.businessModel).toBe("preview_free");
  });

  it("settings are read back correctly by resolveLifecycleConfig and resolveThrottleConfig", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });
    await app.inject({ method: "POST", url: "/v1/templates/preview_free/apply", headers: { cookie: cookieA } });

    const [tenantRow] = await db.select({ settings: tenants.settings })
      .from(tenants).where(eq(tenants.id, tenantAId));

    const settings = tenantRow?.settings as Record<string, unknown> | null;

    // Verify lifecycle resolver reads back spec values
    const lifecycle = resolveLifecycleConfig(settings?.lifecycle as any);
    expect(lifecycle.activation_window_days).toBe(7);
    expect(lifecycle.natural_frequency_days).toBe(3);
    expect(lifecycle.at_risk_missed_intervals).toBe(2);
    expect(lifecycle.dormant_days).toBe(14);
    expect(lifecycle.churned_days).toBe(30);

    // Verify throttle resolver reads back spec values
    const throttle = resolveThrottleConfig(settings?.throttle);
    expect(throttle.max_emails_per_user_per_week).toBe(3);
    expect(throttle.min_interval_between_emails_hours).toBe(24);

    // Brain context stored
    expect(settings?.brain_context).toBeTruthy();
    expect(typeof settings?.brain_context).toBe("string");
  });

  it("freemium template: lifecycle and throttle match spec values", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });
    await app.inject({ method: "POST", url: "/v1/templates/freemium/apply", headers: { cookie: cookieA } });

    const [tenantRow] = await db.select({ settings: tenants.settings }).from(tenants).where(eq(tenants.id, tenantAId));
    const settings = tenantRow?.settings as Record<string, unknown> | null;

    const lifecycle = resolveLifecycleConfig(settings?.lifecycle as any);
    expect(lifecycle.activation_window_days).toBe(14);
    expect(lifecycle.natural_frequency_days).toBe(7);
    expect(lifecycle.at_risk_missed_intervals).toBe(3);
    expect(lifecycle.dormant_days).toBe(45);
    expect(lifecycle.churned_days).toBe(120);

    const throttle = resolveThrottleConfig(settings?.throttle);
    expect(throttle.max_emails_per_user_per_week).toBe(1);
    expect(throttle.min_interval_between_emails_hours).toBe(72);
  });

  it("time_limited_trial template: lifecycle and throttle match spec values", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });
    await app.inject({ method: "POST", url: "/v1/templates/time_limited_trial/apply", headers: { cookie: cookieA } });

    const [tenantRow] = await db.select({ settings: tenants.settings }).from(tenants).where(eq(tenants.id, tenantAId));
    const settings = tenantRow?.settings as Record<string, unknown> | null;

    const lifecycle = resolveLifecycleConfig(settings?.lifecycle as any);
    expect(lifecycle.activation_window_days).toBe(3);
    expect(lifecycle.natural_frequency_days).toBe(2);
    expect(lifecycle.dormant_days).toBe(7);
    expect(lifecycle.churned_days).toBe(14);

    const throttle = resolveThrottleConfig(settings?.throttle);
    expect(throttle.max_emails_per_user_per_week).toBe(4);
    expect(throttle.min_interval_between_emails_hours).toBe(18);
  });

  it("every template applies without error (completeness check)", async () => {
    if (!dbAvailable) return;
    for (const template of BUSINESS_MODEL_TEMPLATE_LIST) {
      // Use a fresh tenant for each template to avoid conflict
      const slug = `test-tmpl-complete-${template.id}`;
      await db.execute(sql`DELETE FROM flows WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${slug})`);
      await db.execute(sql`DELETE FROM sessions WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${slug})`);
      await db.execute(sql`DELETE FROM users WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${slug})`);
      await db.execute(sql`DELETE FROM tenants WHERE slug = ${slug}`);

      const [t] = await db.insert(tenants).values({ name: `Template ${template.id}`, slug, plan: "free" }).returning({ id: tenants.id });
      const [u] = await db.insert(users).values({ tenantId: t!.id, email: `owner@${template.id}.test`, role: "owner" }).returning({ id: users.id });
      const [s] = await db.insert(sessions).values({ tenantId: t!.id, userId: u!.id, expiresAt: new Date(Date.now() + 86400_000) }).returning({ id: sessions.id });
      const cookie = `claros_session=${s!.id}`;

      const app = await buildApp({ db, logger: false });
      const res = await app.inject({
        method: "POST",
        url: `/v1/templates/${template.id}/apply`,
        headers: { cookie },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().business_model).toBe(template.id);
      expect(res.json().flows_created.length).toBe(template.flows.length);

      // Cleanup
      await db.execute(sql`DELETE FROM flows WHERE tenant_id = ${t!.id}::uuid`);
      await db.execute(sql`DELETE FROM sessions WHERE tenant_id = ${t!.id}::uuid`);
      await db.execute(sql`DELETE FROM users WHERE tenant_id = ${t!.id}::uuid`);
      await db.execute(sql`DELETE FROM tenants WHERE id = ${t!.id}::uuid`);
    }
  });

  it("flows are created in draft status and are not compiled", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });
    await app.inject({ method: "POST", url: "/v1/templates/preview_free/apply", headers: { cookie: cookieA } });

    const flowRows = await db.select({
      status: flows.status,
      compileStatus: flows.compileStatus,
      compiledPlan: flows.compiledPlan,
      source: flows.source,
    }).from(flows).where(eq(flows.tenantId, tenantAId));

    expect(flowRows.length).toBeGreaterThan(0);
    for (const f of flowRows) {
      expect(f.status).toBe("draft");
      expect(f.compileStatus).toBeNull();
      expect(f.compiledPlan).toBeNull();
      expect(f.source).toBe("library");
    }
  });

  it("applying to a tenant with no LLM configuration succeeds", async () => {
    // No llm_configs row exists for tenantA - the apply endpoint must not require it
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });
    const res = await app.inject({
      method: "POST",
      url: "/v1/templates/freemium/apply",
      headers: { cookie: cookieA },
    });
    expect(res.statusCode).toBe(200); // must succeed without credentials
  });

  it("second apply is rejected (409) with business model unchanged and no additional flows", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });

    // First apply
    const res1 = await app.inject({
      method: "POST",
      url: "/v1/templates/preview_free/apply",
      headers: { cookie: cookieA },
    });
    expect(res1.statusCode).toBe(200);
    const flowsAfterFirst = await db.select({ id: flows.id }).from(flows).where(eq(flows.tenantId, tenantAId));

    // Second apply (different template)
    const res2 = await app.inject({
      method: "POST",
      url: "/v1/templates/freemium/apply",
      headers: { cookie: cookieA },
    });
    expect(res2.statusCode).toBe(409);
    expect(res2.json().applied_template).toBe("preview_free");

    // Business model unchanged
    const [tenantRow] = await db.select({ businessModel: tenants.businessModel })
      .from(tenants).where(eq(tenants.id, tenantAId));
    expect(tenantRow?.businessModel).toBe("preview_free");

    // No additional flows created
    const flowsAfterSecond = await db.select({ id: flows.id }).from(flows).where(eq(flows.tenantId, tenantAId));
    expect(flowsAfterSecond.length).toBe(flowsAfterFirst.length);
  });

  it("second apply (same template) is also rejected", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });

    await app.inject({ method: "POST", url: "/v1/templates/preview_free/apply", headers: { cookie: cookieA } });
    const res = await app.inject({ method: "POST", url: "/v1/templates/preview_free/apply", headers: { cookie: cookieA } });
    expect(res.statusCode).toBe(409);
  });

  it("unknown template id returns 400", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });
    const res = await app.inject({
      method: "POST",
      url: "/v1/templates/nonexistent_template/apply",
      headers: { cookie: cookieA },
    });
    expect(res.statusCode).toBe(400);
  });

  it("tenant isolation: applying a template affects only the calling tenant", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });

    // Apply as tenant A
    await app.inject({ method: "POST", url: "/v1/templates/preview_free/apply", headers: { cookie: cookieA } });

    // Tenant B must have no business_model and no flows
    const [tenantBRow] = await db.select({ businessModel: tenants.businessModel })
      .from(tenants).where(eq(tenants.id, tenantBId));
    expect(tenantBRow?.businessModel).toBeNull();

    const tenantBFlows = await db.select({ id: flows.id }).from(flows).where(eq(flows.tenantId, tenantBId));
    expect(tenantBFlows.length).toBe(0);
  });

  it("returns 401 without session", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });
    const res = await app.inject({ method: "POST", url: "/v1/templates/preview_free/apply" });
    expect(res.statusCode).toBe(401);
  });
});
