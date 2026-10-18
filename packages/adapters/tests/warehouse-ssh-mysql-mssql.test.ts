/**
 * MySQL and SQL Server through an SSH tunnel, against real servers.
 *
 * Set MYSQL_TEST_URL (mysql://user:pass@host:port/db) and/or MSSQL_TEST_URL (mssql://sa:pass@host:port/db; a login that may
 * create tables) to run these. Each suite is skipped when its variable is not set. The bastion is the in-process SSH server
 * in helpers/ssh-bastion.ts: it checks keys for real and forwards only the names a test lists, so the "private" database
 * names below can only be resolved on the far side of the tunnel.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import mysql from "mysql2/promise";
import mssql from "mssql";
import { createMysqlClient } from "../src/warehouse/mysql.js";
import { createMssqlClient } from "../src/warehouse/mssql.js";
import { WarehouseError } from "../src/warehouse/types.js";
import { HOST_FP, clientKey, startBastion, type Bastion } from "./helpers/ssh-bastion.js";

const policy = { restrict: false, allowedHosts: [] as string[] };
const ssh = (b: Bastion) => ({ host: "127.0.0.1", port: b.port, user: "tunnel", host_fingerprint: HOST_FP });
const failure = async (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as WarehouseError);
const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));

const mysqlUrl = process.env.MYSQL_TEST_URL ? new URL(process.env.MYSQL_TEST_URL) : null;
const mssqlUrl = process.env.MSSQL_TEST_URL ? new URL(process.env.MSSQL_TEST_URL) : null;

(mysqlUrl ? describe : describe.skip)("MySQL through a tunnel (a real database)", () => {
  let admin: mysql.Connection;
  let b: Bastion;
  const q = { sql: "SELECT id, email, plan, updated_at FROM wh_ssh_users WHERE updated_at >= CAST(:cursor AS DATETIME)", cursor: "1970-01-01 00:00:00", cursorColumn: "updated_at", maxRows: 100, timeoutMs: 8000 };
  const port = () => Number(mysqlUrl!.port || 3306);
  const dbName = () => decodeURIComponent(mysqlUrl!.pathname.slice(1));

  beforeAll(async () => {
    admin = await mysql.createConnection({ host: mysqlUrl!.hostname, port: port(), user: decodeURIComponent(mysqlUrl!.username), password: decodeURIComponent(mysqlUrl!.password), database: dbName() });
    await admin.query("DROP TABLE IF EXISTS wh_ssh_users");
    await admin.query("CREATE TABLE wh_ssh_users (id int, email varchar(100), plan varchar(20), score decimal(6,2), updated_at datetime)");
    await admin.query("INSERT INTO wh_ssh_users VALUES (1,'a@x.test','pro',9.50,'2026-01-01 00:00:00'),(2,'b@x.test','free',NULL,'2026-01-02 00:00:00')");
    b = await startBastion({ allow: [clientKey.public] });
    b.routes.set("private-mysql.corp.internal:3306", { host: mysqlUrl!.hostname, port: port() });
  });
  afterAll(async () => {
    await admin.query("DROP TABLE IF EXISTS wh_ssh_users");
    await admin.end();
    await b.stop();
  });

  const client = (over: Record<string, unknown> = {}, secretOver: Record<string, unknown> = {}) =>
    createMysqlClient(
      { host: "private-mysql.corp.internal", port: 3306, database: dbName(), user: decodeURIComponent(mysqlUrl!.username), ssl_mode: "disable", ssh: ssh(b), ...over } as never,
      { password: decodeURIComponent(mysqlUrl!.password), ssh_private_key: clientKey.private, ...secretOver },
      { policy },
    );

  it("runs a real query to a database whose name only the SSH server can resolve", async () => {
    const out = await client().query(q);
    expect(out.columns).toEqual(["id", "email", "plan", "updated_at"]);
    expect(out.rows.map((r) => r.id)).toEqual([1, 2]);
    expect(out.rows[0]).toMatchObject({ email: "a@x.test", plan: "pro", updated_at: "2026-01-01T00:00:00.000Z" });
    expect(b.forwards).toContain("private-mysql.corp.internal:3306");
  });

  it("returns decimals as numbers and NULL as null, and binds :cursor as a value", async () => {
    const out = await client().query({ ...q, sql: "SELECT id, score, updated_at FROM wh_ssh_users WHERE updated_at >= CAST(:cursor AS DATETIME) AND '--' <> :cursor", cursor: "2026-01-01 12:00:00" });
    expect(out.rows).toEqual([{ id: 2, score: null, updated_at: "2026-01-02T00:00:00.000Z" }]);
    const all = await client().query({ ...q, sql: "SELECT score, updated_at FROM wh_ssh_users WHERE updated_at >= CAST(:cursor AS DATETIME)" });
    expect(all.rows[0]!.score).toBe(9.5);
  });

  it("caps the rows and orders by the cursor column", async () => {
    const out = await client().query({ ...q, maxRows: 1 });
    expect(out.rows.map((r) => r.id)).toEqual([1]);
  });

  it("closes the tunnel when the query is done, and when it fails", async () => {
    await settle();
    const before = b.closed;
    await client().query(q);
    await expect(client().query({ ...q, sql: "SELECT nope FROM wh_ssh_users" })).rejects.toThrow(/query failed/);
    await settle();
    expect(b.closed).toBe(before + 2);
  });

  it("is read-only through the tunnel", async () => {
    await admin.query("DROP FUNCTION IF EXISTS wh_ssh_sneaky");
    await admin.query("SET GLOBAL log_bin_trust_function_creators = 1"); // lets a test create a writing function with binary logging on
    await admin.query("CREATE FUNCTION wh_ssh_sneaky() RETURNS int MODIFIES SQL DATA BEGIN INSERT INTO wh_ssh_users(id) VALUES (99); RETURN 1; END");
    const e = await failure(client().query({ ...q, sql: "SELECT wh_ssh_sneaky() AS updated_at" }));
    expect(e!.message).toMatch(/read.only/i);
    await admin.query("DROP FUNCTION IF EXISTS wh_ssh_sneaky");
    const [rows] = (await admin.query("SELECT count(*) AS n FROM wh_ssh_users")) as unknown as [Array<{ n: number }>];
    expect(Number(rows[0]!.n)).toBe(2);
  });

  it("names the real problem when the database address is wrong as the SSH server sees it", async () => {
    const e = await failure(client({ host: "no-such-db.corp.internal" }).query(q));
    expect(e).toBeInstanceOf(WarehouseError);
    expect(e!.message).toMatch(/could not reach no-such-db\.corp\.internal:3306/);
  });

  it("a wrong database password is a database error, not an SSH one", async () => {
    const e = await failure(client({}, { password: "nope" }).query(q));
    expect(e!.message).toMatch(/Could not connect to the database/);
  });

  it("needs the SSH key when a tunnel is configured", async () => {
    const e = await failure(client({}, { ssh_private_key: undefined }).query(q));
    expect(e!.message).toMatch(/needs its private key/);
  });

  it("with certificate checking on, refuses a server certificate it cannot trust, through the tunnel", async () => {
    const e = await failure(client({ ssl_mode: "verify" }).query(q));
    expect(e!.message).toMatch(/Could not connect to the database/);
  });

  it("encrypted without verification works through the tunnel", async () => {
    const out = await client({ ssl_mode: "no-verify" }).query(q);
    expect(out.rows).toHaveLength(2);
  });
});

(mssqlUrl ? describe : describe.skip)("SQL Server through a tunnel (a real database)", () => {
  let admin: mssql.ConnectionPool;
  let b: Bastion;
  const q = { sql: "SELECT id, email, [plan], updated_at FROM dbo.wh_ssh_users WHERE updated_at >= CAST(:cursor AS DATETIME2)", cursor: "1970-01-01T00:00:00", cursorColumn: "updated_at", maxRows: 100, timeoutMs: 15000 };
  const host = () => mssqlUrl!.hostname;
  const port = () => Number(mssqlUrl!.port || 1433);
  const dbName = () => decodeURIComponent(mssqlUrl!.pathname.slice(1)) || "master";

  beforeAll(async () => {
    admin = await new mssql.ConnectionPool({
      server: host(),
      port: port(),
      user: decodeURIComponent(mssqlUrl!.username),
      password: decodeURIComponent(mssqlUrl!.password),
      database: dbName(),
      options: { encrypt: true, trustServerCertificate: true },
    }).connect();
    await admin.request().batch("IF OBJECT_ID('dbo.wh_ssh_users') IS NOT NULL DROP TABLE dbo.wh_ssh_users");
    await admin.request().batch("CREATE TABLE dbo.wh_ssh_users (id int, email nvarchar(100), [plan] nvarchar(20), score decimal(6,2), updated_at datetime2)");
    await admin.request().batch("INSERT INTO dbo.wh_ssh_users VALUES (1,'a@x.test','pro',9.50,'2026-01-01T00:00:00'),(2,'b@x.test','free',NULL,'2026-01-02T00:00:00')");
    b = await startBastion({ allow: [clientKey.public] });
    b.routes.set("private-mssql.corp.internal:1433", { host: host(), port: port() });
  });
  afterAll(async () => {
    await admin.request().batch("IF OBJECT_ID('dbo.wh_ssh_users') IS NOT NULL DROP TABLE dbo.wh_ssh_users");
    await admin.close();
    await b.stop();
  });

  const client = (over: Record<string, unknown> = {}, secretOver: Record<string, unknown> = {}) =>
    createMssqlClient(
      { host: "private-mssql.corp.internal", port: 1433, database: dbName(), user: decodeURIComponent(mssqlUrl!.username), ssl_mode: "no-verify", ssh: ssh(b), ...over } as never,
      { password: decodeURIComponent(mssqlUrl!.password), ssh_private_key: clientKey.private, ...secretOver },
      { policy },
    );

  it("runs a real query to a database whose name only the SSH server can resolve", async () => {
    const out = await client().query(q);
    expect(out.columns).toEqual(["id", "email", "plan", "updated_at"]);
    expect(out.rows.map((r) => r.id)).toEqual([1, 2]);
    expect(out.rows[0]).toMatchObject({ email: "a@x.test", plan: "pro", updated_at: "2026-01-01T00:00:00.000Z" });
    expect(b.forwards).toContain("private-mssql.corp.internal:1433");
  });

  it("returns decimals as numbers and NULL as null, and binds :cursor as a value", async () => {
    const out = await client().query({ ...q, sql: "SELECT id, score, updated_at FROM dbo.wh_ssh_users WHERE updated_at >= CAST(:cursor AS DATETIME2) AND '--' <> :cursor", cursor: "2026-01-01T12:00:00" });
    expect(out.rows).toEqual([{ id: 2, score: null, updated_at: "2026-01-02T00:00:00.000Z" }]);
    const all = await client().query({ ...q, sql: "SELECT score, updated_at FROM dbo.wh_ssh_users WHERE updated_at >= CAST(:cursor AS DATETIME2)" });
    expect(all.rows[0]!.score).toBe(9.5);
  });

  it("caps the rows and orders by the cursor column", async () => {
    const out = await client().query({ ...q, maxRows: 1 });
    expect(out.rows.map((r) => r.id)).toEqual([1]);
  });

  it("closes the tunnel when the query is done, and when it fails", async () => {
    await settle();
    const before = b.closed;
    await client().query(q);
    await expect(client().query({ ...q, sql: "SELECT nope FROM dbo.wh_ssh_users" })).rejects.toThrow(/query failed/);
    await settle(500);
    expect(b.closed).toBe(before + 2);
  });

  it("names the real problem when the database address is wrong as the SSH server sees it", async () => {
    const e = await failure(client({ host: "no-such-db.corp.internal" }).query(q));
    expect(e).toBeInstanceOf(WarehouseError);
    expect(e!.message).toMatch(/could not reach no-such-db\.corp\.internal:1433/);
  });

  it("a wrong database password is a database error, not an SSH one", async () => {
    const e = await failure(client({}, { password: "nope" }).query(q));
    expect(e!.message).toMatch(/Could not connect to the database/);
  });

  it("needs the SSH key when a tunnel is configured", async () => {
    const e = await failure(client({}, { ssh_private_key: undefined }).query(q));
    expect(e!.message).toMatch(/needs its private key/);
  });

  it("with certificate checking on, refuses a server certificate it cannot trust, through the tunnel", async () => {
    const e = await failure(client({ ssl_mode: "verify" }).query(q));
    expect(e!.message).toMatch(/Could not connect to the database/);
  });
});
