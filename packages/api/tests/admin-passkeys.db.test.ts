/**
 * Integration tests for passkeys on the standalone admin console. A software
 * authenticator builds real WebAuthn messages, so the server's genuine verification
 * runs against valid ones and against every kind of faulty or hostile one.
 *
 * Needs a reachable Postgres via DATABASE_URL, like the other *.db tests.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { TransportAdapter, TransportSendParams, TransportSendResult } from "@mailforge/adapters";
import { buildAdminApp, ADMIN_SESSION_COOKIE } from "../src/index.js";
import { passkeyModeFromEnv } from "../src/admin/passkeys.js";
import { VirtualAuthenticator, type Faults } from "./helpers/virtual-authenticator.js";

const TEST_DB_URL = process.env.DATABASE_URL;
if (!TEST_DB_URL) throw new Error("[admin-passkeys.test] DATABASE_URL is not set.");

const OPS = "ops@adm-p.example";
const OTHER = "second@adm-p.example";
const ADMIN_URL = "http://localhost:3011";
const RP_ID = "localhost";
const HOST_LIMIT = { perEmail: 10_000, perIp: 10_000 };

class Outbox implements TransportAdapter {
  sent: TransportSendParams[] = [];
  async send(p: TransportSendParams): Promise<TransportSendResult> {
    this.sent.push(p);
    return { success: true, providerMessageId: `m-${this.sent.length}` };
  }
}
const loginBox = new Outbox();

let pool: pg.Pool;
let db: ReturnType<typeof drizzle>;
let dbAvailable = false;
let optional: FastifyInstance;
let enforced: FastifyInstance;
let off: FastifyInstance;
let https: FastifyInstance;
let strict: FastifyInstance;

async function q<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  return (await db.execute(query)).rows as T[];
}
const count = async (table: string, where = "TRUE") => Number((await q<{ n: string }>(sql.raw(`SELECT count(*)::text AS n FROM ${table} WHERE ${where}`)))[0]!.n);

async function cleanup(): Promise<void> {
  await db.execute(sql`DELETE FROM admin_passkeys WHERE email LIKE '%@adm-p.example'`);
  await db.execute(sql`DELETE FROM admin_sessions WHERE email LIKE '%@adm-p.example'`);
  await db.execute(sql`DELETE FROM admin_login_tokens WHERE email LIKE '%@adm-p.example'`);
  await db.execute(sql`DELETE FROM admin_passkey_challenges`);
}

// ---- helpers -----------------------------------------------------------------------
let ipCounter = 0;
const nextIp = () => `10.20.${Math.floor(ipCounter / 250) % 250}.${(ipCounter++ % 250) + 1}`;
const cookieOf = (res: { cookies: Array<{ name: string; value: string }> }) => res.cookies.find((c) => c.name === ADMIN_SESSION_COOKIE)?.value;
const call = (a: FastifyInstance, method: "GET" | "POST" | "DELETE", url: string, session: string | null, payload?: unknown, extra: { headers?: Record<string, string>; ip?: string } = {}) =>
  a.inject({ method, url, cookies: session ? { [ADMIN_SESSION_COOKIE]: session } : {}, payload: payload as object | undefined, headers: extra.headers, remoteAddress: extra.ip ?? nextIp() });

/** Sign in with an emailed link and return the session id. */
async function emailSession(email = OPS, a: FastifyInstance = optional): Promise<string> {
  loginBox.sent = [];
  await a.inject({ method: "POST", url: "/admin-auth/login", payload: { email }, remoteAddress: nextIp() });
  const token = /token=([A-Za-z0-9_-]+)/.exec(loginBox.sent[loginBox.sent.length - 1]!.bodyText)![1]!;
  const res = await a.inject({ method: "POST", url: "/admin-auth/verify", headers: { "content-type": "application/x-www-form-urlencoded" }, payload: `token=${token}` });
  return cookieOf(res)!;
}

interface RegisterResult {
  options: { challenge: string; user: { id: string }; rp: { id: string } } & Record<string, unknown>;
  challengeId: string;
  verify: Awaited<ReturnType<typeof call>>;
}
/** The whole "add a passkey" ceremony; `tweak` lets a test corrupt what the device sends. */
async function register(a: FastifyInstance, session: string, auth: VirtualAuthenticator, opts: { name?: string; faults?: Faults; challengeId?: string } = {}): Promise<RegisterResult> {
  const opt = (await call(a, "POST", "/admin-auth/passkeys/register/options", session)).json();
  const response = auth.create(opt.options, opts.faults);
  const verify = await call(a, "POST", "/admin-auth/passkeys/register/verify", session, { challenge_id: opts.challengeId ?? opt.challenge_id, response, name: opts.name });
  return { options: opt.options, challengeId: opt.challenge_id, verify };
}

