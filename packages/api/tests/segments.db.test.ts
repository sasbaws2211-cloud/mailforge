/**
 * Segment API integration tests: create, list, view, edit, refresh, archive, preview, the People filter,
 * workspace isolation, and the time limit.
 *
 * Requires local Postgres (see flows.db.test.ts for DATABASE_URL).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { sql } from "drizzle-orm";
import { buildApp } from "../src/index.js";
import { tenants, users, sessions, contacts, events, flows, suppressions } from "@loomail/db/schema";
import { SegmentTooSlowError, withStatementTimeout } from "../src/segments/run.js";
import { MAX_SEGMENTS_PER_WORKSPACE } from "../src/routes/segments.js";

const TEST_DB_URL = process.env.DATABASE_URL;
if (!TEST_DB_URL) throw new Error("[segments.test] DATABASE_URL is not set (see flows.db.test.ts).");

const SLUG_A = "test-segments-a";
const SLUG_B = "test-segments-b";

let pool: pg.Pool;
let db: ReturnType<typeof drizzle>;
let dbAvailable = false;
let tenantA: string;
let tenantB: string;
let cookieA: string;
let cookieB: string;

const TABLES = ["events", "suppressions", "segments", "flows", "contacts", "sessions", "users"];
async function cleanup() {
  for (const table of TABLES) {
    await db.execute(sql.raw(`DELETE FROM ${table} WHERE tenant_id IN (SELECT id FROM tenants WHERE slug IN ('${SLUG_A}', '${SLUG_B}'))`));
  }
  await db.execute(sql.raw(`DELETE FROM tenants WHERE slug IN ('${SLUG_A}', '${SLUG_B}')`));
}

const paid = { field: "payment_status", op: "is", value: "paid" };
const def = (...rules: unknown[]) => ({ match: "all", rules: rules.length ? rules : [paid] });

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: TEST_DB_URL, connectionTimeoutMillis: 3000 });
  try {
    await pool.query("SELECT 1");
    db = drizzle(pool);
    dbAvailable = true;
  } catch {
    console.warn("[segments.test] DATABASE_URL not reachable - tests skipped.");
    return;
  }
  await cleanup();

  const mk = async (name: string, slug: string, email: string) => {
    const [t] = await db.insert(tenants).values({ name, slug, plan: "free" }).returning({ id: tenants.id });
    const [u] = await db.insert(users).values({ tenantId: t!.id, email, role: "owner" }).returning({ id: users.id });
    const [s] = await db
      .insert(sessions)
      .values({ tenantId: t!.id, userId: u!.id, expiresAt: new Date(Date.now() + 86_400_000) })
      .returning({ id: sessions.id });
    return { tenantId: t!.id, cookie: `loomail_session=${s!.id}` };
  };
  const a = await mk("Segments A", SLUG_A, "owner-a@segments.test");
  const b = await mk("Segments B", SLUG_B, "owner-b@segments.test");
  tenantA = a.tenantId;
  cookieA = a.cookie;
  tenantB = b.tenantId;
  cookieB = b.cookie;

  // Workspace A: 12 contacts. 0-5 paid (even ones with an email), 6-11 free. Workspace B: 3 paid contacts.
  const seed = (n: number, owner: string, status: string, email: string | null) => ({
    tenantId: owner,
    externalId: `u${n}`,
    lifecycleState: n % 2 ? "engaged" : "at_risk",
    paymentStatus: status,
    email,
    properties: { plan: n % 3 === 0 ? "Pro" : "Free", seats: n },
    firstSeenAt: new Date(Date.now() - 40 * 86_400_000),
    lastSeenAt: new Date(Date.now() - (n + 1) * 86_400_000),
  });
  const inserted = await db
    .insert(contacts)
    .values(Array.from({ length: 12 }, (_, n) => seed(n, tenantA, n < 6 ? "paid" : "free", n % 2 === 0 ? `a${n}@seg.test` : null)))
    .returning({ id: contacts.id, externalId: contacts.externalId });
  await db.insert(contacts).values(Array.from({ length: 3 }, (_, n) => seed(n, tenantB, "paid", `b${n}@seg.test`)));

  // an event for two paid contacts, none for the others
  const first = inserted.find((c) => c.externalId === "u0")!;
  const second = inserted.find((c) => c.externalId === "u2")!;
  await db.insert(events).values([
    { tenantId: tenantA, contactId: first.id, type: "track", eventName: "exported", timestamp: new Date(Date.now() - 2 * 86_400_000) },
    { tenantId: tenantA, contactId: second.id, type: "track", eventName: "exported", timestamp: new Date(Date.now() - 3 * 86_400_000) },
  ]);
  // u0's email is suppressed: counted as a member, but not reachable
  await db.insert(suppressions).values({ tenantId: tenantA, email: "a0@seg.test", reason: "manual" });
});

afterAll(async () => {
  if (dbAvailable) await cleanup();
  await pool.end();
});

const call = async (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, cookie: string, payload?: unknown) => {
  const app = await buildApp({ db, logger: false });
  return app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as never } : {}) });
};
const create = (name: string, definition: unknown = def(), cookie = cookieA) => call("POST", "/v1/segments", cookie, { name, definition });
let seq = 0;
const unique = (prefix = "Seg") => `${prefix} ${Date.now()}-${++seq}`;

describe("auth", () => {
  it("needs a signed-in user", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });
    expect((await app.inject({ method: "GET", url: "/v1/segments" })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/v1/segments/preview", payload: { definition: def() } })).statusCode).toBe(401);
  });
});

describe("create", () => {
  it("saves the rules and counts who is in the segment", async () => {
    if (!dbAvailable) return;
    const res = await create(unique("Paid"));
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.definition).toEqual(def());
    expect(body.member_count).toBe(6);
    expect(body.count_capped).toBe(false);
    expect(typeof body.counted_at).toBe("string");
    expect(body.archived).toBe(false);
    expect(body.used_by_flows).toEqual([]);
  });

  it("accepts an empty description sent as null, as a form with an empty box does", async () => {
    if (!dbAvailable) return;
    const res = await call("POST", "/v1/segments", cookieA, { name: unique("No description"), description: null, definition: def() });
    expect(res.statusCode).toBe(201);
    expect(res.json().description).toBeNull();
    const blank = await call("POST", "/v1/segments", cookieA, { name: unique("Blank description"), description: "   ", definition: def() });
    expect(blank.statusCode).toBe(201);
    expect(blank.json().description).toBeNull();
  });

  it("counts only this workspace's contacts", async () => {
    if (!dbAvailable) return;
    const res = await create(unique("Everyone paid"), def({ field: "payment_status", op: "in", value: ["paid", "free"] }));
    expect(res.json().member_count).toBe(12); // workspace B's 3 are not counted
  });

  it("400 with the path when a rule is wrong, and says what is wrong with it", async () => {
    if (!dbAvailable) return;
    const res = await create(unique(), def({ field: "hair", op: "is", value: "red" }));
    expect(res.statusCode).toBe(400);
    const issue = res.json().issues.find((i: { path: string }) => i.path.startsWith("definition.rules"));
    expect(issue.message).toBe("not a rule the segment builder understands");
    const noWindow = await create(unique(), def({ field: "event", name: "x", op: "performed" }));
    expect(noWindow.statusCode).toBe(400);
  });

  it("400 for a missing name, an empty definition and nested groups", async () => {
    if (!dbAvailable) return;
    expect((await call("POST", "/v1/segments", cookieA, { definition: def() })).statusCode).toBe(400);
    expect((await call("POST", "/v1/segments", cookieA, { name: "   ", definition: def() })).statusCode).toBe(400);
    expect((await create(unique(), { match: "all", rules: [] })).statusCode).toBe(400);
    const nested = def({ match: "any", rules: [paid, { match: "all", rules: [paid] }] });
    expect((await create(unique(), nested)).statusCode).toBe(400);
  });

  it("409 for a name already in use, but a name is free again once its segment is archived", async () => {
    if (!dbAvailable) return;
    const name = unique("Dupe");
    const first = await create(name);
    expect(first.statusCode).toBe(201);
    expect((await create(name)).statusCode).toBe(409);
    expect((await call("DELETE", `/v1/segments/${first.json().id}`, cookieA)).statusCode).toBe(200);
    expect((await create(name)).statusCode).toBe(201);
    // another workspace may use the same name
    expect((await create(name, def(), cookieB)).statusCode).toBe(201);
  });

  it("422 once a workspace has its maximum number of segments", async () => {
    if (!dbAvailable) return;
    await db.execute(sql`DELETE FROM segments WHERE tenant_id = ${tenantB}::uuid`);
    await db.execute(sql`
      INSERT INTO segments (tenant_id, name, definition)
      SELECT ${tenantB}::uuid, 'filler ' || g, ${JSON.stringify(def())}::jsonb FROM generate_series(1, ${MAX_SEGMENTS_PER_WORKSPACE}) g`);
    const res = await create(unique("one too many"), def(), cookieB);
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toMatch(/up to 200 segments/);
    await db.execute(sql`DELETE FROM segments WHERE tenant_id = ${tenantB}::uuid`);
  });
});

describe("list and view", () => {
  it("lists this workspace's live segments, newest first, with a flow count", async () => {
    if (!dbAvailable) return;
    const mine = await create(unique("List me"));
    const theirs = await create(unique("Not yours"), def(), cookieB);
    const list = (await call("GET", "/v1/segments", cookieA)).json().segments as Array<{ id: string; flow_count: number }>;
    expect(list.some((s) => s.id === mine.json().id)).toBe(true);
    expect(list.some((s) => s.id === theirs.json().id)).toBe(false);
    expect(list.every((s) => typeof s.flow_count === "number")).toBe(true);
  });

  it("hides archived segments unless asked", async () => {
    if (!dbAvailable) return;
    const seg = await create(unique("Archive me"));
    await call("DELETE", `/v1/segments/${seg.json().id}`, cookieA);
    const hidden = (await call("GET", "/v1/segments", cookieA)).json().segments as Array<{ id: string }>;
    const shown = (await call("GET", "/v1/segments?include_archived=true", cookieA)).json().segments as Array<{ id: string; archived: boolean }>;
    expect(hidden.some((s) => s.id === seg.json().id)).toBe(false);
    expect(shown.find((s) => s.id === seg.json().id)?.archived).toBe(true);
  });

  it("one segment by id; 404 for another workspace's, a missing one, and a malformed id", async () => {
    if (!dbAvailable) return;
    const seg = await create(unique("View me"));
    const id = seg.json().id;
    expect((await call("GET", `/v1/segments/${id}`, cookieA)).json().name).toBe(seg.json().name);
    expect((await call("GET", `/v1/segments/${id}`, cookieB)).statusCode).toBe(404);
    expect((await call("GET", "/v1/segments/00000000-0000-0000-0000-000000000000", cookieA)).statusCode).toBe(404);
    expect((await call("GET", "/v1/segments/not-a-uuid", cookieA)).statusCode).toBe(404);
  });
});

describe("edit", () => {
  it("renames and re-describes without recounting", async () => {
    if (!dbAvailable) return;
    const seg = await create(unique("Before"));
    const countedAt = seg.json().counted_at;
    const res = await call("PATCH", `/v1/segments/${seg.json().id}`, cookieA, { name: unique("After"), description: "who pays" });
    expect(res.statusCode).toBe(200);
    expect(res.json().description).toBe("who pays");
    expect(res.json().counted_at).toBe(countedAt);
  });

  it("changing the rules recounts", async () => {
    if (!dbAvailable) return;
    const seg = await create(unique("Recount"));
    expect(seg.json().member_count).toBe(6);
    const res = await call("PATCH", `/v1/segments/${seg.json().id}`, cookieA, { definition: def({ field: "payment_status", op: "is", value: "free" }) });
    expect(res.statusCode).toBe(200);
    expect(res.json().member_count).toBe(6);
    expect(res.json().definition.rules[0].value).toBe("free");
    const narrower = await call("PATCH", `/v1/segments/${seg.json().id}`, cookieA, { definition: def(paid, { field: "has_email", op: "is", value: true }) });
    expect(narrower.json().member_count).toBe(3); // paid contacts 0, 2, 4 have an email
  });

  it("clears a description with null", async () => {
    if (!dbAvailable) return;
    const seg = await call("POST", "/v1/segments", cookieA, { name: unique("Desc"), description: "x", definition: def() });
    const res = await call("PATCH", `/v1/segments/${seg.json().id}`, cookieA, { description: null });
    expect(res.json().description).toBeNull();
  });

  it("400 for nothing to change or a bad rule, 409 for a taken name, 404 for someone else's, 422 once archived", async () => {
    if (!dbAvailable) return;
    const a = await create(unique("A"));
    const b = await create(unique("B"));
    const id = a.json().id;
    expect((await call("PATCH", `/v1/segments/${id}`, cookieA, {})).statusCode).toBe(400);
    expect((await call("PATCH", `/v1/segments/${id}`, cookieA, { definition: { match: "all", rules: [] } })).statusCode).toBe(400);
    expect((await call("PATCH", `/v1/segments/${id}`, cookieA, { name: b.json().name })).statusCode).toBe(409);
    expect((await call("PATCH", `/v1/segments/${id}`, cookieB, { name: unique() })).statusCode).toBe(404);
    await call("DELETE", `/v1/segments/${id}`, cookieA);
    expect((await call("PATCH", `/v1/segments/${id}`, cookieA, { name: unique() })).statusCode).toBe(422);
  });
});

describe("refresh", () => {
  it("recounts against who is there now", async () => {
    if (!dbAvailable) return;
    const seg = await create(unique("Refresh"), def({ field: "trait", key: "seats", op: "gt", value: 100 }));
    expect(seg.json().member_count).toBe(0);
    const [added] = await db
      .insert(contacts)
      .values({ tenantId: tenantA, externalId: `refresh-${Date.now()}`, lifecycleState: "engaged", paymentStatus: "paid", properties: { seats: 500 }, lastSeenAt: new Date() })
      .returning({ id: contacts.id });
    const res = await call("POST", `/v1/segments/${seg.json().id}/refresh`, cookieA);
    expect(res.statusCode).toBe(200);
    expect(res.json().member_count).toBe(1);
    expect(new Date(res.json().counted_at).getTime()).toBeGreaterThanOrEqual(new Date(seg.json().counted_at).getTime());
    await db.execute(sql`DELETE FROM contacts WHERE id = ${added!.id}::uuid`);
    expect((await call("POST", `/v1/segments/${seg.json().id}/refresh`, cookieA)).json().member_count).toBe(0);
  });

  it("404 for someone else's segment", async () => {
    if (!dbAvailable) return;
    const seg = await create(unique("Mine"));
    expect((await call("POST", `/v1/segments/${seg.json().id}/refresh`, cookieB)).statusCode).toBe(404);
  });
});

describe("archive", () => {
  const flowUsing = async (segmentId: string, status: string) => {
    const [f] = await db
      .insert(flows)
      .values({
        tenantId: tenantA,
        name: `uses ${segmentId.slice(0, 6)}`,
        triggerType: "segment",
        triggerConfig: { segment_id: segmentId },
        steps: [],
        status,
      })
      .returning({ id: flows.id });
    return f!.id;
  };

  it("archives a segment nothing uses; doing it again changes nothing", async () => {
    if (!dbAvailable) return;
    const seg = await create(unique("Unused"));
    const res = await call("DELETE", `/v1/segments/${seg.json().id}`, cookieA);
    expect(res.statusCode).toBe(200);
    expect(res.json().archived).toBe(true);
    expect((await call("DELETE", `/v1/segments/${seg.json().id}`, cookieA)).statusCode).toBe(200);
  });

  it("refuses while a flow starts from it, and names the flow", async () => {
    if (!dbAvailable) return;
    const seg = await create(unique("In use"));
    const id = seg.json().id;
    const flowId = await flowUsing(id, "active");
    const res = await call("DELETE", `/v1/segments/${id}`, cookieA);
    expect(res.statusCode).toBe(422);
    expect(res.json().flows.map((f: { id: string }) => f.id)).toEqual([flowId]);
    expect(res.json().error).toMatch(/still starts from/);
    // the view and list show the use
    expect((await call("GET", `/v1/segments/${id}`, cookieA)).json().used_by_flows).toHaveLength(1);
    const listed = (await call("GET", "/v1/segments", cookieA)).json().segments.find((s: { id: string }) => s.id === id);
    expect(listed.flow_count).toBe(1);
  });

  it("a draft flow counts as using it; an archived flow does not", async () => {
    if (!dbAvailable) return;
    const seg = await create(unique("Draft use"));
    const id = seg.json().id;
    const flowId = await flowUsing(id, "draft");
    expect((await call("DELETE", `/v1/segments/${id}`, cookieA)).statusCode).toBe(422);
    await db.execute(sql`UPDATE flows SET status = 'archived' WHERE id = ${flowId}::uuid`);
    expect((await call("DELETE", `/v1/segments/${id}`, cookieA)).statusCode).toBe(200);
  });

  it("404 for someone else's segment", async () => {
    if (!dbAvailable) return;
    const seg = await create(unique("Hands off"));
    expect((await call("DELETE", `/v1/segments/${seg.json().id}`, cookieB)).statusCode).toBe(404);
  });
});

describe("preview", () => {
  const preview = (definition: unknown, cookie = cookieA) => call("POST", "/v1/segments/preview", cookie, { definition });

  it("counts, says how many can be emailed, samples members and saves nothing", async () => {
    if (!dbAvailable) return;
    const before = (await db.execute<{ n: string }>(sql`SELECT count(*) AS n FROM segments WHERE tenant_id = ${tenantA}::uuid`)).rows[0]!.n;
    const res = await preview(def());
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.count).toBe(6);
    expect(body.capped).toBe(false);
    // paid contacts 0, 2, 4 have an email; u0's is suppressed, so 2 can be emailed
    expect(body.reachable).toBe(2);
    expect(body.sample).toHaveLength(6);
    expect(body.sample[0]).toMatchObject({ lifecycle_state: expect.any(String), external_id: expect.any(String) });
    const after = (await db.execute<{ n: string }>(sql`SELECT count(*) AS n FROM segments WHERE tenant_id = ${tenantA}::uuid`)).rows[0]!.n;
    expect(after).toBe(before);
  });

  it("limits the sample to 10, most recently active first", async () => {
    if (!dbAvailable) return;
    const res = await preview(def({ field: "payment_status", op: "in", value: ["paid", "free"] }));
    expect(res.json().count).toBeGreaterThanOrEqual(12);
    expect(res.json().sample).toHaveLength(10);
    const seen = res.json().sample.map((c: { last_seen_at: string }) => new Date(c.last_seen_at).getTime());
    expect([...seen].sort((a, b) => b - a)).toEqual(seen);
  });

  it("an empty segment is a valid answer", async () => {
    if (!dbAvailable) return;
    const res = await preview(def({ field: "trait", key: "seats", op: "gt", value: 99999 }));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ count: 0, reachable: 0, sample: [] });
  });

  it("warns about an event the workspace has never received", async () => {
    if (!dbAvailable) return;
    const res = await preview(def({ field: "event", name: "exported", op: "performed", within_days: 30 }, { field: "event", name: "never_heard_of", op: "not_performed", within_days: 30 }));
    expect(res.json().never_sent_events).toEqual(["never_heard_of"]);
    expect(res.json().count).toBe(2); // two contacts exported, and every contact has 'not done' the event nobody sends
  });

  it("counts event checks inside the window", async () => {
    if (!dbAvailable) return;
    const did = await preview(def({ field: "event", name: "exported", op: "performed", within_days: 30 }));
    expect(did.json().count).toBe(2);
    const didNot = await preview(def(paid, { field: "event", name: "exported", op: "not_performed", within_days: 30 }));
    expect(didNot.json().count).toBe(4); // 6 paid contacts, 2 of whom exported
    const tooShort = await preview(def({ field: "event", name: "exported", op: "performed", within_days: 1 }));
    expect(tooShort.json().count).toBe(0); // they exported 2 and 3 days ago
  });

  it("works with a group and the lifecycle and age checks", async () => {
    if (!dbAvailable) return;
    const res = await preview(
      def(
        { field: "lifecycle_state", op: "is", value: "at_risk" },
        { match: "any", rules: [paid, { field: "last_seen", op: "within_days", days: 2 }] },
        { field: "first_seen", op: "before_days", days: 30 },
      ),
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().count).toBeGreaterThan(0);
  });

  it("400 for a bad definition; another workspace's contacts are never counted", async () => {
    if (!dbAvailable) return;
    expect((await preview({ match: "all", rules: [] })).statusCode).toBe(400);
    expect((await call("POST", "/v1/segments/preview", cookieA, {})).statusCode).toBe(400);
    expect((await preview(def(), cookieB)).json().count).toBe(3);
  });

  it("429 when asked too often", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });
    let last = 200;
    for (let i = 0; i < 65; i++) {
      const res = await app.inject({ method: "POST", url: "/v1/segments/preview", headers: { cookie: cookieB }, payload: { definition: def() } });
      last = res.statusCode;
      if (last === 429) {
        expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
        break;
      }
    }
    expect(last).toBe(429);
  });
});

describe("the People list", () => {
  const list = (query: string, cookie = cookieA) => call("GET", `/v1/contacts?${query}`, cookie);

  it("?segment_id lists exactly the members", async () => {
    if (!dbAvailable) return;
    const seg = await create(unique("People"), def(paid, { field: "has_email", op: "is", value: true }));
    const res = await list(`segment_id=${seg.json().id}&limit=200`);
    expect(res.statusCode).toBe(200);
    const ids = res.json().contacts.map((c: { external_id: string }) => c.external_id).sort();
    expect(ids).toEqual(["u0", "u2", "u4"]);
  });

  it("combines with other filters and pages through the members", async () => {
    if (!dbAvailable) return;
    const seg = await create(unique("Paging"));
    const id = seg.json().id;
    const filtered = await list(`segment_id=${id}&lifecycle_state=engaged&limit=200`);
    expect(filtered.json().contacts.every((c: { lifecycle_state: string }) => c.lifecycle_state === "engaged")).toBe(true);
    expect(filtered.json().contacts).toHaveLength(3);
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 10; i++) {
      const res = await list(`segment_id=${id}&limit=2${cursor ? `&after=${cursor}` : ""}`);
      seen.push(...res.json().contacts.map((c: { external_id: string }) => c.external_id));
      cursor = res.json().next_cursor;
      if (!cursor) break;
    }
    expect(seen.sort()).toEqual(["u0", "u1", "u2", "u3", "u4", "u5"]);
  });

  it("404 for another workspace's segment, a missing one and an archived one; 400 for a malformed id", async () => {
    if (!dbAvailable) return;
    const seg = await create(unique("Private"));
    expect((await list(`segment_id=${seg.json().id}`, cookieB)).statusCode).toBe(404);
    expect((await list("segment_id=00000000-0000-0000-0000-000000000000")).statusCode).toBe(404);
    expect((await list("segment_id=nope")).statusCode).toBe(400);
    await call("DELETE", `/v1/segments/${seg.json().id}`, cookieA);
    expect((await list(`segment_id=${seg.json().id}`)).statusCode).toBe(404);
  });

  it("a list without a segment is unchanged", async () => {
    if (!dbAvailable) return;
    const res = await list("limit=200");
    expect(res.json().contacts.length).toBeGreaterThanOrEqual(12);
  });
});

describe("the time limit", () => {
  it("cancels a query that runs too long, and the limit does not leak to later work", async () => {
    if (!dbAvailable) return;
    const slow = withStatementTimeout(db as never, 100, (tx) => tx.execute(sql`SELECT pg_sleep(2)`));
    await expect(slow).rejects.toBeInstanceOf(SegmentTooSlowError);
    await expect(slow).rejects.toThrow(/takes too long/);
    // an ordinary query afterwards is unaffected, and nothing is left holding the connection
    const after = await db.execute(sql`SELECT pg_sleep(0.3), current_setting('statement_timeout') AS t`);
    expect(after.rows[0]).toMatchObject({ t: "0" });
  });

  it("lets a quick query through and returns its result", async () => {
    if (!dbAvailable) return;
    const result = await withStatementTimeout(db as never, 5000, async (tx) => (await tx.execute(sql`SELECT 42 AS n`)).rows[0]);
    expect(result).toEqual({ n: 42 });
  });
});
