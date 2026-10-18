/**
 * Snowflake connector, over the SQL API (https://<account>.snowflakecomputing.com/api/v2/statements). No driver.
 *
 * Authentication is key-pair: the customer gives Snowflake the public key (ALTER USER ... SET RSA_PUBLIC_KEY) and
 * Loomail the private key. Each call carries a short-lived RS256 token whose `iss` is
 * <ACCOUNT>.<USER>.<SHA256:fingerprint> (account in upper case, without any region part; user upper case).
 *
 * The call is synchronous for up to 45 seconds; past that Snowflake answers 202 and Loomail polls the statement
 * until the deadline. Every value in `data` comes back as text, so each is converted by the column's type.
 * A request id with retry=true makes a resubmission after a network error safe.
 *
 * Mirror side: PUBLIC (packages/adapters is mirrored).
 */
import { randomUUID } from "node:crypto";
import { publicKeyFingerprint, readPrivateKey, signJwtRS256 } from "./jwt.js";
import { compileQuery } from "./query.js";
import { WarehouseError, type CellValue, type WarehouseClient, type WarehouseQuery, type WarehouseRows } from "./types.js";

export interface SnowflakeConfig {
  /** Account identifier: "myorg-myaccount" or a locator such as "xy12345.eu-west-1". */
  account: string;
  user: string;
  warehouse?: string;
  role?: string;
  database?: string;
  schema?: string;
}

export interface SnowflakeSecret {
  /** PEM private key (PKCS#8). */
  private_key: string;
  passphrase?: string;
}

export const SNOWFLAKE_ACCOUNT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,98}[A-Za-z0-9]$/;

export function snowflakeHost(account: string): string {
  return `${account.toLowerCase()}.snowflakecomputing.com`;
}

/** The account part of the token's `iss`: upper case, region and cloud removed (what Snowflake's own drivers do). */
export function jwtAccount(account: string): string {
  const a = account.toUpperCase();
  return (a.includes(".GLOBAL") ? a.split("-")[0]! : a.split(".")[0]!).trim();
}

export function snowflakeToken(config: SnowflakeConfig, secret: SnowflakeSecret, nowSeconds: number): string {
  const key = readPrivateKey(secret.private_key, secret.passphrase);
  const account = jwtAccount(config.account);
  const user = config.user.toUpperCase();
  return signJwtRS256({
    iss: `${account}.${user}.${publicKeyFingerprint(key)}`,
    sub: `${account}.${user}`,
    iat: nowSeconds,
    exp: nowSeconds + 59 * 60,
  }, key);
}