/** The whole passkey sign-in ceremony. */
async function passkeyLogin(a: FastifyInstance, auth: VirtualAuthenticator, faults: Faults = {}) {
  const opt = (await call(a, "POST", "/admin-auth/passkey/options", null)).json();
  const response = auth.get(opt.options, faults);
  const verify = await call(a, "POST", "/admin-auth/passkey/verify", null, { challenge_id: opt.challenge_id, response });
  return { opt, response, verify };
}

/** An administrator with a passkey registered; returns what a test needs. */
async function withPasskey(email = OPS, a: FastifyInstance = optional) {
  const session = await emailSession(email, a);
  const auth = new VirtualAuthenticator(ADMIN_URL, RP_ID);
  const r = await register(a, session, auth, { name: "Test laptop" });
  expect(r.verify.statusCode).toBe(200);
  return { session, auth };
}

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: TEST_DB_URL, connectionTimeoutMillis: 3000 });
  try {
    await pool.query("SELECT 1");
    db = drizzle(pool);
    dbAvailable = true;
  } catch (err) {
    if (process.env.CI === "true") throw new Error(`[admin-passkeys.test] DATABASE_URL not reachable in CI: ${(err as Error).message}`);
    console.warn("[admin-passkeys.test] DATABASE_URL not reachable - tests skipped.");
    return;
  }
  await cleanup();
  process.env.MAILFORGE_PLATFORM_ADMINS = `${OPS}, ${OTHER}`;
  const base = { logger: false as const, db: db as never, adminUrl: ADMIN_URL, loginTransports: [{ adapter: loginBox, fromEmail: "no-reply@platform.example", fromName: null }], loginLimits: HOST_LIMIT };
  optional = await buildAdminApp({ ...base, passkeys: { mode: "optional" } });
  enforced = await buildAdminApp({ ...base, passkeys: { mode: "enforced" } });
  off = await buildAdminApp({ ...base, passkeys: { mode: "off" } });
  https = await buildAdminApp({ ...base, adminUrl: "https://admin.example.com", passkeys: { mode: "optional" } });
  strict = await buildAdminApp({ ...base, passkeys: { mode: "optional" } });
});

beforeEach(() => {
  loginBox.sent = [];
});
afterEach(async () => {
  if (dbAvailable) await cleanup();
});
afterAll(async () => {
  delete process.env.MAILFORGE_PLATFORM_ADMINS;
  for (const a of [optional, enforced, off, https, strict]) if (a) await a.close();
  await pool?.end();
});

// ===========================================================================
describe("configuration", () => {
  it("MAILFORGE_ADMIN_PASSKEYS defaults to optional and accepts only the three modes", () => {
    expect(passkeyModeFromEnv(undefined)).toBe("optional");
    expect(passkeyModeFromEnv("")).toBe("optional");
    expect(passkeyModeFromEnv(" Enforced ")).toBe("enforced");
    expect(passkeyModeFromEnv("off")).toBe("off");
    // A typo must not quietly become something weaker than intended.
    for (const bad of ["enforce", "required", "on", "true", "1"]) expect(() => passkeyModeFromEnv(bad), bad).toThrow(/not valid/);
  });

  it("tells the sign-in page what to offer", async () => {
    if (!dbAvailable) return;
    expect((await call(optional, "GET", "/admin-auth/config", null)).json()).toEqual({ passkeys: true, passkey_mode: "optional" });
    expect((await call(enforced, "GET", "/admin-auth/config", null)).json()).toEqual({ passkeys: true, passkey_mode: "enforced" });
    expect((await call(off, "GET", "/admin-auth/config", null)).json()).toEqual({ passkeys: false, passkey_mode: "off" });
  });

  it("with passkeys off there are no passkey endpoints at all", async () => {
    if (!dbAvailable) return;
    const s = await emailSession(OPS, off);
    for (const [method, url] of [
      ["POST", "/admin-auth/passkey/options"],
      ["POST", "/admin-auth/passkey/verify"],
      ["GET", "/admin-auth/passkeys"],
      ["POST", "/admin-auth/passkeys/register/options"],
    ] as const) {
      expect((await call(off, method, url, s)).statusCode, url).toBe(404);
    }
    const me = (await call(off, "GET", "/admin-auth/me", s)).json();
    expect(me).toMatchObject({ passkey_mode: "off", passkey_count: 0 });
  });
});

