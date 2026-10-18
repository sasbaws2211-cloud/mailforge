/**
 * The whole path for a database behind an SSH tunnel: save a source over HTTP, press "Test", run a sync, check the contacts
 * and events that arrive, change a row, sync again, and check the failures a person can cause (wrong host key, wrong
 * password, missing key). The connectors are the real ones, the databases are real, and the bastion is a real SSH server
 * (the in-process one the adapter tests use) that only knows the private names below.
 *
 * Needs: DATABASE_URL (the app's Postgres; it also plays the customer's Postgres), and optionally
 *   MYSQL_TEST_URL  mysql://user:pass@host:port/db
 *   MSSQL_TEST_URL  mssql://sa:pass@host:port/db
 * Each database's tests are skipped when its variable is missing.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import mysql from "mysql2/promise";
import mssql from "mssql";
import { sql } from "drizzle-orm";
import { buildApp } from "../src/index.js";
import { tenants, users, sessions } from "@loomail/db/schema";
import { clientKey, HOST_FP, otherHostKey, fpOf, startBastion, type Bastion } from "../../adapters/tests/helpers/ssh-bastion.js";

process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");
const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) throw new Error("[warehouse-tunnel.test] DATABASE_URL is not set.");
const MYSQL_URL = process.env.MYSQL_TEST_URL ? new URL(process.env.MYSQL_TEST_URL) : null;
const MSSQL_URL = process.env.MSSQL_TEST_URL ? new URL(process.env.MSSQL_TEST_URL) : null;
const PG_URL = new URL(DB_URL);

const SLUG = "test-wh-tunnel";
let pool: pg.Pool;
let db: ReturnType<typeof drizzle>;
let app: Awaited<ReturnType<typeof buildApp>>;
let tenant = "";
let cookie = "";
let bastion: Bastion;

const api = async (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) => {
  const res = await app.inject({
    method,
    url,
    headers: { cookie, ...(payload !== undefined ? { "content-type": "application/json" } : {}) },
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
  return { status: res.statusCode, body: res.json() as any };
};
const one = async (query: ReturnType<typeof sql>) => (await db.execute(query)).rows as Array<Record<string, any>>;
const contactBy = async (externalId: string) => (await one(sql`SELECT external_id, email, properties FROM contacts WHERE tenant_id = ${tenant} AND external_id = ${externalId}`))[0];
const eventsOf = async (externalId: string) =>
  one(sql`SELECT e.event_name FROM events e JOIN contacts c ON c.id = e.contact_id WHERE e.tenant_id = ${tenant} AND c.external_id = ${externalId} AND e.type = 'track'`);
const sourceRow = async (id: string) => (await one(sql`SELECT * FROM inbound_sources WHERE id = ${id}`))[0]!;
const contactCount = async () => Number((await one(sql`SELECT count(*)::int AS n FROM contacts WHERE tenant_id = ${tenant}`))[0]!.n);

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: DB_URL, connectionTimeoutMillis: 3000 });
  db = drizzle(pool);
  const t = sql`(SELECT id FROM tenants WHERE slug = ${SLUG})`;
  for (const table of ["inbound_source_log", "inbound_sources", "contact_conflicts", "lifecycle_transitions", "events", "contacts", "sessions", "users"]) {
    await db.execute(sql`DELETE FROM ${sql.raw(table)} WHERE tenant_id IN ${t}`);
  }
  await db.execute(sql`DELETE FROM tenants WHERE slug = ${SLUG}`);
  const [tn] = await db.insert(tenants).values({ name: SLUG, slug: SLUG, plan: "free", warehouseAccess: true }).returning({ id: tenants.id });
  const [u] = await db.insert(users).values({ tenantId: tn!.id, email: `owner@${SLUG}.test`, role: "owner" }).returning({ id: users.id });
  const [s] = await db.insert(sessions).values({ tenantId: tn!.id, userId: u!.id, expiresAt: new Date(Date.now() + 86400_000) }).returning({ id: sessions.id });
  tenant = tn!.id;
  cookie = `loomail_session=${s!.id}`;
  bastion = await startBastion({ allow: [clientKey.public] });
  bastion.routes.set("private-pg.corp.internal:5432", { host: PG_URL.hostname, port: Number(PG_URL.port || 5432) });
  if (MYSQL_URL) bastion.routes.set("private-mysql.corp.internal:3306", { host: MYSQL_URL.hostname, port: Number(MYSQL_URL.port || 3306) });
  if (MSSQL_URL) bastion.routes.set("private-mssql.corp.internal:1433", { host: MSSQL_URL.hostname, port: Number(MSSQL_URL.port || 1433) });
  app = await buildApp({ db, logger: false, warehouseLimitsPerMinute: { test: 1000, sync: 1000 } });
  await app.ready();
});

afterAll(async () => {
  await bastion?.stop();
  await app?.close();
  await pool?.end();
});

const tunnel = (over: Record<string, unknown> = {}) => ({ host: "127.0.0.1", port: bastion.port, user: "tunnel", host_fingerprint: HOST_FP, ...over });
const MAPPING = {
  cursor_column: "updated_at",
  user_id_column: "id",
  email_column: "email",
  event_name: "crm_user_updated",
  trait_columns: { plan_name: "plan", seats: "seats" },
  batch_size: 10,
  max_batches_per_run: 5,
};
const dec = (s: string) => decodeURIComponent(s);

interface Flavour {
  name: string;
  enabled: boolean;
  /** Source settings (without the tunnel) and credential. */
  config(): Record<string, unknown>;
  secret(): Record<string, unknown>;
  /** Make a 25-row table (ids 1..25, one second apart from 2026-03-01 00:00:00 UTC), and change row 7. */
  create(): Promise<void>;
  changeRow7(): Promise<void>;
  drop(): Promise<void>;
}

