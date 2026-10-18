/**
 * SQL Server connector (also Azure SQL Database and Azure SQL Managed Instance). Runs the query with the cursor as a
 * bound parameter, declares read-only intent, and gives up after the time limit.
 *
 * SQL Server has no read-only transaction, so the read-only guarantee is the login: the docs tell customers to connect
 * with a user that has only SELECT (db_datareader).
 *
 * A database that is not reachable from the internet can be reached through an SSH tunnel (see ssh-tunnel.ts): set `ssh`
 * in the config and the SSH key in the secret. Connect to a port (usually 1433), not an instance name: named instances
 * are found with a UDP lookup that cannot travel through a tunnel.
 *
 * Mirror side: PUBLIC (packages/adapters is mirrored).
 */
import { Connection, Request, TYPES } from "tedious";
import { isIP } from "node:net";
import { warehouseHostPolicyFromEnv, type WarehouseHostPolicy } from "./guard.js";
import { compileQuery } from "./query.js";
import { reachDatabase, type NetworkDbConfig, type NetworkDbSecret } from "./reach.js";
import { WarehouseError, type CellValue, type WarehouseClient, type WarehouseQuery, type WarehouseRows } from "./types.js";

export interface MssqlConfig extends NetworkDbConfig {
  database: string;
  user: string;
  /** verify: encrypted and the certificate is checked (default). no-verify: encrypted, certificate not checked. disable: plain. */
  ssl_mode: "verify" | "no-verify" | "disable";
  /** PEM text of the certificate authority that signed the server's certificate (a private CA, or SQL Server's own self-signed one). */
  ssl_ca?: string;
}

export interface MssqlSecret extends NetworkDbSecret {
  password: string;
}

export function mssqlCell(value: unknown): CellValue {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "bigint") return Number(value);
  if (Buffer.isBuffer(value)) return value.toString("base64");
  return JSON.stringify(value);
}

function describe(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    return (typeof code === "string" && code ? `${code}: ` : "") + err.message.slice(0, 300);
  }
  return "unknown error";
}

/** Run one statement on one connection and close it. A tunnel serves exactly one connection, so no pool. */
function run(conn: Connection, sqlText: string, cursor: string | null, timeoutMs: number): Promise<WarehouseRows> {
  return new Promise<WarehouseRows>((resolve, reject) => {
    const columns: string[] = [];
    const rows: Array<Record<string, CellValue>> = [];
    const req = new Request(sqlText, (err) => {
      if (err) reject(err);
      else resolve({ columns, rows });
    });
    // The cursor is a bound parameter (sp_executesql), never pasted into the text.
    if (cursor !== null) req.addParameter("cursor", TYPES.NVarChar, cursor, { length: 4000 });
    req.setTimeout(timeoutMs);
    req.on("columnMetadata", (meta) => {
      for (const c of meta as unknown as Array<{ colName: string }>) columns.push(c.colName.toLowerCase());
    });
    req.on("row", (cells) => {
      const o: Record<string, CellValue> = {};
      (cells as unknown as Array<{ value: unknown }>).forEach((c, i) => {
        o[columns[i]!] = mssqlCell(c.value);
      });
      rows.push(o);
    });
    conn.execSql(req);
  });
}

export function createMssqlClient(config: MssqlConfig, secret: MssqlSecret, opts: { policy?: WarehouseHostPolicy } = {}): WarehouseClient {
  return {
    async query(q: WarehouseQuery): Promise<WarehouseRows> {
      const compiled = compileQuery(q.sql, "mssql", q.cursorColumn, q.maxRows);
      if (!compiled.ok) throw new WarehouseError(compiled.error);

      const policy = opts.policy ?? warehouseHostPolicyFromEnv();
      const { host, port, identity, tunnel } = await reachDatabase(config, secret, policy, q.timeoutMs);

      const conn = new Connection({
        server: host,
        authentication: { type: "default", options: { userName: config.user, password: secret.password } },
        options: {
          port,
          database: config.database,
          connectTimeout: Math.min(q.timeoutMs, 15_000),
          requestTimeout: q.timeoutMs + 2_000,
          encrypt: config.ssl_mode !== "disable",
          trustServerCertificate: config.ssl_mode === "no-verify",
          // The name the certificate must match (and the TLS server name): the host the customer typed, even through a tunnel.
          ...(isIP(identity) === 0 ? { serverName: identity } : {}),
          ...(config.ssl_ca ? { cryptoCredentialsDetails: { ca: config.ssl_ca } } : {}),
          readOnlyIntent: true,
          appName: "Loomail sync",
          // The first failure is the answer; a retry would dial a tunnel that serves one connection.
          maxRetriesOnTransientErrors: 0,
          useUTC: true,
          camelCaseColumns: false,
        },
      });
      conn.on("error", () => {}); // a dropped connection surfaces through the pending call

      try {
        try {
          await new Promise<void>((resolve, reject) => {
            conn.once("connect", (err?: Error) => (err ? reject(err) : resolve()));
            conn.connect();
          });
        } catch (err) {
          throw new WarehouseError(tunnel?.forwardError() ?? `Could not connect to the database: ${describe(err)}`, true);
        }
        try {
          return await run(conn, compiled.sql, compiled.cursorCount > 0 ? q.cursor : null, q.timeoutMs + 2_000);
        } catch (err) {
          throw new WarehouseError(`The query failed: ${describe(err)}`, false);
        } finally {
          conn.close();
        }
      } finally {
        tunnel?.close();
      }
    },
  };
}
