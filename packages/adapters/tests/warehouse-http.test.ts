/** Snowflake and BigQuery clients against fake servers that check the signed tokens like the real ones do. */
import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createHash, generateKeyPairSync, verify, type KeyObject } from "node:crypto";
import { createSnowflakeClient, jwtAccount, snowflakeCell, snowflakeToken } from "../src/warehouse/snowflake.js";
import { bigqueryCell, createBigQueryClient } from "../src/warehouse/bigquery.js";
import { WarehouseError } from "../src/warehouse/types.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

function decodeJwt(token: string): { header: Record<string, unknown>; claims: Record<string, unknown>; valid: (k: KeyObject) => boolean } {
  const [h, c, s] = token.split(".") as [string, string, string];
  return {
    header: JSON.parse(Buffer.from(h, "base64url").toString()),
    claims: JSON.parse(Buffer.from(c, "base64url").toString()),
    valid: (k) => verify("RSA-SHA256", Buffer.from(`${h}.${c}`), k, Buffer.from(s, "base64url")),
  };
}

type Handler = (req: http.IncomingMessage, body: string, res: http.ServerResponse) => void;
const servers: http.Server[] = [];
async function fake(handler: Handler): Promise<string> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => handler(req, Buffer.concat(chunks).toString(), res));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});
const json = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

const q = { sql: "SELECT id, email, updated_at FROM users WHERE updated_at >= TO_TIMESTAMP_TZ(:cursor)", cursor: "2026-01-01T00:00:00.000Z", cursorColumn: "updated_at", maxRows: 100, timeoutMs: 30_000 };

describe("Snowflake", () => {
  const config = { account: "myorg-myaccount", user: "loomail_reader", warehouse: "WH", role: "READER" };
  const rowType = [
    { name: "ID", type: "fixed", scale: 0 },
    { name: "EMAIL", type: "text" },
    { name: "UPDATED_AT", type: "timestamp_ntz", scale: 9 },
  ];

  it("signs a key-pair token Snowflake would accept", () => {
    const fp = "SHA256:" + createHash("sha256").update(publicKey.export({ type: "spki", format: "der" })).digest("base64");
    const t = decodeJwt(snowflakeToken({ ...config, account: "xy12345.eu-west-1" }, { private_key: pem }, 1_800_000_000));
    expect(t.valid(publicKey)).toBe(true);
    expect(t.header.alg).toBe("RS256");
    expect(t.claims).toEqual({ iss: `XY12345.LOOMAIL_READER.${fp}`, sub: "XY12345.LOOMAIL_READER", iat: 1_800_000_000, exp: 1_800_000_000 + 59 * 60 });
    expect(jwtAccount("myorg-myaccount")).toBe("MYORG-MYACCOUNT");
    expect(jwtAccount("xy12345.eu-west-1.aws")).toBe("XY12345");
  });

  it("runs the statement with bound cursor, converts typed values, and reads further partitions", async () => {
    const seen: Array<{ url: string; auth: string | undefined; type: string | undefined; body: Record<string, unknown> | null }> = [];
    const base = await fake((req, body, res) => {
      seen.push({ url: req.url!, auth: req.headers.authorization, type: req.headers["x-snowflake-authorization-token-type"] as string, body: body ? JSON.parse(body) : null });
      if (req.method === "POST") {
        return json(res, 200, {
          statementHandle: "h1",
          resultSetMetaData: { rowType, partitionInfo: [{ rowCount: 1 }, { rowCount: 1 }] },
          data: [["7", "a@x.com", "1767225600.000000000"]],
        });
      }
      expect(req.url).toContain("partition=1");
      return json(res, 200, { data: [["8", null, "1767229200.500000000"]] });
    });
    const out = await createSnowflakeClient(config, { private_key: pem }, { baseUrl: base }).query(q);
    expect(out.columns).toEqual(["id", "email", "updated_at"]);
    expect(out.rows).toEqual([
      { id: 7, email: "a@x.com", updated_at: "2026-01-01T00:00:00.000Z" },
      { id: 8, email: null, updated_at: "2026-01-01T01:00:00.500Z" },
    ]);
    const post = seen[0]!;
    expect(post.url).toMatch(/^\/api\/v2\/statements\?requestId=[0-9a-f-]{36}$/);
    expect(post.type).toBe("KEYPAIR_JWT");
    expect(decodeJwt(post.auth!.replace("Bearer ", "")).valid(publicKey)).toBe(true);
    expect(post.body).toMatchObject({ warehouse: "WH", role: "READER", bindings: { "1": { type: "TEXT", value: q.cursor } } });
    expect(String(post.body!.statement)).toBe("SELECT * FROM (SELECT id, email, updated_at FROM users WHERE updated_at >= TO_TIMESTAMP_TZ(?)) AS loomail_q ORDER BY updated_at ASC LIMIT 100");
  });

  it("polls a 202 statement until it finishes", async () => {
    let polls = 0;
    const base = await fake((req, _b, res) => {
      if (req.method === "POST") return json(res, 202, { statementHandle: "h2", statementStatusUrl: "/api/v2/statements/h2" });
      polls++;
      if (polls < 3) return json(res, 202, { statementHandle: "h2", statementStatusUrl: "/api/v2/statements/h2" });
      return json(res, 200, { statementHandle: "h2", resultSetMetaData: { rowType: [rowType[0]!] }, data: [["1"]] });
    });
    const out = await createSnowflakeClient(config, { private_key: pem }, { baseUrl: base, pollMs: 1 }).query(q);
    expect(polls).toBe(3);
    expect(out.rows).toEqual([{ id: 1 }]);
  });

  it("explains a failed statement, a refused sign-in, and a bad account name", async () => {
    const failing = await fake((_r, _b, res) => json(res, 422, { code: "002003", message: "SQL compilation error: Object 'USERS' does not exist." }));
    await expect(createSnowflakeClient(config, { private_key: pem }, { baseUrl: failing }).query(q)).rejects.toThrow(/does not exist/);
    const refused = await fake((_r, _b, res) => json(res, 401, { message: "JWT token is invalid." }));
    await expect(createSnowflakeClient(config, { private_key: pem }, { baseUrl: refused }).query(q)).rejects.toThrow(/refused the sign-in/);
    await expect(createSnowflakeClient({ ...config, account: "evil.com/../x" }, { private_key: pem }).query(q)).rejects.toThrow(WarehouseError);
    await expect(createSnowflakeClient(config, { private_key: "not a key" }).query(q)).rejects.toThrow(/private key/);
    await expect(createSnowflakeClient(config, { private_key: pem }).query({ ...q, sql: "DROP TABLE users" })).rejects.toThrow(/SELECT or WITH/);
  });

  it("marks outages as worth retrying and gives up at the deadline", async () => {
    const down = await fake((_r, _b, res) => json(res, 503, { message: "busy" }));
    const err = await createSnowflakeClient(config, { private_key: pem }, { baseUrl: down }).query(q).catch((e) => e);
    expect(err).toBeInstanceOf(WarehouseError);
    expect(err.retryable).toBe(true);
    let t = 0;
    const slow = await fake((_r, _b, res) => json(res, 202, { statementHandle: "h", statementStatusUrl: "/api/v2/statements/h" }));
    const late = await createSnowflakeClient(config, { private_key: pem }, { baseUrl: slow, pollMs: 1, now: () => (t += 20_000) }).query({ ...q, timeoutMs: 30_000 }).catch((e) => e);
    expect(late.message).toMatch(/took too long/);
  });

  it("converts each column type", () => {
    expect(snowflakeCell("12", { name: "a", type: "fixed" })).toBe(12);
    expect(snowflakeCell("1.5", { name: "a", type: "real" })).toBe(1.5);
    expect(snowflakeCell("true", { name: "a", type: "boolean" })).toBe(true);
    expect(snowflakeCell("20454", { name: "a", type: "date" })).toBe("2026-01-01");
    expect(snowflakeCell("1767225600.000000000 1980", { name: "a", type: "timestamp_tz" })).toBe("2026-01-01T00:00:00.000Z");
    expect(snowflakeCell(null, { name: "a", type: "text" })).toBeNull();
    expect(snowflakeCell("{\"a\":1}", { name: "a", type: "variant" })).toBe("{\"a\":1}");
  });
});

