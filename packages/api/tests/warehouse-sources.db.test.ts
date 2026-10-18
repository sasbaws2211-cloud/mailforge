/**
 * Warehouse sources over HTTP and in the sync engine.
 *
 * Management: validation, the credential is never returned, tenant isolation, the per-workspace limit, the host guard,
 *   changing the position column starts again, webhook sources and warehouse sources stay out of each other's way.
 * Test query: shows rows and what each would become, reports missing columns and warehouse errors, uses the saved
 *   credential for a saved source.
 * Sync: contacts, traits and events are recorded; running again records nothing twice; new and changed rows arrive;
 *   batches and the per-run cap; failures leave the position alone and retry sooner; one run at a time (lease);
 *   what is due, and what is not (disabled, suspended workspace, leased, not yet due).
 * End to end: the real Postgres connector against a real table.
 *
 * Requires local Postgres (DATABASE_URL). The "warehouse" in the end-to-end test is the same server.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { sql } from "drizzle-orm";
import { WarehouseError, type CellValue, type WarehouseClient, type WarehouseConnection, type WarehouseQuery } from "@loomail/adapters";
import { buildApp } from "../src/index.js";
import { tenants, users, sessions } from "@loomail/db/schema";
import { dueSources, syncDueSources, syncSource } from "../src/warehouse/sync.js";

// Credentials are only stored when the install can encrypt them.
process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");
const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) throw new Error("[warehouse-sources.test] DATABASE_URL is not set.");

let pool: pg.Pool;
let db: ReturnType<typeof drizzle>;
let dbAvailable = false;
let app: Awaited<ReturnType<typeof buildApp>>;
let realApp: Awaited<ReturnType<typeof buildApp>>; // no fake warehouse: the real connectors
const SLUGS = ["test-wh-a", "test-wh-b"];
let tenantA = "";
let tenantB = "";
let cookieA = "";
let cookieB = "";

// --- A fake warehouse that honours the same contract as the real clients -------------------------------------------

type FakeRow = Record<string, CellValue>;
let table: FakeRow[] = [];
let queries: WarehouseQuery[] = [];
let connections: WarehouseConnection[] = [];
let failWith: Error | null = null;
const fakeFactory = (conn: WarehouseConnection): WarehouseClient => {
  connections.push(conn);
  return {
    async query(q) {
      queries.push(q);
      if (failWith) throw failWith;
      const col = q.cursorColumn;
      const rows = table
        .filter((r) => (q.cursor === "" ? true : String(r[col]) >= q.cursor))
        .sort((a, b) => String(a[col]).localeCompare(String(b[col])))
        .slice(0, q.maxRows);
      return { columns: table[0] ? Object.keys(table[0]) : [], rows };
    },
  };
};

const api = async (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, cookie: string | null, payload?: unknown, which: "fake" | "real" = "fake") => {
  const res = await (which === "real" ? realApp : app).inject({
    method,
    url,
    headers: { ...(cookie ? { cookie } : {}), ...(payload !== undefined ? { "content-type": "application/json" } : {}) },
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
  return { status: res.statusCode, body: res.json() as any };
};
const one = async (query: ReturnType<typeof sql>) => (await db.execute(query)).rows as Array<Record<string, any>>;
const contactBy = async (tenant: string, externalId: string) =>
  (await one(sql`SELECT external_id, email, name, company, payment_status, properties FROM contacts WHERE tenant_id = ${tenant} AND external_id = ${externalId}`))[0];
const eventsOf = async (tenant: string, externalId: string) =>
  one(sql`SELECT e.event_name, e.properties FROM events e JOIN contacts c ON c.id = e.contact_id WHERE e.tenant_id = ${tenant} AND c.external_id = ${externalId} AND e.type = 'track' ORDER BY e.timestamp, e.id`);
const sourceRow = async (id: string) => (await one(sql`SELECT * FROM inbound_sources WHERE id = ${id}`))[0]!;
const logOf = async (id: string) => one(sql`SELECT status, summary FROM inbound_source_log WHERE source_id = ${id} ORDER BY created_at, id`);

const CONFIG = {
  warehouse: "postgres",
  host: "warehouse.example.com",
  database: "crm",
  user: "loomail_reader",
  query: "SELECT id, email, plan, updated_at FROM users WHERE updated_at >= :cursor::timestamptz",
  cursor_column: "updated_at",
  user_id_column: "id",
  email_column: "email",
  event_name: "warehouse_user_synced",
  trait_columns: { plan_name: "plan" },
  batch_size: 10,
};
const SECRET = { password: "s3cret-pw" };
const deps = (now?: () => Date) => ({ enqueue: async () => null, clientFor: fakeFactory, ...(now ? { now } : {}) });

async function newSource(config: Record<string, unknown> = CONFIG, cookie = cookieA, name = "CRM warehouse") {
  const res = await api("POST", "/v1/warehouse-sources", cookie, { name, config, secret: SECRET });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.source.id as string;
}
const iso = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();
const makeRows = (n: number, from = 1): FakeRow[] => Array.from({ length: n }, (_, i) => ({ id: `u${from + i}`, email: `u${from + i}@x.test`, plan: "pro", updated_at: iso(from + i) }));

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: DB_URL, connectionTimeoutMillis: 3000 });
  try {
    await pool.query("SELECT 1");
    db = drizzle(pool);
    dbAvailable = true;
  } catch (err) {
    if (process.env.CI === "true") throw err;
    console.warn("[warehouse-sources.test] DATABASE_URL not reachable - skipped.");
    return;
  }
  for (const slug of SLUGS) {
    const t = sql`(SELECT id FROM tenants WHERE slug = ${slug})`;
    for (const table of ["inbound_source_log", "inbound_sources", "contact_conflicts", "lifecycle_transitions", "events", "contacts", "sessions", "users"]) {
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
  [tenantA, cookieA, tenantB, cookieB] = [a.id, a.cookie, b.id, b.cookie];
  app = await buildApp({ db, logger: false, warehouseClientFor: (c) => fakeFactory(c), warehouseLimitsPerMinute: { test: 1000, sync: 1000 } });
  await app.ready();
  realApp = await buildApp({ db, logger: false });
  await realApp.ready();
});

afterAll(async () => {
  if (app) await app.close();
  if (realApp) await realApp.close();
  if (pool) {
    if (dbAvailable) {
      for (const slug of SLUGS) {
        const t = sql`(SELECT id FROM tenants WHERE slug = ${slug})`;
        for (const tbl of ["inbound_source_log", "inbound_sources", "contact_conflicts", "lifecycle_transitions", "events", "contacts", "sessions", "users"]) {
          await db.execute(sql`DELETE FROM ${sql.raw(tbl)} WHERE tenant_id IN ${t}`);
        }
        await db.execute(sql`DELETE FROM tenants WHERE slug = ${slug}`);
      }
    }
    await pool.end();
  }
});

beforeEach(async () => {
  if (!dbAvailable) return;
  table = [];
  queries = [];
  connections = [];
  failWith = null;
  for (const tbl of ["inbound_source_log", "inbound_sources", "contact_conflicts", "lifecycle_transitions", "events", "contacts"]) {
    await db.execute(sql`DELETE FROM ${sql.raw(tbl)} WHERE tenant_id IN (${tenantA}, ${tenantB})`);
  }
  await db.execute(sql`UPDATE tenants SET suspended_at = NULL WHERE id IN (${tenantA}, ${tenantB})`);
});

const run = (name: string, fn: () => Promise<void>) => it(name, async () => (dbAvailable ? fn() : undefined));

describe("managing warehouse sources", () => {
  run("creates one, never returns the credential, and seals it at rest", async () => {
    const id = await newSource();
    const list = await api("GET", "/v1/warehouse-sources", cookieA);
    expect(list.status).toBe(200);
    expect(list.body.sources).toHaveLength(1);
    const s = list.body.sources[0];
    expect(s).toMatchObject({ id, name: "CRM warehouse", kind: "warehouse", enabled: true, has_credential: true });
    expect(s.config).toMatchObject({ warehouse: "postgres", port: 5432, ssl_mode: "verify", interval_minutes: 60 });
    expect(JSON.stringify(list.body)).not.toContain("s3cret-pw");
    expect(JSON.stringify(list.body)).not.toContain("secret_sealed");
    const raw = await sourceRow(id);
    expect(raw.secret_sealed).toBeTruthy();
    expect(raw.secret_sealed).not.toContain("s3cret-pw");
    expect(raw.token_hash).toBeNull();
  });

  run("will not store a credential on an install that cannot encrypt it", async () => {
    const key = process.env.ENCRYPTION_KEY;
    delete process.env.ENCRYPTION_KEY;
    try {
      const r = await api("POST", "/v1/warehouse-sources", cookieA, { name: "x", config: CONFIG, secret: SECRET });
      expect(r.status).toBe(503);
      expect(r.body.error).toMatch(/ENCRYPTION_KEY/);
      expect((await api("GET", "/v1/warehouse-sources", cookieA)).body.sources).toHaveLength(0);
    } finally {
      process.env.ENCRYPTION_KEY = key;
    }
  });

  run("validates settings and the credential with field paths", async () => {
    const bad = await api("POST", "/v1/warehouse-sources", cookieA, { name: "x", config: { ...CONFIG, cursor_column: "a;b", user_id_column: undefined, email_column: undefined }, secret: SECRET });
    expect(bad.status).toBe(400);
    const paths = bad.body.issues.map((i: any) => i.path);
    expect(paths).toContain("config.cursor_column");
    expect(paths).toContain("config.user_id_column");
    const noSecret = await api("POST", "/v1/warehouse-sources", cookieA, { name: "x", config: CONFIG, secret: {} });
    expect(noSecret.status).toBe(400);
    expect(noSecret.body.issues[0].path).toBe("secret.password");
    const extra = await api("POST", "/v1/warehouse-sources", cookieA, { name: "x", config: CONFIG, secret: SECRET, token: "no" });
    expect(extra.status).toBe(400);
    expect((await api("GET", "/v1/warehouse-sources", cookieA)).body.sources).toHaveLength(0);
  });

  run("needs a session, and keeps workspaces apart", async () => {
    expect((await api("GET", "/v1/warehouse-sources", null)).status).toBe(401);
    const id = await newSource();
    expect((await api("GET", "/v1/warehouse-sources", cookieB)).body.sources).toHaveLength(0);
    expect((await api("PATCH", `/v1/warehouse-sources/${id}`, cookieB, { name: "mine now" })).status).toBe(404);
    expect((await api("DELETE", `/v1/warehouse-sources/${id}`, cookieB)).status).toBe(404);
    expect((await api("POST", `/v1/warehouse-sources/${id}/sync`, cookieB)).status).toBe(404);
    expect((await api("GET", `/v1/warehouse-sources/${id}/log`, cookieB)).status).toBe(404);
    expect((await api("POST", "/v1/warehouse-sources/test", cookieB, { id })).status).toBe(404);
    expect((await api("GET", `/v1/warehouse-sources/not-a-uuid/log`, cookieA)).status).toBe(404);
  });

  run("allows five per workspace", async () => {
    for (let i = 0; i < 5; i++) await newSource(CONFIG, cookieA, `s${i}`);
    const sixth = await api("POST", "/v1/warehouse-sources", cookieA, { name: "s5", config: CONFIG, secret: SECRET });
    expect(sixth.status).toBe(409);
    expect((await api("POST", "/v1/warehouse-sources", cookieB, { name: "other", config: CONFIG, secret: SECRET })).status).toBe(201);
    await db.execute(sql`DELETE FROM inbound_sources WHERE tenant_id = ${tenantB}`);
  });

  run("refuses a private database address when the guard is on, but not when it is off", async () => {
    const prev = process.env.LOOMAIL_RESTRICT_WAREHOUSE_HOSTS;
    process.env.LOOMAIL_RESTRICT_WAREHOUSE_HOSTS = "true";
    try {
      for (const host of ["127.0.0.1", "169.254.169.254", "10.0.0.5", "localhost"]) {
        const r = await api("POST", "/v1/warehouse-sources", cookieA, { name: "x", config: { ...CONFIG, host }, secret: SECRET });
        expect(r.status, host).toBe(400);
        expect(r.body.issues[0].path).toBe("config.host");
      }
      expect((await api("GET", "/v1/warehouse-sources", cookieA)).body.sources).toHaveLength(0);
    } finally {
      if (prev === undefined) delete process.env.LOOMAIL_RESTRICT_WAREHOUSE_HOSTS;
      else process.env.LOOMAIL_RESTRICT_WAREHOUSE_HOSTS = prev;
    }
    expect((await api("POST", "/v1/warehouse-sources", cookieA, { name: "x", config: { ...CONFIG, host: "127.0.0.1" }, secret: SECRET })).status).toBe(201);
  });

  run("renames, disables, replaces the credential, and starts again when the position column changes", async () => {
    const id = await newSource();
    await db.execute(sql`UPDATE inbound_sources SET sync_cursor = 'x', next_sync_at = now() WHERE id = ${id}`);
    const renamed = await api("PATCH", `/v1/warehouse-sources/${id}`, cookieA, { name: "Renamed", enabled: false });
    expect(renamed.body.source).toMatchObject({ name: "Renamed", enabled: false });
    expect((await sourceRow(id)).sync_cursor).toBe("x"); // untouched

    const sameCol = await api("PATCH", `/v1/warehouse-sources/${id}`, cookieA, { config: { ...CONFIG, query: "SELECT id, email, plan, updated_at FROM users2 WHERE updated_at >= :cursor::timestamptz" } });
    expect(sameCol.status).toBe(200);
    expect((await sourceRow(id)).sync_cursor).toBe("x"); // a new query keeps its place

    const newCol = await api("PATCH", `/v1/warehouse-sources/${id}`, cookieA, { config: { ...CONFIG, cursor_column: "id", cursor_type: "text" } });
    expect(newCol.status).toBe(200);
    expect((await sourceRow(id)).sync_cursor).toBeNull();

    const before = (await sourceRow(id)).secret_sealed;
    expect((await api("PATCH", `/v1/warehouse-sources/${id}`, cookieA, { secret: { password: "new-pw-1" } })).status).toBe(200);
    expect((await sourceRow(id)).secret_sealed).not.toBe(before);
    expect((await api("PATCH", `/v1/warehouse-sources/${id}`, cookieA, { secret: { password: "" } })).status).toBe(400);
    expect((await api("PATCH", `/v1/warehouse-sources/${id}`, cookieA, { secret: {} })).status).toBe(200); // nothing to change

    await db.execute(sql`UPDATE inbound_sources SET sync_cursor = 'y' WHERE id = ${id}`);
    await api("PATCH", `/v1/warehouse-sources/${id}`, cookieA, { reset_cursor: true });
    expect((await sourceRow(id)).sync_cursor).toBeNull();
  });

  run("cannot change warehouse, and refuses unknown fields", async () => {
    const id = await newSource();
    const sf = { warehouse: "snowflake", account: "myorg-myaccount", user: "R", query: CONFIG.query, cursor_column: "updated_at", user_id_column: "id", event_name: "e" };
    const r = await api("PATCH", `/v1/warehouse-sources/${id}`, cookieA, { config: sf });
    expect(r.status).toBe(400);
    expect(r.body.issues[0].path).toBe("config.warehouse");
    expect((await api("PATCH", `/v1/warehouse-sources/${id}`, cookieA, { kind: "generic" })).status).toBe(400);
  });

  run("deletes a source with its log", async () => {
    const id = await newSource();
    table = makeRows(2);
    await syncSource(db, id, deps());
    expect((await logOf(id)).length).toBeGreaterThan(0);
    expect((await api("DELETE", `/v1/warehouse-sources/${id}`, cookieA)).body).toEqual({ deleted: true });
    expect((await one(sql`SELECT 1 FROM inbound_sources WHERE id = ${id}`)).length).toBe(0);
    expect((await one(sql`SELECT 1 FROM inbound_source_log WHERE source_id = ${id}`)).length).toBe(0);
  });

  run("keeps webhook sources and warehouse sources apart", async () => {
    const wh = await newSource();
    const hook = await api("POST", "/v1/inbound-sources", cookieA, { kind: "generic", name: "Typeform", config: { event_name: "e", user_id_path: "id" } });
    expect(hook.status).toBe(201);
    const hookList = await api("GET", "/v1/inbound-sources", cookieA);
    expect(hookList.body.sources.map((s: any) => s.id)).toEqual([hook.body.source.id]);
    expect((await api("GET", "/v1/warehouse-sources", cookieA)).body.sources.map((s: any) => s.id)).toEqual([wh]);
    // the webhook routes cannot touch a warehouse source
    expect((await api("DELETE", `/v1/inbound-sources/${wh}`, cookieA)).status).toBe(404);
    expect((await api("PATCH", `/v1/inbound-sources/${wh}`, cookieA, { name: "x" })).status).toBe(404);
    expect((await api("POST", `/v1/inbound-sources/${wh}/rotate-token`, cookieA)).status).toBe(404);
    // and nothing can post to it
    const post = await app.inject({ method: "POST", url: `/webhooks/in/${wh}`, headers: { "content-type": "application/json" }, payload: "{}" });
    expect(post.statusCode).toBe(401);
    // a webhook source does not count against the warehouse limit and vice versa
    expect((await api("GET", "/v1/warehouse-sources", cookieA)).body.sources).toHaveLength(1);
    await db.execute(sql`DELETE FROM inbound_sources WHERE id = ${hook.body.source.id}`);
  });
});

const SSH_FP = "SHA256:" + "B".repeat(43);
const SSH_KEY = ["-----BEGIN OPENSSH PRIVATE KEY-----", "Q".repeat(160), "-----END OPENSSH PRIVATE KEY-----"].join("\n");
const TUNNEL_CONFIG = { ...CONFIG, host: "db.corp.internal", ssh_tunnel: { host: "bastion.example.com", user: "tunnel", host_fingerprint: SSH_FP } };
const TUNNEL_SECRET = { password: "s3cret-pw", ssh_private_key: SSH_KEY, ssh_passphrase: "key phrase" };

async function newTunnelSource(config: Record<string, unknown> = TUNNEL_CONFIG, secret: Record<string, unknown> = TUNNEL_SECRET) {
  const res = await api("POST", "/v1/warehouse-sources", cookieA, { name: "Private DB", config, secret });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.source.id as string;
}

describe("a database reached through an SSH tunnel", () => {
  run("needs its private key, and its pinned host key", async () => {
    const noKey = await api("POST", "/v1/warehouse-sources", cookieA, { name: "x", config: TUNNEL_CONFIG, secret: SECRET });
    expect(noKey.status).toBe(400);
    expect(noKey.body.issues[0]).toMatchObject({ path: "secret.ssh_private_key" });
    const badFp = await api("POST", "/v1/warehouse-sources", cookieA, { name: "x", config: { ...TUNNEL_CONFIG, ssh_tunnel: { ...TUNNEL_CONFIG.ssh_tunnel, host_fingerprint: "SHA256:nope" } }, secret: TUNNEL_SECRET });
    expect(badFp.status).toBe(400);
    expect(badFp.body.issues.map((i: any) => i.path)).toContain("config.ssh_tunnel.host_fingerprint");
    const noFp = await api("POST", "/v1/warehouse-sources", cookieA, { name: "x", config: { ...TUNNEL_CONFIG, ssh_tunnel: { host: "b.example.com", user: "u" } }, secret: TUNNEL_SECRET });
    expect(noFp.status).toBe(400);
    expect((await api("GET", "/v1/warehouse-sources", cookieA)).body.sources).toHaveLength(0);
  });

  run("stores the key sealed and never returns it, the passphrase or the password", async () => {
    const id = await newTunnelSource();
    const list = await api("GET", "/v1/warehouse-sources", cookieA);
    const text = JSON.stringify(list.body);
    for (const secret of ["s3cret-pw", "key phrase", "QQQQQQQQ", "PRIVATE KEY"]) expect(text, secret).not.toContain(secret);
    expect(list.body.sources[0].config.ssh_tunnel).toEqual({ host: "bastion.example.com", port: 22, user: "tunnel", host_fingerprint: SSH_FP });
    const raw = await sourceRow(id);
    expect(raw.secret_sealed).not.toContain("QQQQQQQQ");
    expect(raw.secret_sealed).not.toContain("key phrase");
  });

  run("a sync and a test hand the tunnel and the key to the connector", async () => {
    const id = await newTunnelSource();
    table = makeRows(2);
    await syncSource(db, id, deps());
    expect(connections[0]).toMatchObject({
      kind: "postgres",
      config: { host: "db.corp.internal", ssh: { host: "bastion.example.com", port: 22, user: "tunnel", host_fingerprint: SSH_FP } },
      secret: { password: "s3cret-pw", ssh_private_key: SSH_KEY, ssh_passphrase: "key phrase" },
    });
    connections = [];
    const test = await api("POST", "/v1/warehouse-sources/test", cookieA, { id });
    expect(test.body.ok).toBe(true);
    expect(connections[0]).toMatchObject({ config: { ssh: { user: "tunnel" } }, secret: { ssh_private_key: SSH_KEY } });
  });

  run("the private-address guard applies to the SSH server, and the database behind it may be private", async () => {
    const prev = process.env.LOOMAIL_RESTRICT_WAREHOUSE_HOSTS;
    process.env.LOOMAIL_RESTRICT_WAREHOUSE_HOSTS = "true";
    try {
      for (const host of ["127.0.0.1", "169.254.169.254", "10.0.0.5", "localhost"]) {
        const r = await api("POST", "/v1/warehouse-sources", cookieA, { name: "x", config: { ...TUNNEL_CONFIG, ssh_tunnel: { ...TUNNEL_CONFIG.ssh_tunnel, host } }, secret: TUNNEL_SECRET });
        expect(r.status, host).toBe(400);
        expect(r.body.issues[0].path).toBe("config.ssh_tunnel.host");
      }
      // a private database address is fine when it is reached through the SSH server (which resolves it)...
      const publicBastion = { ...TUNNEL_CONFIG.ssh_tunnel, host: "93.184.216.34" }; // an address literal, so no DNS is needed
      const ok = await api("POST", "/v1/warehouse-sources", cookieA, { name: "x", config: { ...TUNNEL_CONFIG, host: "10.0.0.5", ssh_tunnel: publicBastion }, secret: TUNNEL_SECRET });
      expect(ok.status, JSON.stringify(ok.body)).toBe(201);
      // ...and still refused when there is no tunnel
      const direct = await api("POST", "/v1/warehouse-sources", cookieA, { name: "y", config: { ...CONFIG, host: "10.0.0.5" }, secret: SECRET });
      expect(direct.status).toBe(400);
      expect(direct.body.issues[0].path).toBe("config.host");
      // the test route applies the same rule
      const test = await api("POST", "/v1/warehouse-sources/test", cookieA, { config: { ...TUNNEL_CONFIG, ssh_tunnel: { ...TUNNEL_CONFIG.ssh_tunnel, host: "169.254.169.254" } }, secret: TUNNEL_SECRET });
      expect(test.status).toBe(400);
    } finally {
      if (prev === undefined) delete process.env.LOOMAIL_RESTRICT_WAREHOUSE_HOSTS;
      else process.env.LOOMAIL_RESTRICT_WAREHOUSE_HOSTS = prev;
    }
  });

  run("editing the password keeps the SSH key, and editing the key keeps the password", async () => {
    const id = await newTunnelSource();
    expect((await api("PATCH", `/v1/warehouse-sources/${id}`, cookieA, { secret: { password: "new-pw" } })).status).toBe(200);
    table = makeRows(1);
    await syncSource(db, id, deps());
    expect(connections.at(-1)!.secret).toMatchObject({ password: "new-pw", ssh_private_key: SSH_KEY, ssh_passphrase: "key phrase" });
    const key2 = SSH_KEY.replace(/Q/g, "R");
    expect((await api("PATCH", `/v1/warehouse-sources/${id}`, cookieA, { secret: { ssh_private_key: key2, ssh_passphrase: "other" } })).status).toBe(200);
    await syncSource(db, id, deps(), true);
    expect(connections.at(-1)!.secret).toMatchObject({ password: "new-pw", ssh_private_key: key2, ssh_passphrase: "other" });
    // a bad value is refused and nothing changes
    expect((await api("PATCH", `/v1/warehouse-sources/${id}`, cookieA, { secret: { ssh_private_key: "garbage" } })).status).toBe(400);
  });

  run("turning the tunnel off drops the key; turning it on needs one", async () => {
    const id = await newTunnelSource();
    const off = await api("PATCH", `/v1/warehouse-sources/${id}`, cookieA, { config: { ...CONFIG, host: "warehouse.example.com" } });
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    expect(off.body.source.config.ssh_tunnel).toBeUndefined();
    table = makeRows(1);
    await syncSource(db, id, deps(), true);
    expect(connections.at(-1)!.secret).toEqual({ password: "s3cret-pw" }); // no key left behind
    // on again with no key to hand: refused
    const on = await api("PATCH", `/v1/warehouse-sources/${id}`, cookieA, { config: TUNNEL_CONFIG });
    expect(on.status).toBe(400);
    expect(on.body.issues[0].path).toBe("secret.ssh_private_key");
    // on again with a key: fine
    expect((await api("PATCH", `/v1/warehouse-sources/${id}`, cookieA, { config: TUNNEL_CONFIG, secret: { ssh_private_key: SSH_KEY } })).status).toBe(200);
    await syncSource(db, id, deps(), true);
    expect(connections.at(-1)!.secret).toMatchObject({ password: "s3cret-pw", ssh_private_key: SSH_KEY });
  });

  run("changing only the tunnel's address keeps the saved key", async () => {
    const id = await newTunnelSource();
    const moved = { ...TUNNEL_CONFIG, ssh_tunnel: { ...TUNNEL_CONFIG.ssh_tunnel, host: "bastion2.example.com", port: 2222 } };
    expect((await api("PATCH", `/v1/warehouse-sources/${id}`, cookieA, { config: moved })).status).toBe(200);
    table = makeRows(1);
    await syncSource(db, id, deps(), true);
    expect(connections.at(-1)).toMatchObject({ config: { ssh: { host: "bastion2.example.com", port: 2222 } }, secret: { ssh_private_key: SSH_KEY } });
  });

  run("testing edited settings uses the saved key unless a new one is given", async () => {
    const id = await newTunnelSource();
    table = makeRows(1);
    const moved = { ...TUNNEL_CONFIG, ssh_tunnel: { ...TUNNEL_CONFIG.ssh_tunnel, user: "other" } };
    const r = await api("POST", "/v1/warehouse-sources/test", cookieA, { id, config: moved });
    expect(r.body.ok).toBe(true);
    expect(connections.at(-1)).toMatchObject({ config: { ssh: { user: "other" } }, secret: { ssh_private_key: SSH_KEY, password: "s3cret-pw" } });
    // a brand-new test (nothing saved) with a tunnel and no key is refused
    const bare = await api("POST", "/v1/warehouse-sources/test", cookieA, { config: TUNNEL_CONFIG, secret: SECRET });
    expect(bare.status).toBe(400);
    expect(bare.body.issues[0].path).toBe("secret.ssh_private_key");
  });
});

describe("test query", () => {
  run("shows the rows and what each would become", async () => {
    table = [...makeRows(2), { id: null, email: null, plan: "x", updated_at: iso(50) }];
    const r = await api("POST", "/v1/warehouse-sources/test", cookieA, { config: CONFIG, secret: SECRET });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, columns: ["id", "email", "plan", "updated_at"], missing: [] });
    expect(r.body.rows[0].result).toEqual({ ok: true, person: "u1", event: "warehouse_user_synced", traits: { plan_name: "pro" } });
    expect(r.body.rows[2].result).toEqual({ ok: false, reason: "no user id or email in this row" });
    // nothing was recorded
    expect((await one(sql`SELECT 1 FROM contacts WHERE tenant_id = ${tenantA}`)).length).toBe(0);
    expect(queries[0]).toMatchObject({ maxRows: 5, cursorColumn: "updated_at" });
    expect(connections[0]).toMatchObject({ kind: "postgres", secret: SECRET });
  });

  run("reports columns the settings need but the query does not return, and warehouse errors", async () => {
    table = makeRows(1);
    const r = await api("POST", "/v1/warehouse-sources/test", cookieA, { config: { ...CONFIG, trait_columns: { x: "nope" } }, secret: SECRET });
    expect(r.body).toMatchObject({ ok: true, missing: ["nope"] });
    failWith = new WarehouseError("Could not connect to the database: ECONNREFUSED", true);
    const bad = await api("POST", "/v1/warehouse-sources/test", cookieA, { config: CONFIG, secret: SECRET });
    expect(bad.body).toEqual({ ok: false, error: "Could not connect to the database: ECONNREFUSED" });
    failWith = new Error("boom internals /etc/passwd");
    const odd = await api("POST", "/v1/warehouse-sources/test", cookieA, { config: CONFIG, secret: SECRET });
    expect(odd.body).toEqual({ ok: false, error: "The connection could not be tested." });
  });

  run("uses the saved credential for a saved source, and needs one otherwise", async () => {
    const id = await newSource();
    table = makeRows(1);
    const saved = await api("POST", "/v1/warehouse-sources/test", cookieA, { id });
    expect(saved.body.ok).toBe(true);
    expect(connections[0]).toMatchObject({ secret: SECRET });
    const withNew = await api("POST", "/v1/warehouse-sources/test", cookieA, { id, config: { ...CONFIG, trait_columns: { plan_name: "plan", em: "email" } } });
    expect(withNew.body.rows[0].result.traits).toEqual({ plan_name: "pro", em: "u1@x.test" });
    const none = await api("POST", "/v1/warehouse-sources/test", cookieA, { config: CONFIG });
    expect(none.status).toBe(400);
    expect(none.body.issues[0].path).toBe("secret");
  });

  run("applies the private-address rule too", async () => {
    const prev = process.env.LOOMAIL_RESTRICT_WAREHOUSE_HOSTS;
    process.env.LOOMAIL_RESTRICT_WAREHOUSE_HOSTS = "true";
    try {
      const r = await api("POST", "/v1/warehouse-sources/test", cookieA, { config: { ...CONFIG, host: "169.254.169.254" }, secret: SECRET });
      expect(r.status).toBe(400);
      expect(queries).toHaveLength(0);
    } finally {
      if (prev === undefined) delete process.env.LOOMAIL_RESTRICT_WAREHOUSE_HOSTS;
      else process.env.LOOMAIL_RESTRICT_WAREHOUSE_HOSTS = prev;
    }
  });
});

describe("syncing", () => {
  run("records contacts, traits and events, and moves the position", async () => {
    const id = await newSource();
    table = makeRows(3);
    const out = await syncSource(db, id, deps());
    expect(out).toMatchObject({ ok: true, read: 3, applied: 3, skipped: 0 });
    const c = await contactBy(tenantA, "u2");
    expect(c).toMatchObject({ email: "u2@x.test" });
    expect(c!.properties).toMatchObject({ plan_name: "pro" });
    const ev = await eventsOf(tenantA, "u2");
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ event_name: "warehouse_user_synced", properties: { id: "u2", plan: "pro" } });
    const row = await sourceRow(id);
    expect(row).toMatchObject({ sync_cursor: iso(3), last_sync_status: "ok", sync_lease_until: null });
    expect(row.last_sync_note).toBe("Read 3 rows: 3 recorded.");
    expect(new Date(row.next_sync_at).getTime()).toBeGreaterThan(Date.now() + 59 * 60_000);
    expect((await logOf(id)).map((l) => l.status)).toEqual(["processed"]);
    // the first run started from the beginning of time
    expect(queries[0]!.cursor).toBe("1970-01-01T00:00:00.000Z");
  });

  run("a second run with nothing new records nothing, says so, and writes no log line", async () => {
    const id = await newSource();
    table = makeRows(3);
    await syncSource(db, id, deps());
    const again = await syncSource(db, id, deps());
    expect(again).toMatchObject({ ok: true, read: 0, applied: 0, skipped: 0, note: "Nothing new." });
    expect(queries.at(-1)!.cursor).toBe(iso(3));
    expect(await eventsOf(tenantA, "u3")).toHaveLength(1);
    expect((await one(sql`SELECT count(*)::int AS n FROM contacts WHERE tenant_id = ${tenantA}`))[0]!.n).toBe(3);
    expect(await logOf(id)).toHaveLength(1); // only the first run
    expect((await sourceRow(id)).last_sync_note).toBe("Nothing new.");
  });

  run("a late row with the same position value as the last one is not lost, and nothing is doubled", async () => {
    const id = await newSource();
    table = [{ id: "u1", email: "u1@x.test", plan: "a", updated_at: iso(5) }, { id: "u2", email: "u2@x.test", plan: "a", updated_at: iso(5) }];
    await syncSource(db, id, deps());
    table = [...table, { id: "u3", email: "u3@x.test", plan: "a", updated_at: iso(5) }];
    const out = await syncSource(db, id, deps());
    expect(out).toMatchObject({ ok: true, read: 3 });
    expect(await contactBy(tenantA, "u3")).toBeTruthy();
    expect(await eventsOf(tenantA, "u1")).toHaveLength(1); // recognised, not doubled
    expect(await eventsOf(tenantA, "u3")).toHaveLength(1);
    // and now the boundary is the three, so the next run is quiet
    expect((await syncSource(db, id, deps()))!.note).toBe("Nothing new.");
  });

  run("an edit to a row at the saved position is picked up", async () => {
    const id = await newSource();
    table = makeRows(2);
    await syncSource(db, id, deps());
    table[1] = { ...table[1]!, plan: "enterprise" }; // same updated_at, different content
    const out = await syncSource(db, id, deps());
    expect(out!.read).toBe(1);
    expect((await contactBy(tenantA, "u2"))!.properties).toMatchObject({ plan_name: "enterprise" });
  });

  run("new rows arrive on the next run, and a changed row updates the person", async () => {
    const id = await newSource();
    table = makeRows(2);
    await syncSource(db, id, deps());
    table = [...makeRows(2), ...makeRows(1, 3)];
    table[0] = { ...table[0]!, plan: "enterprise", updated_at: iso(10) };
    const out = await syncSource(db, id, deps());
    expect(out!.ok).toBe(true);
    expect((await contactBy(tenantA, "u3"))!.email).toBe("u3@x.test");
    expect((await contactBy(tenantA, "u1"))!.properties).toMatchObject({ plan_name: "enterprise" });
    expect(await eventsOf(tenantA, "u1")).toHaveLength(2); // a changed row is a new fact
    expect((await sourceRow(id)).sync_cursor).toBe(iso(10));
  });

  run("reads several batches in one run, up to the per-run cap, and carries on next time", async () => {
    const id = await newSource({ ...CONFIG, batch_size: 10, max_batches_per_run: 2 });
    table = makeRows(25);
    const first = await syncSource(db, id, deps());
    expect(first).toMatchObject({ ok: true });
    expect(queries).toHaveLength(2);
    expect(first).toMatchObject({ read: 19, applied: 19 }); // the second batch starts at the first one's last row, which it skips
    expect((await sourceRow(id)).sync_cursor).toBe(iso(19));
    const second = await syncSource(db, id, deps());
    expect(second!.ok).toBe(true);
    expect((await one(sql`SELECT count(*)::int AS n FROM contacts WHERE tenant_id = ${tenantA}`))[0]!.n).toBe(25);
    expect((await sourceRow(id)).sync_cursor).toBe(iso(25));
  });

  run("says so when more rows than a batch share one position value", async () => {
    const id = await newSource({ ...CONFIG, batch_size: 10 });
    table = makeRows(12).map((r) => ({ ...r, updated_at: iso(5) }));
    const out = await syncSource(db, id, deps());
    // first batch moves from the beginning to iso(5); the second finds it cannot move
    expect(out).toMatchObject({ ok: false });
    expect(out!.note).toMatch(/share the same updated_at value/);
    expect((await sourceRow(id)).last_sync_status).toBe("error");
  });

  run("skips rows it cannot place, and says why", async () => {
    const id = await newSource();
    table = [...makeRows(2), { id: null, email: null, plan: "x", updated_at: iso(9) }];
    const out = await syncSource(db, id, deps());
    expect(out).toMatchObject({ ok: true, read: 3, applied: 2, skipped: 1 });
    expect(out!.note).toBe("Read 3 rows: 2 recorded, 1 skipped (1 no user id or email in this row).");
  });

  run("names a missing column and does not move on", async () => {
    const id = await newSource({ ...CONFIG, trait_columns: { x: "absent_col" } });
    table = makeRows(2);
    const out = await syncSource(db, id, deps());
    expect(out!.ok).toBe(false);
    expect(out!.note).toContain("absent_col");
    expect(out!.note).toContain("id, email, plan, updated_at");
    expect((await sourceRow(id)).sync_cursor).toBeNull();
    expect((await one(sql`SELECT 1 FROM contacts WHERE tenant_id = ${tenantA}`)).length).toBe(0);
  });

  run("a warehouse failure leaves the position alone and is tried again within 15 minutes", async () => {
    const id = await newSource();
    table = makeRows(2);
    await syncSource(db, id, deps());
    const cursor = (await sourceRow(id)).sync_cursor;
    failWith = new WarehouseError("Could not reach Snowflake.", true);
    const t0 = new Date();
    const out = await syncSource(db, id, deps(() => t0));
    expect(out).toMatchObject({ ok: false, note: "Could not reach Snowflake." });
    const row = await sourceRow(id);
    expect(row).toMatchObject({ sync_cursor: cursor, last_sync_status: "error", last_sync_note: "Could not reach Snowflake.", sync_lease_until: null });
    expect(new Date(row.next_sync_at).getTime()).toBe(t0.getTime() + 15 * 60_000);
    expect((await logOf(id)).at(-1)).toMatchObject({ status: "error", summary: "Could not reach Snowflake." });
    // and it works again once the warehouse does
    failWith = null;
    expect((await syncSource(db, id, deps()))!.ok).toBe(true);
  });

  run("does not leak unexpected errors to the customer", async () => {
    const id = await newSource();
    failWith = new Error("connect ECONNREFUSED 10.1.2.3:5432 internal detail");
    const out = await syncSource(db, id, deps());
    expect(out!.ok).toBe(false);
    expect(out!.note).not.toContain("10.1.2.3");
  });

  run("a row with an invalid email address is still recorded, without the email", async () => {
    const id = await newSource();
    table = makeRows(6);
    table[3] = { ...table[3]!, email: "x".repeat(400) };
    const out = await syncSource(db, id, deps());
    expect(out).toMatchObject({ ok: true, read: 6, applied: 6 });
    expect((await contactBy(tenantA, "u4"))!.email).toBeNull();
  });

  run("only one run at a time per source, and a crashed run's hold expires", async () => {
    const id = await newSource();
    table = makeRows(2);
    await db.execute(sql`UPDATE inbound_sources SET sync_lease_until = now() + interval '5 minutes' WHERE id = ${id}`);
    expect(await syncSource(db, id, deps())).toBeNull();
    expect((await api("POST", `/v1/warehouse-sources/${id}/sync`, cookieA)).status).toBe(409);
    expect(queries).toHaveLength(0);
    await db.execute(sql`UPDATE inbound_sources SET sync_lease_until = now() - interval '1 minute' WHERE id = ${id}`);
    expect((await syncSource(db, id, deps()))!.ok).toBe(true);
    // two at once: exactly one wins
    await db.execute(sql`UPDATE inbound_sources SET sync_lease_until = NULL WHERE id = ${id}`);
    const both = await Promise.all([syncSource(db, id, deps()), syncSource(db, id, deps())]);
    expect(both.filter((x) => x !== null)).toHaveLength(1);
  });

  run("Sync now runs a source that is disabled or not yet due, and returns the result", async () => {
    const id = await newSource();
    await api("PATCH", `/v1/warehouse-sources/${id}`, cookieA, { enabled: false });
    table = makeRows(2);
    const r = await api("POST", `/v1/warehouse-sources/${id}/sync`, cookieA);
    expect(r.status).toBe(200);
    expect(r.body.outcome).toMatchObject({ ok: true, applied: 2 });
    expect(r.body.source.sync).toMatchObject({ status: "ok", cursor: iso(2), running: false });
  });

  run("a credential that cannot be read is reported, not thrown", async () => {
    const id = await newSource();
    await db.execute(sql`UPDATE inbound_sources SET secret_sealed = NULL WHERE id = ${id}`);
    const out = await syncSource(db, id, deps());
    expect(out).toMatchObject({ ok: false, note: "This source has no credential saved." });
    await db.execute(sql`UPDATE inbound_sources SET config = '{"warehouse":"nope"}'::jsonb WHERE id = ${id}`);
    expect((await syncSource(db, id, deps()))!.note).toMatch(/settings are not valid/);
  });
});

describe("what is due", () => {
  run("picks enabled, due, unleased sources in running workspaces, and sets the next time", async () => {
    const due = await newSource(CONFIG, cookieA, "due");
    const off = await newSource(CONFIG, cookieA, "off");
    const leased = await newSource(CONFIG, cookieA, "leased");
    const later = await newSource(CONFIG, cookieA, "later");
    const other = await newSource(CONFIG, cookieB, "suspended");
    await db.execute(sql`UPDATE inbound_sources SET enabled = false WHERE id = ${off}`);
    await db.execute(sql`UPDATE inbound_sources SET sync_lease_until = now() + interval '5 minutes' WHERE id = ${leased}`);
    await db.execute(sql`UPDATE inbound_sources SET next_sync_at = now() + interval '1 hour' WHERE id = ${later}`);
    await db.execute(sql`UPDATE tenants SET suspended_at = now() WHERE id = ${tenantB}`);
    expect(await dueSources(db, new Date())).toEqual([due]);
    // once the hour has passed, "later" is due too
    const inTwoHours = await dueSources(db, new Date(Date.now() + 2 * 3600_000));
    expect(inTwoHours).toContain(later);
    expect(inTwoHours).not.toContain(off);
    expect(inTwoHours).not.toContain(other);
    table = makeRows(2);
    expect(await syncDueSources(db, deps())).toBe(1);
    expect((await sourceRow(due)).last_sync_status).toBe("ok");
    expect(await dueSources(db, new Date())).toEqual([]); // just ran: not due again
    expect((await sourceRow(other)).last_sync_status).toBeNull();
    expect((await sourceRow(off)).last_sync_status).toBeNull();
  });

  run("a source that is erroring does not block the others", async () => {
    const bad = await newSource({ ...CONFIG, trait_columns: { x: "absent_col" } }, cookieA, "bad");
    const good = await newSource(CONFIG, cookieA, "good");
    table = makeRows(2);
    expect(await syncDueSources(db, deps())).toBe(2);
    expect((await sourceRow(bad)).last_sync_status).toBe("error");
    expect((await sourceRow(good)).last_sync_status).toBe("ok");
  });
});

// --- The real Postgres connector, end to end ---------------------------------------------------------------------------

describe("end to end with a real Postgres", () => {
  const url = new URL(DB_URL);
  const REAL = {
    warehouse: "postgres",
    host: url.hostname,
    port: Number(url.port || 5432),
    database: url.pathname.slice(1),
    user: decodeURIComponent(url.username),
    ssl_mode: "disable",
    query: "SELECT id::text AS id, email, plan, seats, updated_at FROM wh_e2e_users WHERE updated_at >= :cursor::timestamptz",
    cursor_column: "updated_at",
    user_id_column: "id",
    email_column: "email",
    event_name: "crm_user_updated",
    trait_columns: { plan_name: "plan", seats: "seats" },
    batch_size: 10,
    max_batches_per_run: 5,
  };
  const REAL_SECRET = { password: decodeURIComponent(url.password) };

  run("syncs a real table in batches, then picks up a change", async () => {
    await pool.query("DROP TABLE IF EXISTS wh_e2e_users");
    await pool.query("CREATE TABLE wh_e2e_users (id int, email text, plan text, seats int, updated_at timestamptz)");
    await pool.query("INSERT INTO wh_e2e_users SELECT g, 'e2e' || g || '@x.test', 'pro', g, timestamptz '2026-03-01 00:00:00+00' + (g || ' seconds')::interval FROM generate_series(1, 25) g");
    try {
      const created = await api("POST", "/v1/warehouse-sources", cookieA, { name: "real", config: REAL, secret: REAL_SECRET }, "real");
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const id = created.body.source.id as string;

      const test = await api("POST", "/v1/warehouse-sources/test", cookieA, { id }, "real");
      expect(test.body.ok, JSON.stringify(test.body)).toBe(true);
      expect(test.body.rows).toHaveLength(5);
      expect(test.body.rows[0].result).toMatchObject({ ok: true, person: "1", event: "crm_user_updated", traits: { plan_name: "pro", seats: 1 } });

      const run1 = await api("POST", `/v1/warehouse-sources/${id}/sync`, cookieA, undefined, "real");
      expect(run1.body.outcome, JSON.stringify(run1.body)).toMatchObject({ ok: true, applied: 25 });
      expect((await contactBy(tenantA, "7"))).toMatchObject({ email: "e2e7@x.test" });
      expect((await contactBy(tenantA, "7"))!.properties).toMatchObject({ plan_name: "pro", seats: 7 });
      expect((await sourceRow(id)).sync_cursor).toBe("2026-03-01T00:00:25.000Z");

      await pool.query("UPDATE wh_e2e_users SET plan = 'enterprise', seats = 50, updated_at = timestamptz '2026-03-02 00:00:00+00' WHERE id = 7");
      const run2 = await api("POST", `/v1/warehouse-sources/${id}/sync`, cookieA, undefined, "real");
      expect(run2.body.outcome.ok).toBe(true);
      expect((await contactBy(tenantA, "7"))!.properties).toMatchObject({ plan_name: "enterprise", seats: 50 });
      expect(await eventsOf(tenantA, "7")).toHaveLength(2);
      expect(await eventsOf(tenantA, "8")).toHaveLength(1);
      expect((await sourceRow(id)).sync_cursor).toBe("2026-03-02T00:00:00.000Z");
    } finally {
      await pool.query("DROP TABLE IF EXISTS wh_e2e_users");
    }
  });

  run("a wrong password is a clear failure, not a crash", async () => {
    const created = await api("POST", "/v1/warehouse-sources", cookieA, { name: "wrongpw", config: REAL, secret: { password: "not-the-password" } }, "real");
    const id = created.body.source.id as string;
    const r = await api("POST", `/v1/warehouse-sources/${id}/sync`, cookieA, undefined, "real");
    expect(r.status).toBe(200);
    expect(r.body.outcome.ok).toBe(false);
    expect(r.body.outcome.note).toMatch(/Could not connect/);
    expect(JSON.stringify(r.body)).not.toContain("not-the-password");
  });
});