interface RowType {
  name: string;
  type: string;
  scale?: number | null;
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

function isoFromEpoch(seconds: number): string {
  return new Date(Math.floor(seconds * 1000)).toISOString();
}

/** Convert one Snowflake text value by its column type. */
export function snowflakeCell(value: string | null, col: RowType): CellValue {
  if (value === null || value === undefined) return null;
  const t = col.type.toLowerCase();
  switch (t) {
    case "fixed": {
      const n = Number(value);
      return Number.isFinite(n) ? n : value;
    }
    case "real": {
      const n = Number(value);
      return Number.isFinite(n) ? n : value;
    }
    case "boolean":
      return value === "true" || value === "1";
    case "date": {
      const days = Number(value);
      if (!Number.isFinite(days)) return value;
      const d = new Date(days * 86_400_000);
      return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
    }
    case "timestamp_ntz":
    case "timestamp_ltz": {
      const s = Number(value);
      return Number.isFinite(s) ? isoFromEpoch(s) : value;
    }
    case "timestamp_tz": {
      // "<epoch seconds> <offset minutes + 1440>": the epoch is already UTC.
      const s = Number(value.split(" ")[0]);
      return Number.isFinite(s) ? isoFromEpoch(s) : value;
    }
    default:
      return value; // text, time, variant, object, array, binary
  }
}

interface Payload {
  resultSetMetaData?: { rowType?: RowType[]; partitionInfo?: unknown[] };
  data?: Array<Array<string | null>>;
  statementHandle?: string;
  statementStatusUrl?: string;
  message?: string;
  code?: string;
}

function failureText(status: number, body: Payload | null): string {
  const m = body?.message ? ` ${String(body.message).slice(0, 300)}` : "";
  if (status === 401 || status === 403) return `Snowflake refused the sign-in (${status}). Check the account, user and that the public key is set on that user.${m}`;
  return `Snowflake answered ${status}.${m}`;
}

export function createSnowflakeClient(
  config: SnowflakeConfig,
  secret: SnowflakeSecret,
  opts: {
    /** Tests only: replaces https://<account>.snowflakecomputing.com. Never taken from customer input. */
    baseUrl?: string;
    now?: () => number;
    fetchImpl?: typeof fetch;
    pollMs?: number;
  } = {},
): WarehouseClient {
  const doFetch = opts.fetchImpl ?? fetch;
  const now = opts.now ?? (() => Date.now());
  const base = opts.baseUrl ?? `https://${snowflakeHost(config.account)}`;

  return {
    async query(q: WarehouseQuery): Promise<WarehouseRows> {
      if (!SNOWFLAKE_ACCOUNT.test(config.account)) throw new WarehouseError("The Snowflake account identifier does not look right.");
      const compiled = compileQuery(q.sql, "snowflake", q.cursorColumn, q.maxRows);
      if (!compiled.ok) throw new WarehouseError(compiled.error);

      let token: string;
      try {
        token = snowflakeToken(config, secret, Math.floor(now() / 1000));
      } catch (err) {
        throw new WarehouseError(err instanceof Error ? err.message : "The private key could not be used.");
      }
      const headers = {
        Authorization: `Bearer ${token}`,
        "X-Snowflake-Authorization-Token-Type": "KEYPAIR_JWT",
        Accept: "application/json",
        "User-Agent": "Loomail-Sync/1",
      };
      const deadline = now() + q.timeoutMs;
      const call = async (url: string, init?: RequestInit): Promise<{ status: number; body: Payload | null; res: Response }> => {
        const left = Math.max(1000, deadline - now() + 5000);
        let res: Response;
        try {
          res = await doFetch(url, { ...init, headers: { ...headers, ...(init?.headers ?? {}) }, redirect: "error", signal: AbortSignal.timeout(left) });
        } catch {
          throw new WarehouseError("Could not reach Snowflake.", true);
        }
        let body: Payload | null = null;
        try {
          body = (await res.json()) as Payload;
        } catch {
          body = null;
        }
        return { status: res.status, body, res };
      };

      const bindings: Record<string, { type: string; value: string }> = {};
      for (let i = 1; i <= compiled.cursorCount; i++) bindings[String(i)] = { type: "TEXT", value: q.cursor };
      const requestBody: Record<string, unknown> = {
        statement: compiled.sql,
        timeout: Math.max(1, Math.ceil(q.timeoutMs / 1000)),
        ...(config.warehouse ? { warehouse: config.warehouse } : {}),
        ...(config.role ? { role: config.role } : {}),
        ...(config.database ? { database: config.database } : {}),
        ...(config.schema ? { schema: config.schema } : {}),
        ...(compiled.cursorCount > 0 ? { bindings } : {}),
      };

      const first = await call(`${base}/api/v2/statements?requestId=${randomUUID()}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      });
      let { status, body } = first;
      const poll = opts.pollMs ?? 1000;
      while (status === 202 || status === 429) {
        if (now() > deadline) throw new WarehouseError("The query took too long. Make it faster or raise the time limit.", true);
        const url = body?.statementStatusUrl ?? (body?.statementHandle ? `/api/v2/statements/${body.statementHandle}` : null);
        if (!url) throw new WarehouseError("Snowflake did not say where to find the result.", true);
        await new Promise((r) => setTimeout(r, poll));
        ({ status, body } = await call(`${base}${url}`));
      }
      if (status !== 200 || !body) throw new WarehouseError(failureText(status, body), status === 429 || status >= 500);

      const types = body.resultSetMetaData?.rowType ?? [];
      const columns = types.map((t) => t.name.toLowerCase());
      const data: Array<Array<string | null>> = [...(body.data ?? [])];
      const parts = body.resultSetMetaData?.partitionInfo?.length ?? 1;
      for (let p = 1; p < parts; p++) {
        const next = await call(`${base}/api/v2/statements/${body.statementHandle}?partition=${p}`);
        if (next.status !== 200 || !next.body) throw new WarehouseError(failureText(next.status, next.body), next.status >= 500);
        data.push(...(next.body.data ?? []));
      }
      const rows = data.map((r) => {
        const o: Record<string, CellValue> = {};
        types.forEach((t, i) => {
          o[columns[i]!] = snowflakeCell(r[i] ?? null, t);
        });
        return o;
      });
      return { columns, rows };
    },
  };
}
