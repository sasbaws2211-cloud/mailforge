/**
 * Integration tests for the standalone admin console: its own sign-in by emailed
 * link, its own session, the admin API behind that session, and the isolation
 * between it and the customer app.
 *
 * Needs a reachable Postgres via DATABASE_URL, like the other *.db tests.
 * Every tenant created here has a slug starting with "adm-s-".
 */
import { createHash } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { TransportAdapter, TransportSendParams, TransportSendResult } from "@mailforge/adapters";
import { tenantTablesInDeleteOrder } from "@mailforge/db/purge";
import { buildAdminApp, buildApp, ADMIN_SESSION_COOKIE } from "../src/index.js";
import { SESSION_COOKIE_NAME } from "../src/routes/auth.js";

const TEST_DB_URL = process.env.DATABASE_URL;
if (!TEST_DB_URL) throw new Error("[admin-standalone.test] DATABASE_URL is not set.");

const OPS = "ops@adm-s.example";
const OTHER_ADMIN = "second@adm-s.example";
const ADMIN_URL = "http://localhost:3011";
const CUSTOMER_URL = "http://localhost:3010";

class Outbox implements TransportAdapter {
  sent: TransportSendParams[] = [];
  mode: "ok" | "fail" | "throw" = "ok";
  async send(p: TransportSendParams): Promise<TransportSendResult> {
    if (this.mode === "throw") throw new Error("smtp down");
    if (this.mode === "fail") return { success: false, error: "rejected", permanent: false };
    this.sent.push(p);
    return { success: true, providerMessageId: `m-${this.sent.length}` };
  }
}
const loginBox = new Outbox();
const noticeBox = new Outbox();

let pool: pg.Pool;
let lockClient: pg.PoolClient | undefined;
let db: ReturnType<typeof drizzle>;
let dbAvailable = false;
let admin: FastifyInstance;
let adminHttps: FastifyInstance;
let adminStrict: FastifyInstance;
let customer: FastifyInstance;
let embedded: FastifyInstance;

async function q<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  return (await db.execute(query)).rows as T[];
}

interface Tenant {
  id: string;
  slug: string;
  email: string;
  session: string;
}
let counter = 0;
async function newTenant(opts: { email?: string; plan?: string } = {}): Promise<Tenant> {
  const slug = `adm-s-${Date.now()}-${counter++}`;
  const email = opts.email ?? `${slug}@adm-s.example`;
  const [t] = await q<{ id: string }>(sql`INSERT INTO tenants (name, slug, plan) VALUES (${slug}, ${slug}, ${opts.plan ?? "free"}) RETURNING id`);
  const [u] = await q<{ id: string }>(sql`INSERT INTO users (tenant_id, email, role) VALUES (${t!.id}::uuid, ${email}, 'owner') RETURNING id`);
  const [s] = await q<{ id: string }>(sql`INSERT INTO sessions (tenant_id, user_id, expires_at) VALUES (${t!.id}::uuid, ${u!.id}::uuid, now() + interval '1 day') RETURNING id`);
  return { id: t!.id, slug, email, session: s!.id };
}

async function cleanup(): Promise<void> {
  await db.execute(sql`DELETE FROM admin_sessions WHERE email LIKE '%@adm-s.example'`);
  await db.execute(sql`DELETE FROM admin_login_tokens WHERE email LIKE '%@adm-s.example'`);
  const ids = (await q<{ id: string }>(sql`SELECT id FROM tenants WHERE slug LIKE 'adm-s-%'`)).map((r) => r.id);
  for (const id of ids) {
    for (const t of await db.transaction(async (tx) => tenantTablesInDeleteOrder(tx as never))) {
      await db.execute(sql.raw(`DELETE FROM "${t}" WHERE tenant_id = '${id}'`));
    }
    await db.execute(sql`DELETE FROM tenants WHERE id = ${id}::uuid`);
  }
  await db.execute(sql`DELETE FROM admin_audit_log WHERE actor_email LIKE '%@adm-s.example' OR detail->>'workspace_slug' LIKE 'adm-s-%'`);
  await db.execute(sql`DELETE FROM deleted_workspaces WHERE slug LIKE 'adm-s-%'`);
}

