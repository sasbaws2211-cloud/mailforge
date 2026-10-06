/**
 * Integration tests: a customer cannot use the SMTP settings to make the server
 * connect to its own network. Covers saving (PUT /v1/settings/transport), what is
 * already stored (a config saved before the guard existed must be refused at send
 * time too), the operator's exempt-host list, and that a self-hosted install is
 * unchanged.
 *
 * Needs a reachable Postgres via DATABASE_URL. Tenants have slugs starting with "smtpg-t-".
 */
import { createServer as createTcpServer, type Server } from "node:net";
import type { AddressInfo } from "node:net";
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import { SESSION_COOKIE_NAME } from "../src/routes/auth.js";
import { encrypt, parseEncryptionKey, resolveTransportAdapter } from "@mailforge/adapters";

const TEST_DB_URL = process.env.DATABASE_URL;
if (!TEST_DB_URL) throw new Error("[smtp-guard.test] DATABASE_URL is not set.");

const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
let pool: pg.Pool;
let db: ReturnType<typeof drizzle>;
let dbAvailable = false;
let app: FastifyInstance;
let savedKey: string | undefined;
let smtp: Server;
let smtpPort = 0;
let connections = 0;

const GUARD_ENV = ["MAILFORGE_RESTRICT_SMTP_HOSTS", "MAILFORGE_SMTP_ALLOWED_HOSTS", "MAILFORGE_SMTP_ALLOWED_PORTS", "MAILFORGE_PUBLIC_SITE", "MAILFORGE_ENFORCE_PLANS"];

beforeAll(async () => {
  savedKey = process.env.ENCRYPTION_KEY;
  process.env.ENCRYPTION_KEY = KEY;

  // A tiny SMTP server on 127.0.0.1: greets, answers EHLO, says goodbye. Counts connections.
  smtp = createTcpServer((socket) => {
    connections++;
    socket.write("220 test ESMTP\r\n");
    socket.on("data", (d) => {
      const text = d.toString();
      if (/^EHLO|^HELO/im.test(text)) socket.write("250-test\r\n250 OK\r\n");
      if (/^QUIT/im.test(text)) socket.end("221 bye\r\n");
    });
    socket.on("error", () => undefined);
  });
  await new Promise<void>((resolve) => smtp.listen(0, "127.0.0.1", resolve));
  smtpPort = (smtp.address() as AddressInfo).port;

  pool = new pg.Pool({ connectionString: TEST_DB_URL, connectionTimeoutMillis: 3000 });
  try {
    await pool.query("SELECT 1");
    db = drizzle(pool);
    dbAvailable = true;
  } catch (err) {
    if (process.env.CI === "true") throw new Error(`[smtp-guard.test] DATABASE_URL not reachable in CI: ${(err as Error).message}`);
    console.warn("[smtp-guard.test] DATABASE_URL not reachable - tests skipped.");
    return;
  }
  await cleanup();
  app = await buildApp({ logger: false, db, baseUrl: "http://localhost:3000", dashboardUrl: "http://localhost:3000" });
});

afterEach(async () => {
  if (!dbAvailable) return;
  for (const k of GUARD_ENV) delete process.env[k];
  connections = 0;
  await cleanup();
});

afterAll(async () => {
  for (const k of GUARD_ENV) delete process.env[k];
  if (savedKey !== undefined) process.env.ENCRYPTION_KEY = savedKey;
  else delete process.env.ENCRYPTION_KEY;
  if (app) await app.close();
  await pool?.end();
  await new Promise<void>((resolve) => smtp.close(() => resolve()));
});

async function q<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  return (await db.execute(query)).rows as T[];
}

let counter = 0;
async function newTenant(): Promise<{ id: string; session: string }> {
  const slug = `smtpg-t-${Date.now()}-${counter++}`;
  const [t] = await q<{ id: string }>(sql`INSERT INTO tenants (name, slug) VALUES (${slug}, ${slug}) RETURNING id`);
  const id = t!.id;
  const [u] = await q<{ id: string }>(sql`INSERT INTO users (tenant_id, email, role) VALUES (${id}::uuid, ${slug + "@smtpg.example"}, 'owner') RETURNING id`);
  const [s] = await q<{ id: string }>(sql`INSERT INTO sessions (tenant_id, user_id, expires_at) VALUES (${id}::uuid, ${u!.id}::uuid, now() + interval '1 day') RETURNING id`);
  return { id, session: s!.id };
}

async function cleanup() {
  const ids = (await q<{ id: string }>(sql`SELECT id FROM tenants WHERE slug LIKE 'smtpg-t-%'`)).map((r) => r.id);
  for (const id of ids) {
    for (const t of ["transport_configs", "sessions", "users"]) await db.execute(sql.raw(`DELETE FROM ${t} WHERE tenant_id = '${id}'`));
    await db.execute(sql`DELETE FROM tenants WHERE id = ${id}::uuid`);
  }
}

