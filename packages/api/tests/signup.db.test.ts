/**
 * Integration tests for self-serve signup (POST /signup).
 *
 * Needs a reachable Postgres via DATABASE_URL, like the other *.db tests.
 * Every address used here ends in @signup-test.example so cleanup is exact.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { TRIAL_DAYS } from "@mailforge/core";
import { buildApp } from "../src/index.js";
import { SESSION_COOKIE_NAME } from "../src/routes/auth.js";

const TEST_DB_URL = process.env.DATABASE_URL;
if (!TEST_DB_URL) {
  throw new Error("[signup.test] DATABASE_URL is not set. Point it at a test database.");
}

const DOMAIN = "@signup-test.example";
let pool: pg.Pool;
let db: ReturnType<typeof drizzle>;
let dbAvailable = false;
const apps: FastifyInstance[] = [];
const savedEnv: Record<string, string | undefined> = {};

async function newApp(): Promise<FastifyInstance> {
  const app = await buildApp({
    logger: false,
    db,
    publicSite: true,
    baseUrl: "http://localhost:3000",
    dashboardUrl: "http://localhost:3000",
  });
  apps.push(app);
  return app;
}

function form(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}

function post(app: FastifyInstance, fields: Record<string, string>, remoteAddress?: string) {
  return app.inject({
    method: "POST",
    url: "/signup",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: form(fields),
    remoteAddress,
  });
}

const goodFields = (email: string, extra: Record<string, string> = {}) => ({
  workspace: "Signup Test Co",
  email,
  terms: "yes",
  ...extra,
});

async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  const r = await db.execute(query);
  return r.rows as T[];
}

async function cleanup(): Promise<void> {
  const ids = await rows<{ tenant_id: string }>(
    sql`SELECT DISTINCT tenant_id FROM users WHERE email LIKE ${"%" + DOMAIN}`,
  );
  for (const { tenant_id } of ids) {
    await db.execute(sql`DELETE FROM managed_sending WHERE tenant_id = ${tenant_id}`);
    await db.execute(sql`DELETE FROM magic_link_tokens WHERE tenant_id = ${tenant_id}`);
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
    if (process.env.CI === "true") throw new Error(`[signup.test] DATABASE_URL not reachable in CI: ${(err as Error).message}`);
    console.warn("[signup.test] DATABASE_URL not reachable - tests skipped.");
    return;
  }
  // Keep the platform sender out of tests: no real email, login links print to the console.
  for (const k of ["PLATFORM_FROM_EMAIL", "PLATFORM_SMTP_HOST", "PLATFORM_RESEND_API_KEY"]) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  await cleanup();
});

afterEach(async () => {
  for (const k of ["MAILFORGE_MANAGED_RESEND_API_KEY", "MAILFORGE_MANAGED_SHARED_FROM", "MAILFORGE_MANAGED_SENDING", "MAILFORGE_SIGNUP_AUTO_SENDING"]) delete process.env[k];
  vi.restoreAllMocks();
  while (apps.length) await apps.pop()!.close();
  if (dbAvailable) await cleanup();
});

afterAll(async () => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  if (dbAvailable) await cleanup();
  await pool?.end();
});

describe("POST /signup: creating a workspace", () => {
  it("creates a trial workspace with an owner, and shows the check-your-email page", async () => {
    if (!dbAvailable) return;
    const app = await newApp();
    const email = `new1${DOMAIN}`;
    const res = await post(app, goodFields(email));

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Check your email");
    expect(res.body).toContain(email);
    expect(res.body).toContain('content="noindex,nofollow"');

    const [t] = await rows<{ name: string; slug: string; plan: string; trial_ends_at: Date; settings: { signup: { plan_interest: string } } }>(
      sql`SELECT t.name, t.slug, t.plan, t.trial_ends_at, t.settings FROM tenants t JOIN users u ON u.tenant_id = t.id WHERE u.email = ${email}`,
    );
    expect(t!.name).toBe("Signup Test Co");
    expect(t!.slug).toBe("signup-test-co");
    expect(t!.plan).toBe("trial");
    expect(t!.settings.signup.plan_interest).toBe("growth");
    const msLeft = new Date(t!.trial_ends_at).getTime() - Date.now();
    expect(msLeft).toBeGreaterThan((TRIAL_DAYS * 86_400 - 120) * 1000);
    expect(msLeft).toBeLessThanOrEqual(TRIAL_DAYS * 86_400_000);

    const [u] = await rows<{ role: string }>(sql`SELECT role FROM users WHERE email = ${email}`);
    expect(u!.role).toBe("owner");
  });

  it("accepts JSON too and answers {ok:true}", async () => {
    if (!dbAvailable) return;
    const app = await newApp();
    const email = `json1${DOMAIN}`;
    const res = await app.inject({
      method: "POST",
      url: "/signup",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ workspace: "Json Co", email, terms: true }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    const [c] = await rows<{ n: string }>(sql`SELECT count(*)::text AS n FROM users WHERE email = ${email}`);
    expect(c!.n).toBe("1");
  });

  it("the free plan starts on free with no trial", async () => {
    if (!dbAvailable) return;
    const app = await newApp();
    const email = `free1${DOMAIN}`;
    expect((await post(app, goodFields(email, { plan: "free" }))).statusCode).toBe(200);
    const [t] = await rows<{ plan: string; trial_ends_at: Date | null; settings: { signup: { plan_interest: string } } }>(
      sql`SELECT t.plan, t.trial_ends_at, t.settings FROM tenants t JOIN users u ON u.tenant_id = t.id WHERE u.email = ${email}`,
    );
    expect(t!.plan).toBe("free");
    expect(t!.trial_ends_at).toBeNull();
    expect(t!.settings.signup.plan_interest).toBe("free");
  });

  it("two workspaces with the same name get different slugs", async () => {
    if (!dbAvailable) return;
    const app = await newApp();
    await post(app, goodFields(`dup-a${DOMAIN}`));
    await post(app, goodFields(`dup-b${DOMAIN}`));
    const slugs = await rows<{ slug: string }>(
      sql`SELECT t.slug FROM tenants t JOIN users u ON u.tenant_id = t.id WHERE u.email IN (${`dup-a${DOMAIN}`}, ${`dup-b${DOMAIN}`}) ORDER BY u.email`,
    );
    expect(slugs).toHaveLength(2);
    expect(slugs[0]!.slug).not.toBe(slugs[1]!.slug);
    expect(slugs[0]!.slug).toBe("signup-test-co");
    expect(slugs[1]!.slug).toMatch(/^signup-test-co-[0-9a-f]{6}$/);
  });

  it("a double-submitted form creates exactly one workspace", async () => {
    if (!dbAvailable) return;
    const app = await newApp();
    const email = `race1${DOMAIN}`;
    const results = await Promise.all([post(app, goodFields(email)), post(app, goodFields(email))]);
    expect(results.map((r) => r.statusCode)).toEqual([200, 200]);
    const [c] = await rows<{ users: string; tenants: string }>(
      sql`SELECT (SELECT count(*) FROM users WHERE email = ${email})::text AS users,
                 (SELECT count(DISTINCT tenant_id) FROM users WHERE email = ${email})::text AS tenants`,
    );
    expect(c).toEqual({ users: "1", tenants: "1" });
  });
});

describe("POST /signup: an address that already has a workspace", () => {
  it("creates nothing new, sends a link, and looks identical to a new signup", async () => {
    if (!dbAvailable) return;
    const app = await newApp();
    const existing = `exists1${DOMAIN}`;
    await post(app, goodFields(existing));
    const [before] = await rows<{ t: string; l: string }>(
      sql`SELECT (SELECT count(*) FROM tenants WHERE id IN (SELECT tenant_id FROM users WHERE email LIKE ${"%" + DOMAIN}))::text AS t,
                 (SELECT count(*) FROM magic_link_tokens WHERE user_id IN (SELECT id FROM users WHERE email = ${existing}))::text AS l`,
    );

    const again = await post(app, goodFields(existing, { workspace: "Different Name" }));
    const fresh = await post(app, goodFields(`fresh1${DOMAIN}`));

    const [after] = await rows<{ t: string; l: string }>(
      sql`SELECT (SELECT count(*) FROM tenants WHERE id IN (SELECT tenant_id FROM users WHERE email = ${existing}))::text AS t,
                 (SELECT count(*) FROM magic_link_tokens WHERE user_id IN (SELECT id FROM users WHERE email = ${existing}))::text AS l`,
    );
    expect(after!.t).toBe("1"); // still one workspace for that address
    expect(Number(after!.l)).toBe(Number(before!.l) + 1); // and a fresh link was issued

    // No enumeration: same status and same page, apart from the echoed address.
    expect(again.statusCode).toBe(fresh.statusCode);
    const strip = (body: string, email: string) => body.split(email).join("<EMAIL>");
    expect(strip(again.body, existing)).toBe(strip(fresh.body, `fresh1${DOMAIN}`));
  });
});

describe("POST /signup: refusing bad input", () => {
  it("a filled honeypot looks like success but creates nothing", async () => {
    if (!dbAvailable) return;
    const app = await newApp();
    const email = `bot1${DOMAIN}`;
    const res = await post(app, goodFields(email, { website: "http://spam.example" }));
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Check your email");
    const [c] = await rows<{ n: string }>(sql`SELECT count(*)::text AS n FROM users WHERE email = ${email}`);
    expect(c!.n).toBe("0");
  });

  it("a disposable address is refused with the form re-shown and values kept", async () => {
    if (!dbAvailable) return;
    const app = await newApp();
    const res = await post(app, goodFields("x@mailinator.com", { workspace: "Keep My Name" }));
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("disposable");
    expect(res.body).toContain('value="Keep My Name"');
    const [c] = await rows<{ n: string }>(sql`SELECT count(*)::text AS n FROM users WHERE email = 'x@mailinator.com'`);
    expect(c!.n).toBe("0");
  });

  it("not accepting the terms is refused", async () => {
    if (!dbAvailable) return;
    const app = await newApp();
    const email = `noterms1${DOMAIN}`;
    const res = await post(app, { workspace: "Acme", email });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("Terms");
    const [c] = await rows<{ n: string }>(sql`SELECT count(*)::text AS n FROM users WHERE email = ${email}`);
    expect(c!.n).toBe("0");
  });

  it("hostile input is escaped when the form is re-shown", async () => {
    if (!dbAvailable) return;
    const app = await newApp();
    const res = await post(app, { workspace: '"><script>alert(1)</script>', email: "bad", terms: "yes" });
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain("<script>alert(1)</script>");
    expect(res.body).toContain("&lt;script&gt;");
  });
});

describe("POST /signup: rate limits", () => {
  it("blocks a fourth attempt for the same address within the hour", async () => {
    if (!dbAvailable) return;
    const app = await newApp();
    const email = `rl-email${DOMAIN}`;
    for (let i = 0; i < 3; i++) expect((await post(app, goodFields(email))).statusCode).toBe(200);
    const res = await post(app, goodFields(email));
    expect(res.statusCode).toBe(429);
    expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
    expect(res.body).toContain("Too many attempts");
  });

  it("blocks a seventh signup from one IP within the hour", async () => {
    if (!dbAvailable) return;
    const app = await newApp();
    for (let i = 0; i < 6; i++) {
      expect((await post(app, goodFields(`rl-ip${i}${DOMAIN}`), "203.0.113.9")).statusCode, `attempt ${i}`).toBe(200);
    }
    expect((await post(app, goodFields(`rl-ip6${DOMAIN}`), "203.0.113.9")).statusCode).toBe(429);
    // A different IP is unaffected.
    expect((await post(app, goodFields(`rl-ip7${DOMAIN}`), "203.0.113.10")).statusCode).toBe(200);
  });

  describe("behind a reverse proxy (MAILFORGE_TRUST_PROXY)", () => {
    // Every request arrives from the proxy (10.0.0.1); the real visitor is in X-Forwarded-For.
    const viaProxy = (app: FastifyInstance, email: string, visitor: string) =>
      app.inject({
        method: "POST",
        url: "/signup",
        headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": visitor },
        payload: form(goodFields(email)),
        remoteAddress: "10.0.0.1",
      });

    it("by default the header is ignored, so one client cannot dodge the limit by changing it", async () => {
      if (!dbAvailable) return;
      delete process.env.MAILFORGE_TRUST_PROXY;
      const app = await newApp();
      for (let i = 0; i < 6; i++) expect((await viaProxy(app, `tp-off${i}${DOMAIN}`, `198.51.100.${i + 1}`)).statusCode, `attempt ${i}`).toBe(200);
      expect((await viaProxy(app, `tp-off6${DOMAIN}`, "198.51.100.77")).statusCode).toBe(429);
    });

    it("with trust on, each visitor is counted by their own address, not the proxy's", async () => {
      if (!dbAvailable) return;
      process.env.MAILFORGE_TRUST_PROXY = "true";
      try {
        const app = await newApp();
        // Eight different visitors through the same proxy: none is limited.
        for (let i = 0; i < 8; i++) expect((await viaProxy(app, `tp-on${i}${DOMAIN}`, `198.51.100.${i + 1}`)).statusCode, `visitor ${i}`).toBe(200);
        // One visitor still hits the per-IP limit of six.
        for (let i = 0; i < 6; i++) expect((await viaProxy(app, `tp-same${i}${DOMAIN}`, "203.0.113.50")).statusCode, `same ${i}`).toBe(200);
        expect((await viaProxy(app, `tp-same6${DOMAIN}`, "203.0.113.50")).statusCode).toBe(429);
      } finally {
        delete process.env.MAILFORGE_TRUST_PROXY;
      }
    });

    it("trusting one proxy takes the address that proxy added, ignoring what the client sent before it", async () => {
      if (!dbAvailable) return;
      process.env.MAILFORGE_TRUST_PROXY = "1";
      try {
        const app = await newApp();
        // The client claims a different address each time, but the proxy always appends the real one.
        for (let i = 0; i < 6; i++) {
          expect((await viaProxy(app, `tp-one${i}${DOMAIN}`, `198.51.100.${i + 1}, 203.0.113.60`)).statusCode, `attempt ${i}`).toBe(200);
        }
        // The same real visitor (the proxy-added entry) is limited, whatever the client wrote before it...
        expect((await viaProxy(app, `tp-one6${DOMAIN}`, "192.0.2.1, 203.0.113.60")).statusCode).toBe(429);
        // ...and a different real visitor through the same proxy is not.
        expect((await viaProxy(app, `tp-one7${DOMAIN}`, "192.0.2.1, 203.0.113.61")).statusCode).toBe(200);
      } finally {
        delete process.env.MAILFORGE_TRUST_PROXY;
      }
    });
  });

  it("JSON clients get a 429 JSON body", async () => {
    if (!dbAvailable) return;
    const app = await newApp();
    const email = `rl-json${DOMAIN}`;
    const send = () =>
      app.inject({ method: "POST", url: "/signup", headers: { "content-type": "application/json" }, payload: JSON.stringify({ workspace: "Acme", email, terms: true }) });
    for (let i = 0; i < 3; i++) await send();
    const res = await send();
    expect(res.statusCode).toBe(429);
    expect(res.json().error).toContain("Too many attempts");
  });
});

describe("signup to signed-in workspace, end to end", () => {
  it("the emailed link signs the new owner into their own empty workspace", async () => {
    if (!dbAvailable) return;
    const logged: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logged.push(a.join(" ")));

    const app = await newApp();
    const email = `e2e1${DOMAIN}`;
    expect((await post(app, goodFields(email, { workspace: "End To End" }))).statusCode).toBe(200);

    // With no transport anywhere, the sign-in link is printed to the console.
    const line = logged.find((l) => l.includes("/auth/verify?token="));
    expect(line, "sign-in link was issued").toBeDefined();
    const token = new URL(line!.match(/https?:\/\/\S+/)![0]).searchParams.get("token")!;

    // The page the link opens carries the current brand, not the old droplet.
    const page = await app.inject({ method: "GET", url: `/auth/verify?token=${encodeURIComponent(token)}` });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("M5 5 H19");
    expect(page.body).toContain("#b8541a");
    expect(page.body).not.toContain("M0 -10.8");
    expect(page.body).not.toContain("#008fba");

    const verify = await app.inject({
      method: "POST",
      url: "/auth/verify",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: form({ token }),
    });
    expect(verify.statusCode).toBe(302);
    const cookie = verify.cookies.find((c: { name: string }) => c.name === SESSION_COOKIE_NAME)!;
    expect(cookie).toBeDefined();

    const me = await app.inject({ method: "GET", url: "/auth/me", cookies: { [SESSION_COOKIE_NAME]: cookie.value } });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.email).toBe(email);

    // The new workspace is isolated: it sees none of anyone else's contacts.
    const contacts = await app.inject({ method: "GET", url: "/v1/contacts", cookies: { [SESSION_COOKIE_NAME]: cookie.value } });
    expect(contacts.statusCode).toBe(200);
    expect(contacts.json().contacts).toEqual([]);

    // The token was single-use.
    const replay = await app.inject({
      method: "POST",
      url: "/auth/verify",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: form({ token }),
    });
    expect(replay.statusCode).toBe(302);
    expect(String(replay.headers.location)).toContain("invalid_link");
  });
});

describe("POST /signup: Mailforge Sending is switched on for new workspaces", () => {
  const offer = (shared: string | null = "hello@shared.example") => {
    process.env.MAILFORGE_MANAGED_RESEND_API_KEY = "re_operator";
    if (shared) process.env.MAILFORGE_MANAGED_SHARED_FROM = shared;
  };
  async function signupManaged(tag: string) {
    const app = await newApp();
    const email = `${tag}${DOMAIN}`;
    expect((await post(app, goodFields(email))).statusCode).toBe(200);
    return rows<{ enabled: boolean; domain: string | null; paused_at: Date | null }>(
      sql`SELECT m.enabled, m.domain, m.paused_at FROM managed_sending m JOIN users u ON u.tenant_id = m.tenant_id WHERE u.email = ${email}`,
    );
  }

  it("turns it on when the operator offers it and has a shared address", async () => {
    if (!dbAvailable) return;
    offer();
    const m = await signupManaged("auto1");
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ enabled: true, domain: null, paused_at: null });
  });

  it("does not, when there is no shared address (it would wait for a verified domain)", async () => {
    if (!dbAvailable) return;
    offer(null);
    expect(await signupManaged("auto2")).toHaveLength(0);
  });

  it("does not, when managed sending is not offered at all", async () => {
    if (!dbAvailable) return;
    process.env.MAILFORGE_MANAGED_SHARED_FROM = "hello@shared.example";
    expect(await signupManaged("auto3")).toHaveLength(0);
  });

  it("does not, when the operator switched managed sending off", async () => {
    if (!dbAvailable) return;
    offer();
    process.env.MAILFORGE_MANAGED_SENDING = "false";
    expect(await signupManaged("auto4")).toHaveLength(0);
  });

  it("does not, when the operator opted out of auto-enable", async () => {
    if (!dbAvailable) return;
    offer();
    process.env.MAILFORGE_SIGNUP_AUTO_SENDING = "false";
    expect(await signupManaged("auto5")).toHaveLength(0);
  });

  it("creates one row only, even when the same form is submitted twice", async () => {
    if (!dbAvailable) return;
    offer();
    const app = await newApp();
    const email = `auto6${DOMAIN}`;
    await post(app, goodFields(email));
    await post(app, goodFields(email));
    const n = await rows<{ n: string }>(sql`SELECT count(*)::text AS n FROM managed_sending m JOIN users u ON u.tenant_id = m.tenant_id WHERE u.email = ${email}`);
    expect(n[0]!.n).toBe("1");
  });

  it("leaves an existing workspace untouched when its owner signs up again", async () => {
    if (!dbAvailable) return;
    const app = await newApp();
    const email = `auto7${DOMAIN}`;
    await post(app, goodFields(email));
    offer();
    await post(app, goodFields(email));
    const n = await rows<{ n: string }>(sql`SELECT count(*)::text AS n FROM managed_sending m JOIN users u ON u.tenant_id = m.tenant_id WHERE u.email = ${email}`);
    expect(n[0]!.n).toBe("0");
  });

  it("makes the onboarding sender step done straight away", async () => {
    if (!dbAvailable) return;
    offer();
    const app = await newApp();
    const email = `auto8${DOMAIN}`;
    await post(app, goodFields(email));
    const [u] = await rows<{ id: string; tenant_id: string }>(sql`SELECT id, tenant_id FROM users WHERE email = ${email}`);
    const [s] = await rows<{ id: string }>(sql`INSERT INTO sessions (tenant_id, user_id, expires_at) VALUES (${u!.tenant_id}::uuid, ${u!.id}::uuid, now() + interval '1 day') RETURNING id`);
    const res = await app.inject({ method: "GET", url: "/v1/onboarding", cookies: { [SESSION_COOKIE_NAME]: s!.id } });
    expect(res.json().steps.find((x: { id: string }) => x.id === "sender").done).toBe(true);
  });
});

describe("POST /signup: goal", () => {
  const goalOf = async (email: string) =>
    (await rows<{ g: string | null }>(sql`SELECT t.settings->'signup'->>'goal' AS g FROM tenants t JOIN users u ON u.tenant_id = t.id WHERE u.email = ${email}`))[0]!.g;

  it("stores the chosen goal next to the plan interest", async () => {
    if (!dbAvailable) return;
    const app = await newApp();
    const email = `goal1${DOMAIN}`;
    expect((await post(app, goodFields(email, { goal: "convert_trials" }))).statusCode).toBe(200);
    expect(await goalOf(email)).toBe("convert_trials");
  });

  it("stores nothing when the question was skipped", async () => {
    if (!dbAvailable) return;
    const app = await newApp();
    const email = `goal2${DOMAIN}`;
    await post(app, goodFields(email));
    expect(await goalOf(email)).toBeNull();
  });

  it("ignores an unknown goal but still creates the workspace", async () => {
    if (!dbAvailable) return;
    const app = await newApp();
    const email = `goal3${DOMAIN}`;
    expect((await post(app, goodFields(email, { goal: "<script>x</script>" }))).statusCode).toBe(200);
    expect(await goalOf(email)).toBeNull();
  });

  it("accepts the goal in a JSON signup too", async () => {
    if (!dbAvailable) return;
    const app = await newApp();
    const email = `goal4${DOMAIN}`;
    const res = await app.inject({ method: "POST", url: "/signup", headers: { "content-type": "application/json" }, payload: JSON.stringify({ workspace: "Goal Co", email, terms: true, goal: "upgrade_free" }) });
    expect(res.statusCode).toBe(200);
    expect(await goalOf(email)).toBe("upgrade_free");
  });

  it("keeps the chosen goal selected when the form comes back with an error", async () => {
    if (!dbAvailable) return;
    const app = await newApp();
    const res = await post(app, { workspace: "Goal Co", email: "not-an-email", terms: "yes", goal: "upgrade_free" });
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatch(/name="goal" value="upgrade_free" checked/);
  });

  it("does not change the goal of an existing workspace when its owner signs up again", async () => {
    if (!dbAvailable) return;
    const app = await newApp();
    const email = `goal5${DOMAIN}`;
    await post(app, goodFields(email, { goal: "welcome" }));
    await post(app, goodFields(email, { goal: "convert_trials" }));
    expect(await goalOf(email)).toBe("welcome");
  });
});