const login = (email: unknown, a: FastifyInstance = admin, ip?: string) =>
  a.inject({ method: "POST", url: "/admin-auth/login", payload: { email }, remoteAddress: ip });
const tokenFrom = (m: TransportSendParams) => /token=([A-Za-z0-9_-]+)/.exec(m.bodyText)![1]!;
const lastToken = () => tokenFrom(loginBox.sent[loginBox.sent.length - 1]!);
const confirm = (token: string, a: FastifyInstance = admin) =>
  a.inject({ method: "POST", url: "/admin-auth/verify", headers: { "content-type": "application/x-www-form-urlencoded" }, payload: `token=${encodeURIComponent(token)}` });
const cookieOf = (res: { cookies: Array<{ name: string; value: string }> }, name = ADMIN_SESSION_COOKIE) => res.cookies.find((c) => c.name === name)?.value;

/** Full sign-in as an admin; returns the session id. */
async function signIn(email = OPS, a: FastifyInstance = admin): Promise<string> {
  loginBox.sent = [];
  await login(email, a, `10.0.${counter++ % 250}.${counter % 250}`);
  const res = await confirm(lastToken(), a);
  return cookieOf(res)!;
}
const api = (a: FastifyInstance, method: "GET" | "POST", url: string, session: string | null, payload?: unknown, headers: Record<string, string> = {}) =>
  a.inject({ method, url, cookies: session ? { [ADMIN_SESSION_COOKIE]: session } : {}, payload: payload as object | undefined, headers });

const auditRows = async (tenantId: string) =>
  q<{ action: string; actor_email: string; actor_user_id: string | null }>(sql`SELECT action, actor_email, actor_user_id FROM admin_audit_log WHERE tenant_id = ${tenantId}::uuid ORDER BY created_at`);

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: TEST_DB_URL, connectionTimeoutMillis: 3000 });
  try {
    await pool.query("SELECT 1");
    db = drizzle(pool);
    dbAvailable = true;
    // These files share global tables (platform_llm_configs, platform_alert_state), so only one runs at a time.
    lockClient = await pool.connect();
    await lockClient.query("SELECT pg_advisory_lock(7770001)");
  } catch (err) {
    if (process.env.CI === "true") throw new Error(`[admin-standalone.test] DATABASE_URL not reachable in CI: ${(err as Error).message}`);
    console.warn("[admin-standalone.test] DATABASE_URL not reachable - tests skipped.");
    return;
  }
  await cleanup();
  process.env.MAILFORGE_PLATFORM_ADMINS = ` ${OPS.toUpperCase()} , ${OTHER_ADMIN}`;
  const sender = { adapter: loginBox, fromEmail: "no-reply@platform.example", fromName: "Mailforge" };
  const noticeSender = { adapter: noticeBox, fromEmail: "no-reply@platform.example", fromName: "Mailforge" };
  const quiet = { logger: false as const };
  // The main instance has generous limits so tests can sign in as often as they like; adminStrict has the real ones.
  admin = await buildAdminApp({ ...quiet, db: db as never, adminUrl: ADMIN_URL, customerUrl: CUSTOMER_URL, loginTransports: [sender], noticeTransports: [noticeSender], loginLimits: { perEmail: 10_000, perIp: 10_000 } });
  adminHttps = await buildAdminApp({ ...quiet, db: db as never, adminUrl: "https://admin.example.com", loginTransports: [sender], loginLimits: { perEmail: 10_000, perIp: 10_000 } });
  adminStrict = await buildAdminApp({ ...quiet, db: db as never, adminUrl: ADMIN_URL, loginTransports: [sender] });
  const base = { logger: false as const, db: db as never, baseUrl: CUSTOMER_URL, dashboardUrl: CUSTOMER_URL };
  customer = await buildApp({ ...base, adminEmbedded: false });
  embedded = await buildApp(base);
});

beforeEach(() => {
  loginBox.sent = [];
  loginBox.mode = "ok";
  noticeBox.sent = [];
});

afterEach(async () => {
  if (dbAvailable) await cleanup();
});

afterAll(async () => {
  delete process.env.MAILFORGE_PLATFORM_ADMINS;
  for (const a of [admin, adminHttps, adminStrict, customer, embedded]) if (a) await a.close();
  if (lockClient) {
    await lockClient.query("SELECT pg_advisory_unlock(7770001)");
    lockClient.release();
  }
  await pool?.end();
});

