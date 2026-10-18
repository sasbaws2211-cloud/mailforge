/**
 * BigQuery connector, over the REST API (jobs.query, then jobs.getQueryResults for further pages). No driver.
 *
 * Authentication is a Google service account: Loomail signs a short-lived JWT with the account's private key and
 * trades it at https://oauth2.googleapis.com/token for an access token. The token address inside the key file is
 * ignored on purpose: it is customer-supplied text, and the server must only ever call Google.
 *
 * The service account needs "BigQuery Job User" on the project and "BigQuery Data Viewer" on the data. Every query
 * carries `maximumBytesBilled`, so a careless query fails instead of running up a bill.
 *
 * Mirror side: PUBLIC (packages/adapters is mirrored).
 */
import { randomUUID } from "node:crypto";
import { readPrivateKey, signJwtRS256 } from "./jwt.js";
import { compileQuery } from "./query.js";
import { WarehouseError, type CellValue, type WarehouseClient, type WarehouseQuery, type WarehouseRows } from "./types.js";

export interface BigQueryConfig {
  project_id: string;
  /** Dataset location ("US", "EU", "europe-west2", ...). Needed when the data is not in the US/EU multi-region default. */
  location?: string;
  /** Refuse any query that would read more than this many bytes. */
  max_bytes_billed: number;
}

/** The service-account key file, as JSON text or already parsed. */
export interface BigQuerySecret {
  client_email: string;
  private_key: string;
}

export const BIGQUERY_PROJECT = /^[a-z][a-z0-9.:-]{4,61}[a-z0-9]$/;
const TOKEN_URL = "https://oauth2.googleapis.com/token";
// Read-only is enough for jobs.query (the docs list it as an accepted scope) and limits what a leaked token could do.
const SCOPE = "https://www.googleapis.com/auth/bigquery.readonly";

interface Field {
  name: string;
  type: string;
}

interface QueryResponse {
  jobComplete?: boolean;
  jobReference?: { jobId?: string; location?: string };
  schema?: { fields?: Field[] };
  rows?: Array<{ f?: Array<{ v: unknown }> }>;
  pageToken?: string;
  error?: { message?: string; code?: number };
}

export function bigqueryCell(value: unknown, type: string): CellValue {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return JSON.stringify(value); // RECORD / REPEATED
  switch (type.toUpperCase()) {
    case "INTEGER":
    case "INT64":
    case "FLOAT":
    case "FLOAT64":
    case "NUMERIC":
    case "BIGNUMERIC": {
      const n = Number(value);
      return Number.isFinite(n) ? n : value;
    }
    case "BOOLEAN":
    case "BOOL":
      return value === "true";
    case "TIMESTAMP": {
      // With useInt64Timestamp (which the client asks for) the value is whole microseconds since the epoch. Without it
      // it would be seconds as a float, e.g. "1.7283E9"; both are understood.
      if (/^-?\d+$/.test(value)) {
        const ms = Number(BigInt(value) / 1000n);
        return new Date(ms).toISOString();
      }
      const s = Number(value);
      return Number.isFinite(s) ? new Date(Math.floor(s * 1000)).toISOString() : value;
    }
    default:
      return value; // STRING, DATE, DATETIME, TIME, JSON, BYTES, GEOGRAPHY
  }
}

