/**
 * MySQL connector (also MariaDB, Aurora MySQL, PlanetScale, TiDB, ... anything that speaks the MySQL protocol).
 * Runs the query as a prepared statement inside a READ ONLY transaction, with a statement time limit where the server
 * has one.
 *
 * A database that is not reachable from the internet can be reached through an SSH tunnel (see ssh-tunnel.ts): set `ssh`
 * in the config and the SSH key in the secret.
 *
 * Mirror side: PUBLIC (packages/adapters is mirrored).
 */
import mysql from "mysql2/promise";
import net from "node:net";
import { warehouseHostPolicyFromEnv, type WarehouseHostPolicy } from "./guard.js";
import { compileQuery } from "./query.js";
import { reachDatabase, type NetworkDbConfig, type NetworkDbSecret } from "./reach.js";
import { WarehouseError, type CellValue, type WarehouseClient, type WarehouseQuery, type WarehouseRows } from "./types.js";

export interface MysqlConfig extends NetworkDbConfig {
  database: string;
  user: string;
  /** verify: encrypted and the certificate is checked (default). no-verify: encrypted, certificate not checked. disable: plain. */
  ssl_mode: "verify" | "no-verify" | "disable";
  /** PEM text of the certificate authority that signed the server's certificate, for services that use their own (Amazon RDS, a private CA). */
  ssl_ca?: string;
}

export interface MysqlSecret extends NetworkDbSecret {
  password: string;
}

export function mysqlCell(value: unknown): CellValue {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "bigint") return Number(value);
  if (Buffer.isBuffer(value)) return value.toString("base64"); // blobs, binary(16) ids
  return JSON.stringify(value); // JSON columns, sets
}

function describe(err: unknown): string {
  if (err instanceof Error) {
    const e = err as NodeJS.ErrnoException & { sqlMessage?: string };
    return (e.code ? `${e.code}: ` : "") + (e.sqlMessage ?? err.message).slice(0, 300);
  }
  return "unknown error";
}

export function createMysqlClient(config: MysqlConfig, secret: MysqlSecret, opts: { policy?: WarehouseHostPolicy } = {}): WarehouseClient {
  return {
    async query(q: WarehouseQuery): Promise<WarehouseRows> {
      const compiled = compileQuery(q.sql, "mysql", q.cursorColumn, q.maxRows);
      if (!compiled.ok) throw new WarehouseError(compiled.error);

      const policy = opts.policy ?? warehouseHostPolicyFromEnv();
      const { host, port: dialPort, identity, tunnel } = await reachDatabase(config, secret, policy, q.timeoutMs);

      let conn: mysql.Connection | null = null;
      try {
        try {
          conn = await mysql.createConnection({
            // The driver names the server by this host for the certificate check, so it gets the host the customer typed;
            // the socket itself goes to the address the guard checked, or the tunnel.
            host: identity,
            port: config.port,
            stream: () => net.connect({ host, port: dialPort }),
            database: config.database,
            user: config.user,
            password: secret.password,
            connectTimeout: Math.min(q.timeoutMs, 15_000),
            timezone: "Z", // DATETIME has no zone; read it as UTC like the rest of Loomail
            decimalNumbers: true,
            multipleStatements: false,
            ssl:
              config.ssl_mode === "disable"
                ? undefined
                : {
                    rejectUnauthorized: config.ssl_mode === "verify",
                    verifyIdentity: config.ssl_mode === "verify",
                    // A given CA replaces the built-in list, which is what a private or provider CA needs.
                    ...(config.ssl_ca ? { ca: config.ssl_ca } : {}),
                  },
          });
        } catch (err) {
          // When the SSH server could not reach the database, that is the real reason; the driver only sees a closed socket.
          throw new WarehouseError(tunnel?.forwardError() ?? `Could not connect to the database: ${describe(err)}`, true);
        }
        conn.on("error", () => {}); // a dropped connection surfaces through the pending call

        try {
          // Limits are best effort: MySQL 5.7.8+ takes max_execution_time (ms), MariaDB takes max_statement_time (s).
          // Each failing on the other server is expected, so each is tried on its own.
          for (const stmt of [`SET SESSION max_execution_time = ${Math.floor(q.timeoutMs)}`, `SET SESSION max_statement_time = ${Math.ceil(q.timeoutMs / 1000)}`]) {
            await conn.query(stmt).catch(() => {});
          }
          await conn.query("SET SESSION TRANSACTION READ ONLY");
          await conn.query("START TRANSACTION READ ONLY");
          // :cursor became one ? per use, each taking the same value.
          const [rows, fields] = await conn.execute({
            sql: compiled.sql,
            values: Array.from({ length: compiled.cursorCount }, () => q.cursor),
            rowsAsArray: true,
            timeout: q.timeoutMs + 2_000,
          });
          await conn.query("ROLLBACK");
          const columns = (fields as mysql.FieldPacket[]).map((f) => f.name.toLowerCase());
          const out = (rows as unknown[][]).map((r) => {
            const o: Record<string, CellValue> = {};
            columns.forEach((c, i) => {
              o[c] = mysqlCell(r[i]);
            });
            return o;
          });
          return { columns, rows: out };
        } catch (err) {
          await conn.query("ROLLBACK").catch(() => {});
          throw new WarehouseError(`The query failed: ${describe(err)}`, false);
        } finally {
          await conn.end().catch(() => conn?.destroy());
        }
      } finally {
        tunnel?.close();
      }
    },
  };
}