describe("BigQuery", () => {
  const key = { client_email: "reader@proj.iam.gserviceaccount.com", private_key: pem };
  const config = { project_id: "my-project-123", max_bytes_billed: 5_000_000_000, location: "EU" };
  const bq = { ...q, sql: "SELECT id, email, ts FROM `my-project-123.crm.users` WHERE ts >= TIMESTAMP(:cursor)", cursorColumn: "ts" };

  it("trades a signed JWT for a token, runs the query with a named parameter and a bytes cap, and pages", async () => {
    const calls: string[] = [];
    let exchange: Record<string, string> = {};
    let queryBody: Record<string, unknown> = {};
    let tokenAuth = "";
    const schema = { fields: [{ name: "id", type: "INTEGER" }, { name: "email", type: "STRING" }, { name: "ts", type: "TIMESTAMP" }, { name: "ok", type: "BOOLEAN" }] };
    const base = await fake((req, body, res) => {
      calls.push(`${req.method} ${req.url}`);
      if (req.url === "/token") {
        exchange = Object.fromEntries(new URLSearchParams(body));
        return json(res, 200, { access_token: "tok-123", expires_in: 3600 });
      }
      tokenAuth = String(req.headers.authorization);
      if (req.method === "POST") {
        queryBody = JSON.parse(body);
        return json(res, 200, { jobComplete: true, jobReference: { jobId: "job1", location: "EU" }, schema, rows: [{ f: [{ v: "1" }, { v: "a@x.com" }, { v: "1767225600000000" }, { v: "true" }] }], pageToken: "p2" });
      }
      expect(req.url).toContain("pageToken=p2");
      expect(req.url).toContain("formatOptions.useInt64Timestamp=true");
      expect(req.url).toContain("location=EU");
      return json(res, 200, { jobComplete: true, schema, rows: [{ f: [{ v: "2" }, { v: null }, { v: "1767229200000000" }, { v: "false" }] }] });
    });
    const out = await createBigQueryClient(config, key, { apiBase: base, tokenUrl: `${base}/token` }).query(bq);
    expect(out.rows).toEqual([
      { id: 1, email: "a@x.com", ts: "2026-01-01T00:00:00.000Z", ok: true },
      { id: 2, email: null, ts: "2026-01-01T01:00:00.000Z", ok: false },
    ]);
    const assertion = decodeJwt(exchange.assertion!);
    expect(exchange.grant_type).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    expect(assertion.valid(publicKey)).toBe(true);
    expect(assertion.claims).toMatchObject({ iss: key.client_email, scope: "https://www.googleapis.com/auth/bigquery.readonly", aud: "https://oauth2.googleapis.com/token" });
    expect(tokenAuth).toBe("Bearer tok-123");
    expect(queryBody).toMatchObject({
      useLegacySql: false,
      location: "EU",
      maximumBytesBilled: "5000000000",
      formatOptions: { useInt64Timestamp: true },
      parameterMode: "NAMED",
      queryParameters: [{ name: "cursor", parameterType: { type: "STRING" }, parameterValue: { value: q.cursor } }],
    });
    expect(String(queryBody.query)).toBe("SELECT * FROM (SELECT id, email, ts FROM `my-project-123.crm.users` WHERE ts >= TIMESTAMP(@cursor)) AS loomail_q ORDER BY ts ASC LIMIT 100");
    expect(calls.filter((c) => c.startsWith("POST /bigquery")).length).toBe(1);
  });

  it("waits for a job that is not finished yet", async () => {
    let polls = 0;
    const base = await fake((req, _b, res) => {
      if (req.url === "/token") return json(res, 200, { access_token: "t" });
      if (req.method === "POST") return json(res, 200, { jobComplete: false, jobReference: { jobId: "j", location: "EU" } });
      polls++;
      if (polls < 2) return json(res, 200, { jobComplete: false, jobReference: { jobId: "j" } });
      return json(res, 200, { jobComplete: true, schema: { fields: [{ name: "n", type: "INT64" }] }, rows: [{ f: [{ v: "5" }] }] });
    });
    const out = await createBigQueryClient(config, key, { apiBase: base, tokenUrl: `${base}/token`, pollMs: 1 }).query(bq);
    expect(out.rows).toEqual([{ n: 5 }]);
  });

  it("never calls the token address from the key file, and explains refusals", async () => {
    const base = await fake((req, _b, res) => {
      if (req.url === "/token") return json(res, 400, { error: "invalid_grant", error_description: "Invalid JWT Signature." });
      return json(res, 200, {});
    });
    await expect(createBigQueryClient(config, { ...key, token_uri: "http://169.254.169.254/" } as never, { apiBase: base, tokenUrl: `${base}/token` }).query(bq)).rejects.toThrow(/Invalid JWT Signature/);
    const denied = await fake((req, _b, res) => (req.url === "/token" ? json(res, 200, { access_token: "t" }) : json(res, 403, { error: { code: 403, message: "Access Denied: Table my-project-123:crm.users: Permission bigquery.tables.getData denied" } })));
    await expect(createBigQueryClient(config, key, { apiBase: denied, tokenUrl: `${denied}/token` }).query(bq)).rejects.toThrow(/Access Denied/);
    const capped = await fake((req, _b, res) => (req.url === "/token" ? json(res, 200, { access_token: "t" }) : json(res, 400, { error: { message: "Query exceeded limit for bytes billed: 5000000000. 12000000000 or higher required." } })));
    await expect(createBigQueryClient(config, key, { apiBase: capped, tokenUrl: `${capped}/token` }).query(bq)).rejects.toThrow(/bytes billed/);
    await expect(createBigQueryClient({ ...config, project_id: "../x" }, key).query(bq)).rejects.toThrow(/project id/);
    await expect(createBigQueryClient(config, { ...key, private_key: "nope" }).query(bq)).rejects.toThrow(/private key/);
  });

  it("converts each column type", () => {
    expect(bigqueryCell("42", "INT64")).toBe(42);
    expect(bigqueryCell("1.25", "NUMERIC")).toBe(1.25);
    expect(bigqueryCell("false", "BOOL")).toBe(false);
    expect(bigqueryCell("1767225600123456", "TIMESTAMP")).toBe("2026-01-01T00:00:00.123Z"); // microseconds, floored to ms
    expect(bigqueryCell("1.7672256E9", "TIMESTAMP")).toBe("2026-01-01T00:00:00.000Z"); // float seconds still understood
    expect(bigqueryCell("2026-01-01", "DATE")).toBe("2026-01-01");
    expect(bigqueryCell(null, "STRING")).toBeNull();
    expect(bigqueryCell({ a: 1 }, "RECORD")).toBe("{\"a\":1}");
  });
});