export function createBigQueryClient(
  config: BigQueryConfig,
  secret: BigQuerySecret,
  opts: {
    /** Tests only: replace the Google addresses. Never taken from customer input. */
    apiBase?: string;
    tokenUrl?: string;
    now?: () => number;
    fetchImpl?: typeof fetch;
    pollMs?: number;
  } = {},
): WarehouseClient {
  const doFetch = opts.fetchImpl ?? fetch;
  const now = opts.now ?? (() => Date.now());
  const api = opts.apiBase ?? "https://bigquery.googleapis.com";
  const tokenUrl = opts.tokenUrl ?? TOKEN_URL;

  const send = async (url: string, init: RequestInit, timeoutMs: number): Promise<{ status: number; body: unknown }> => {
    let res: Response;
    try {
      res = await doFetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
    } catch {
      throw new WarehouseError("Could not reach Google.", true);
    }
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { status: res.status, body };
  };

  async function accessToken(): Promise<string> {
    let key;
    try {
      key = readPrivateKey(secret.private_key);
    } catch (err) {
      throw new WarehouseError(err instanceof Error ? err.message : "The private key could not be used.");
    }
    const iat = Math.floor(now() / 1000);
    const assertion = signJwtRS256({ iss: secret.client_email, scope: SCOPE, aud: TOKEN_URL, iat, exp: iat + 3000 }, key);
    const { status, body } = await send(
      tokenUrl,
      { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString() },
      20_000,
    );
    const token = (body as { access_token?: string } | null)?.access_token;
    if (status !== 200 || !token) {
      const why = (body as { error_description?: string } | null)?.error_description;
      throw new WarehouseError(`Google refused the service account${why ? `: ${String(why).slice(0, 200)}` : "."}`, status >= 500);
    }
    return token;
  }

  return {
    async query(q: WarehouseQuery): Promise<WarehouseRows> {
      if (!BIGQUERY_PROJECT.test(config.project_id)) throw new WarehouseError("The BigQuery project id does not look right.");
      const compiled = compileQuery(q.sql, "bigquery", q.cursorColumn, q.maxRows);
      if (!compiled.ok) throw new WarehouseError(compiled.error);

      const token = await accessToken();
      const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json", "User-Agent": "Loomail-Sync/1" };
      const deadline = now() + q.timeoutMs;
      const project = encodeURIComponent(config.project_id);

      const fail = (status: number, body: unknown): never => {
        const msg = (body as QueryResponse | null)?.error?.message;
        throw new WarehouseError(`BigQuery answered ${status}${msg ? `: ${String(msg).slice(0, 300)}` : "."}`, status === 429 || status >= 500);
      };

      const requestBody = {
        query: compiled.sql,
        useLegacySql: false,
        requestId: randomUUID(),
        timeoutMs: Math.min(q.timeoutMs, 60_000),
        maxResults: 10_000,
        maximumBytesBilled: String(config.max_bytes_billed),
        formatOptions: { useInt64Timestamp: true },
        ...(config.location ? { location: config.location } : {}),
        ...(compiled.cursorCount > 0
          ? { parameterMode: "NAMED", queryParameters: [{ name: "cursor", parameterType: { type: "STRING" }, parameterValue: { value: q.cursor } }] }
          : {}),
      };
      let { status, body } = await send(`${api}/bigquery/v2/projects/${project}/queries`, { method: "POST", headers: auth, body: JSON.stringify(requestBody) }, Math.min(q.timeoutMs, 60_000) + 10_000);
      if (status !== 200) fail(status, body);
      let page = body as QueryResponse;

      const jobId = page.jobReference?.jobId;
      const location = page.jobReference?.location ?? config.location;
      const resultsUrl = (pageToken?: string) => {
        const p = new URLSearchParams({ maxResults: "10000", timeoutMs: "10000", "formatOptions.useInt64Timestamp": "true" });
        if (location) p.set("location", location);
        if (pageToken) p.set("pageToken", pageToken);
        return `${api}/bigquery/v2/projects/${project}/queries/${encodeURIComponent(jobId ?? "")}?${p.toString()}`;
      };

      while (page.jobComplete === false) {
        if (now() > deadline) throw new WarehouseError("The query took too long. Make it faster or raise the time limit.", true);
        if (!jobId) throw new WarehouseError("BigQuery did not say which job to wait for.", true);
        await new Promise((r) => setTimeout(r, opts.pollMs ?? 1000));
        ({ status, body } = await send(resultsUrl(), { method: "GET", headers: auth }, 30_000));
        if (status !== 200) fail(status, body);
        page = body as QueryResponse;
      }

      const fields = page.schema?.fields ?? [];
      const columns = fields.map((f) => f.name.toLowerCase());
      const rows: Array<Record<string, CellValue>> = [];
      const take = (p: QueryResponse) => {
        for (const r of p.rows ?? []) {
          const o: Record<string, CellValue> = {};
          fields.forEach((f, i) => {
            o[columns[i]!] = bigqueryCell(r.f?.[i]?.v, f.type);
          });
          rows.push(o);
        }
      };
      take(page);
      while (page.pageToken && rows.length < q.maxRows) {
        if (!jobId) break;
        ({ status, body } = await send(resultsUrl(page.pageToken), { method: "GET", headers: auth }, 30_000));
        if (status !== 200) fail(status, body);
        page = body as QueryResponse;
        take(page);
      }
      return { columns, rows };
    },
  };
}