// ===========================================================================
describe("asking for a sign-in link", () => {
  it("emails an administrator a link on the admin console's own address", async () => {
    if (!dbAvailable) return;
    const res = await login(OPS);
    expect(res.statusCode).toBe(200);
    expect(loginBox.sent).toHaveLength(1);
    const m = loginBox.sent[0]!;
    expect(m.to).toBe(OPS);
    expect(m.from).toBe("no-reply@platform.example");
    expect(m.subject).toBe("Your admin console sign-in link");
    expect(m.bodyText).toContain(`${ADMIN_URL}/admin-auth/verify?token=`);
    expect(m.bodyHtml).toContain(`${ADMIN_URL}/admin-auth/verify?token=`);
    expect(m.headers).toEqual({});
  });

  it("treats the address case-insensitively and ignores surrounding spaces", async () => {
    if (!dbAvailable) return;
    await login(`  ${OPS.toUpperCase()} `);
    expect(loginBox.sent.map((m) => m.to)).toEqual([OPS]);
  });

  it("answers a stranger exactly as it answers an administrator, and sends nothing", async () => {
    if (!dbAvailable) return;
    const real = await login(OTHER_ADMIN, admin, "10.9.0.1");
    loginBox.sent = [];
    const fake = await login("nobody@adm-s.example", admin, "10.9.0.2");
    expect(fake.statusCode).toBe(real.statusCode);
    expect(fake.json()).toEqual(real.json());
    expect(loginBox.sent).toHaveLength(0);
    expect((await q<{ n: string }>(sql`SELECT count(*)::text AS n FROM admin_login_tokens WHERE email = 'nobody@adm-s.example'`))[0]!.n).toBe("0");
  });

  it("a workspace owner who is not on the list gets nothing, even with a real account", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    expect((await login(t.email)).statusCode).toBe(200);
    expect(loginBox.sent).toHaveLength(0);
  });

  it("rejects a missing, non-text or oversized address", async () => {
    if (!dbAvailable) return;
    for (const email of [undefined, null, 5, "", "a".repeat(255)]) {
      expect((await login(email, admin, `10.8.0.${counter++ % 250}`)).statusCode, String(email)).toBe(400);
    }
  });

  it("stores only a hash of the link, never the link itself", async () => {
    if (!dbAvailable) return;
    await login(OPS);
    const token = lastToken();
    const rows = await q<{ token_hash: string }>(sql`SELECT token_hash FROM admin_login_tokens WHERE email = ${OPS}`);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.token_hash).toBe(createHash("sha256").update(token).digest("hex"));
    expect(JSON.stringify(rows)).not.toContain(token);
  });

  it("limits requests per address (the same for administrators and strangers) and per client", async () => {
    if (!dbAvailable) return;
    for (const email of [OPS, "stranger@adm-s.example"]) {
      for (let i = 0; i < 5; i++) expect((await login(email, adminStrict, `10.7.${counter++ % 250}.1`)).statusCode).toBe(200);
      expect((await login(email, adminStrict, `10.7.${counter++ % 250}.2`)).statusCode, email).toBe(429);
    }
    for (let i = 0; i < 20; i++) expect((await login(`u${i}@adm-s.example`, adminStrict, "10.6.0.1")).statusCode).toBe(200);
    expect((await login("one-more@adm-s.example", adminStrict, "10.6.0.1")).statusCode).toBe(429);
  });

  it("a mail problem never breaks the request: same answer, no crash", async () => {
    if (!dbAvailable) return;
    for (const mode of ["fail", "throw"] as const) {
      loginBox.mode = mode;
      const res = await login(OTHER_ADMIN, admin, `10.5.${counter++ % 250}.1`);
      expect(res.statusCode, mode).toBe(200);
      expect(res.json().message).toContain("If that address belongs to an administrator");
    }
  });
});