const flavours: Flavour[] = [
  {
    name: "Postgres",
    enabled: true,
    config: () => ({
      warehouse: "postgres",
      host: "private-pg.corp.internal",
      port: 5432,
      database: PG_URL.pathname.slice(1),
      user: dec(PG_URL.username),
      ssl_mode: "disable",
      query: "SELECT id::text AS id, email, plan, seats, updated_at FROM wh_tun_users WHERE updated_at >= :cursor::timestamptz",
      ...MAPPING,
    }),
    secret: () => ({ password: dec(PG_URL.password) }),
    create: async () => {
      await pool.query("DROP TABLE IF EXISTS wh_tun_users");
      await pool.query("CREATE TABLE wh_tun_users (id int, email text, plan text, seats int, updated_at timestamptz)");
      await pool.query("INSERT INTO wh_tun_users SELECT g, 'tun' || g || '@x.test', 'pro', g, timestamptz '2026-03-01 00:00:00+00' + (g || ' seconds')::interval FROM generate_series(1, 25) g");
    },
    changeRow7: async () => void (await pool.query("UPDATE wh_tun_users SET plan = 'enterprise', seats = 50, updated_at = timestamptz '2026-03-02 00:00:00+00' WHERE id = 7")),
    drop: async () => void (await pool.query("DROP TABLE IF EXISTS wh_tun_users")),
  },
  {
    name: "MySQL",
    enabled: !!MYSQL_URL,
    config: () => ({
      warehouse: "mysql",
      host: "private-mysql.corp.internal",
      port: 3306,
      database: dec(MYSQL_URL!.pathname.slice(1)),
      user: dec(MYSQL_URL!.username),
      ssl_mode: "disable",
      query: "SELECT CAST(id AS CHAR) AS id, email, plan, seats, updated_at FROM wh_tun_users WHERE updated_at >= CAST(:cursor AS DATETIME)",
      ...MAPPING,
    }),
    secret: () => ({ password: dec(MYSQL_URL!.password) }),
    create: async () => {
      const c = await mysql.createConnection({ host: MYSQL_URL!.hostname, port: Number(MYSQL_URL!.port || 3306), user: dec(MYSQL_URL!.username), password: dec(MYSQL_URL!.password), database: dec(MYSQL_URL!.pathname.slice(1)) });
      await c.query("DROP TABLE IF EXISTS wh_tun_users");
      await c.query("CREATE TABLE wh_tun_users (id int, email varchar(100), plan varchar(20), seats int, updated_at datetime)");
      for (let g = 1; g <= 25; g++) await c.query("INSERT INTO wh_tun_users VALUES (?,?,?,?, TIMESTAMPADD(SECOND, ?, '2026-03-01 00:00:00'))", [g, `tun${g}@x.test`, "pro", g, g]);
      await c.end();
    },
    changeRow7: async () => {
      const c = await mysql.createConnection({ host: MYSQL_URL!.hostname, port: Number(MYSQL_URL!.port || 3306), user: dec(MYSQL_URL!.username), password: dec(MYSQL_URL!.password), database: dec(MYSQL_URL!.pathname.slice(1)) });
      await c.query("UPDATE wh_tun_users SET plan = 'enterprise', seats = 50, updated_at = '2026-03-02 00:00:00' WHERE id = 7");
      await c.end();
    },
    drop: async () => {
      const c = await mysql.createConnection({ host: MYSQL_URL!.hostname, port: Number(MYSQL_URL!.port || 3306), user: dec(MYSQL_URL!.username), password: dec(MYSQL_URL!.password), database: dec(MYSQL_URL!.pathname.slice(1)) });
      await c.query("DROP TABLE IF EXISTS wh_tun_users");
      await c.end();
    },
  },
  {
    name: "SQL Server",
    enabled: !!MSSQL_URL,
    config: () => ({
      warehouse: "mssql",
      host: "private-mssql.corp.internal",
      port: 1433,
      database: dec(MSSQL_URL!.pathname.slice(1)) || "master",
      user: dec(MSSQL_URL!.username),
      ssl_mode: "no-verify",
      query: "SELECT CAST(id AS NVARCHAR(20)) AS id, email, [plan], seats, updated_at FROM dbo.wh_tun_users WHERE updated_at >= CAST(:cursor AS DATETIME2)",
      ...MAPPING,
    }),
    secret: () => ({ password: dec(MSSQL_URL!.password) }),
    create: async () => {
      const p = await admin();
      await p.request().batch("IF OBJECT_ID('dbo.wh_tun_users') IS NOT NULL DROP TABLE dbo.wh_tun_users");
      await p.request().batch("CREATE TABLE dbo.wh_tun_users (id int, email nvarchar(100), [plan] nvarchar(20), seats int, updated_at datetime2)");
      await p.request().batch("INSERT INTO dbo.wh_tun_users SELECT n, 'tun' + CAST(n AS varchar(5)) + '@x.test', 'pro', n, DATEADD(SECOND, n, '2026-03-01T00:00:00') FROM (SELECT TOP 25 ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS n FROM sys.all_objects) t");
      await p.close();
    },
    changeRow7: async () => {
      const p = await admin();
      await p.request().batch("UPDATE dbo.wh_tun_users SET [plan] = 'enterprise', seats = 50, updated_at = '2026-03-02T00:00:00' WHERE id = 7");
      await p.close();
    },
    drop: async () => {
      const p = await admin();
      await p.request().batch("IF OBJECT_ID('dbo.wh_tun_users') IS NOT NULL DROP TABLE dbo.wh_tun_users");
      await p.close();
    },
  },
];
const admin = () =>
  new mssql.ConnectionPool({ server: MSSQL_URL!.hostname, port: Number(MSSQL_URL!.port || 1433), user: dec(MSSQL_URL!.username), password: dec(MSSQL_URL!.password), database: dec(MSSQL_URL!.pathname.slice(1)) || "master", options: { encrypt: true, trustServerCertificate: true } }).connect();

