/**
 * Integration tests for the platform email sender fallback on /auth/login.
 *
 * A fake SMTP server stands in for the operator's mail relay, so the platform
 * sender is exercised end to end over a real SMTP conversation.
 *
 * Needs a reachable Postgres via DATABASE_URL, like the other *.db tests.
 */
import net from "node:net";
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { sql } from "drizzle-orm";
import { encrypt, parseEncryptionKey } from "@mailforge/adapters";
import { buildApp } from "../src/index.js";

const TEST_DB_URL = process.env.DATABASE_URL;
if (!TEST_DB_URL) throw new Error("[platform-login.test] DATABASE_URL is not set.");

const DOMAIN = "@platform-login-test.example";
const TEST_ENCRYPTION_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

let pool: pg.Pool;
let db: ReturnType<typeof drizzle>;
let dbAvailable = false;

// ---------------------------------------------------------------------------
// Fake SMTP relay: accepts mail, records it, optionally rejects it.
// ---------------------------------------------------------------------------

interface Captured {
  from: string;
  to: string[];
  data: string;
}

function startFakeSmtp(opts: { rejectData?: boolean } = {}): Promise<{ port: number; mail: Captured[]; close: () => Promise<void> }> {
  const mail: Captured[] = [];
  const server = net.createServer((sock) => {
    let buf = "";
    let inData = false;
    let cur: Captured = { from: "", to: [], data: "" };
    sock.write("220 fake ESMTP\r\n");
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      for (;;) {
        if (inData) {
          const end = buf.indexOf("\r\n.\r\n");
          if (end < 0) return;
          cur.data = buf.slice(0, end);
          buf = buf.slice(end + 5);
          inData = false;
          if (opts.rejectData) {
            sock.write("550 mailbox unavailable\r\n");
          } else {
            mail.push(cur);
            sock.write("250 queued\r\n");
          }
          cur = { from: "", to: [], data: "" };
          continue;
        }
        const nl = buf.indexOf("\r\n");
        if (nl < 0) return;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === "EHLO" || cmd === "HELO") sock.write("250-fake\r\n250 8BITMIME\r\n");
        else if (cmd === "MAIL") {
          cur.from = (line.match(/<([^>]*)>/) ?? [])[1] ?? "";
          sock.write("250 ok\r\n");
        } else if (cmd === "RCPT") {
          cur.to.push((line.match(/<([^>]*)>/) ?? [])[1] ?? "");
          sock.write("250 ok\r\n");
        } else if (cmd === "DATA") {
          inData = true;
          sock.write("354 go\r\n");
        } else if (cmd === "QUIT") {
          sock.write("221 bye\r\n");
          sock.end();
        } else sock.write("250 ok\r\n");
      }
    });
    sock.on("error", () => {});
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port;
      resolve({ port, mail, close: () => new Promise<void>((r) => server.close(() => r())) });
    });
  });
}

/** Decode quoted-printable so assertions can read the message body. */
function decodeBody(data: string): string {
  return data.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const saved: Record<string, string | undefined> = {};
function setEnv(vars: Record<string, string>): void {
  for (const [k, v] of Object.entries(vars)) {
    if (!(k in saved)) saved[k] = process.env[k];
    process.env[k] = v;
  }
}

async function makeTenantWithUser(slug: string, email: string): Promise<string> {
  const t = await db.execute<{ id: string }>(
    sql`INSERT INTO tenants (name, slug, plan) VALUES (${"Platform Login " + slug}, ${slug}, 'free') RETURNING id`,
  );
  const tenantId = t.rows[0]!.id;
  await db.execute(sql`INSERT INTO users (tenant_id, email, role) VALUES (${tenantId}::uuid, ${email}, 'owner')`);
  return tenantId;
}

async function cleanup(): Promise<void> {
  const ids = await db.execute<{ tenant_id: string }>(sql`SELECT DISTINCT tenant_id FROM users WHERE email LIKE ${"%" + DOMAIN}`);
  for (const { tenant_id } of ids.rows) {
    await db.execute(sql`DELETE FROM magic_link_tokens WHERE tenant_id = ${tenant_id}`);
    await db.execute(sql`DELETE FROM transport_configs WHERE tenant_id = ${tenant_id}`);
    await db.execute(sql`DELETE FROM sessions WHERE tenant_id = ${tenant_id}`);
    await db.execute(sql`DELETE FROM users WHERE tenant_id = ${tenant_id}`);
    await db.execute(sql`DELETE FROM tenants WHERE id = ${tenant_id}`);
  }
}

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: TEST_DB_URL, connectionTimeoutMillis: 3000 });
  try {
    await pool.query("SELECT 1");
    db = drizzle(pool);
    dbAvailable = true;
  } catch (err) {
    if (process.env.CI === "true") throw new Error(`[platform-login.test] DATABASE_URL not reachable in CI: ${(err as Error).message}`);
    console.warn("[platform-login.test] DATABASE_URL not reachable - tests skipped.");
    return;
  }
  await cleanup();
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
    delete saved[k];
  }
  if (dbAvailable) await cleanup();
});

afterAll(async () => {
  await pool?.end();
});