// ===========================================================================
describe("using the link", () => {
  it("opening it shows a confirmation page and changes nothing, so a mail scanner cannot sign anyone in", async () => {
    if (!dbAvailable) return;
    await login(OPS);
    const token = lastToken();
    for (let i = 0; i < 3; i++) {
      const res = await admin.inject({ method: "GET", url: `/admin-auth/verify?token=${token}` });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("text/html");
      expect(res.body).toContain(OPS);
      expect(res.body).toContain('action="/admin-auth/verify"');
      expect(cookieOf(res)).toBeUndefined();
    }
    expect((await q<{ n: string }>(sql`SELECT count(*)::text AS n FROM admin_sessions WHERE email = ${OPS}`))[0]!.n).toBe("0");
    expect((await q<{ c: Date | null }>(sql`SELECT consumed_at AS c FROM admin_login_tokens WHERE email = ${OPS}`))[0]!.c).toBeNull();
  });

  it("confirming starts a session in an HttpOnly, SameSite=Lax cookie and goes to the console", async () => {
    if (!dbAvailable) return;
    await login(OPS);
    const res = await confirm(lastToken());
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/");
    const set = String(([] as string[]).concat(res.headers["set-cookie"] as string | string[])[0]);
    expect(set).toContain(`${ADMIN_SESSION_COOKIE}=`);
    expect(set).toMatch(/HttpOnly/i);
    expect(set).toMatch(/SameSite=Lax/i);
    expect(set).toMatch(/Path=\//);
    expect(set).not.toMatch(/Secure/i); // plain http locally
    const [s] = await q<{ email: string; hours: number }>(sql`SELECT email, extract(epoch FROM (expires_at - now())) / 3600 AS hours FROM admin_sessions WHERE email = ${OPS}`);
    expect(s!.email).toBe(OPS);
    expect(Number(s!.hours)).toBeGreaterThan(7.9);
    expect(Number(s!.hours)).toBeLessThan(8.01);
  });

  it("the cookie is Secure when the console is served over https", async () => {
    if (!dbAvailable) return;
    await login(OPS, adminHttps);
    const res = await confirm(lastToken(), adminHttps);
    expect(String(([] as string[]).concat(res.headers["set-cookie"] as string | string[])[0])).toMatch(/Secure/i);
  });

  it("works once: the same link cannot start a second session", async () => {
    if (!dbAvailable) return;
    await login(OPS);
    const token = lastToken();
    expect((await confirm(token)).headers.location).toBe("/");
    const again = await confirm(token);
    expect(again.headers.location).toBe("/login?error=invalid_link");
    expect(cookieOf(again)).toBeUndefined();
    const view = await admin.inject({ method: "GET", url: `/admin-auth/verify?token=${token}` });
    expect(view.headers.location).toBe("/login?error=invalid_link");
  });

  it("two simultaneous clicks start exactly one session", async () => {
    if (!dbAvailable) return;
    await login(OPS);
    const token = lastToken();
    const results = await Promise.all([confirm(token), confirm(token), confirm(token)]);
    expect(results.filter((r) => r.headers.location === "/")).toHaveLength(1);
    expect((await q<{ n: string }>(sql`SELECT count(*)::text AS n FROM admin_sessions WHERE email = ${OPS}`))[0]!.n).toBe("1");
  });

  it("an expired, unknown, empty or tampered link is refused", async () => {
    if (!dbAvailable) return;
    await login(OPS);
    const token = lastToken();
    await db.execute(sql`UPDATE admin_login_tokens SET expires_at = now() - interval '1 second' WHERE email = ${OPS}`);
    expect((await confirm(token)).headers.location).toBe("/login?error=invalid_link");
    expect((await admin.inject({ method: "GET", url: `/admin-auth/verify?token=${token}` })).headers.location).toBe("/login?error=invalid_link");
    for (const bad of ["", "nonsense", `${token}x`, token.slice(1)]) {
      expect((await confirm(bad)).headers.location, bad).toBe("/login?error=invalid_link");
    }
    expect((await admin.inject({ method: "GET", url: "/admin-auth/verify" })).headers.location).toBe("/login?error=invalid_link");
    expect((await admin.inject({ method: "POST", url: "/admin-auth/verify", payload: {} })).headers.location).toBe("/login?error=invalid_link");
  });

  it("a link is useless if its owner has been taken off the administrator list since", async () => {
    if (!dbAvailable) return;
    await login(OTHER_ADMIN);
    const token = lastToken();
    const saved = process.env.MAILFORGE_PLATFORM_ADMINS;
    process.env.MAILFORGE_PLATFORM_ADMINS = OPS;
    try {
      expect((await confirm(token)).headers.location).toBe("/login?error=invalid_link");
    } finally {
      process.env.MAILFORGE_PLATFORM_ADMINS = saved;
    }
  });
});

// ===========================================================================
describe("the session", () => {
  it("/admin-auth/me names the signed-in administrator, and is 401 for everyone else", async () => {
    if (!dbAvailable) return;
    const s = await signIn();
    expect((await api(admin, "GET", "/admin-auth/me", s)).json()).toMatchObject({ email: OPS, customer_url: CUSTOMER_URL, method: "email" });
    expect((await api(adminHttps, "GET", "/admin-auth/me", await signIn(OPS, adminHttps))).json()).toMatchObject({ email: OPS, customer_url: null });
    expect((await api(admin, "GET", "/admin-auth/me", null)).statusCode).toBe(401);
    expect((await api(admin, "GET", "/admin-auth/me", "not-a-session")).statusCode).toBe(401);
    expect((await api(admin, "GET", "/admin-auth/me", "00000000-0000-4000-8000-000000000000")).statusCode).toBe(401);
  });

  it("expires: an old session is refused and removed", async () => {
    if (!dbAvailable) return;
    const s = await signIn();
    await db.execute(sql`UPDATE admin_sessions SET expires_at = now() - interval '1 second' WHERE id = ${s}::uuid`);
    expect((await api(admin, "GET", "/admin-auth/me", s)).statusCode).toBe(401);
    expect((await q<{ n: string }>(sql`SELECT count(*)::text AS n FROM admin_sessions WHERE id = ${s}::uuid`))[0]!.n).toBe("0");
  });

  it("ends the moment the person is taken off the administrator list", async () => {
    if (!dbAvailable) return;
    const s = await signIn(OTHER_ADMIN);
    expect((await api(admin, "GET", "/v1/admin/overview", s)).statusCode).toBe(200);
    const saved = process.env.MAILFORGE_PLATFORM_ADMINS;
    process.env.MAILFORGE_PLATFORM_ADMINS = OPS;
    try {
      expect((await api(admin, "GET", "/v1/admin/overview", s)).statusCode).toBe(401);
      expect((await q<{ n: string }>(sql`SELECT count(*)::text AS n FROM admin_sessions WHERE id = ${s}::uuid`))[0]!.n).toBe("0");
    } finally {
      process.env.MAILFORGE_PLATFORM_ADMINS = saved;
    }
  });

  it("signing out removes the session, so the cookie stops working even if someone kept it", async () => {
    if (!dbAvailable) return;
    const s = await signIn();
    const res = await api(admin, "POST", "/admin-auth/logout", s);
    expect(res.statusCode).toBe(200);
    expect((await api(admin, "GET", "/v1/admin/overview", s)).statusCode).toBe(401);
    expect((await q<{ n: string }>(sql`SELECT count(*)::text AS n FROM admin_sessions WHERE id = ${s}::uuid`))[0]!.n).toBe("0");
  });

  it("two administrators have separate sessions; signing one out leaves the other in", async () => {
    if (!dbAvailable) return;
    const a = await signIn(OPS);
    const b = await signIn(OTHER_ADMIN);
    await api(admin, "POST", "/admin-auth/logout", a);
    expect((await api(admin, "GET", "/admin-auth/me", b)).json()).toMatchObject({ email: OTHER_ADMIN });
  });
});

// ===========================================================================
describe("the admin API on the standalone console", () => {
  it("answers 401 (so the page can show its sign-in) when nobody is signed in, never data", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    for (const [method, url] of [
      ["GET", "/v1/admin/overview"],
      ["GET", "/v1/admin/tenants"],
      ["GET", `/v1/admin/tenants/${t.id}`],
      ["GET", "/v1/admin/audit"],
      ["GET", `/v1/admin/tenants/${t.id}/export`],
      ["POST", `/v1/admin/tenants/${t.id}/suspend`],
    ] as const) {
      const res = await api(admin, method, url, null, method === "POST" ? { reason: "x" } : undefined);
      expect(res.statusCode, url).toBe(401);
      expect(res.json()).toEqual({ error: "Authentication required." });
    }
  });

  it("serves the console to a signed-in administrator", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    const s = await signIn();
    expect((await api(admin, "GET", "/v1/admin/overview", s)).statusCode).toBe(200);
    const list = (await api(admin, "GET", `/v1/admin/tenants?q=${t.slug}`, s)).json();
    expect(list.tenants.map((w: { id: string }) => w.id)).toEqual([t.id]);
    expect((await api(admin, "GET", `/v1/admin/tenants/${t.id}`, s)).statusCode).toBe(200);
  });

  it("an administrator needs no workspace: changes are recorded with their email and no user id", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    const s = await signIn();
    const res = await api(admin, "POST", `/v1/admin/tenants/${t.id}/suspend`, s, { reason: "Spam complaints" });
    expect(res.statusCode).toBe(200);
    expect(await auditRows(t.id)).toEqual([{ action: "suspend", actor_email: OPS, actor_user_id: null }]);
    expect((await api(admin, "POST", `/v1/admin/tenants/${t.id}/unsuspend`, s, { reason: "Resolved" })).statusCode).toBe(200);
    const shown = (await api(admin, "GET", `/v1/admin/audit?tenant_id=${t.id}`, s)).json().entries;
    expect(shown.map((e: { action: string; actor: string }) => `${e.action}:${e.actor}`)).toEqual([`unsuspend:${OPS}`, `suspend:${OPS}`]);
  });

  it("the rules still hold: a reason is needed, and you cannot suspend or delete a workspace you belong to", async () => {
    if (!dbAvailable) return;
    const mine = await newTenant({ email: OPS });
    const other = await newTenant();
    const s = await signIn();
    expect((await api(admin, "POST", `/v1/admin/tenants/${other.id}/suspend`, s, {})).json().code).toBe("reason_required");
    expect((await api(admin, "POST", `/v1/admin/tenants/${mine.id}/suspend`, s, { reason: "oops" })).json().code).toBe("own_workspace");
    expect((await api(admin, "POST", `/v1/admin/tenants/${mine.id}/delete`, s, { confirm: mine.slug, reason: "oops", immediate: true })).json().code).toBe("own_workspace");
    expect((await q<{ n: string }>(sql`SELECT count(*)::text AS n FROM tenants WHERE id = ${mine.id}::uuid AND suspended_at IS NULL`))[0]!.n).toBe("1");
  });

  it("emails to owners link back to the customer app, not the console", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    const s = await signIn();
    const res = await api(admin, "POST", `/v1/admin/tenants/${t.id}/delete`, s, { confirm: t.slug, reason: "Customer asked" });
    expect(res.statusCode).toBe(200);
    expect(noticeBox.sent).toHaveLength(1);
    for (const m of noticeBox.sent) {
      expect(m.bodyText).toContain(CUSTOMER_URL);
      expect(m.bodyText).not.toContain(ADMIN_URL);
    }
    expect((await q<{ d: Date | null }>(sql`SELECT deletion_scheduled_at AS d FROM tenants WHERE id = ${t.id}::uuid`))[0]!.d).not.toBeNull();
  });
});

