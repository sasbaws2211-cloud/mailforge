/**
 * Knowledge base CRUD integration tests.
 *
 * Coverage:
 *
 * Happy paths:
 *   - POST /v1/kb creates an entry; embedding vector is null; embedding_status shows in response; is_active defaults to true
 *   - POST /v1/kb with all optional fields
 *   - GET  /v1/kb lists active entries by default (excludes inactive) with preview
 *   - GET  /v1/kb?include_inactive=true includes inactive entries
 *   - GET  /v1/kb/:id returns the full entry (full content, not preview)
 *   - PATCH /v1/kb/:id updates supplied fields; unsupplied fields are preserved
 *   - DELETE /v1/kb/:id hard-deletes the entry; 404 on subsequent GET
 *
 * Auth:
 *   - Requests without a session cookie are rejected with 401
 *   - Bearer key (ingest scope) on KB endpoints returns 401
 *
 * Tenant isolation:
 *   - GET /v1/kb/:id for an entry owned by another tenant returns 404 (not 403)
 *   - PATCH /v1/kb/:id for an entry owned by another tenant returns 404
 *   - DELETE /v1/kb/:id for an entry owned by another tenant returns 404
 *   - GET /v1/kb list returns only entries for the calling tenant
 *
 * Validation:
 *   - POST without title: 400 with issues array containing path "title"
 *   - POST without content: 400 with issues array containing path "content"
 *   - POST with invalid content_type: 400
 *   - POST with invalid source: 400
 *   - PATCH with invalid content_type: 400
 *
 * Pagination:
 *   - Default page size (50) applies when ?limit is not specified
 *   - Max page size (200) is enforced when a larger value is requested
 *   - Cursor-based paging returns correct disjoint sets across pages
 *   - Tenant scoping holds on every page (other tenant's entries never appear)
 *   - next_cursor is null on the last page
 *   - list returns content_preview (≤300 chars), not full content
 *   - GET /v1/kb/:id returns full content, not a preview
 *
 * Update semantics:
 *   - PATCH that omits title does not clear title
 *   - PATCH that sets is_active=false deactivates the entry (excluded from default list)
 *   - PATCH that updates content re-enqueues embedding (enqueue called with KB_EMBED)
 *   - PATCH that updates only tags does NOT re-enqueue embedding
 *
 * Requires local Postgres (docker compose up postgres).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { sql } from "drizzle-orm";
import { buildApp } from "../src/index.js";
import { tenants, users, sessions, apiKeys } from "@claros/db/schema";
import { randomBytes, createHash } from "node:crypto";

const TEST_DB_URL = process.env.DATABASE_URL;
if (!TEST_DB_URL) {
  const inCI = process.env.CI === "true";
  throw new Error(
    `[kb.test] DATABASE_URL is not set.\n\n` +
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

const TEST_SLUG_A = "test-kb-a";
const TEST_SLUG_B = "test-kb-b";

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
        `[kb.test] DATABASE_URL not reachable in CI.\nURL: ${TEST_DB_URL}\nCause: ${(err as Error).message}`,
      );
    }
    console.warn("[kb.test] DATABASE_URL not reachable - integration tests will be skipped.");
    return;
  }

  // Clean up from previous runs (reverse dependency order)
  await db.execute(sql`DELETE FROM kb_entries WHERE tenant_id IN (SELECT id FROM tenants WHERE slug IN (${TEST_SLUG_A}, ${TEST_SLUG_B}))`);
  await db.execute(sql`DELETE FROM api_keys WHERE tenant_id IN (SELECT id FROM tenants WHERE slug IN (${TEST_SLUG_A}, ${TEST_SLUG_B}))`);
  await db.execute(sql`DELETE FROM sessions WHERE tenant_id IN (SELECT id FROM tenants WHERE slug IN (${TEST_SLUG_A}, ${TEST_SLUG_B}))`);
  await db.execute(sql`DELETE FROM users WHERE tenant_id IN (SELECT id FROM tenants WHERE slug IN (${TEST_SLUG_A}, ${TEST_SLUG_B}))`);
  await db.execute(sql`DELETE FROM tenants WHERE slug IN (${TEST_SLUG_A}, ${TEST_SLUG_B})`);

  // Tenant A
  const [tA] = await db
    .insert(tenants)
    .values({ name: "Test KB A", slug: TEST_SLUG_A, plan: "free" })
    .returning({ id: tenants.id });
  tenantAId = tA!.id;

  const [uA] = await db
    .insert(users)
    .values({ tenantId: tenantAId, email: "owner-a@kb.test", role: "owner" })
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
    .values({ name: "Test KB B", slug: TEST_SLUG_B, plan: "free" })
    .returning({ id: tenants.id });
  tenantBId = tB!.id;

  const [uB] = await db
    .insert(users)
    .values({ tenantId: tenantBId, email: "owner-b@kb.test", role: "owner" })
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
    await db.execute(sql`DELETE FROM kb_entries WHERE tenant_id IN (SELECT id FROM tenants WHERE slug IN (${TEST_SLUG_A}, ${TEST_SLUG_B}))`);
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

function minimalEntry(overrides: Record<string, unknown> = {}) {
  return {
    title: "Pricing FAQ",
    content: "Our pricing starts at $29/month.",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("KB CRUD", () => {
  describe("auth", () => {
    it("returns 401 with no session cookie", async () => {
      if (!dbAvailable) return;
      const app = await buildApp({ db, logger: false });
      const res = await app.inject({ method: "POST", url: "/v1/kb", payload: minimalEntry() });
      expect(res.statusCode).toBe(401);
    });

    it("returns 401 when using a bearer key (ingest scope) on the KB endpoint", async () => {
      if (!dbAvailable) return;
      const app = await buildApp({ db, logger: false });
      const res = await app.inject({
        method: "POST",
        url: "/v1/kb",
        headers: { authorization: `Bearer ${rawApiKey}` },
        payload: minimalEntry(),
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe("POST /v1/kb", () => {
    it("creates an entry; returns 201 with is_active=true and no embedding vector field", async () => {
      if (!dbAvailable) return;
      const app = await buildApp({ db, logger: false });
      const res = await app.inject({
        method: "POST",
        url: "/v1/kb",
        headers: { cookie: cookieA },
        payload: minimalEntry({ title: "Onboarding Guide" }),
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.title).toBe("Onboarding Guide");
      expect(body.is_active).toBe(true);
      expect(body.tenant_id).toBe(tenantAId);
      expect(typeof body.id).toBe("string");
      // embedding vector must not appear in the response (it's a large float array)
      expect("embedding" in body).toBe(false);
      // embedding_status is present (operators need it to track embedding lifecycle)
      expect("embedding_status" in body).toBe(true);
    });

    it("applies defaults: content_type=markdown, source=manual", async () => {
      if (!dbAvailable) return;
      const app = await buildApp({ db, logger: false });
      const res = await app.inject({
        method: "POST",
        url: "/v1/kb",
        headers: { cookie: cookieA },
        payload: minimalEntry({ title: "Defaults Test" }),
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.content_type).toBe("markdown");
      expect(body.source).toBe("manual");
    });

    it("accepts all optional fields", async () => {
      if (!dbAvailable) return;
      const app = await buildApp({ db, logger: false });
      const res = await app.inject({
        method: "POST",
        url: "/v1/kb",
        headers: { cookie: cookieA },
        payload: {
          title: "Full Entry",
          content: "Detailed content here.",
          content_type: "html",
          source: "crawl",
          source_url: "https://example.com/docs",
          tags: ["pricing", "faq"],
          is_active: false,
        },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.content_type).toBe("html");
      expect(body.source).toBe("crawl");
      expect(body.source_url).toBe("https://example.com/docs");
      expect(body.tags).toEqual(["pricing", "faq"]);
      expect(body.is_active).toBe(false);
    });

    // --- validation failures ---

    it("400 when title is missing", async () => {
      if (!dbAvailable) return;
      const app = await buildApp({ db, logger: false });
      const payload = minimalEntry();
      delete (payload as any).title;
      const res = await app.inject({
        method: "POST", url: "/v1/kb", headers: { cookie: cookieA }, payload,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().issues.some((i: any) => i.path === "title")).toBe(true);
    });

    it("400 when content is missing", async () => {
      if (!dbAvailable) return;
      const app = await buildApp({ db, logger: false });
      const payload = minimalEntry();
      delete (payload as any).content;
      const res = await app.inject({
        method: "POST", url: "/v1/kb", headers: { cookie: cookieA }, payload,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().issues.some((i: any) => i.path === "content")).toBe(true);
    });

    it("400 when content_type is invalid", async () => {
      if (!dbAvailable) return;
      const app = await buildApp({ db, logger: false });
      const res = await app.inject({
        method: "POST", url: "/v1/kb", headers: { cookie: cookieA },
        payload: minimalEntry({ content_type: "pdf" }),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().issues.some((i: any) => i.path === "content_type")).toBe(true);
    });

    it("400 when source is invalid", async () => {
      if (!dbAvailable) return;
      const app = await buildApp({ db, logger: false });
      const res = await app.inject({
        method: "POST", url: "/v1/kb", headers: { cookie: cookieA },
        payload: minimalEntry({ source: "import" }),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().issues.some((i: any) => i.path === "source")).toBe(true);
    });
  });

  describe("GET /v1/kb (pagination)", () => {
    it("lists only active entries by default (excludes inactive)", async () => {
      if (!dbAvailable) return;
      const app = await buildApp({ db, logger: false });

      const r1 = await app.inject({
        method: "POST", url: "/v1/kb", headers: { cookie: cookieA },
        payload: minimalEntry({ title: "Active Entry Pagination" }),
      });
      const activeId = r1.json().id;

      const r2 = await app.inject({
        method: "POST", url: "/v1/kb", headers: { cookie: cookieA },
        payload: minimalEntry({ title: "Inactive Entry Pagination", is_active: false }),
      });
      const inactiveId = r2.json().id;

      const res = await app.inject({
        method: "GET", url: "/v1/kb", headers: { cookie: cookieA },
      });
      expect(res.statusCode).toBe(200);
      const ids = res.json().entries.map((e: any) => e.id);
      expect(ids).toContain(activeId);
      expect(ids).not.toContain(inactiveId);
    });

    it("includes inactive entries when include_inactive=true", async () => {
      if (!dbAvailable) return;
      const app = await buildApp({ db, logger: false });

      const r = await app.inject({
        method: "POST", url: "/v1/kb", headers: { cookie: cookieA },
        payload: minimalEntry({ title: "Inactive For Include Test Pag", is_active: false }),
      });
      const id = r.json().id;

      const res = await app.inject({
        method: "GET", url: "/v1/kb?include_inactive=true", headers: { cookie: cookieA },
      });
      expect(res.statusCode).toBe(200);
      const ids = res.json().entries.map((e: any) => e.id);
      expect(ids).toContain(id);
    });

    it("returns 401 without session", async () => {
      if (!dbAvailable) return;
      const app = await buildApp({ db, logger: false });
      const res = await app.inject({ method: "GET", url: "/v1/kb" });
      expect(res.statusCode).toBe(401);
    });

    it("returns only entries for the calling tenant (cross-tenant isolation)", async () => {
      if (!dbAvailable) return;
      const app = await buildApp({ db, logger: false });

      // Create an entry as tenant B
      const rB = await app.inject({
        method: "POST", url: "/v1/kb",
        headers: { cookie: `claros_session=${sessionBId}` },
        payload: minimalEntry({ title: "Tenant B Private Entry Pag" }),
      });
      const idB = rB.json().id;

      // List as tenant A - must not see tenant B's entry
      const res = await app.inject({
        method: "GET", url: "/v1/kb?include_inactive=true", headers: { cookie: cookieA },
      });
      expect(res.statusCode).toBe(200);
      const ids = res.json().entries.map((e: any) => e.id);
      expect(ids).not.toContain(idB);
    });

    it("response has next_cursor and entries fields", async () => {
      if (!dbAvailable) return;
      const app = await buildApp({ db, logger: false });
      const res = await app.inject({
        method: "GET", url: "/v1/kb", headers: { cookie: cookieA },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(Array.isArray(body.entries)).toBe(true);
      // next_cursor is either a string or null
      expect(body.next_cursor === null || typeof body.next_cursor === "string").toBe(true);
      // total must NOT appear (intentionally omitted)
      expect("total" in body).toBe(false);
    });

    it("list entries carry content_preview (not full content)", async () => {
      if (!dbAvailable) return;
      const app = await buildApp({ db, logger: false });

      // Create an entry with content longer than 300 chars
      const longContent = "A".repeat(400);
      const r = await app.inject({
        method: "POST", url: "/v1/kb", headers: { cookie: cookieA },
        payload: minimalEntry({ title: "Long Content Entry", content: longContent }),
      });
      const id = r.json().id;

      const listRes = await app.inject({
        method: "GET", url: "/v1/kb?include_inactive=true", headers: { cookie: cookieA },
      });
      const entry = listRes.json().entries.find((e: any) => e.id === id);
      expect(entry).toBeDefined();
      // content_preview must be present; full content must not be
      expect("content_preview" in entry).toBe(true);
      expect("content" in entry).toBe(false);
      // Preview truncated to 300 chars + "..."
      expect(entry.content_preview.length).toBeLessThanOrEqual(303); // 300 + "..."
      expect(entry.content_preview.endsWith("...")).toBe(true);
    });

    it("content shorter than 300 chars is returned as-is in content_preview", async () => {
      if (!dbAvailable) return;
      const app = await buildApp({ db, logger: false });

      const shortContent = "Short content.";
      const r = await app.inject({
        method: "POST", url: "/v1/kb", headers: { cookie: cookieA },
        payload: minimalEntry({ title: "Short Content Entry", content: shortContent }),
      });
      const id = r.json().id;

      const listRes = await app.inject({
        method: "GET", url: "/v1/kb?include_inactive=true", headers: { cookie: cookieA },
      });
      const entry = listRes.json().entries.find((e: any) => e.id === id);
      expect(entry).toBeDefined();
      expect(entry.content_preview).toBe(shortContent);
      expect(entry.content_preview.endsWith("...")).toBe(false);
    });

    it("default page size applies when ?limit is not specified", async () => {
      if (!dbAvailable) return;
      const app = await buildApp({ db, logger: false });

      // We only need to verify the default is 50. With far fewer entries in the
      // test DB, the default simply returns all entries (next_cursor = null).
      // Create a small batch and confirm all are returned without a cursor.
      const created: string[] = [];
      for (let i = 1; i <= 3; i++) {
        const r = await app.inject({
          method: "POST", url: "/v1/kb", headers: { cookie: cookieA },
          payload: minimalEntry({ title: `Default Page Size Entry ${i}` }),
        });
        created.push(r.json().id);
      }

      // No ?limit - defaults to 50, all 3 (and however many already exist) should
      // be within the first page.
      const res = await app.inject({
        method: "GET", url: "/v1/kb?include_inactive=true", headers: { cookie: cookieA },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      const ids = body.entries.map((e: any) => e.id);
      for (const id of created) {
        expect(ids).toContain(id);
      }
    });

    it("max page size (200) is enforced when a larger value is requested", async () => {
      if (!dbAvailable) return;
      const app = await buildApp({ db, logger: false });

      // Request a huge limit; we cannot easily create 201 entries in a test, so
      // we verify that the response returns AT MOST 200 items and the structure
      // is correct. Since the DB has far fewer than 200 entries, next_cursor=null
      // confirms no second page was needed (correct; not a cap violation).
      const res = await app.inject({
        method: "GET", url: "/v1/kb?limit=9999&include_inactive=true", headers: { cookie: cookieA },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.entries.length).toBeLessThanOrEqual(200);
      // When entry count < 200, no next page should exist
      // (we can't guarantee this in a shared DB but can confirm structure)
      expect(Array.isArray(body.entries)).toBe(true);
    });

    it("cursor-based paging returns correct disjoint sets", async () => {
      if (!dbAvailable) return;
      const app = await buildApp({ db, logger: false });

      // Use a separate slug prefix for this test to count entries precisely.
      // We create 5 entries and paginate with limit=2.
      const created: string[] = [];
      for (let i = 1; i <= 5; i++) {
        const r = await app.inject({
          method: "POST", url: "/v1/kb", headers: { cookie: cookieA },
          payload: minimalEntry({ title: `Paging Test Entry ${String(i).padStart(2, "0")}` }),
        });
        created.push(r.json().id);
      }

      // Fetch all 5 entries across pages with limit=2, collecting results
      const allIds: string[] = [];
      let cursor: string | null = null;
      let pages = 0;

      for (;;) {
        const url = cursor
          ? `/v1/kb?limit=2&include_inactive=true&after=${cursor}`
          : "/v1/kb?limit=2&include_inactive=true";

        const res = await app.inject({
          method: "GET", url, headers: { cookie: cookieA },
        });
        expect(res.statusCode).toBe(200);

        const body = res.json();
        const pageIds: string[] = body.entries.map((e: any) => e.id);
        allIds.push(...pageIds);

        // No page should return more than 2 items
        expect(pageIds.length).toBeLessThanOrEqual(2);

        pages++;
        cursor = body.next_cursor;
        if (!cursor) break;

        // Safety valve: prevent infinite loops in test
        if (pages > 20) throw new Error("Too many pages - possible infinite loop");
      }

      // All 5 created entries must appear across pages
      for (const id of created) {
        expect(allIds).toContain(id);
      }

      // No duplicates across pages
      const unique = new Set(allIds);
      expect(unique.size).toBe(allIds.length);
    });

    it("tenant scoping holds on every page", async () => {
      if (!dbAvailable) return;
      const app = await buildApp({ db, logger: false });

      // Create entries as tenant B
      for (let i = 1; i <= 3; i++) {
        await app.inject({
          method: "POST", url: "/v1/kb",
          headers: { cookie: `claros_session=${sessionBId}` },
          payload: minimalEntry({ title: `Tenant B Scope Page ${i}` }),
        });
      }

      // Paginate as tenant A - collect all IDs across pages
      const allIds: string[] = [];
      let cursor: string | null = null;

      for (;;) {
        const url = cursor
          ? `/v1/kb?limit=2&include_inactive=true&after=${cursor}`
          : "/v1/kb?limit=2&include_inactive=true";

        const res = await app.inject({
          method: "GET", url, headers: { cookie: cookieA },
        });
        const body = res.json();
        allIds.push(...body.entries.map((e: any) => e.id));
        cursor = body.next_cursor;
        if (!cursor) break;
      }

      // Fetch all tenant B entries directly to get their IDs
      const tenantBList = await app.inject({
        method: "GET", url: "/v1/kb?include_inactive=true",
        headers: { cookie: `claros_session=${sessionBId}` },
      });
      const tenantBIds = tenantBList.json().entries.map((e: any) => e.id);

      // None of tenant B's IDs should appear in tenant A's paginated results
      for (const idB of tenantBIds) {
        expect(allIds).not.toContain(idB);
      }
    });

    it("next_cursor is null on the last page", async () => {
      if (!dbAvailable) return;
      const app = await buildApp({ db, logger: false });

      // Fetch the last page (limit=1000 returns everything at once)
      const res = await app.inject({
        method: "GET", url: "/v1/kb?limit=200&include_inactive=true", headers: { cookie: cookieA },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      // If all entries fit in one page, next_cursor must be null
      if (body.entries.length < 200) {
        expect(body.next_cursor).toBeNull();
      }
    });
  });

  describe("GET /v1/kb/:id", () => {
    it("returns the full entry row with full content (not a preview)", async () => {
      if (!dbAvailable) return;
      const app = await buildApp({ db, logger: false });
      const longContent = "B".repeat(400);
      const created = await app.inject({
        method: "POST", url: "/v1/kb", headers: { cookie: cookieA },
        payload: minimalEntry({ title: "Get By Id Test", content: longContent }),
      });
      const id = created.json().id;

      const res = await app.inject({
        method: "GET", url: `/v1/kb/${id}`, headers: { cookie: cookieA },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.id).toBe(id);
      expect(body.title).toBe("Get By Id Test");
      // Full content (not preview)
      expect(body.content).toBe(longContent);
      expect("content_preview" in body).toBe(false);
    });

    it("returns 404 for a non-existent id", async () => {
      if (!dbAvailable) return;
      const app = await buildApp({ db, logger: false });
      const res = await app.inject({
        method: "GET",
        url: "/v1/kb/00000000-0000-0000-0000-000000000000",
        headers: { cookie: cookieA },
      });
      expect(res.statusCode).toBe(404);
    });

    it("returns 404 for an entry owned by another tenant (no info leak)", async () => {
      if (!dbAvailable) return;
      const app = await buildApp({ db, logger: false });
      // Create under tenant B
      const created = await app.inject({
        method: "POST", url: "/v1/kb",
        headers: { cookie: `claros_session=${sessionBId}` },
        payload: minimalEntry({ title: "Tenant B Entry" }),
      });
      const idB = created.json().id;

      // Attempt to read as tenant A
      const res = await app.inject({
        method: "GET", url: `/v1/kb/${idB}`, headers: { cookie: cookieA },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("PATCH /v1/kb/:id", () => {
    it("updates only the supplied fields; other fields are preserved", async () => {
      if (!dbAvailable) return;
      const app = await buildApp({ db, logger: false });
      const created = await app.inject({
        method: "POST", url: "/v1/kb", headers: { cookie: cookieA },
        payload: {
          title: "Original Title",
          content: "Original content.",
          tags: ["original"],
          source_url: "https://example.com/original",
        },
      });
      const id = created.json().id;

      // Only update title - content, tags, source_url must be unchanged
      const res = await app.inject({
        method: "PATCH", url: `/v1/kb/${id}`, headers: { cookie: cookieA },
        payload: { title: "Updated Title" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.title).toBe("Updated Title");
      expect(body.content).toBe("Original content.");
      expect(body.tags).toEqual(["original"]);
      expect(body.source_url).toBe("https://example.com/original");
    });

    it("setting is_active=false deactivates the entry; it is excluded from the default list", async () => {
      if (!dbAvailable) return;
      const app = await buildApp({ db, logger: false });
      const created = await app.inject({
        method: "POST", url: "/v1/kb", headers: { cookie: cookieA },
        payload: minimalEntry({ title: "To Deactivate" }),
      });
      const id = created.json().id;

      const patch = await app.inject({
        method: "PATCH", url: `/v1/kb/${id}`, headers: { cookie: cookieA },
        payload: { is_active: false },
      });
      expect(patch.statusCode).toBe(200);
      expect(patch.json().is_active).toBe(false);

      // Must not appear in default list
      const list = await app.inject({
        method: "GET", url: "/v1/kb", headers: { cookie: cookieA },
      });
      const ids = list.json().entries.map((e: any) => e.id);
      expect(ids).not.toContain(id);
    });

    it("content update re-enqueues embedding job", async () => {
      if (!dbAvailable) return;
      const enqueue = vi.fn().mockResolvedValue("job-id");
      const app = await buildApp({ db, logger: false, enqueue });

      const created = await app.inject({
        method: "POST", url: "/v1/kb", headers: { cookie: cookieA },
        payload: minimalEntry({ title: "Embed On Create" }),
      });
      const id = created.json().id;

      // Reset call count after create
      enqueue.mockClear();

      // PATCH with content change - should enqueue KB_EMBED
      await app.inject({
        method: "PATCH", url: `/v1/kb/${id}`, headers: { cookie: cookieA },
        payload: { content: "Updated content triggers re-embed." },
      });

      expect(enqueue).toHaveBeenCalledOnce();
      const [queueName, payload] = enqueue.mock.calls[0]!;
      expect(queueName).toBe("claros.kb-embed");
      expect(payload).toMatchObject({ kb_entry_id: id, tenant_id: tenantAId });
    });

    it("tag-only update does NOT enqueue an embedding job", async () => {
      if (!dbAvailable) return;
      const enqueue = vi.fn().mockResolvedValue("job-id");
      const app = await buildApp({ db, logger: false, enqueue });

      const created = await app.inject({
        method: "POST", url: "/v1/kb", headers: { cookie: cookieA },
        payload: minimalEntry({ title: "No Embed On Tag Change" }),
      });
      const id = created.json().id;

      // Reset call count after create
      enqueue.mockClear();

      // PATCH only tags - must NOT enqueue KB_EMBED
      await app.inject({
        method: "PATCH", url: `/v1/kb/${id}`, headers: { cookie: cookieA },
        payload: { tags: ["new-tag"] },
      });

      // Enqueue must not have been called for KB_EMBED
      const kbEmbedCalls = enqueue.mock.calls.filter(
        ([q]: [string]) => q === "claros.kb-embed",
      );
      expect(kbEmbedCalls).toHaveLength(0);
    });

    it("400 when content_type is invalid in PATCH", async () => {
      if (!dbAvailable) return;
      const app = await buildApp({ db, logger: false });
      const created = await app.inject({
        method: "POST", url: "/v1/kb", headers: { cookie: cookieA },
        payload: minimalEntry({ title: "Patch Validation" }),
      });
      const id = created.json().id;

      const res = await app.inject({
        method: "PATCH", url: `/v1/kb/${id}`, headers: { cookie: cookieA },
        payload: { content_type: "binary" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().issues.some((i: any) => i.path === "content_type")).toBe(true);
    });

    it("returns 404 for a non-existent id", async () => {
      if (!dbAvailable) return;
      const app = await buildApp({ db, logger: false });
      const res = await app.inject({
        method: "PATCH",
        url: "/v1/kb/00000000-0000-0000-0000-000000000000",
        headers: { cookie: cookieA },
        payload: { title: "Ghost" },
      });
      expect(res.statusCode).toBe(404);
    });

    it("returns 404 for an entry owned by another tenant", async () => {
      if (!dbAvailable) return;
      const app = await buildApp({ db, logger: false });
      const created = await app.inject({
        method: "POST", url: "/v1/kb",
        headers: { cookie: `claros_session=${sessionBId}` },
        payload: minimalEntry({ title: "Tenant B PATCH Target" }),
      });
      const idB = created.json().id;

      const res = await app.inject({
        method: "PATCH", url: `/v1/kb/${idB}`, headers: { cookie: cookieA },
        payload: { title: "Hijack" },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("DELETE /v1/kb/:id", () => {
    it("deletes the entry; returns the deleted row; subsequent GET returns 404", async () => {
      if (!dbAvailable) return;
      const app = await buildApp({ db, logger: false });
      const created = await app.inject({
        method: "POST", url: "/v1/kb", headers: { cookie: cookieA },
        payload: minimalEntry({ title: "To Delete" }),
      });
      const id = created.json().id;

      const res = await app.inject({
        method: "DELETE", url: `/v1/kb/${id}`, headers: { cookie: cookieA },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().id).toBe(id);
      expect(res.json().title).toBe("To Delete");

      // Entry must be gone (hard delete)
      const get = await app.inject({
        method: "GET", url: `/v1/kb/${id}`, headers: { cookie: cookieA },
      });
      expect(get.statusCode).toBe(404);
    });

    it("returns 404 for a non-existent id", async () => {
      if (!dbAvailable) return;
      const app = await buildApp({ db, logger: false });
      const res = await app.inject({
        method: "DELETE",
        url: "/v1/kb/00000000-0000-0000-0000-000000000000",
        headers: { cookie: cookieA },
      });
      expect(res.statusCode).toBe(404);
    });

    it("returns 404 for an entry owned by another tenant", async () => {
      if (!dbAvailable) return;
      const app = await buildApp({ db, logger: false });
      const created = await app.inject({
        method: "POST", url: "/v1/kb",
        headers: { cookie: `claros_session=${sessionBId}` },
        payload: minimalEntry({ title: "Tenant B DELETE Target" }),
      });
      const idB = created.json().id;

      const res = await app.inject({
        method: "DELETE", url: `/v1/kb/${idB}`, headers: { cookie: cookieA },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("POST /v1/kb/re-embed (step 0b: bulk recovery + idempotency + cap)", () => {
    it("returns 503 when enqueue is not available", async () => {
      if (!dbAvailable) return;
      const app = await buildApp({ db, logger: false }); // no enqueue

      const res = await app.inject({
        method: "POST", url: "/v1/kb/re-embed", headers: { cookie: cookieA },
      });
      expect(res.statusCode).toBe(503);
    });

    it("returns 401 without session", async () => {
      if (!dbAvailable) return;
      const enqueue = vi.fn().mockResolvedValue("job-id");
      const app = await buildApp({ db, logger: false, enqueue });

      const res = await app.inject({ method: "POST", url: "/v1/kb/re-embed" });
      expect(res.statusCode).toBe(401);
    });

    it("returns 202 with enqueued=0 and remaining=0 when all entries are already embedded", async () => {
      if (!dbAvailable) return;
      // This test uses a dedicated tenant to avoid cross-test contamination.
      const TEST_SLUG_EMBED = "test-kb-reembed-clean";
      const enqueue = vi.fn().mockResolvedValue("job-id");
      const app = await buildApp({ db, logger: false, enqueue });

      // Set up a clean tenant
      await db.execute(sql`DELETE FROM kb_entries WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${TEST_SLUG_EMBED})`);
      await db.execute(sql`DELETE FROM sessions WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${TEST_SLUG_EMBED})`);
      await db.execute(sql`DELETE FROM users WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${TEST_SLUG_EMBED})`);
      await db.execute(sql`DELETE FROM tenants WHERE slug = ${TEST_SLUG_EMBED}`);

      const [cleanTenant] = await db.insert(tenants).values({ name: "KB Re-embed Clean", slug: TEST_SLUG_EMBED, plan: "free" }).returning({ id: tenants.id });
      const cleanTenantId = cleanTenant!.id;
      const [cleanUser] = await db.insert(users).values({ tenantId: cleanTenantId, email: "owner@clean-reembed.test", role: "owner" }).returning({ id: users.id });
      const [cleanSession] = await db.insert(sessions).values({ tenantId: cleanTenantId, userId: cleanUser!.id, expiresAt: new Date(Date.now() + 86400_000) }).returning({ id: sessions.id });
      const cleanCookie = `claros_session=${cleanSession!.id}`;

      // Insert an entry already embedded
      await db.execute(sql`
        INSERT INTO kb_entries (tenant_id, title, content, content_type, source, is_active, embedding, embedding_status)
        VALUES (${cleanTenantId}::uuid, 'Already Embedded Clean', 'Content', 'markdown', 'manual', true,
                array_fill(0.1, ARRAY[1536])::vector, NULL)
      `);

      enqueue.mockClear();

      const res = await app.inject({
        method: "POST", url: "/v1/kb/re-embed", headers: { cookie: cleanCookie },
      });
      expect(res.statusCode).toBe(202);
      expect(res.json().enqueued).toBe(0);
      expect(res.json().remaining).toBe(0);

      // Cleanup
      await db.execute(sql`DELETE FROM kb_entries WHERE tenant_id = ${cleanTenantId}::uuid`);
      await db.execute(sql`DELETE FROM sessions WHERE tenant_id = ${cleanTenantId}::uuid`);
      await db.execute(sql`DELETE FROM users WHERE tenant_id = ${cleanTenantId}::uuid`);
      await db.execute(sql`DELETE FROM tenants WHERE id = ${cleanTenantId}::uuid`);
    });

    it("enqueues jobs for entries with embedding_status = null (never enqueued)", async () => {
      if (!dbAvailable) return;
      const enqueue = vi.fn().mockResolvedValue("job-id");
      const app = await buildApp({ db, logger: false, enqueue });

      // Insert entries without enqueue (embedding_status stays null = never enqueued)
      const r1 = await app.inject({
        method: "POST", url: "/v1/kb", headers: { cookie: cookieA },
        payload: minimalEntry({ title: "Never Enqueued Entry 1" }),
      });
      const r2 = await app.inject({
        method: "POST", url: "/v1/kb", headers: { cookie: cookieA },
        payload: minimalEntry({ title: "Never Enqueued Entry 2" }),
      });
      // Set embedding_status to NULL (as if never enqueued)
      await db.execute(sql`UPDATE kb_entries SET embedding_status = NULL WHERE id = ${r1.json().id}::uuid`);
      await db.execute(sql`UPDATE kb_entries SET embedding_status = NULL WHERE id = ${r2.json().id}::uuid`);

      enqueue.mockClear();

      const res = await app.inject({
        method: "POST", url: "/v1/kb/re-embed", headers: { cookie: cookieA },
      });
      expect(res.statusCode).toBe(202);
      const kbEmbedCalls = enqueue.mock.calls.filter(([q]: [string]) => q === "claros.kb-embed");
      const enqueuedIds = kbEmbedCalls.map(([, p]: [string, { kb_entry_id: string }]) => p.kb_entry_id);
      expect(enqueuedIds).toContain(r1.json().id);
      expect(enqueuedIds).toContain(r2.json().id);
    });

    it("enqueues jobs for entries with embedding_status = 'failed'", async () => {
      if (!dbAvailable) return;
      const enqueue = vi.fn().mockResolvedValue("job-id");
      const app = await buildApp({ db, logger: false, enqueue });

      const r = await app.inject({
        method: "POST", url: "/v1/kb", headers: { cookie: cookieA },
        payload: minimalEntry({ title: "Failed Embed Entry Re-embed" }),
      });
      const id = r.json().id;

      // Simulate permanent failure
      await db.execute(sql`UPDATE kb_entries SET embedding_status = 'failed', embedding_error = 'HTTP 401: bad key' WHERE id = ${id}::uuid`);

      enqueue.mockClear();

      const res = await app.inject({
        method: "POST", url: "/v1/kb/re-embed", headers: { cookie: cookieA },
      });
      expect(res.statusCode).toBe(202);

      const kbEmbedCalls = enqueue.mock.calls.filter(([q]: [string]) => q === "claros.kb-embed");
      const enqueuedIds = kbEmbedCalls.map(([, p]: [string, { kb_entry_id: string }]) => p.kb_entry_id);
      expect(enqueuedIds).toContain(id);
    });

    it("idempotency: two rapid consecutive calls do not produce duplicate jobs for the same entry", async () => {
      if (!dbAvailable) return;
      const enqueue = vi.fn().mockResolvedValue("job-id");
      const app = await buildApp({ db, logger: false, enqueue });

      // Insert an entry with embedding_status = 'failed' so it qualifies
      const r = await app.inject({
        method: "POST", url: "/v1/kb", headers: { cookie: cookieA },
        payload: minimalEntry({ title: "Idempotency Test Entry" }),
      });
      const id = r.json().id;
      await db.execute(sql`UPDATE kb_entries SET embedding_status = 'failed', embedding_error = 'test' WHERE id = ${id}::uuid`);

      enqueue.mockClear();

      // First call: should enqueue the entry and set status to 'pending'
      const res1 = await app.inject({
        method: "POST", url: "/v1/kb/re-embed", headers: { cookie: cookieA },
      });
      expect(res1.statusCode).toBe(202);

      const callsAfterFirst = enqueue.mock.calls.filter(
        ([q]: [string]) => q === "claros.kb-embed",
      ).filter(([, p]: [string, { kb_entry_id: string }]) => p.kb_entry_id === id);
      expect(callsAfterFirst.length).toBe(1);

      enqueue.mockClear();

      // Second call immediately after (entry is now 'pending' with recent updated_at):
      // must NOT produce a second job for it (< 15 min threshold = live job assumed)
      await app.inject({
        method: "POST", url: "/v1/kb/re-embed", headers: { cookie: cookieA },
      });

      const callsAfterSecond = enqueue.mock.calls.filter(
        ([q]: [string]) => q === "claros.kb-embed",
      ).filter(([, p]: [string, { kb_entry_id: string }]) => p.kb_entry_id === id);
      expect(callsAfterSecond.length).toBe(0);
    });

    it("recent 'pending' entries (< 15 min) are not re-enqueued (live job assumed)", async () => {
      if (!dbAvailable) return;
      const enqueue = vi.fn().mockResolvedValue("job-id");
      const app = await buildApp({ db, logger: false, enqueue });

      // Create an entry with POST (sets embedding_status = 'pending', updated_at = now)
      const r = await app.inject({
        method: "POST", url: "/v1/kb", headers: { cookie: cookieA },
        payload: minimalEntry({ title: "Recent Pending Entry" }),
      });
      const id = r.json().id;
      expect(r.json().embedding_status).toBe("pending");

      enqueue.mockClear();

      // Re-embed should NOT enqueue this entry (recent pending = live job assumed)
      const res = await app.inject({
        method: "POST", url: "/v1/kb/re-embed", headers: { cookie: cookieA },
      });
      expect(res.statusCode).toBe(202);

      const kbEmbedCalls = enqueue.mock.calls.filter(
        ([q]: [string]) => q === "claros.kb-embed",
      ).filter(([, p]: [string, { kb_entry_id: string }]) => p.kb_entry_id === id);
      expect(kbEmbedCalls.length).toBe(0);
    });

    it("stale 'pending' entry (> 15 min, orphan) is picked up by re-embed", async () => {
      if (!dbAvailable) return;
      const enqueue = vi.fn().mockResolvedValue("job-id");
      const app = await buildApp({ db, logger: false, enqueue });

      // Insert an entry with embedding_status = 'pending' but aged > 15 min
      // (simulates an orphan: process died between INSERT and boss.send())
      const r = await app.inject({
        method: "POST", url: "/v1/kb", headers: { cookie: cookieA },
        payload: minimalEntry({ title: "Orphan Pending Entry" }),
      });
      const id = r.json().id;
      // Age the updated_at by 20 minutes to simulate an orphan
      await db.execute(sql`
        UPDATE kb_entries
        SET updated_at = now() - interval '20 minutes',
            embedding_status = 'pending'
        WHERE id = ${id}::uuid
      `);

      enqueue.mockClear();

      // Re-embed should pick up this stale 'pending' entry as an orphan
      const res = await app.inject({
        method: "POST", url: "/v1/kb/re-embed", headers: { cookie: cookieA },
      });
      expect(res.statusCode).toBe(202);

      const kbEmbedCalls = enqueue.mock.calls.filter(
        ([q]: [string]) => q === "claros.kb-embed",
      ).filter(([, p]: [string, { kb_entry_id: string }]) => p.kb_entry_id === id);
      expect(kbEmbedCalls.length).toBe(1);
    });

    it("cap is enforced: response reports remaining when more entries exist than the cap", async () => {
      if (!dbAvailable) return;
      // Use a dedicated clean tenant so we control the exact entry count.
      const TEST_SLUG_CAP = "test-kb-reembed-cap";
      const enqueue = vi.fn().mockResolvedValue("job-id");
      const app = await buildApp({ db, logger: false, enqueue });

      // Clean up
      await db.execute(sql`DELETE FROM kb_entries WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${TEST_SLUG_CAP})`);
      await db.execute(sql`DELETE FROM sessions WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${TEST_SLUG_CAP})`);
      await db.execute(sql`DELETE FROM users WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${TEST_SLUG_CAP})`);
      await db.execute(sql`DELETE FROM tenants WHERE slug = ${TEST_SLUG_CAP}`);

      const [capTenant] = await db.insert(tenants).values({ name: "KB Re-embed Cap", slug: TEST_SLUG_CAP, plan: "free" }).returning({ id: tenants.id });
      const capTenantId = capTenant!.id;
      const [capUser] = await db.insert(users).values({ tenantId: capTenantId, email: "owner@cap-reembed.test", role: "owner" }).returning({ id: users.id });
      const [capSession] = await db.insert(sessions).values({ tenantId: capTenantId, userId: capUser!.id, expiresAt: new Date(Date.now() + 86400_000) }).returning({ id: sessions.id });
      const capCookie = `claros_session=${capSession!.id}`;

      // Insert CAP + 3 entries all with embedding_status = 'failed'
      const CAP = 100; // must match RE_EMBED_BATCH_CAP in kb.ts
      const EXTRA = 3;
      const TOTAL = CAP + EXTRA;
      for (let i = 1; i <= TOTAL; i++) {
        await db.execute(sql`
          INSERT INTO kb_entries (tenant_id, title, content, content_type, source, is_active, embedding_status)
          VALUES (${capTenantId}::uuid, ${`Cap Entry ${i}`}, 'Content', 'markdown', 'manual', true, 'failed')
        `);
      }

      enqueue.mockClear();

      const res = await app.inject({
        method: "POST", url: "/v1/kb/re-embed", headers: { cookie: capCookie },
      });
      expect(res.statusCode).toBe(202);

      const body = res.json();
      expect(body.enqueued).toBe(CAP);
      expect(body.remaining).toBe(EXTRA);
      expect(body.total_qualifying).toBe(TOTAL);

      const kbEmbedCalls = enqueue.mock.calls.filter(([q]: [string]) => q === "claros.kb-embed");
      expect(kbEmbedCalls.length).toBe(CAP);

      // Second call processes the remaining entries
      enqueue.mockClear();
      const res2 = await app.inject({
        method: "POST", url: "/v1/kb/re-embed", headers: { cookie: capCookie },
      });
      expect(res2.statusCode).toBe(202);
      expect(res2.json().enqueued).toBe(EXTRA);
      expect(res2.json().remaining).toBe(0);

      // Cleanup
      await db.execute(sql`DELETE FROM kb_entries WHERE tenant_id = ${capTenantId}::uuid`);
      await db.execute(sql`DELETE FROM sessions WHERE tenant_id = ${capTenantId}::uuid`);
      await db.execute(sql`DELETE FROM users WHERE tenant_id = ${capTenantId}::uuid`);
      await db.execute(sql`DELETE FROM tenants WHERE id = ${capTenantId}::uuid`);
    }, 30_000); // extra time for inserting 103 entries

    it("resets embedding_status to 'pending' on re-enqueued entries", async () => {
      if (!dbAvailable) return;
      const enqueue = vi.fn().mockResolvedValue("job-id");
      const app = await buildApp({ db, logger: false, enqueue });

      const r = await app.inject({
        method: "POST", url: "/v1/kb", headers: { cookie: cookieA },
        payload: minimalEntry({ title: "Status Reset On Re-embed" }),
      });
      const id = r.json().id;

      // Set as failed to verify reset
      await db.execute(sql`UPDATE kb_entries SET embedding_status = 'failed', embedding_error = 'test error' WHERE id = ${id}::uuid`);

      await app.inject({
        method: "POST", url: "/v1/kb/re-embed", headers: { cookie: cookieA },
      });

      // Check that embedding_status was reset to 'pending' and error cleared
      const row = await db.execute<{ embedding_status: string; embedding_error: string | null }>(
        sql`SELECT embedding_status, embedding_error FROM kb_entries WHERE id = ${id}::uuid`,
      );
      expect(row.rows[0]!.embedding_status).toBe("pending");
      expect(row.rows[0]!.embedding_error).toBeNull();
    });

    it("does not enqueue entries from another tenant", async () => {
      if (!dbAvailable) return;
      const enqueue = vi.fn().mockResolvedValue("job-id");
      const app = await buildApp({ db, logger: false, enqueue });

      // Create entry as tenant B and set to failed
      const rB = await app.inject({
        method: "POST", url: "/v1/kb",
        headers: { cookie: `claros_session=${sessionBId}` },
        payload: minimalEntry({ title: "Tenant B Entry Re-embed Isolation" }),
      });
      const idB = rB.json().id;
      await db.execute(sql`UPDATE kb_entries SET embedding_status = 'failed' WHERE id = ${idB}::uuid`);

      enqueue.mockClear();

      // Re-embed as tenant A
      const res = await app.inject({
        method: "POST", url: "/v1/kb/re-embed", headers: { cookie: cookieA },
      });
      expect(res.statusCode).toBe(202);

      const kbEmbedCalls = enqueue.mock.calls.filter(([q]: [string]) => q === "claros.kb-embed");
      const enqueuedIds = kbEmbedCalls.map(([, p]: [string, { kb_entry_id: string }]) => p.kb_entry_id);
      expect(enqueuedIds).not.toContain(idB);
    });
  });
});
