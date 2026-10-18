/**
 * Postgres connector against a Postgres-compatible service that refuses `SET LOCAL statement_timeout` (some managed
 * or emulated services do): the query must still run, in a fresh read-only transaction, and still cannot write.
 * The driver is replaced with a scripted one so the exact statements can be checked.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const log: string[] = [];
let failTimeout = true;

vi.mock("pg", () => {
  class Client {
    on() {}
    async connect() {}
    async end() {}
    async query(arg: string | { text: string; values?: unknown[] }) {
      const text = typeof arg === "string" ? arg : arg.text;
      log.push(text);
      if (/^SET LOCAL statement_timeout/.test(text) && failTimeout) throw new Error('unrecognized configuration parameter "statement_timeout"');
      if (/^SELECT \* FROM/.test(text)) return { fields: [{ name: "n", dataTypeID: 23 }], rows: [{ n: 1 }] };
      return { fields: [], rows: [] };
    }
  }
  return { default: { Client } };
});

const { createPostgresClient } = await import("../src/warehouse/postgres.js");

const client = () =>
  createPostgresClient({ host: "db.example.com", port: 5439, database: "dev", user: "reader", ssl_mode: "verify" }, { password: "p" }, { policy: { restrict: false, allowedHosts: [] } });
const q = { sql: "SELECT 1 AS n", cursor: "", cursorColumn: "n", maxRows: 10, timeoutMs: 5000 };

beforeEach(() => {
  log.length = 0;
  failTimeout = true;
});

describe("a service that does not take SET LOCAL statement_timeout", () => {
  it("runs the query anyway, in a new read-only transaction", async () => {
    const out = await client().query(q);
    expect(out.rows).toEqual([{ n: 1 }]);
    expect(log.slice(0, 5)).toEqual(["BEGIN READ ONLY", "SET LOCAL statement_timeout = 5000", "ROLLBACK", "BEGIN READ ONLY", expect.stringMatching(/^SELECT \* FROM/)]);
    expect(log.at(-1)).toBe("ROLLBACK");
  });

  it("uses the timeout when the service takes it, with no extra rollback", async () => {
    failTimeout = false;
    await client().query(q);
    expect(log).toEqual(["BEGIN READ ONLY", "SET LOCAL statement_timeout = 5000", expect.stringMatching(/^SELECT \* FROM/), "ROLLBACK"]);
  });
});
