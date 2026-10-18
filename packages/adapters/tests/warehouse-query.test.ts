/** The customer's SELECT: what is allowed, how :cursor is rewritten, how the batch is wrapped. */
import { describe, it, expect } from "vitest";
import { checkQuery, compileQuery } from "../src/warehouse/query.js";
import { resolveWarehouseHost, warehouseHostPolicyFromEnv } from "../src/warehouse/guard.js";

describe("checkQuery", () => {
  it("accepts SELECT and WITH, with comments, parentheses and one trailing semicolon", () => {
    expect(checkQuery("select 1", "postgres").ok).toBe(true);
    expect(checkQuery("  -- note\n  SELECT id FROM t;  ", "postgres").ok).toBe(true);
    expect(checkQuery("/* hi */ WITH a AS (SELECT 1) SELECT * FROM a", "snowflake").ok).toBe(true);
    expect(checkQuery("(SELECT 1)", "bigquery").ok).toBe(true);
  });

  it("refuses anything that is not a single read", () => {
    for (const bad of ["DELETE FROM t", "update t set a=1", "DROP TABLE t", "insert into t values (1)", "", "   "]) {
      expect(checkQuery(bad, "postgres").ok, bad).toBe(false);
    }
    expect(checkQuery("SELECT 1; DROP TABLE t", "postgres").ok).toBe(false);
    expect(checkQuery("SELECT 1; SELECT 2", "snowflake").ok).toBe(false);
    expect(checkQuery("SELECT 1 /* x */ ; -- ok\n", "postgres").ok).toBe(true);
  });

  it("does not mistake text inside strings, quoted names or comments for SQL", () => {
    expect(checkQuery("SELECT 'a;b' AS x, \"c;d\" FROM t", "postgres").ok).toBe(true);
    expect(checkQuery("SELECT 'it''s; fine' FROM t", "postgres").ok).toBe(true);
    expect(checkQuery("SELECT 1 -- ; DROP TABLE t", "postgres").ok).toBe(true);
    expect(checkQuery("SELECT `a;b` FROM t", "bigquery").ok).toBe(true);
  });

  it("treats backslash as an escape in Snowflake and BigQuery strings, but not in Postgres", () => {
    // Snowflake: the quote is escaped, so the string continues and the semicolon is inside it.
    expect(checkQuery("SELECT 'a\\'; DROP TABLE t; --' FROM t", "snowflake").ok).toBe(true);
    // Postgres: the backslash is an ordinary character, the string ends at the quote, the semicolon is real.
    expect(checkQuery("SELECT 'a\\'; DROP TABLE t; --' FROM t", "postgres").ok).toBe(false);
  });

  it("refuses unclosed quotes and comments, and dollar quoting", () => {
    expect(checkQuery("SELECT 'abc", "postgres").ok).toBe(false);
    expect(checkQuery("SELECT 1 /* never closed", "postgres").ok).toBe(false);
    expect(checkQuery("SELECT $$a; DROP TABLE t$$", "postgres").ok).toBe(false);
    expect(checkQuery("SELECT $tag$x$tag$", "snowflake").ok).toBe(false);
  });

  it("refuses the warehouse's own placeholder, so :cursor is the only parameter", () => {
    expect(checkQuery("SELECT * FROM t WHERE a > $1", "postgres").ok).toBe(false);
    expect(checkQuery("SELECT * FROM t WHERE a > ?", "snowflake").ok).toBe(false);
    expect(checkQuery("SELECT * FROM t WHERE a > @cursor", "bigquery").ok).toBe(false);
    // inside a string they are just text
    expect(checkQuery("SELECT '$1 ? @x' FROM t", "postgres").ok).toBe(true);
  });
});

