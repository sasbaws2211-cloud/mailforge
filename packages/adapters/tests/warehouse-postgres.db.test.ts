/** The Postgres connector against a real database. Skipped when no test database is reachable. */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { createPostgresClient } from "../src/warehouse/postgres.js";
import { WarehouseError } from "../src/warehouse/types.js";

const url = process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL) : null;
const run = url ? describe : describe.skip;

run("Postgres connector", () => {
  const cfg = url
    ? { host: url.hostname, port: Number(url.port || 5432), database: url.pathname.slice(1), user: decodeURIComponent(url.username), ssl_mode: "disable" as const }
    : (null as never);
  const secret = { password: url ? decodeURIComponent(url.password) : "" };
  const policy = { restrict: false, allowedHosts: [] };
  const admin = url ? new pg.Pool({ connectionString: process.env.DATABASE_URL }) : (null as never);
  const client = () => createPostgresClient(cfg, secret, { policy });
  const q = { sql: "SELECT id, email, plan, seats, active, score, joined, meta, updated_at FROM wh_pg_users WHERE updated_at >= :cursor::timestamptz", cursor: "1970-01-01T00:00:00.000Z", cursorColumn: "updated_at", maxRows: 100, timeoutMs: 10_000 };

  beforeAll(async () => {
    await admin.query("DROP TABLE IF EXISTS wh_pg_users");
    await admin.query("CREATE TABLE wh_pg_users (id bigint, email text, plan text, seats int, active boolean, score numeric, joined date, meta jsonb, updated_at timestamptz)");
    await admin.query(`INSERT INTO wh_pg_users VALUES
      (1,'a@x.com','pro',5,true,9.5,'2026-01-02','{"k":1}','2026-01-01T00:00:00Z'),
      (2,'b@x.com',NULL,1,false,NULL,NULL,NULL,'2026-01-02T00:00:00Z'),
      (3,'c@x.com','free',2,true,1,'2026-02-01',NULL,'2026-01-03T00:00:00Z')`);
  });
  afterAll(async () => {
    await admin.query("DROP TABLE IF EXISTS wh_pg_users");
    await admin.end();
  });

  it("returns typed rows in cursor order, with lower-case names and ISO timestamps", async () => {
    const out = await client().query(q);
    expect(out.columns).toEqual(["id", "email", "plan", "seats", "active", "score", "joined", "meta", "updated_at"]);
    expect(out.rows.map((r) => r.id)).toEqual([1, 2, 3]);
    expect(out.rows[0]).toMatchObject({ email: "a@x.com", seats: 5, active: true, score: 9.5, meta: "{\"k\":1}", updated_at: "2026-01-01T00:00:00.000Z" });
    expect(typeof out.rows[0]!.joined).toBe("string");
    expect(out.rows[1]).toMatchObject({ plan: null, score: null, meta: null });
  });

  it("applies the cursor as a bound value and the row cap", async () => {
    const after = await client().query({ ...q, cursor: "2026-01-02T00:00:00.000Z" });
    expect(after.rows.map((r) => r.id)).toEqual([2, 3]);
    const capped = await client().query({ ...q, maxRows: 2 });
    expect(capped.rows.map((r) => r.id)).toEqual([1, 2]);
    // a cursor that tries to break out is only ever a value
    await expect(client().query({ ...q, cursor: "x'; DROP TABLE wh_pg_users; --" })).rejects.toThrow(/query failed/);
    expect((await admin.query("SELECT count(*)::int AS n FROM wh_pg_users")).rows[0].n).toBe(3);
  });

  it("cannot write, even if the query is dressed up as a read", async () => {
    // Postgres itself refuses a data-modifying WITH inside the wrapper, and the READ ONLY transaction would refuse the rest.
    const sneaky = { ...q, sql: "WITH d AS (DELETE FROM wh_pg_users RETURNING id, email, plan, seats, active, score, joined, meta, updated_at) SELECT * FROM d" };
    await expect(client().query(sneaky)).rejects.toThrow(/query failed/);
    expect((await admin.query("SELECT count(*)::int AS n FROM wh_pg_users")).rows[0].n).toBe(3);
  });

  it("runs inside a read-only transaction", async () => {
    await admin.query("CREATE OR REPLACE FUNCTION wh_pg_sneaky() RETURNS timestamptz LANGUAGE sql VOLATILE AS $$ INSERT INTO wh_pg_users(id) VALUES (99) RETURNING now() $$");
    await expect(client().query({ ...q, sql: "SELECT wh_pg_sneaky() AS updated_at" })).rejects.toThrow(/read-only transaction/);
    expect((await admin.query("SELECT count(*)::int AS n FROM wh_pg_users")).rows[0].n).toBe(3);
    await admin.query("DROP FUNCTION wh_pg_sneaky()");
  });

  it("enforces the time limit", async () => {
    await expect(client().query({ ...q, sql: "SELECT pg_sleep(3), now() AS updated_at", timeoutMs: 500 })).rejects.toThrow(/timeout/i);
  });

  it("refuses non-reads before connecting, and a restricted host", async () => {
    await expect(client().query({ ...q, sql: "DROP TABLE wh_pg_users" })).rejects.toThrow(/SELECT or WITH/);
    const hosted = createPostgresClient({ ...cfg, host: "127.0.0.1" }, secret, { policy: { restrict: true, allowedHosts: [] } });
    await expect(hosted.query(q)).rejects.toThrow(/not allowed/);
  });

  it("says plainly when it cannot connect, and that it is worth retrying", async () => {
    const err = await createPostgresClient({ ...cfg, port: 1 }, secret, { policy }).query(q).catch((e) => e);
    expect(err).toBeInstanceOf(WarehouseError);
    expect(err.message).toMatch(/Could not connect/);
    expect(err.retryable).toBe(true);
    const bad = await createPostgresClient(cfg, { password: "wrong" }, { policy }).query(q).catch((e) => e);
    expect(bad.message).toMatch(/Could not connect/);
  });
});