async function login(email: string) {
  const app = await buildApp({ logger: false, db, baseUrl: "http://localhost:3000", dashboardUrl: "http://localhost:3000" });
  const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email } });
  await app.close();
  return res;
}

describe("login link via the platform sender", () => {
  it("a workspace with no transport of its own gets its link from the platform sender", async () => {
    if (!dbAvailable) return;
    const smtp = await startFakeSmtp();
    try {
      setEnv({ NODE_ENV: "test", PLATFORM_FROM_EMAIL: "no-reply@platform.example", PLATFORM_FROM_NAME: "Acme Platform", PLATFORM_SMTP_HOST: "127.0.0.1", PLATFORM_SMTP_PORT: String(smtp.port) });
      const email = `new1${DOMAIN}`;
      await makeTenantWithUser("platform-login-1", email);
      const log = vi.spyOn(console, "log").mockImplementation(() => {});

      const res = await login(email);

      expect(res.statusCode).toBe(200);
      expect(res.json().message).toBe("If that email is registered, a login link has been sent.");
      expect(smtp.mail).toHaveLength(1);
      expect(smtp.mail[0]!.to).toEqual([email]);
      expect(smtp.mail[0]!.from).toBe("no-reply@platform.example");
      const raw = decodeBody(smtp.mail[0]!.data);
      expect(raw).toContain("Acme Platform");
      expect(raw).toContain("Subject: Your login link");
      expect(raw).toContain("/auth/verify?token=");
      // Transactional: no marketing unsubscribe header.
      expect(raw).not.toMatch(/^List-Unsubscribe:/im);
      // The link went by email, not to the server console.
      expect(log.mock.calls.flat().join(" ")).not.toContain("/auth/verify?token=");
    } finally {
      await smtp.close();
    }
  });

  it("when the relay rejects the message it falls back to the console and still answers 200", async () => {
    if (!dbAvailable) return;
    const smtp = await startFakeSmtp({ rejectData: true });
    try {
      setEnv({ NODE_ENV: "test", PLATFORM_FROM_EMAIL: "no-reply@platform.example", PLATFORM_SMTP_HOST: "127.0.0.1", PLATFORM_SMTP_PORT: String(smtp.port) });
      const email = `reject1${DOMAIN}`;
      await makeTenantWithUser("platform-login-2", email);
      const log = vi.spyOn(console, "log").mockImplementation(() => {});

      const res = await login(email);

      expect(res.statusCode).toBe(200);
      expect(smtp.mail).toHaveLength(0);
      expect(log.mock.calls.flat().join(" ")).toContain("/auth/verify?token=");
    } finally {
      await smtp.close();
    }
  });

  it("a workspace's own transport takes priority over the platform sender", async () => {
    if (!dbAvailable) return;
    const smtp = await startFakeSmtp();
    try {
      setEnv({
        NODE_ENV: "test",
        ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
        PLATFORM_FROM_EMAIL: "no-reply@platform.example",
        PLATFORM_SMTP_HOST: "127.0.0.1",
        PLATFORM_SMTP_PORT: String(smtp.port),
      });
      const email = `own1${DOMAIN}`;
      const tenantId = await makeTenantWithUser("platform-login-3", email);
      const encrypted = encrypt(JSON.stringify({ apiKey: "re_test_fake_key" }), parseEncryptionKey(TEST_ENCRYPTION_KEY));
      await db.execute(sql`
        INSERT INTO transport_configs (tenant_id, provider, config, is_active, from_email, from_name)
        VALUES (${tenantId}::uuid, 'resend', ${encrypted}::jsonb, true, 'hello@tenant.example', 'Tenant Co')`);

      const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: "m1" }) });
      const originalFetch = globalThis.fetch;
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        const res = await login(email);
        expect(res.statusCode).toBe(200);
      } finally {
        globalThis.fetch = originalFetch;
      }

      // Sent by the tenant's own provider, from the tenant's own address...
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(JSON.parse(fetchMock.mock.calls[0]![1].body as string).from).toContain("hello@tenant.example");
      // ...and the platform relay was never used.
      expect(smtp.mail).toHaveLength(0);
    } finally {
      await smtp.close();
    }
  });

  it("with no platform sender and no transport the link prints to the console, as before", async () => {
    if (!dbAvailable) return;
    setEnv({ NODE_ENV: "test" });
    const email = `none1${DOMAIN}`;
    await makeTenantWithUser("platform-login-4", email);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const res = await login(email);
    expect(res.statusCode).toBe(200);
    expect(res.json().message).toBe("Login link printed to server console.");
    expect(log.mock.calls.flat().join(" ")).toContain("/auth/verify?token=");
  });

  it("in production with no sender at all it neither prints nor leaks the link", async () => {
    if (!dbAvailable) return;
    setEnv({ NODE_ENV: "production" });
    const email = `prod1${DOMAIN}`;
    await makeTenantWithUser("platform-login-5", email);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const res = await login(email);
    expect(res.statusCode).toBe(200);
    expect(res.json().message).toBe("If that email is registered, a login link has been sent.");
    expect(log.mock.calls.flat().join(" ")).not.toContain("/auth/verify?token=");
  });
});