describe("compileQuery", () => {
  it("rewrites :cursor per warehouse and wraps the batch", () => {
    const sql = "SELECT id, updated_at FROM users WHERE updated_at >= :cursor::timestamptz";
    const pg = compileQuery(sql, "postgres", "updated_at", 100);
    expect(pg).toEqual({ ok: true, cursorCount: 1, sql: "SELECT * FROM (SELECT id, updated_at FROM users WHERE updated_at >= $1::timestamptz) AS loomail_q ORDER BY updated_at ASC LIMIT 100" });
    const sf = compileQuery("SELECT * FROM t WHERE a >= TO_TIMESTAMP_TZ(:cursor) OR b > :cursor", "snowflake", "A", 5);
    expect(sf).toMatchObject({ ok: true, cursorCount: 2 });
    expect((sf as { sql: string }).sql).toContain("a >= TO_TIMESTAMP_TZ(?) OR b > ?");
    const bq = compileQuery("SELECT * FROM `p.d.t` WHERE ts >= TIMESTAMP(:cursor);", "bigquery", "ts", 7);
    expect((bq as { sql: string }).sql).toBe("SELECT * FROM (SELECT * FROM `p.d.t` WHERE ts >= TIMESTAMP(@cursor)) AS loomail_q ORDER BY ts ASC LIMIT 7");
  });

  it("leaves :cursor alone inside strings and does not touch ::casts or longer names", () => {
    const r = compileQuery("SELECT ':cursor' AS a, x::text, :cursorish FROM t WHERE y > :cursor", "postgres", "y", 1);
    expect(r.ok).toBe(true);
    const sql = (r as { sql: string }).sql;
    expect(sql).toContain("':cursor' AS a");
    expect(sql).toContain(":cursorish");
    expect(sql).toContain("y > $1");
    expect((r as { cursorCount: number }).cursorCount).toBe(1);
  });

  it("works when the query has no :cursor at all (a full read each time)", () => {
    expect(compileQuery("SELECT 1 AS n", "postgres", "n", 10)).toMatchObject({ ok: true, cursorCount: 0 });
  });

  it("puts a newline before the closing parenthesis when the query ends in a line comment", () => {
    const r = compileQuery("SELECT a FROM t -- trailing", "postgres", "a", 3) as { sql: string };
    expect(r.sql).toBe("SELECT * FROM (SELECT a FROM t -- trailing\n) AS loomail_q ORDER BY a ASC LIMIT 3");
  });

  it("refuses a cursor column that is not a plain name, and a bad row cap", () => {
    expect(compileQuery("SELECT 1", "postgres", "a; drop table x", 5).ok).toBe(false);
    expect(compileQuery("SELECT 1", "postgres", "a b", 5).ok).toBe(false);
    expect(compileQuery("SELECT 1", "postgres", "a", 0).ok).toBe(false);
    expect(compileQuery("SELECT 1", "postgres", "a", 1.5).ok).toBe(false);
  });
});

describe("MySQL queries", () => {
  it("binds :cursor as one ? per use, and wraps with LIMIT", () => {
    const r = compileQuery("SELECT id, ts FROM t WHERE ts >= CAST(:cursor AS DATETIME) OR ts > :cursor", "mysql", "ts", 50);
    expect(r).toEqual({ ok: true, cursorCount: 2, sql: "SELECT * FROM (SELECT id, ts FROM t WHERE ts >= CAST(? AS DATETIME) OR ts > ?) AS loomail_q ORDER BY ts ASC LIMIT 50" });
  });
  it("knows backticks, backslash escapes and # comments", () => {
    expect(checkQuery("SELECT `a;b` FROM t", "mysql").ok).toBe(true);
    expect(checkQuery("SELECT 'a\\'; DROP TABLE t; --' FROM t", "mysql").ok).toBe(true); // the quote is escaped, the semicolon is text
    expect(checkQuery("SELECT 1 # ; DROP TABLE t", "mysql").ok).toBe(true);
    expect(checkQuery("SELECT 1; DROP TABLE t", "mysql").ok).toBe(false);
    expect(checkQuery("SELECT `a FROM t", "mysql").ok).toBe(false);
  });
  it("closes the wrapper after a # comment, refuses ? and the executable /*! comment", () => {
    expect((compileQuery("SELECT a FROM t # note", "mysql", "a", 3) as { sql: string }).sql).toBe("SELECT * FROM (SELECT a FROM t # note\n) AS loomail_q ORDER BY a ASC LIMIT 3");
    expect(checkQuery("SELECT * FROM t WHERE a > ?", "mysql").ok).toBe(false);
    expect(checkQuery("SELECT /*!50000 1; DROP TABLE t */ 1", "mysql").ok).toBe(false);
    expect(checkQuery("SELECT 1 /* plain */", "mysql").ok).toBe(true);
    expect(checkQuery("SELECT a$b FROM t", "mysql").ok).toBe(true); // $ is an ordinary identifier character here
  });
});