// ===========================================================================
describe("adding a passkey", () => {
  it("needs a signed-in administrator on every route", async () => {
    if (!dbAvailable) return;
    for (const [method, url] of [
      ["GET", "/admin-auth/passkeys"],
      ["POST", "/admin-auth/passkeys/register/options"],
      ["POST", "/admin-auth/passkeys/register/verify"],
      ["DELETE", "/admin-auth/passkeys/abc"],
    ] as const) {
      expect((await call(optional, method, url, null, method === "POST" ? {} : undefined)).statusCode, url).toBe(401);
    }
  });

  it("asks the device for a discoverable, user-verified credential, bound to this site, with no attestation", async () => {
    if (!dbAvailable) return;
    const s = await emailSession();
    const body = (await call(optional, "POST", "/admin-auth/passkeys/register/options", s)).json();
    const o = body.options;
    expect(o.rp.id).toBe(RP_ID);
    expect(o.user.name).toBe(OPS);
    expect(o.attestation).toBe("none");
    expect(o.authenticatorSelection).toMatchObject({ residentKey: "required", userVerification: "required" });
    expect(o.challenge.length).toBeGreaterThanOrEqual(32);
    expect(o.excludeCredentials ?? []).toEqual([]);
    expect(body.challenge_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("each request gets a fresh challenge, and an administrator keeps the same opaque user id, distinct from others and from their email", async () => {
    if (!dbAvailable) return;
    const a = await emailSession(OPS);
    const b = await emailSession(OTHER);
    const o1 = (await call(optional, "POST", "/admin-auth/passkeys/register/options", a)).json().options;
    const o2 = (await call(optional, "POST", "/admin-auth/passkeys/register/options", a)).json().options;
    const o3 = (await call(optional, "POST", "/admin-auth/passkeys/register/options", b)).json().options;
    expect(o1.challenge).not.toBe(o2.challenge);
    expect(o1.user.id).toBe(o2.user.id);
    expect(o1.user.id).not.toBe(o3.user.id);
    expect(Buffer.from(o1.user.id, "base64url").toString()).not.toContain("adm-p");
  });

  it("stores only the public key, with a name, and lists it", async () => {
    if (!dbAvailable) return;
    const s = await emailSession();
    const auth = new VirtualAuthenticator(ADMIN_URL, RP_ID);
    const r = await register(optional, s, auth, { name: "  Work laptop  " });
    expect(r.verify.statusCode).toBe(200);
    expect(r.verify.json()).toMatchObject({ ok: true, id: auth.id, name: "Work laptop" });
    const [row] = await q<{ email: string; counter: string; name: string; public_key: string; last_used_at: Date | null }>(sql`SELECT email, counter::text, name, public_key, last_used_at FROM admin_passkeys WHERE id = ${auth.id}`);
    expect(row).toMatchObject({ email: OPS, counter: "0", name: "Work laptop", last_used_at: null });
    expect(row!.public_key.length).toBeGreaterThan(40);
    const list = (await call(optional, "GET", "/admin-auth/passkeys", s)).json().passkeys;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: auth.id, name: "Work laptop", last_used_at: null });
    expect(JSON.stringify(list)).not.toContain(row!.public_key);
  });

  it("names it 'Passkey' when no name is given and cuts a long name to 60 characters", async () => {
    if (!dbAvailable) return;
    const s = await emailSession();
    const a1 = new VirtualAuthenticator(ADMIN_URL, RP_ID);
    const a2 = new VirtualAuthenticator(ADMIN_URL, RP_ID);
    await register(optional, s, a1, { name: "   " });
    await register(optional, s, a2, { name: "x".repeat(200) });
    const names = (await call(optional, "GET", "/admin-auth/passkeys", s)).json().passkeys.map((p: { name: string }) => p.name);
    expect(names).toContain("Passkey");
    expect(names).toContain("x".repeat(60));
  });

  it("offers the browser the passkeys already registered, so one device is not enrolled twice", async () => {
    if (!dbAvailable) return;
    const { session, auth } = await withPasskey();
    const o = (await call(optional, "POST", "/admin-auth/passkeys/register/options", session)).json().options;
    expect(o.excludeCredentials.map((c: { id: string }) => c.id)).toEqual([auth.id]);
  });

  it("refuses the same credential twice if a client ignores that", async () => {
    if (!dbAvailable) return;
    const { session, auth } = await withPasskey();
    const again = await register(optional, session, auth);
    expect(again.verify.statusCode).toBe(409);
    expect(again.verify.json().code).toBe("duplicate");
    expect(await count("admin_passkeys", "email = 'ops@adm-p.example'")).toBe(1);
  });

  it("registers under the signed-in administrator's email, whatever the request says", async () => {
    if (!dbAvailable) return;
    const s = await emailSession(OPS);
    const auth = new VirtualAuthenticator(ADMIN_URL, RP_ID);
    const opt = (await call(optional, "POST", "/admin-auth/passkeys/register/options", s)).json();
    await call(optional, "POST", "/admin-auth/passkeys/register/verify", s, { challenge_id: opt.challenge_id, response: auth.create(opt.options), email: OTHER });
    expect((await q<{ email: string }>(sql`SELECT email FROM admin_passkeys WHERE id = ${auth.id}`))[0]!.email).toBe(OPS);
  });

  it("limits an administrator to 10", async () => {
    if (!dbAvailable) return;
    const s = await emailSession();
    for (let i = 0; i < 10; i++) {
      await db.execute(sql`INSERT INTO admin_passkeys (id, email, public_key, name) VALUES (${"fake-" + i}, ${OPS}, 'x', ${"d" + i})`);
    }
    const res = await call(optional, "POST", "/admin-auth/passkeys/register/options", s);
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("too_many");
  });

  describe("refuses what a real attacker or a broken device could send", () => {
    const cases: Array<[string, Faults]> = [
      ["a different origin (a look-alike site)", { origin: "https://evil.example" }],
      ["the same host on another port", { origin: "http://localhost:4000" }],
      ["a different site name", { rpId: "evil.example" }],
      ["no user verification (a bare tap)", { noUserVerification: true }],
      ["no user presence", { noUserPresence: true }],
      ["the wrong ceremony type", { type: "webauthn.get" }],
      ["a challenge the server did not issue", { challenge: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }],
    ];
    for (const [name, faults] of cases) {
      it(name, async () => {
        if (!dbAvailable) return;
        const s = await emailSession();
        const auth = new VirtualAuthenticator(ADMIN_URL, RP_ID);
        const r = await register(optional, s, auth, { faults });
        expect(r.verify.statusCode).toBe(400);
        expect(await count("admin_passkeys")).toBe(0);
      });
    }

    it("a challenge used twice", async () => {
      if (!dbAvailable) return;
      const s = await emailSession();
      const auth = new VirtualAuthenticator(ADMIN_URL, RP_ID);
      const first = await register(optional, s, auth);
      expect(first.verify.statusCode).toBe(200);
      await db.execute(sql`DELETE FROM admin_passkeys WHERE id = ${auth.id}`);
      const replay = await call(optional, "POST", "/admin-auth/passkeys/register/verify", s, { challenge_id: first.challengeId, response: auth.create(first.options) });
      expect(replay.statusCode).toBe(400);
      expect(await count("admin_passkeys")).toBe(0);
    });

    it("an expired challenge", async () => {
      if (!dbAvailable) return;
      const s = await emailSession();
      const auth = new VirtualAuthenticator(ADMIN_URL, RP_ID);
      const opt = (await call(optional, "POST", "/admin-auth/passkeys/register/options", s)).json();
      await db.execute(sql`UPDATE admin_passkey_challenges SET expires_at = now() - interval '1 second'`);
      const res = await call(optional, "POST", "/admin-auth/passkeys/register/verify", s, { challenge_id: opt.challenge_id, response: auth.create(opt.options) });
      expect(res.statusCode).toBe(400);
    });

    it("a challenge that was issued to a different administrator", async () => {
      if (!dbAvailable) return;
      const mine = await emailSession(OPS);
      const theirs = await emailSession(OTHER);
      const auth = new VirtualAuthenticator(ADMIN_URL, RP_ID);
      const opt = (await call(optional, "POST", "/admin-auth/passkeys/register/options", theirs)).json();
      const res = await call(optional, "POST", "/admin-auth/passkeys/register/verify", mine, { challenge_id: opt.challenge_id, response: auth.create(opt.options) });
      expect(res.statusCode).toBe(400);
      expect(await count("admin_passkeys")).toBe(0);
    });

    it("a sign-in challenge presented as a registration one", async () => {
      if (!dbAvailable) return;
      const s = await emailSession();
      const auth = new VirtualAuthenticator(ADMIN_URL, RP_ID);
      const login = (await call(optional, "POST", "/admin-auth/passkey/options", null)).json();
      const res = await call(optional, "POST", "/admin-auth/passkeys/register/verify", s, { challenge_id: login.challenge_id, response: auth.create({ ...login.options, user: { id: "AA" } }) });
      expect(res.statusCode).toBe(400);
      expect(await count("admin_passkeys")).toBe(0);
    });

    it("missing, malformed or unknown input", async () => {
      if (!dbAvailable) return;
      const s = await emailSession();
      for (const body of [{}, { challenge_id: "nope" }, { challenge_id: "00000000-0000-4000-8000-000000000000", response: {} }, { challenge_id: 5, response: "x" }]) {
        expect((await call(optional, "POST", "/admin-auth/passkeys/register/verify", s, body)).statusCode, JSON.stringify(body)).toBe(400);
      }
    });
  });
});

// ===========================================================================
describe("signing in with a passkey", () => {
  it("needs no email address: the options name no account and accept any registered passkey", async () => {
    if (!dbAvailable) return;
    await withPasskey();
    const body = (await call(optional, "POST", "/admin-auth/passkey/options", null)).json();
    expect(body.options.rpId).toBe(RP_ID);
    expect(body.options.userVerification).toBe("required");
    expect(body.options.allowCredentials ?? []).toEqual([]);
    expect(body.options.challenge.length).toBeGreaterThanOrEqual(32);
  });

  it("signs the administrator in, as the person the passkey belongs to, with a passkey session", async () => {
    if (!dbAvailable) return;
    const { auth } = await withPasskey(OTHER);
    const { verify } = await passkeyLogin(optional, auth);
    expect(verify.statusCode).toBe(200);
    expect(verify.json()).toEqual({ ok: true });
    const session = cookieOf(verify)!;
    expect(session).toMatch(/^[0-9a-f-]{36}$/);
    const me = (await call(optional, "GET", "/admin-auth/me", session)).json();
    expect(me).toMatchObject({ email: OTHER, method: "passkey", passkey_mode: "optional", passkey_count: 1 });
    expect((await call(optional, "GET", "/v1/admin/overview", session)).statusCode).toBe(200);
    expect((await q<{ method: string }>(sql`SELECT method FROM admin_sessions WHERE id = ${session}::uuid`))[0]!.method).toBe("passkey");
  });

  it("the session cookie is HttpOnly and SameSite=Lax, and Secure over https", async () => {
    if (!dbAvailable) return;
    const { auth } = await withPasskey();
    const set = String(([] as string[]).concat((await passkeyLogin(optional, auth)).verify.headers["set-cookie"] as string | string[])[0]);
    expect(set).toMatch(/HttpOnly/i);
    expect(set).toMatch(/SameSite=Lax/i);
    expect(set).not.toMatch(/Secure/i);

    const s = await emailSession(OTHER, https);
    const httpsAuth = new VirtualAuthenticator("https://admin.example.com", "admin.example.com");
    const reg = await register(https, s, httpsAuth);
    // The https app binds passkeys to its own host name, not to localhost.
    expect(reg.options.rp.id).toBe("admin.example.com");
    expect(reg.verify.statusCode).toBe(200);
    const sh = String(([] as string[]).concat((await passkeyLogin(https, httpsAuth)).verify.headers["set-cookie"] as string | string[])[0]);
    expect(sh).toMatch(/Secure/i);
  });

  it("records the use: counter advances and last-used is set", async () => {
    if (!dbAvailable) return;
    const { auth } = await withPasskey();
    await passkeyLogin(optional, auth);
    await passkeyLogin(optional, auth);
    const [row] = await q<{ counter: string; last_used_at: Date | null }>(sql`SELECT counter::text, last_used_at FROM admin_passkeys WHERE id = ${auth.id}`);
    expect(row!.counter).toBe("2");
    expect(row!.last_used_at).not.toBeNull();
  });

  it("works with an authenticator that never counts (always reports 0), as many phones do", async () => {
    if (!dbAvailable) return;
    const { auth } = await withPasskey();
    for (let i = 0; i < 3; i++) expect((await passkeyLogin(optional, auth, { counter: 0 })).verify.statusCode).toBe(200);
  });

  it("two administrators each sign in to their own account", async () => {
    if (!dbAvailable) return;
    const a = await withPasskey(OPS);
    const b = await withPasskey(OTHER);
    const sa = cookieOf((await passkeyLogin(optional, a.auth)).verify)!;
    const sb = cookieOf((await passkeyLogin(optional, b.auth)).verify)!;
    expect((await call(optional, "GET", "/admin-auth/me", sa)).json().email).toBe(OPS);
    expect((await call(optional, "GET", "/admin-auth/me", sb)).json().email).toBe(OTHER);
  });

  describe("refuses what a real attacker or a broken device could send", () => {
    const cases: Array<[string, Faults]> = [
      ["a different origin (phishing site)", { origin: "https://evil.example" }],
      ["the same host on another port", { origin: "http://localhost:4000" }],
      ["a different site name", { rpId: "evil.example" }],
      ["no user verification", { noUserVerification: true }],
      ["no user presence", { noUserPresence: true }],
      ["a tampered signature", { tamperSignature: true }],
      ["a signature from a different key", { wrongKey: true }],
      ["a challenge the server did not issue", { challenge: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }],
      ["the wrong ceremony type", { type: "webauthn.create" }],
    ];
    for (const [name, faults] of cases) {
      it(name, async () => {
        if (!dbAvailable) return;
        const { auth } = await withPasskey();
        const { verify } = await passkeyLogin(optional, auth, faults);
        expect(verify.statusCode).toBe(400);
        expect(verify.json()).toEqual({ error: "That passkey could not be verified." });
        expect(cookieOf(verify)).toBeUndefined();
        expect(await count("admin_sessions", "method = 'passkey'")).toBe(0);
      });
    }

    it("a passkey the server has never seen (and answers exactly like any other failure)", async () => {
      if (!dbAvailable) return;
      await withPasskey();
      const stranger = new VirtualAuthenticator(ADMIN_URL, RP_ID);
      const { verify } = await passkeyLogin(optional, stranger);
      expect(verify.statusCode).toBe(400);
      expect(verify.json()).toEqual({ error: "That passkey could not be verified." });
    });

    it("a recorded sign-in replayed later (the challenge is spent)", async () => {
      if (!dbAvailable) return;
      const { auth } = await withPasskey();
      const first = await passkeyLogin(optional, auth);
      expect(first.verify.statusCode).toBe(200);
      const replay = await call(optional, "POST", "/admin-auth/passkey/verify", null, { challenge_id: first.opt.challenge_id, response: first.response });
      expect(replay.statusCode).toBe(400);
    });

    it("a counter that goes backwards or stands still once it has counted (a cloned credential)", async () => {
      if (!dbAvailable) return;
      const { auth } = await withPasskey();
      expect((await passkeyLogin(optional, auth)).verify.statusCode).toBe(200); // counter 1
      expect((await passkeyLogin(optional, auth, { counter: 1 })).verify.statusCode).toBe(400);
      expect((await passkeyLogin(optional, auth, { counter: 0 })).verify.statusCode).toBe(400);
      expect((await passkeyLogin(optional, auth, { counter: 5 })).verify.statusCode).toBe(200);
    });

    it("an expired challenge", async () => {
      if (!dbAvailable) return;
      const { auth } = await withPasskey();
      const opt = (await call(optional, "POST", "/admin-auth/passkey/options", null)).json();
      await db.execute(sql`UPDATE admin_passkey_challenges SET expires_at = now() - interval '1 second'`);
      const res = await call(optional, "POST", "/admin-auth/passkey/verify", null, { challenge_id: opt.challenge_id, response: auth.get(opt.options) });
      expect(res.statusCode).toBe(400);
    });

    it("a registration challenge presented as a sign-in one", async () => {
      if (!dbAvailable) return;
      const { session, auth } = await withPasskey();
      const reg = (await call(optional, "POST", "/admin-auth/passkeys/register/options", session)).json();
      const res = await call(optional, "POST", "/admin-auth/passkey/verify", null, { challenge_id: reg.challenge_id, response: auth.get(reg.options) });
      expect(res.statusCode).toBe(400);
    });

    it("an administrator taken off the list: their passkey stops working", async () => {
      if (!dbAvailable) return;
      const { auth } = await withPasskey(OTHER);
      const saved = process.env.MAILFORGE_PLATFORM_ADMINS;
      process.env.MAILFORGE_PLATFORM_ADMINS = OPS;
      try {
        expect((await passkeyLogin(optional, auth)).verify.statusCode).toBe(400);
      } finally {
        process.env.MAILFORGE_PLATFORM_ADMINS = saved;
      }
      expect((await passkeyLogin(optional, auth)).verify.statusCode).toBe(200);
    });

    it("missing, malformed or unknown input", async () => {
      if (!dbAvailable) return;
      for (const body of [{}, { challenge_id: "nope" }, { challenge_id: "00000000-0000-4000-8000-000000000000", response: { id: "x" } }, { challenge_id: 5, response: "x" }]) {
        expect((await call(optional, "POST", "/admin-auth/passkey/verify", null, body)).statusCode, JSON.stringify(body)).toBe(400);
      }
    });
  });

  it("limits attempts per client, and sweeps expired challenges as it goes", async () => {
    if (!dbAvailable) return;
    await db.execute(sql`INSERT INTO admin_passkey_challenges (kind, challenge, expires_at) VALUES ('login', 'old', now() - interval '1 hour')`);
    const ip = "10.77.0.1";
    for (let i = 0; i < 60; i++) expect((await call(strict, "POST", "/admin-auth/passkey/options", null, undefined, { ip })).statusCode).toBe(200);
    expect((await call(strict, "POST", "/admin-auth/passkey/options", null, undefined, { ip })).statusCode).toBe(429);
    expect((await call(strict, "POST", "/admin-auth/passkey/verify", null, {}, { ip })).statusCode).toBe(429);
    expect(await count("admin_passkey_challenges", "challenge = 'old'")).toBe(0);
  });

  it("refuses a cross-origin attempt before any of the above", async () => {
    if (!dbAvailable) return;
    const res = await call(optional, "POST", "/admin-auth/passkey/options", null, undefined, { headers: { origin: "https://evil.example" } });
    expect(res.statusCode).toBe(403);
  });
});

// ===========================================================================
describe("managing passkeys", () => {
  it("removes your own, and only your own", async () => {
    if (!dbAvailable) return;
    const mine = await withPasskey(OPS);
    const theirs = await withPasskey(OTHER);
    // A second one so removal is allowed in every mode.
    await register(optional, mine.session, new VirtualAuthenticator(ADMIN_URL, RP_ID), { name: "Spare" });
    expect((await call(optional, "DELETE", `/admin-auth/passkeys/${theirs.auth.id}`, mine.session)).statusCode).toBe(404);
    expect(await count("admin_passkeys", "email = 'second@adm-p.example'")).toBe(1);
    expect((await call(optional, "DELETE", `/admin-auth/passkeys/${mine.auth.id}`, mine.session)).statusCode).toBe(200);
    expect((await call(optional, "GET", "/admin-auth/passkeys", mine.session)).json().passkeys.map((p: { name: string }) => p.name)).toEqual(["Spare"]);
  });

  it("a removed passkey can no longer sign in", async () => {
    if (!dbAvailable) return;
    const { session, auth } = await withPasskey();
    await call(optional, "DELETE", `/admin-auth/passkeys/${auth.id}`, session);
    expect((await passkeyLogin(optional, auth)).verify.statusCode).toBe(400);
  });

  it("the list shows only your own passkeys", async () => {
    if (!dbAvailable) return;
    const mine = await withPasskey(OPS);
    await withPasskey(OTHER);
    const list = (await call(optional, "GET", "/admin-auth/passkeys", mine.session)).json().passkeys;
    expect(list.map((p: { id: string }) => p.id)).toEqual([mine.auth.id]);
  });

  it("the Origin check covers removal too", async () => {
    if (!dbAvailable) return;
    const { session, auth } = await withPasskey();
    const res = await call(optional, "DELETE", `/admin-auth/passkeys/${auth.id}`, session, undefined, { headers: { origin: "https://evil.example" } });
    expect(res.statusCode).toBe(403);
    expect(await count("admin_passkeys")).toBe(1);
  });
});

// ===========================================================================
describe("policy: optional", () => {
  it("an administrator with a passkey can still use an emailed link", async () => {
    if (!dbAvailable) return;
    await withPasskey();
    loginBox.sent = [];
    await optional.inject({ method: "POST", url: "/admin-auth/login", payload: { email: OPS }, remoteAddress: nextIp() });
    expect(loginBox.sent).toHaveLength(1);
    const s = await emailSession(OPS, optional);
    expect((await call(optional, "GET", "/admin-auth/me", s)).json()).toMatchObject({ method: "email", passkey_count: 1 });
  });

  it("the last passkey can be removed", async () => {
    if (!dbAvailable) return;
    const { session, auth } = await withPasskey();
    expect((await call(optional, "DELETE", `/admin-auth/passkeys/${auth.id}`, session)).statusCode).toBe(200);
  });
});

describe("policy: enforced", () => {
  it("an administrator with no passkey yet gets a link, signs in with it, and can enrol one", async () => {
    if (!dbAvailable) return;
    const s = await emailSession(OPS, enforced);
    expect(s).toBeTruthy();
    const reg = await register(enforced, s, new VirtualAuthenticator(ADMIN_URL, RP_ID));
    expect(reg.verify.statusCode).toBe(200);
  });

  it("an administrator WITH a passkey is sent no link, and the answer looks the same as for anyone", async () => {
    if (!dbAvailable) return;
    await withPasskey(OPS, enforced);
    // Forget the link that was used to enrol the passkey; what matters is what happens from here.
    await db.execute(sql`DELETE FROM admin_login_tokens WHERE email = ${OPS}`);
    loginBox.sent = [];
    const withKey = await enforced.inject({ method: "POST", url: "/admin-auth/login", payload: { email: OPS }, remoteAddress: nextIp() });
    const stranger = await enforced.inject({ method: "POST", url: "/admin-auth/login", payload: { email: "nobody@adm-p.example" }, remoteAddress: nextIp() });
    const noKey = await enforced.inject({ method: "POST", url: "/admin-auth/login", payload: { email: OTHER }, remoteAddress: nextIp() });
    expect(withKey.statusCode).toBe(200);
    expect(withKey.json()).toEqual(stranger.json());
    expect(withKey.json()).toEqual(noKey.json());
    expect(loginBox.sent.map((m) => m.to)).toEqual([OTHER]); // only the admin with no passkey
    expect(await count("admin_login_tokens", "email = 'ops@adm-p.example'")).toBe(0);
  });

  it("a link issued before the administrator enrolled a passkey no longer signs them in", async () => {
    if (!dbAvailable) return;
    loginBox.sent = [];
    await enforced.inject({ method: "POST", url: "/admin-auth/login", payload: { email: OPS }, remoteAddress: nextIp() });
    const token = /token=([A-Za-z0-9_-]+)/.exec(loginBox.sent[0]!.bodyText)![1]!;
    // Meanwhile a passkey is enrolled (from another session or device).
    await db.execute(sql`INSERT INTO admin_passkeys (id, email, public_key, name) VALUES ('enrolled-meanwhile', ${OPS}, 'x', 'Phone')`);

    const view = await enforced.inject({ method: "GET", url: `/admin-auth/verify?token=${token}` });
    expect(view.headers.location).toBe("/login?error=passkey_required");
    const post = await enforced.inject({ method: "POST", url: "/admin-auth/verify", headers: { "content-type": "application/x-www-form-urlencoded" }, payload: `token=${token}` });
    expect(post.headers.location).toBe("/login?error=passkey_required");
    expect(cookieOf(post)).toBeUndefined();
    expect(await count("admin_sessions", "email = 'ops@adm-p.example'")).toBe(0);
  });

  it("passkey sign-in works as usual", async () => {
    if (!dbAvailable) return;
    const { auth } = await withPasskey(OPS, enforced);
    const { verify } = await passkeyLogin(enforced, auth);
    expect(verify.statusCode).toBe(200);
    expect((await call(enforced, "GET", "/admin-auth/me", cookieOf(verify)!)).json()).toMatchObject({ method: "passkey", passkey_mode: "enforced" });
  });

  it("the last passkey cannot be removed (that would drop back to a bare emailed link), but a spare can", async () => {
    if (!dbAvailable) return;
    const { session, auth } = await withPasskey(OPS, enforced);
    const blocked = await call(enforced, "DELETE", `/admin-auth/passkeys/${auth.id}`, session);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().code).toBe("last_passkey");
    const spare = new VirtualAuthenticator(ADMIN_URL, RP_ID);
    await register(enforced, session, spare, { name: "Spare" });
    expect((await call(enforced, "DELETE", `/admin-auth/passkeys/${spare.id}`, session)).statusCode).toBe(200);
    expect(await count("admin_passkeys", "email = 'ops@adm-p.example'")).toBe(1);
  });
});
