/**
 * Postgres connector (also works for anything that speaks the Postgres protocol: Redshift, AlloyDB, Aurora, Neon,
 * Supabase, ...). Connects with a normal driver, inside a READ ONLY transaction with a statement timeout.
 *
 * A database that is not reachable from the internet can be reached through an SSH tunnel (see ssh-tunnel.ts): set `ssh`
 * in the config and the SSH key in the secret.
 *
 * Mirror side: PUBLIC (packages/adapters is mirrored).
 */
import pg from "pg";
import { isIP } from "node:net";
import tls from "node:tls";
import { resolveWarehouseHost, warehouseHostPolicyFromEnv, type WarehouseHostPolicy } from "./guard.js";
import { compileQuery } from "./query.js";
import { openTunnel, type SshTunnelConfig, type Tunnel } from "./ssh-tunnel.js";
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
  /**
   * Reach the database through this SSH server. `host` and `port` above are then the database's address as the SSH
   * server sees it (often a private name or address), not something our server connects to.
   */
  ssh?: SshTunnelConfig;
}

export interface PostgresSecret {
  password: string;
  /** The private key for the SSH tunnel, when `ssh` is set. */
  ssh_private_key?: string;
  ssh_passphrase?: string;
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

      const policy = opts.policy ?? warehouseHostPolicyFromEnv();
      // Where the driver connects, and the name the server's certificate must match: always the host the customer typed.
      let driverHost: string;
      let driverPort = config.port;
      const identity = config.host;
      let tunnel: Tunnel | null = null;

      if (config.ssh) {
        if (!secret.ssh_private_key) throw new WarehouseError("The SSH tunnel needs its private key.");
        // The guard applies to the SSH server (inside openTunnel), not to the database, which the SSH server resolves.
        tunnel = await openTunnel(
          config.ssh,
          { private_key: secret.ssh_private_key, ...(secret.ssh_passphrase ? { passphrase: secret.ssh_passphrase } : {}) },
          { host: config.host, port: config.port },
          { policy, timeoutMs: Math.min(q.timeoutMs, 15_000) },
        );
        driverHost = "127.0.0.1";
        driverPort = tunnel.localPort;
      } else {
        const target = await resolveWarehouseHost(config.host, policy);
        if (!target.ok) throw new WarehouseError(target.error);
        driverHost = target.address.replace(/^\[|\]$/g, "");
      }

      const client = new pg.Client({
        host: driverHost,
        port: driverPort,
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
                servername: isIP(identity) === 0 ? identity : undefined,
                // A given CA replaces the built-in list, which is what a private or provider CA needs.
                ...(config.ssl_ca ? { ca: config.ssl_ca } : {}),
                // Always check the certificate against the host the customer typed, whether that is a name or an address,
                // and even when a guard made us connect to the address it checked or a tunnel made us connect to
                // 127.0.0.1. (Left alone, a socket given an address would be checked against "localhost".)
                checkServerIdentity: (_connectedTo: string, cert: tls.PeerCertificate) => tls.checkServerIdentity(identity, cert),
              },
      });
      client.on("error", () => {}); // a dropped connection surfaces through the pending call

      try {
        try {
          await client.connect();
        } catch (err) {
          // When the SSH server could not reach the database, that is the real reason; the driver only sees a closed socket.
          throw new WarehouseError(tunnel?.forwardError() ?? `Could not connect to the database: ${describe(err)}`, true);
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
      } finally {
        tunnel?.close();
      }
    },
  };
}