const put = (t: { session: string }, body: Record<string, unknown>) =>
  app.inject({ method: "PUT", url: "/v1/settings/transport", cookies: { [SESSION_COOKIE_NAME]: t.session }, payload: { provider: "smtp", from_email: "me@example.com", ...body } });
const stored = (t: { id: string }) => q(sql`SELECT 1 FROM transport_configs WHERE tenant_id = ${t.id}::uuid`);

describe("saving SMTP settings on a hosted install", () => {
  const hosted = () => {
    process.env.MAILFORGE_PUBLIC_SITE = "true";
  };

  it("refuses hosts that point at the inside, before connecting to anything, and stores nothing", async () => {
    hosted();
    const t = await newTenant();
    for (const host of ["127.0.0.1", "localhost", "169.254.169.254", "10.0.0.5", "192.168.1.1", "172.16.5.5", "::1", "[::ffff:127.0.0.1]", "service.internal", "2130706433", "0x7f.1", "127.1"]) {
      const r = await put(t, { host, port: smtpPort });
      expect(r.statusCode, host).toBe(400);
      expect(r.json().code, host).toBe("smtp_host_not_allowed");
    }
    expect(connections).toBe(0);
    expect(await stored(t)).toHaveLength(0);
  });

  it("refuses ports that are not mail ports, even on a public name", async () => {
    hosted();
    const t = await newTenant();
    const r = await put(t, { host: "smtp.example.com", port: 5432 });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/port is not allowed/);
    expect(await stored(t)).toHaveLength(0);
  });

  it("the message tells the customer what to do instead, without revealing anything about the server's network", async () => {
    hosted();
    const t = await newTenant();
    const r = await put(t, { host: "10.0.0.5", port: 587 });
    expect(r.json().error).toMatch(/public SMTP server/);
    expect(r.json().error).not.toMatch(/10\.0\.0\.5|private network|metadata/i);
  });

  it("the operator's exempt-host list lets a trusted relay through (and then it is verified like any other)", async () => {
    hosted();
    process.env.MAILFORGE_SMTP_ALLOWED_HOSTS = "127.0.0.1";
    const t = await newTenant();
    const r = await put(t, { host: "127.0.0.1", port: smtpPort });
    expect(r.statusCode).toBe(200);
    expect(connections).toBeGreaterThan(0);
    expect(await stored(t)).toHaveLength(1);
    // A different private address is still refused.
    expect((await put(t, { host: "127.0.0.2", port: smtpPort })).statusCode).toBe(400);
  });

  it("MAILFORGE_RESTRICT_SMTP_HOSTS=false turns it off even on a hosted install", async () => {
    hosted();
    process.env.MAILFORGE_RESTRICT_SMTP_HOSTS = "false";
    const t = await newTenant();
    expect((await put(t, { host: "127.0.0.1", port: smtpPort })).statusCode).toBe(200);
  });

  it("is also on when only plan enforcement is on", async () => {
    process.env.MAILFORGE_ENFORCE_PLANS = "true";
    const t = await newTenant();
    expect((await put(t, { host: "127.0.0.1", port: smtpPort })).statusCode).toBe(400);
  });
});

describe("a self-hosted install is unchanged", () => {
  it("a local relay on a private address and any port still works", async () => {
    const t = await newTenant();
    const r = await put(t, { host: "127.0.0.1", port: smtpPort });
    expect(r.statusCode).toBe(200);
    expect(connections).toBeGreaterThan(0);
  });
});

describe("a config that was saved before the guard existed", () => {
  const legacy = (host: string, port: number) =>
    encrypt(JSON.stringify({ host, port, secure: false, rejectUnauthorized: true }), parseEncryptionKey(KEY));
  const params = { to: "a@example.com", from: "b@example.com", subject: "s", bodyHtml: "<p>x</p>", bodyText: "x", messageId: "m1" };

  it("is refused at send time on a hosted install, without connecting, so old data cannot be used to reach the inside either", async () => {
    process.env.MAILFORGE_PUBLIC_SITE = "true";
    const r = resolveTransportAdapter("smtp", legacy("127.0.0.1", smtpPort));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const result = await r.transport.adapter.send(params);
    expect(result).toMatchObject({ success: false, permanent: false });
    expect(connections).toBe(0);
  });

  it("still sends on a self-hosted install", async () => {
    const r = resolveTransportAdapter("smtp", legacy("127.0.0.1", smtpPort));
    if (!r.ok) throw new Error("expected ok");
    // The stub does not accept mail, so do not wait for the send to finish: it is enough that a connection is made.
    void r.transport.adapter.send(params).catch(() => undefined);
    for (let i = 0; i < 40 && connections === 0; i++) await new Promise((res) => setTimeout(res, 50));
    expect(connections).toBeGreaterThan(0);
    (r.transport.adapter as { close?: () => void }).close?.();
  });
});