// ===========================================================================
describe("protections specific to a cookie-authenticated console", () => {
  it("refuses a state-changing request that carries another site's Origin, and changes nothing", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    const s = await signIn();
    for (const origin of ["https://evil.example", "http://localhost:3010", "null"]) {
      const res = await api(admin, "POST", `/v1/admin/tenants/${t.id}/suspend`, s, { reason: "x" }, { origin });
      expect(res.statusCode, origin).toBe(403);
    }
    expect(await auditRows(t.id)).toEqual([]);
  });

  it("accepts the console's own Origin, and requests with none (command line tools)", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    const s = await signIn();
    expect((await api(admin, "POST", `/v1/admin/tenants/${t.id}/suspend`, s, { reason: "x" }, { origin: ADMIN_URL })).statusCode).toBe(200);
    expect((await api(admin, "POST", `/v1/admin/tenants/${t.id}/unsuspend`, s, { reason: "y" })).statusCode).toBe(200);
  });

  it("refuses a cross-origin sign-in attempt too", async () => {
    if (!dbAvailable) return;
    const res = await admin.inject({ method: "POST", url: "/admin-auth/login", payload: { email: OPS }, headers: { origin: "https://evil.example" } });
    expect(res.statusCode).toBe(403);
    expect(loginBox.sent).toHaveLength(0);
  });

  it("never uses a referrer policy that makes browsers send Origin: null on the console's own forms", async () => {
    if (!dbAvailable) return;
    // Found live: with "no-referrer" the confirmation button's POST arrived as Origin: null and was refused.
    const res = await admin.inject({ method: "GET", url: "/health" });
    expect(res.headers["referrer-policy"]).not.toBe("no-referrer");
    expect(res.headers["referrer-policy"]).not.toBe("same-origin-only");
    // Still leaks nothing to other sites.
    expect(["same-origin", "strict-origin-when-cross-origin"]).toContain(res.headers["referrer-policy"]);
  });

  it("sends headers that stop framing, indexing and caching", async () => {
    if (!dbAvailable) return;
    const s = await signIn();
    for (const url of ["/v1/admin/overview", "/admin-auth/me", "/health"]) {
      const res = await api(admin, "GET", url, s);
      expect(res.headers["x-frame-options"], url).toBe("DENY");
      expect(res.headers["content-security-policy"], url).toBe("frame-ancestors 'none'");
      expect(res.headers["x-content-type-options"], url).toBe("nosniff");
      expect(res.headers["referrer-policy"], url).toBe("same-origin");
      expect(res.headers["x-robots-tag"], url).toContain("noindex");
    }
    expect((await api(admin, "GET", "/v1/admin/overview", s)).headers["cache-control"]).toBe("no-store");
    expect((await api(admin, "GET", "/admin-auth/me", s)).headers["cache-control"]).toBe("no-store");
  });

  it("answers /health without a session, and says what it is", async () => {
    if (!dbAvailable) return;
    const res = await admin.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, service: "mailforge-admin" });
  });
});