for (const f of flavours) {
  (f.enabled ? describe : describe.skip)(`${f.name} behind an SSH tunnel, start to finish`, () => {
    const SECRET = () => ({ ...f.secret(), ssh_private_key: clientKey.private });

    beforeAll(async () => {
      await f.create();
    });
    afterAll(async () => {
      await f.drop();
      // The workspace holds at most 5 sources; leave room for the next database.
      await db.execute(sql`DELETE FROM inbound_source_log WHERE tenant_id = ${tenant}`);
      await db.execute(sql`DELETE FROM inbound_sources WHERE tenant_id = ${tenant}`);
      // Every database uses the same person ids; start the next one with nobody.
      for (const table of ["contact_conflicts", "lifecycle_transitions", "events", "contacts"]) {
        await db.execute(sql`DELETE FROM ${sql.raw(table)} WHERE tenant_id = ${tenant}`);
      }
    });

    it("saves a source, tests the query, syncs a table in batches, then picks up a change", async () => {
      const created = await api("POST", "/v1/warehouse-sources", { name: `${f.name} behind a tunnel`, config: { ...f.config(), ssh_tunnel: tunnel() }, secret: SECRET() });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const id = created.body.source.id as string;
      // Nothing secret comes back: not the password, not the SSH key.
      expect(JSON.stringify(created.body)).not.toContain("PRIVATE KEY");
      expect(JSON.stringify(created.body)).not.toContain(f.secret().password as string);
      expect(created.body.source.config.ssh_tunnel).toMatchObject({ host: "127.0.0.1", user: "tunnel", host_fingerprint: HOST_FP });

      const before = bastion.forwards.length;
      const test = await api("POST", "/v1/warehouse-sources/test", { id });
      expect(test.body.ok, JSON.stringify(test.body)).toBe(true);
      expect(test.body.rows).toHaveLength(5);
      expect(test.body.rows[0].result).toMatchObject({ ok: true, person: "1", event: "crm_user_updated", traits: { plan_name: "pro", seats: 1 } });
      expect(bastion.forwards.length).toBeGreaterThan(before); // it really went through the bastion

      const contactsBefore = await contactCount();
      const run1 = await api("POST", `/v1/warehouse-sources/${id}/sync`);
      expect(run1.body.outcome, JSON.stringify(run1.body)).toMatchObject({ ok: true, applied: 25 });
      expect(await contactCount()).toBe(contactsBefore + 25);
      expect(await contactBy("7")).toMatchObject({ email: "tun7@x.test" });
      expect((await contactBy("7"))!.properties).toMatchObject({ plan_name: "pro", seats: 7 });
      expect((await sourceRow(id)).sync_cursor).toBe("2026-03-01T00:00:25.000Z");
      expect((await sourceRow(id)).last_sync_status).toBe("ok");

      // Nothing changed: nothing is recorded twice.
      const again = await api("POST", `/v1/warehouse-sources/${id}/sync`);
      expect(again.body.outcome.ok).toBe(true);
      expect(await eventsOf("7")).toHaveLength(1);

      await f.changeRow7();
      const run2 = await api("POST", `/v1/warehouse-sources/${id}/sync`);
      expect(run2.body.outcome.ok, JSON.stringify(run2.body)).toBe(true);
      expect((await contactBy("7"))!.properties).toMatchObject({ plan_name: "enterprise", seats: 50 });
      expect(await eventsOf("7")).toHaveLength(2);
      expect(await eventsOf("8")).toHaveLength(1);
      expect((await sourceRow(id)).sync_cursor).toBe("2026-03-02T00:00:00.000Z");
    });

    it("a host key that is not the pinned one fails the sync with a plain message, and leaves the position alone", async () => {
      const created = await api("POST", "/v1/warehouse-sources", { name: "wrong host key", config: { ...f.config(), ssh_tunnel: tunnel({ host_fingerprint: fpOf(otherHostKey.public) }) }, secret: SECRET() });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const id = created.body.source.id as string;
      const r = await api("POST", `/v1/warehouse-sources/${id}/sync`);
      expect(r.body.outcome.ok).toBe(false);
      expect(r.body.outcome.note).toMatch(/not the one you pinned/);
      expect((await sourceRow(id)).sync_cursor ?? null).toBeNull();
      expect(JSON.stringify(r.body)).not.toContain("PRIVATE KEY");
    });

    it("a wrong database password is a database error, not an SSH one", async () => {
      const created = await api("POST", "/v1/warehouse-sources", { name: "wrong password", config: { ...f.config(), ssh_tunnel: tunnel() }, secret: { ...SECRET(), password: "not-the-password" } });
      const id = created.body.source.id as string;
      const r = await api("POST", `/v1/warehouse-sources/${id}/sync`);
      expect(r.body.outcome.ok).toBe(false);
      expect(r.body.outcome.note).toMatch(/Could not connect to the database/);
      expect(JSON.stringify(r.body)).not.toContain("not-the-password");
    });

    it("refuses to save a tunnel without its key, and keeps the saved key when only the password changes", async () => {
      const noKey = await api("POST", "/v1/warehouse-sources", { name: "no key", config: { ...f.config(), ssh_tunnel: tunnel() }, secret: f.secret() });
      expect(noKey.status).toBe(400);
      expect(JSON.stringify(noKey.body)).toMatch(/private key/i);

      const created = await api("POST", "/v1/warehouse-sources", { name: "keeps key", config: { ...f.config(), ssh_tunnel: tunnel() }, secret: SECRET() });
      const id = created.body.source.id as string;
      const patched = await api("PATCH", `/v1/warehouse-sources/${id}`, { secret: { password: f.secret().password } });
      expect(patched.status, JSON.stringify(patched.body)).toBe(200);
      const test = await api("POST", "/v1/warehouse-sources/test", { id });
      expect(test.body.ok, JSON.stringify(test.body)).toBe(true);
    });

    it("turning the tunnel off removes the saved key and the source then connects directly (and is refused here only because the private name does not resolve)", async () => {
      const created = await api("POST", "/v1/warehouse-sources", { name: "tunnel off later", config: { ...f.config(), ssh_tunnel: tunnel() }, secret: SECRET() });
      const id = created.body.source.id as string;
      const patched = await api("PATCH", `/v1/warehouse-sources/${id}`, { config: f.config() });
      expect(patched.status, JSON.stringify(patched.body)).toBe(200);
      expect(patched.body.source.config.ssh_tunnel).toBeUndefined();
      const r = await api("POST", `/v1/warehouse-sources/${id}/sync`);
      expect(r.body.outcome.ok).toBe(false); // private-*.corp.internal is only known to the bastion
    });
  });
}
