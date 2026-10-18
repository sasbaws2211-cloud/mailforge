/**
 * Postgres connector (also works for anything that speaks the Postgres protocol: Redshift, AlloyDB, Aurora, Neon,
 * Supabase, ...). Connects with a normal driver, inside a READ ONLY transaction with a statement timeout.
 *
 * Mirror side: PUBLIC (packages/adapters is mirrored).
 */
import pg from "pg";
import { isIP } from "node:net";
import tls from "node:tls";
import { resolveWarehouseHost, warehouseHostPolicyFromEnv, type WarehouseHostPolicy } from "./guard.js";
import { compileQuery } from "./query.js";
import { WarehouseError, type CellValue, type WarehouseClient, type WarehouseQuery, type WarehouseRows } from "./types.js";

export interface PostgresConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  /** verify: encrypted and the certificate is checked (default). no-verify: encrypted, certificate not checked. disable: plain. */
  ssl_mode: "verify" | "no-verify" | "disable";
  /**
   * PEM text of the certificate authority (or a bundle of them) that signed the server's certificate, for services that
   * use their own: Amazon RDS, Supabase, a private CA. With it, "verify" still checks the certificate and host name.
   * Public CAs (Neon, Redshift, most others) need nothing.
   */
  ssl_ca?: string;
}

export interface PostgresSecret {
  password: string;
}

const NUMERIC_OIDS = new Set([20, 21, 23, 700, 701, 1700]); // int8 int2 int4 float4 float8 numeric

function cell(value: unknown, oid: number): CellValue {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (NUMERIC_OIDS.has(oid)) {
      const n = Number(value);
      return Number.isFinite(n) ? n : value;
    }
    return value;
  }
  if (typeof value === "bigint") return Number(value);
  return JSON.stringify(value); // json, arrays, bytea
}

function describe(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    return (code && !/^[0-9A-Z]{5}$/.test(code) ? `${code}: ` : "") + err.message.slice(0, 300);
  }
  return "unknown error";
}

export function createPostgresClient(
  config: PostgresConfig,
  secret: PostgresSecret,
  opts: { policy?: WarehouseHostPolicy } = {},
): WarehouseClient {
  return {
    async query(q: WarehouseQuery): Promise<WarehouseRows> {
      const compiled = compileQuery(q.sql, "postgres", q.cursorColumn, q.maxRows);
      if (!compiled.ok) throw new WarehouseError(compiled.error);

      const target = await resolveWarehouseHost(config.host, opts.policy ?? warehouseHostPolicyFromEnv());
      if (!target.ok) throw new WarehouseError(target.error);

      const client = new pg.Client({
        host: target.address.replace(/^\[|\]$/g, ""),
        port: config.port,
        database: config.database,
        user: config.user,
        password: secret.password,
        connectionTimeoutMillis: Math.min(q.timeoutMs, 15_000),
        query_timeout: q.timeoutMs + 2_000,
        application_name: "Loomail sync",
        ssl:
          config.ssl_mode === "disable"
            ? false
            : {
                rejectUnauthorized: config.ssl_mode === "verify",
                servername: isIP(target.servername) === 0 ? target.servername : undefined,
                // A given CA replaces the built-in list, which is what a private or provider CA needs.
                ...(config.ssl_ca ? { ca: config.ssl_ca } : {}),
                // Always check the certificate against the host the customer typed, whether that is a name or an address,
                // and even when a guard made us connect to the address it checked. (Left alone, a socket given an address
                // would be checked against "localhost".)
                checkServerIdentity: (_connectedTo: string, cert: tls.PeerCertificate) => tls.checkServerIdentity(target.servername, cert),
              },
      });
      client.on("error", () => {}); // a dropped connection surfaces through the pending call

      try {
        await client.connect();
      } catch (err) {
        throw new WarehouseError(`Could not connect to the database: ${describe(err)}`, true);
      }
      try {
        await client.query("BEGIN READ ONLY");
        try {
          await client.query(`SET LOCAL statement_timeout = ${Math.floor(q.timeoutMs)}`);
        } catch {
          // A Postgres-compatible service that does not take this setting: carry on without it (the client still
          // gives up after the time limit). The failed statement aborted the transaction, so start it again.
          await client.query("ROLLBACK");
          await client.query("BEGIN READ ONLY");
        }
        // Every :cursor became $1, and Postgres takes one value for all uses of it.
        const res = await client.query({ text: compiled.sql, values: compiled.cursorCount > 0 ? [q.cursor] : [] });
        await client.query("ROLLBACK");
        const oids = res.fields.map((f) => f.dataTypeID);
        const columns = res.fields.map((f) => f.name.toLowerCase());
        const rows = res.rows.map((r: Record<string, unknown>) => {
          const o: Record<string, CellValue> = {};
          res.fields.forEach((f, i) => {
            o[columns[i]!] = cell(r[f.name], oids[i]!);
          });
          return o;
        });
        return { columns, rows };
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw new WarehouseError(`The query failed: ${describe(err)}`, false);
      } finally {
        await client.end().catch(() => {});
      }
    },
  };
}