// ===========================================================================
describe("isolation between the console and the customer app", () => {
  it("a customer session cookie does nothing on the console, even for a listed admin's workspace login", async () => {
    if (!dbAvailable) return;
    const t = await newTenant({ email: OPS });
    for (const name of [SESSION_COOKIE_NAME, ADMIN_SESSION_COOKIE]) {
      const res = await admin.inject({ method: "GET", url: "/v1/admin/overview", cookies: { [name]: t.session } });
      expect(res.statusCode, name).toBe(401);
    }
  });

  it("a console session does nothing on the customer app", async () => {
    if (!dbAvailable) return;
    const s = await signIn();
    for (const name of [SESSION_COOKIE_NAME, ADMIN_SESSION_COOKIE]) {
      expect((await customer.inject({ method: "GET", url: "/v1/plan", cookies: { [name]: s } })).statusCode, name).toBe(401);
      expect((await customer.inject({ method: "GET", url: "/auth/me", cookies: { [name]: s } })).statusCode, name).toBe(401);
    }
  });

  it("with the console deployed separately, the customer app serves no admin API at all", async () => {
    if (!dbAvailable) return;
    const t = await newTenant({ email: OPS });
    for (const url of ["/v1/admin/overview", "/v1/admin/tenants", "/v1/admin/audit"]) {
      const res = await customer.inject({ method: "GET", url, cookies: { [SESSION_COOKIE_NAME]: t.session } });
      expect(res.statusCode, url).toBe(404);
    }
    const post = await customer.inject({ method: "POST", url: `/v1/admin/tenants/${t.id}/suspend`, cookies: { [SESSION_COOKIE_NAME]: t.session }, payload: { reason: "x" } });
    expect(post.statusCode).toBe(404);
  });

  it("and never tells the dashboard that its user is an administrator", async () => {
    if (!dbAvailable) return;
    const t = await newTenant({ email: OPS });
    const off = (await customer.inject({ method: "GET", url: "/auth/me", cookies: { [SESSION_COOKIE_NAME]: t.session } })).json();
    expect(off.platformAdmin).toBe(false);
    const on = (await embedded.inject({ method: "GET", url: "/auth/me", cookies: { [SESSION_COOKIE_NAME]: t.session } })).json();
    expect(on.platformAdmin).toBe(true);
  });

  it("the admin app has no customer routes", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    const s = await signIn();
    for (const url of ["/v1/plan", "/v1/flows", "/v1/contacts", "/auth/me", "/v1/track"]) {
      const res = await api(admin, "GET", url, s);
      expect(res.statusCode, url).toBe(404);
    }
    void t;
  });
});