describe("SQL Server queries", () => {
  it("binds :cursor as @cursor and caps with TOP", () => {
    const r = compileQuery("SELECT id, ts FROM dbo.t WHERE ts >= CAST(:cursor AS DATETIME2);", "mssql", "ts", 25);
    expect(r).toEqual({ ok: true, cursorCount: 1, sql: "SELECT TOP (25) * FROM (SELECT id, ts FROM dbo.t WHERE ts >= CAST(@cursor AS DATETIME2)) AS loomail_q ORDER BY ts ASC" });
  });
  it("knows [bracket] names, treats backslash as plain, and refuses @", () => {
    expect(checkQuery("SELECT [a;b], [c]]d;e] FROM t", "mssql").ok).toBe(true);
    expect(checkQuery("SELECT [a FROM t", "mssql").ok).toBe(false);
    expect(checkQuery("SELECT 'a\\'; DROP TABLE t; --' FROM t", "mssql").ok).toBe(false); // the string ends at the quote
    expect(checkQuery("SELECT * FROM t WHERE a > @x", "mssql").ok).toBe(false);
    expect(checkQuery("SELECT '@x' FROM t", "mssql").ok).toBe(true);
    expect(checkQuery("SELECT 1; DROP TABLE t", "mssql").ok).toBe(false);
  });
  it("explains that a WITH query cannot be wrapped, rather than failing in the database", () => {
    const r = compileQuery("WITH a AS (SELECT 1 AS n) SELECT n FROM a", "mssql", "n", 5);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/WITH/);
    expect(compileQuery("WITH a AS (SELECT 1 AS n) SELECT n FROM a", "mysql", "n", 5).ok).toBe(true);
  });
});

describe("resolveWarehouseHost", () => {
  const hosted = (lookup?: (h: string) => Promise<Array<{ address: string; family: number }>>) => ({ restrict: true, allowedHosts: [], lookup });
  it("is on for a hosted service and off self-hosted", () => {
    expect(warehouseHostPolicyFromEnv({}).restrict).toBe(false);
    expect(warehouseHostPolicyFromEnv({ LOOMAIL_PUBLIC_SITE: "true" }).restrict).toBe(true);
    expect(warehouseHostPolicyFromEnv({ LOOMAIL_PUBLIC_SITE: "true", LOOMAIL_RESTRICT_WAREHOUSE_HOSTS: "false" }).restrict).toBe(false);
    expect(warehouseHostPolicyFromEnv({ LOOMAIL_WAREHOUSE_ALLOWED_HOSTS: " DB.Internal , 10.0.0.9" }).allowedHosts).toEqual(["db.internal", "10.0.0.9"]);
  });
  it("refuses private, loopback and metadata addresses however they are spelled or resolved", async () => {
    for (const h of ["localhost", "127.0.0.1", "10.0.0.5", "169.254.169.254", "192.168.1.1", "::1", "db.internal"]) {
      expect((await resolveWarehouseHost(h, hosted())).ok, h).toBe(false);
    }
    expect((await resolveWarehouseHost("sneaky.example.com", hosted(async () => [{ address: "10.1.2.3", family: 4 }]))).ok).toBe(false);
    expect((await resolveWarehouseHost("mixed.example.com", hosted(async () => [{ address: "93.184.216.34", family: 4 }, { address: "127.0.0.1", family: 4 }]))).ok).toBe(false);
  });
  it("connects to the address it checked, and lets the operator exempt a host", async () => {
    const r = await resolveWarehouseHost("db.example.com", hosted(async () => [{ address: "93.184.216.34", family: 4 }]));
    expect(r).toEqual({ ok: true, address: "93.184.216.34", servername: "db.example.com" });
    expect((await resolveWarehouseHost("db.internal", { restrict: true, allowedHosts: ["db.internal"] })).ok).toBe(true);
    expect((await resolveWarehouseHost("anything", { restrict: false, allowedHosts: [] })).ok).toBe(true);
  });
});
