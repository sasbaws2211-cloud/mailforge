/**
 * Anonymous tracking: track calls with an anonymousId and no userId.
 *
 *   - stored against the anonymous id, creating no contact and no event
 *   - identify with the same anonymousId (top-level or context) moves them onto the contact with their ORIGINAL
 *     times, even older than the 72-hour clamp, and removes the stored rows
 *   - after that, anonymous calls from the same id go straight to the contact
 *   - messageId dedupes; a merge run twice never doubles events
 *   - the per-visitor cap holds
 *   - no id at all, or identify with no userId, is a 400 (batch: a per-item error)
 *   - batch accepts anonymous items next to known ones
 *   - another tenant's visitor with the same id is never touched
 *   - the worker's retention sweep deletes old rows only
 *
 * Requires local Postgres (DATABASE_URL).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { sql } from "drizzle-orm";
import { buildApp, hashApiKey } from "../src/index.js";
import { tenants, apiKeys } from "@loomail/db/schema";
import { ANONYMOUS_MAX_EVENTS_PER_VISITOR, mergeAnonymousEvents } from "../src/routes/ingest.js";
import { sweepAnonymous } from "../../worker/src/anonymous-retention.js";
import { randomBytes } from "node:crypto";

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) throw new Error("[anonymous-tracking.test] DATABASE_URL is not set.");

let pool: pg.Pool;
let db: ReturnType<typeof drizzle>;
let dbAvailable = false;
let app: Awaited<ReturnType<typeof buildApp>>;
let tenantA = "";
let tenantB = "";
let keyA = "";
let keyB = "";
const SLUGS = ["test-anon-a", "test-anon-b"];

async function post(url: string, key: string, payload: unknown) {
  const res = await app.inject({ method: "POST", url, headers: { authorization: `Bearer ${key}` }, payload: payload as object });
  return { status: res.statusCode, body: res.json() };
}
const one = async (query: ReturnType<typeof sql>) => (await db.execute(query)).rows as Array<Record<string, any>>;
const anonRows = (tenant: string, aid: string) =>
  one(sql`SELECT event_name, timestamp FROM anonymous_events WHERE tenant_id = ${tenant} AND anonymous_id = ${aid} ORDER BY timestamp`);
const eventNames = (tenant: string, externalId: string) =>
  one(sql`SELECT e.event_name, e.timestamp, e.context FROM events e JOIN contacts c ON c.id = e.contact_id WHERE e.tenant_id = ${tenant} AND c.external_id = ${externalId} AND e.type = 'track' ORDER BY e.timestamp`);
const contactCount = async (tenant: string) => Number((await one(sql`SELECT count(*) AS n FROM contacts WHERE tenant_id = ${tenant}`))[0]!.n);

async function makeKey(tenantId: string) {
  const raw = `mf_live_${randomBytes(32).toString("base64url")}`;
  await db.insert(apiKeys).values({ tenantId, keyHash: hashApiKey(raw), prefix: raw.slice(0, 8), kind: "secret", allowedOrigins: null });
  return raw;
}

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: DB_URL, connectionTimeoutMillis: 3000 });
  try {
    await pool.query("SELECT 1");
    db = drizzle(pool);
    dbAvailable = true;
  } catch (err) {
    if (process.env.CI === "true") throw err;
    console.warn("[anonymous-tracking.test] DATABASE_URL not reachable - skipped.");
    return;
  }
  for (const slug of SLUGS) {
    const t = sql`(SELECT id FROM tenants WHERE slug = ${slug})`;
    for (const table of ["anonymous_aliases", "anonymous_events", "contact_conflicts", "lifecycle_transitions", "events", "contacts", "api_keys"]) {
      await db.execute(sql`DELETE FROM ${sql.raw(table)} WHERE tenant_id IN ${t}`);
    }
    await db.execute(sql`DELETE FROM tenants WHERE slug = ${slug}`);
  }
  const [a] = await db.insert(tenants).values({ name: SLUGS[0]!, slug: SLUGS[0]!, plan: "free" }).returning({ id: tenants.id });
  const [b] = await db.insert(tenants).values({ name: SLUGS[1]!, slug: SLUGS[1]!, plan: "free" }).returning({ id: tenants.id });
  tenantA = a!.id;
  tenantB = b!.id;
  keyA = await makeKey(tenantA);
  keyB = await makeKey(tenantB);
  app = await buildApp({ db, logger: false });
  await app.ready();
});

afterAll(async () => {
  if (app) await app.close();
  if (pool) await pool.end();
});

describe("anonymous track", () => {
  it("is stored against the anonymous id and creates no contact or event", async () => {
    if (!dbAvailable) return;
    const before = await contactCount(tenantA);
    const res = await post("/v1/track", keyA, { anonymousId: "anon-stored", event: "viewed_pricing", properties: { plan: "pro" } });
    expect(res.status).toBe(200);
    expect(await anonRows(tenantA, "anon-stored")).toHaveLength(1);
    expect(await contactCount(tenantA)).toBe(before);
  });

  it("takes the anonymous id from context too (what the browser snippet sends)", async () => {
    if (!dbAvailable) return;
    const res = await post("/v1/track", keyA, { event: "ctx_event", context: { anonymousId: "anon-ctx" } });
    expect(res.status).toBe(200);
    expect(await anonRows(tenantA, "anon-ctx")).toHaveLength(1);
  });

  it("works from a browser with a publishable key in the body, as the snippet sends it", async () => {
    if (!dbAvailable) return;
    const raw = `mf_pub_${randomBytes(32).toString("base64url")}`;
    await db.insert(apiKeys).values({ tenantId: tenantA, keyHash: hashApiKey(raw), prefix: raw.slice(0, 8), kind: "publishable", allowedOrigins: null });
    const res = await app.inject({
      method: "POST",
      url: "/v1/track",
      headers: { "content-type": "text/plain", origin: "https://shop.test" },
      payload: JSON.stringify({ key: raw, anonymousId: "anon-browser", event: "page_viewed", context: { anonymousId: "anon-browser" }, messageId: "anon:abc" }),
    });
    expect(res.statusCode).toBe(200);
    expect(await anonRows(tenantA, "anon-browser")).toHaveLength(1);
  });

  it("dedupes by messageId", async () => {
    if (!dbAvailable) return;
    const call = () => post("/v1/track", keyA, { anonymousId: "anon-dedupe", event: "e", messageId: "m-1" });
    expect((await call()).body).toMatchObject({ success: true, deduplicated: false });
    expect((await call()).body).toMatchObject({ success: true, deduplicated: true });
    expect(await anonRows(tenantA, "anon-dedupe")).toHaveLength(1);
  });

  it("stops storing past the per-visitor cap", async () => {
    if (!dbAvailable) return;
    const items = Array.from({ length: ANONYMOUS_MAX_EVENTS_PER_VISITOR + 5 }, () => ({ type: "track", anonymousId: "anon-cap", event: "e" }));
    for (let i = 0; i < items.length; i += 100) await post("/v1/batch", keyA, { batch: items.slice(i, i + 100) });
    expect(await anonRows(tenantA, "anon-cap")).toHaveLength(ANONYMOUS_MAX_EVENTS_PER_VISITOR);
  });

  it("with no id at all is a 400, and identify with no userId is a 400", async () => {
    if (!dbAvailable) return;
    expect((await post("/v1/track", keyA, { event: "nobody" })).status).toBe(400);
    expect((await post("/v1/identify", keyA, { anonymousId: "anon-x", traits: { email: "x@y.z" } })).status).toBe(400);
  });

  it("batch accepts anonymous track items next to known ones and reports the ones with no id", async () => {
    if (!dbAvailable) return;
    const res = await post("/v1/batch", keyA, {
      batch: [
        { type: "track", anonymousId: "anon-batch", event: "a" },
        { type: "track", userId: "batch-known", event: "b" },
        { type: "track", event: "no_id" },
        { type: "identify", anonymousId: "anon-batch" },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.received).toBe(2);
    expect(res.body.errors.map((e: { index: number }) => e.index)).toEqual([2, 3]);
  });
});

describe("identify merges the visitor's events", () => {
  it("moves them onto the contact with their original times, older than the 72-hour clamp too", async () => {
    if (!dbAvailable) return;
    await post("/v1/track", keyA, { anonymousId: "anon-merge", event: "visited", messageId: "mm-1" });
    await post("/v1/track", keyA, { anonymousId: "anon-merge", event: "viewed_docs", messageId: "mm-2" });
    // Age one row to 20 days ago, as if the visitor came back much later to sign up.
    const old = new Date(Date.now() - 20 * 86400_000);
    await db.execute(sql`UPDATE anonymous_events SET timestamp = ${old} WHERE tenant_id = ${tenantA} AND message_id = 'mm-1'`);

    const res = await post("/v1/identify", keyA, { userId: "merge-user", anonymousId: "anon-merge", traits: { email: "merge@example.com" } });
    expect(res.status).toBe(200);

    const events = await eventNames(tenantA, "merge-user");
    expect(events.map((e) => e.event_name)).toEqual(["visited", "viewed_docs"]);
    expect(Math.abs(new Date(events[0]!.timestamp).getTime() - old.getTime())).toBeLessThan(1000);
    expect(events[0]!.context).toMatchObject({ anonymousId: "anon-merge", merged_from_anonymous: true });
    expect(await anonRows(tenantA, "anon-merge")).toHaveLength(0);
  });

  it("takes the anonymous id from context on identify too", async () => {
    if (!dbAvailable) return;
    await post("/v1/track", keyA, { anonymousId: "anon-ctx-merge", event: "ctx_seen" });
    await post("/v1/identify", keyA, { userId: "ctx-user", context: { anonymousId: "anon-ctx-merge" } });
    expect((await eventNames(tenantA, "ctx-user")).map((e) => e.event_name)).toEqual(["ctx_seen"]);
  });

  it("afterwards, anonymous calls from the same id go straight to the contact", async () => {
    if (!dbAvailable) return;
    await post("/v1/identify", keyA, { userId: "alias-user", anonymousId: "anon-alias" });
    const res = await post("/v1/track", keyA, { anonymousId: "anon-alias", event: "after_identify" });
    expect(res.status).toBe(200);
    expect((await eventNames(tenantA, "alias-user")).map((e) => e.event_name)).toEqual(["after_identify"]);
    expect(await anonRows(tenantA, "anon-alias")).toHaveLength(0);
  });

  it("a merge run twice never doubles an event", async () => {
    if (!dbAvailable) return;
    await post("/v1/track", keyA, { anonymousId: "anon-twice", event: "once_only" });
    const stored = (await one(sql`SELECT id, timestamp FROM anonymous_events WHERE tenant_id = ${tenantA} AND anonymous_id = 'anon-twice'`))[0]!;
    await post("/v1/identify", keyA, { userId: "twice-user", anonymousId: "anon-twice" });
    expect(await eventNames(tenantA, "twice-user")).toHaveLength(1);
    // Put the same row back, as if deleting it after the first merge had failed, and merge again.
    await db.execute(sql`INSERT INTO anonymous_events (id, tenant_id, anonymous_id, event_name, timestamp) VALUES (${stored.id}, ${tenantA}, 'anon-twice', 'once_only', ${stored.timestamp})`);
    const again = await mergeAnonymousEvents(db as never, undefined, tenantA, "twice-user", "anon-twice");
    expect(again.moved).toBe(1); // the row was processed and cleared...
    expect(await eventNames(tenantA, "twice-user")).toHaveLength(1); // ...but added no second event
    expect(await anonRows(tenantA, "anon-twice")).toHaveLength(0);
  });

  it("never touches another tenant's visitor with the same anonymous id", async () => {
    if (!dbAvailable) return;
    await post("/v1/track", keyB, { anonymousId: "anon-shared-id", event: "b_event" });
    await post("/v1/track", keyA, { anonymousId: "anon-shared-id", event: "a_event" });
    await post("/v1/identify", keyA, { userId: "a-shared", anonymousId: "anon-shared-id" });
    expect((await eventNames(tenantA, "a-shared")).map((e) => e.event_name)).toEqual(["a_event"]);
    expect((await anonRows(tenantB, "anon-shared-id")).map((e) => e.event_name)).toEqual(["b_event"]);
    expect(await contactCount(tenantB)).toBe(0);
  });
});

describe("retention sweep", () => {
  it("deletes old unclaimed events and old links, and keeps recent ones", async () => {
    if (!dbAvailable) return;
    await db.execute(sql`INSERT INTO anonymous_events (tenant_id, anonymous_id, event_name, timestamp, received_at) VALUES
      (${tenantA}, 'sweep-old', 'e', now(), now() - interval '31 days'),
      (${tenantA}, 'sweep-new', 'e', now(), now() - interval '29 days')`);
    await post("/v1/identify", keyA, { userId: "sweep-user", anonymousId: "sweep-alias" });
    await db.execute(sql`UPDATE anonymous_aliases SET created_at = now() - interval '91 days' WHERE tenant_id = ${tenantA} AND anonymous_id = 'sweep-alias'`);

    const result = await sweepAnonymous(db as never, new Date());
    expect(result.eventsDeleted).toBeGreaterThanOrEqual(1);
    expect(result.aliasesDeleted).toBeGreaterThanOrEqual(1);
    expect(await anonRows(tenantA, "sweep-old")).toHaveLength(0);
    expect(await anonRows(tenantA, "sweep-new")).toHaveLength(1);
    expect(await one(sql`SELECT 1 FROM anonymous_aliases WHERE tenant_id = ${tenantA} AND anonymous_id = 'sweep-alias'`)).toHaveLength(0);
  });
});
