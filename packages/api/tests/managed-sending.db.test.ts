/**
 * Integration tests for managed sending: a workspace without an email provider of its
 * own sends through the operator's Resend account. A fake Resend stands in for the real
 * one (domains API, send API, signed webhooks).
 *
 * Covers who may do what, the domain flow (create, verify, change, remove), what is
 * refused, what happens when Resend is down or the operator's key is wrong, that a
 * workspace's own transport always wins, the shared webhook (it can only touch managed
 * workspaces), the test email, data export and erasure (the Resend domain is queued for
 * removal), and the cleanup sweeper.
 *
 * Needs a reachable Postgres via DATABASE_URL. Tenants have slugs starting with "msnd-t-".
 */
import { createHash, randomBytes } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import { SESSION_COOKIE_NAME } from "../src/routes/auth.js";
import { encrypt, parseEncryptionKey } from "@mailforge/adapters";
import { purgeWorkspace } from "@mailforge/db/purge";
import { createResendDomainsClient } from "@mailforge/adapters";
import { sweepDomainCleanup } from "../src/sending/domains.js";
import { resolveManagedAdapter } from "../src/sending/context.js";
import { openWorkspaceExport } from "../src/account/export.js";
import { startFakeResend, type FakeResend } from "./helpers/fake-resend.js";

const TEST_DB_URL = process.env.DATABASE_URL;
if (!TEST_DB_URL) throw new Error("[managed-sending.test] DATABASE_URL is not set.");

const ENC_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const SHARED = "notifications@mail.platform.test";
const MANAGED_ENV = ["MAILFORGE_MANAGED_RESEND_API_KEY", "MAILFORGE_MANAGED_RESEND_WEBHOOK_SECRET", "MAILFORGE_MANAGED_SHARED_FROM", "MAILFORGE_MANAGED_SHARED_DAILY_LIMIT", "MAILFORGE_MANAGED_RESEND_BASE_URL", "MAILFORGE_MANAGED_SENDING"];

let pool: pg.Pool;
let lockClient: pg.PoolClient | undefined;
let db: ReturnType<typeof drizzle>;
let dbAvailable = false;
let app: FastifyInstance;
let fake: FakeResend;
let savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const k of [...MANAGED_ENV, "ENCRYPTION_KEY", "UNSUBSCRIBE_SIGNING_KEY", "BASE_URL"]) savedEnv[k] = process.env[k];
  process.env.ENCRYPTION_KEY = ENC_KEY;
  process.env.UNSUBSCRIBE_SIGNING_KEY = "test-unsubscribe-signing-key-do-not-use";
  fake = await startFakeResend();
  fake.addVerifiedDomain("mail.platform.test");
  pool = new pg.Pool({ connectionString: TEST_DB_URL, connectionTimeoutMillis: 3000 });
  try {
    await pool.query("SELECT 1");
    db = drizzle(pool);
    dbAvailable = true;
    lockClient = await pool.connect();
    await lockClient.query("SELECT pg_advisory_lock(7770001)");
  } catch (err) {
    if (process.env.CI === "true") throw new Error(`[managed-sending.test] DATABASE_URL not reachable in CI: ${(err as Error).message}`);
    console.warn("[managed-sending.test] DATABASE_URL not reachable - tests skipped.");
    return;
  }
  await cleanup();
  app = await buildApp({ logger: false, db, baseUrl: "http://localhost:3000", dashboardUrl: "http://localhost:3000" });
});

function offer(extra: Record<string, string> = {}) {
  process.env.MAILFORGE_MANAGED_RESEND_API_KEY = fake.apiKey;
  process.env.MAILFORGE_MANAGED_RESEND_BASE_URL = fake.baseUrl;
  process.env.MAILFORGE_MANAGED_RESEND_WEBHOOK_SECRET = fake.webhookSecret;
  process.env.MAILFORGE_MANAGED_SHARED_FROM = SHARED;
  process.env.MAILFORGE_MANAGED_SHARED_DAILY_LIMIT = "100";
  for (const [k, v] of Object.entries(extra)) process.env[k] = v;
}

afterEach(async () => {
  if (!dbAvailable) return;
  for (const k of MANAGED_ENV) delete process.env[k];
  fake.setDown(false);
  fake.emails.length = 0;
  fake.requests.length = 0;
  for (const [id, d] of [...fake.domains]) if (d.name !== "mail.platform.test") fake.domains.delete(id);
  await cleanup();
});

afterAll(async () => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  if (app) await app.close();
  if (lockClient) {
    await lockClient.query("SELECT pg_advisory_unlock(7770001)");
    lockClient.release();
  }
  await pool?.end();
  await fake?.close();
});

// --- helpers ----------------------------------------------------------------
interface Tenant {
  id: string;
  slug: string;
  email: string;
  session: string;
  memberSession: string;
}

async function q<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  return (await db.execute(query)).rows as T[];
}

let counter = 0;
async function newTenant(opts: { name?: string; brandName?: string; postal?: boolean } = {}): Promise<Tenant> {
  const slug = `msnd-t-${Date.now()}-${counter++}`;
  const email = `owner-${slug}@msnd.example`;
  const settings: Record<string, unknown> = {};
  if (opts.postal !== false) settings.postal_address = "1 Test Street, Testville";
  if (opts.brandName) settings.brand = { brand_name: opts.brandName };
  const [t] = await q<{ id: string }>(sql`INSERT INTO tenants (name, slug, settings) VALUES (${opts.name ?? "Acme Analytics"}, ${slug}, ${JSON.stringify(settings)}::jsonb) RETURNING id`);
  const id = t!.id;
  const [u] = await q<{ id: string }>(sql`INSERT INTO users (tenant_id, email, role) VALUES (${id}::uuid, ${email}, 'owner') RETURNING id`);
  const [m] = await q<{ id: string }>(sql`INSERT INTO users (tenant_id, email, role) VALUES (${id}::uuid, ${"member-" + email}, 'member') RETURNING id`);
  const [s] = await q<{ id: string }>(sql`INSERT INTO sessions (tenant_id, user_id, expires_at) VALUES (${id}::uuid, ${u!.id}::uuid, now() + interval '1 day') RETURNING id`);
  const [ms] = await q<{ id: string }>(sql`INSERT INTO sessions (tenant_id, user_id, expires_at) VALUES (${id}::uuid, ${m!.id}::uuid, now() + interval '1 day') RETURNING id`);
  const key = `mf_live_${randomBytes(24).toString("base64url")}`;
  await db.execute(sql`INSERT INTO api_keys (tenant_id, key_hash, prefix, label) VALUES (${id}::uuid, ${createHash("sha256").update(key).digest("hex")}, ${key.slice(0, 8)}, 'msnd test')`);
  return { id, slug, email, session: s!.id, memberSession: ms!.id };
}

async function cleanup(): Promise<void> {
  const ids = (await q<{ id: string }>(sql`SELECT id FROM tenants WHERE slug LIKE 'msnd-t-%'`)).map((r) => r.id);
  for (const id of ids) {
    for (const t of ["message_events", "suppressions", "lifecycle_messages", "flow_memberships", "flows", "contacts", "managed_sending", "transport_configs", "admin_audit_log", "api_keys", "sessions", "users"]) {
      await db.execute(sql.raw(`DELETE FROM ${t} WHERE tenant_id = '${id}'`));
    }
    await db.execute(sql`DELETE FROM tenants WHERE id = ${id}::uuid`);
  }
  await db.execute(sql`DELETE FROM managed_domain_cleanup`);
}

const as = (s: string) => ({ [SESSION_COOKIE_NAME]: s });
const call = (method: "GET" | "PUT" | "POST" | "PATCH" | "DELETE", url: string, session: string, payload?: unknown) =>
  app.inject({ method, url, cookies: as(session), ...(payload !== undefined ? { payload: payload as object } : {}) });
const get = (t: Tenant) => call("GET", "/v1/sending", t.session);
const enable = (t: Tenant) => call("POST", "/v1/sending/enable", t.session);
const setDomain = (t: Tenant, domain: unknown, extra: Record<string, unknown> = {}) => call("PUT", "/v1/sending/domain", t.session, { domain, ...extra });
const row = async (t: Tenant) => (await q<Record<string, unknown>>(sql`SELECT * FROM managed_sending WHERE tenant_id = ${t.id}::uuid`))[0];
const resendDomains = () => [...fake.domains.values()].filter((d) => d.name !== "mail.platform.test");
const ageCheck = (t: Tenant) => db.execute(sql`UPDATE managed_sending SET domain_checked_at = now() - interval '5 minutes' WHERE tenant_id = ${t.id}::uuid`);

// ---------------------------------------------------------------------------

describe("when the operator does not offer managed sending", () => {
  it("reports it as unavailable, and refuses to turn on or add a domain", async () => {
    const t = await newTenant();
    const g = (await get(t)).json();
    expect(g).toMatchObject({ available: false, uses: "nothing", managed: null });
    expect((await enable(t)).statusCode).toBe(503);
    expect((await enable(t)).json().code).toBe("managed_unavailable");
    expect((await setDomain(t, "mail.acme-test.dev")).statusCode).toBe(503);
    expect(fake.requests).toHaveLength(0);
  });

  it("a key alone is not enough if the operator switched it off", async () => {
    offer({ MAILFORGE_MANAGED_SENDING: "false" });
    const t = await newTenant();
    expect((await get(t)).json().available).toBe(false);
  });
});

describe("turning it on", () => {
  it("only the owner can; a member can look but not change anything", async () => {
    offer();
    const t = await newTenant();
    expect((await call("POST", "/v1/sending/enable", t.memberSession)).statusCode).toBe(403);
    expect((await call("PUT", "/v1/sending/domain", t.memberSession, { domain: "mail.acme-test.dev" })).statusCode).toBe(403);
    expect((await call("PATCH", "/v1/sending", t.memberSession, { from_name: "X" })).statusCode).toBe(403);
    expect((await call("DELETE", "/v1/sending", t.memberSession)).statusCode).toBe(403);
    expect((await call("POST", "/v1/sending/domain/verify", t.memberSession)).statusCode).toBe(403);
    expect((await call("DELETE", "/v1/sending/domain", t.memberSession)).statusCode).toBe(403);
    expect((await call("GET", "/v1/sending", t.memberSession)).statusCode).toBe(200);
    expect(await row(t)).toBeUndefined();
  });

  it("sends from the shared address straight away: the workspace's name, its owner as Reply-To, and the shared address never shown", async () => {
    offer();
    const t = await newTenant({ name: "Acme Analytics" });
    expect((await get(t)).json()).toMatchObject({ available: true, uses: "nothing", shared: { offered: true, daily_limit: 100 } });
    const e = (await enable(t)).json();
    expect(e.uses).toBe("managed");
    expect(e.managed).toMatchObject({ enabled: true, domain: null, domain_status: "none", needs_domain: false });
    expect(e.managed.sender).toEqual({ mode: "shared", from_email: null, from_name: "Acme Analytics", reply_to: t.email });
    expect(JSON.stringify(e)).not.toContain(SHARED);
  });

  it("the sender name follows the brand name, and reply goes to the brand reply address when set", async () => {
    offer();
    const t = await newTenant({ brandName: "Acme Brand" });
    await db.execute(sql`UPDATE tenants SET settings = jsonb_set(settings, '{brand,reply_to}', '"support@acme-test.dev"') WHERE id = ${t.id}::uuid`);
    const e = (await enable(t)).json();
    expect(e.managed.sender).toMatchObject({ from_name: "Acme Brand", reply_to: "support@acme-test.dev" });
  });

  it("with no shared address offered, it cannot send until a domain is verified, and says so", async () => {
    offer();
    delete process.env.MAILFORGE_MANAGED_SHARED_FROM;
    const t = await newTenant();
    const e = (await enable(t)).json();
    expect(e.uses).toBe("nothing");
    expect(e.managed).toMatchObject({ needs_domain: true, sender: null });
    expect(e.shared).toEqual({ offered: false, daily_limit: null });
  });

  it("turning it off stops it, and on again keeps the domain settings", async () => {
    offer();
    const t = await newTenant();
    await enable(t);
    await setDomain(t, "mail.acme-test.dev");
    expect((await call("DELETE", "/v1/sending", t.session)).json().uses).toBe("nothing");
    const again = (await enable(t)).json();
    expect(again.uses).toBe("managed");
    expect(again.managed.domain).toBe("mail.acme-test.dev");
  });

  it("a workspace's own transport always wins; managed sending waits", async () => {
    offer();
    const t = await newTenant();
    await enable(t);
    const cfg = encrypt(JSON.stringify({ apiKey: "re_theirs" }), parseEncryptionKey(ENC_KEY));
    await db.execute(sql`INSERT INTO transport_configs (tenant_id, provider, config, is_active, from_email) VALUES (${t.id}::uuid, 'resend', ${cfg}, true, 'me@theirs.example')`);
    expect((await get(t)).json().uses).toBe("own_transport");
    await db.execute(sql`DELETE FROM transport_configs WHERE tenant_id = ${t.id}::uuid`);
    expect((await get(t)).json().uses).toBe("managed");
  });
});

describe("adding a sending domain", () => {
  it("registers it at Resend and hands back the DNS records to create, with the workspace still sending from the shared address meanwhile", async () => {
    offer();
    const t = await newTenant();
    const r = await setDomain(t, "Mail.Acme-Test.dev", { from_local: "Team" });
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b.managed).toMatchObject({ domain: "mail.acme-test.dev", domain_status: "not_started", from_local: "team" });
    expect(b.managed.dns_records.map((x: { type: string }) => x.type).sort()).toEqual(["MX", "TXT", "TXT"]);
    expect(b.managed.dns_records[0]).toMatchObject({ name: expect.any(String), value: expect.any(String), status: "not_started" });
    expect(b.managed.sender.mode).toBe("shared");
    expect(resendDomains().map((d) => d.name)).toEqual(["mail.acme-test.dev"]);
    expect(await row(t)).toMatchObject({ domain: "mail.acme-test.dev", domain_status: "not_started", enabled: true });
  });

  it("turns on managed sending by itself if the owner goes straight to adding a domain", async () => {
    offer();
    const t = await newTenant();
    expect((await setDomain(t, "mail.acme-test.dev")).json().uses).toBe("managed");
  });

  it("refuses things that are not a usable domain, before anything reaches Resend", async () => {
    offer();
    const t = await newTenant();
    for (const bad of ["", "gmail.com", "x@yahoo.com", "1.2.3.4", "localhost", "acme", "platform.test", "send.mail.platform.test", "bad domain.com", 42, null]) {
      const r = await setDomain(t, bad);
      expect(r.statusCode, String(bad)).toBe(400);
      expect(r.json().code).toBe("invalid_domain");
    }
    expect((await setDomain(t, "mail.acme-test.dev", { from_local: "a b" })).json().code).toBe("invalid_from_local");
    expect(resendDomains()).toHaveLength(0);
    expect(fake.requests.filter((x) => x.path === "/domains")).toHaveLength(0);
  });

  it("the operator's own domains cannot be claimed (including the host the app is served from)", async () => {
    offer();
    process.env.BASE_URL = "https://app.mailforge-service.test";
    const t = await newTenant();
    for (const d of ["mailforge-service.test", "app.mailforge-service.test", "x.mailforge-service.test"]) {
      expect((await setDomain(t, d)).statusCode, d).toBe(d === "mailforge-service.test" || d.endsWith(".mailforge-service.test") ? 400 : 200);
    }
  });

  it("a domain can belong to one workspace only, whatever the capitals", async () => {
    offer();
    const a = await newTenant();
    const b = await newTenant();
    expect((await setDomain(a, "mail.acme-test.dev")).statusCode).toBe(200);
    const r = await setDomain(b, "MAIL.ACME-TEST.DEV");
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe("domain_taken");
    expect(await row(b)).toBeUndefined();
    expect(resendDomains()).toHaveLength(1);
    // Refused before Resend is even asked: only the first workspace's request ever reached it.
    expect(fake.requests.filter((x) => x.method === "POST" && x.path === "/domains")).toHaveLength(1);
  });

  it("a domain Resend already has but we do not (left over, or someone else's) is refused the same way, nothing stored", async () => {
    offer();
    const t = await newTenant();
    const other = createResendDomainsClient({ apiKey: fake.apiKey, baseUrl: fake.baseUrl });
    await other.createDomain("orphan.acme-test.dev");
    const r = await setDomain(t, "orphan.acme-test.dev");
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe("domain_taken");
    expect(await row(t)).toBeUndefined();
  });

  it("setting the same domain again is harmless and creates nothing new", async () => {
    offer();
    const t = await newTenant();
    await setDomain(t, "mail.acme-test.dev");
    const before = fake.requests.filter((x) => x.method === "POST" && x.path === "/domains").length;
    expect((await setDomain(t, "mail.acme-test.dev", { from_local: "news" })).json().managed.from_local).toBe("news");
    expect(fake.requests.filter((x) => x.method === "POST" && x.path === "/domains")).toHaveLength(before);
  });

  it("changing the domain removes the old one from Resend", async () => {
    offer();
    const t = await newTenant();
    await setDomain(t, "mail.old-test.dev");
    await setDomain(t, "mail.new-test.dev");
    expect(resendDomains().map((d) => d.name)).toEqual(["mail.new-test.dev"]);
    expect((await row(t))!.domain).toBe("mail.new-test.dev");
  });

  it("limits how often a workspace can change its domain", async () => {
    offer();
    const t = await newTenant();
    let last = 200;
    for (let i = 0; i < 8; i++) last = (await setDomain(t, `d${i}.acme-test.dev`)).statusCode;
    expect(last).toBe(429);
  });

  it("when Resend is down or the operator's key is wrong the customer gets a plain 'try again' and nothing is stored or leaked", async () => {
    offer();
    const t = await newTenant();
    fake.setDown(true);
    let r = await setDomain(t, "mail.acme-test.dev");
    expect(r.statusCode).toBe(502);
    expect(r.json().code).toBe("sending_unavailable");
    fake.setDown(false);
    process.env.MAILFORGE_MANAGED_RESEND_API_KEY = "re_wrong_key";
    r = await setDomain(t, "mail.acme-test.dev");
    expect(r.statusCode).toBe(502);
    expect(r.body).not.toMatch(/re_wrong_key|re_fake|127\.0\.0\.1|resend/i);
    expect(await row(t)).toBeUndefined();
  });

  it("passes on a Resend rejection of the name as a plain 400, and a busy Resend as 429", async () => {
    offer();
    const t = await newTenant();
    fake.failNext("/domains", 422, "validation_error", "The domain name is invalid.");
    expect((await setDomain(t, "mail.acme-test.dev")).statusCode).toBe(400);
    fake.failNext("/domains", 429, "rate_limit_exceeded", "Too many requests");
    expect((await setDomain(t, "mail.acme-test.dev")).statusCode).toBe(429);
  });

  it("is refused while sending is paused for the workspace", async () => {
    offer();
    const t = await newTenant();
    await enable(t);
    await db.execute(sql`UPDATE managed_sending SET paused_at = now(), paused_reason = 'x', paused_by = 'auto' WHERE tenant_id = ${t.id}::uuid`);
    const r = await setDomain(t, "mail.acme-test.dev");
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe("paused");
  });
});

describe("verifying the domain", () => {
  it("asks Resend to check, reads the answer back, and starts sending from the domain once it is verified", async () => {
    offer();
    const t = await newTenant();
    await setDomain(t, "mail.acme-test.dev", { from_local: "hello" });
    let r = await call("POST", "/v1/sending/domain/verify", t.session);
    expect(r.statusCode).toBe(200);
    expect(r.json().managed.domain_status).toBe("pending");
    expect(r.json().managed.sender.mode).toBe("shared");
    expect([...fake.domains.values()].find((d) => d.name === "mail.acme-test.dev")!.verifyRequests).toBe(1);

    fake.setStatus("mail.acme-test.dev", "verified"); // DNS set up
    r = await call("POST", "/v1/sending/domain/verify", t.session);
    expect(r.json().managed).toMatchObject({ domain_status: "verified", sender: { mode: "domain", from_email: "hello@mail.acme-test.dev" } });
    expect(r.json().managed.domain_verified_at).toEqual(expect.any(String));
  });

  it("opening the page re-checks a domain that is still verifying (no more often than every 20 seconds), and verified ones are left alone", async () => {
    offer();
    const t = await newTenant();
    await setDomain(t, "mail.acme-test.dev");
    const gets = () => fake.requests.filter((x) => x.method === "GET" && x.path.startsWith("/domains/")).length;
    await get(t); // just created: checked a moment ago, so not again
    expect(gets()).toBe(0);
    fake.setStatus("mail.acme-test.dev", "verified");
    await ageCheck(t);
    expect((await get(t)).json().managed.domain_status).toBe("verified");
    expect(gets()).toBe(1);
    await ageCheck(t);
    await get(t);
    expect(gets()).toBe(1); // verified: never asked again
  });

  it("shows a failed domain as failed and keeps using the shared address", async () => {
    offer();
    const t = await newTenant();
    await setDomain(t, "mail.acme-test.dev");
    fake.setStatus("mail.acme-test.dev", "failed");
    await ageCheck(t);
    const g = (await get(t)).json();
    expect(g.managed).toMatchObject({ domain_status: "failed" });
    expect(g.managed.sender.mode).toBe("shared");
  });

  it("a domain that was verified and later fails goes back to the shared address, and its verified time is cleared", async () => {
    offer();
    const t = await newTenant();
    await setDomain(t, "mail.acme-test.dev");
    fake.setStatus("mail.acme-test.dev", "verified");
    await ageCheck(t);
    await call("POST", "/v1/sending/domain/verify", t.session);
    expect((await row(t))!.domain_verified_at).not.toBeNull();
    fake.setStatus("mail.acme-test.dev", "failed");
    await call("POST", "/v1/sending/domain/verify", t.session);
    expect((await row(t))!.domain_verified_at).toBeNull();
    expect((await get(t)).json().managed.sender.mode).toBe("shared");
  });

  it("needs a domain first, limits how often it can be asked, and survives Resend being down", async () => {
    offer();
    const t = await newTenant();
    expect((await call("POST", "/v1/sending/domain/verify", t.session)).statusCode).toBe(409);
    await setDomain(t, "mail.acme-test.dev");
    fake.setDown(true);
    expect((await call("POST", "/v1/sending/domain/verify", t.session)).statusCode).toBe(502);
    fake.setDown(false);
    let last = 200;
    for (let i = 0; i < 8; i++) last = (await call("POST", "/v1/sending/domain/verify", t.session)).statusCode;
    expect(last).toBe(429);
  });

  it("removing the domain removes it at Resend and returns to the shared address", async () => {
    offer();
    const t = await newTenant();
    await setDomain(t, "mail.acme-test.dev");
    const r = await call("DELETE", "/v1/sending/domain", t.session);
    expect(r.json().managed).toMatchObject({ domain: null, domain_status: "none", dns_records: [] });
    expect(resendDomains()).toHaveLength(0);
    expect((await row(t))!.resend_domain_id).toBeNull();
    // and the name is free for anyone again
    const other = await newTenant();
    expect((await setDomain(other, "mail.acme-test.dev")).statusCode).toBe(200);
  });

  it("if Resend cannot be reached when removing, the domain is queued for removal, not left behind", async () => {
    offer();
    const t = await newTenant();
    await setDomain(t, "mail.acme-test.dev");
    const id = (await row(t))!.resend_domain_id as string;
    fake.setDown(true);
    expect((await call("DELETE", "/v1/sending/domain", t.session)).statusCode).toBe(200);
    fake.setDown(false);
    expect((await q<{ resend_domain_id: string }>(sql`SELECT resend_domain_id FROM managed_domain_cleanup`)).map((r) => r.resend_domain_id)).toEqual([id]);
    const client = createResendDomainsClient({ apiKey: fake.apiKey, baseUrl: fake.baseUrl });
    expect(await sweepDomainCleanup(db as never, client)).toBe(1);
    expect(resendDomains()).toHaveLength(0);
    expect(await q(sql`SELECT 1 FROM managed_domain_cleanup`)).toHaveLength(0);
  });
});

describe("sender details", () => {
  it("accepts a name, an address start and a reply address, cleaned; empty clears them", async () => {
    offer();
    const t = await newTenant();
    await enable(t);
    const r = await call("PATCH", "/v1/sending", t.session, { from_name: 'Acme "Team"\r\nBcc: evil@x.test', from_local: "News", reply_to: " help@acme-test.dev " });
    expect(r.statusCode).toBe(200);
    expect(r.json().managed).toMatchObject({ from_name: "Acme Team Bcc: evil@x.test", from_local: "news", reply_to: "help@acme-test.dev" });
    expect(r.json().managed.sender).toMatchObject({ from_name: "Acme Team Bcc: evil@x.test", reply_to: "help@acme-test.dev" });
    const c = await call("PATCH", "/v1/sending", t.session, { from_name: "", reply_to: null });
    expect(c.json().managed).toMatchObject({ from_name: null, reply_to: null });
    expect(c.json().managed.sender.reply_to).toBe(t.email); // back to the owner
  });

  it("refuses bad values and needs managed sending turned on first", async () => {
    offer();
    const t = await newTenant();
    expect((await call("PATCH", "/v1/sending", t.session, { from_name: "X" })).statusCode).toBe(409);
    await enable(t);
    for (const [body, code] of [[{ from_local: "a@b" }, "invalid_from_local"], [{ reply_to: "Name <a@b.co>" }, "invalid_reply_to"], [{ reply_to: "a@b.co, c@d.co" }, "invalid_reply_to"], [{ from_name: "<>" }, "invalid_from_name"]] as const) {
      const r = await call("PATCH", "/v1/sending", t.session, body);
      expect(r.statusCode, JSON.stringify(body)).toBe(400);
      expect(r.json().code).toBe(code);
    }
  });
});

describe("the test email", () => {
  it("sends through managed sending from the shared address when there is no provider of their own, with the compliance headers", async () => {
    offer();
    const t = await newTenant({ name: "Acme Analytics" });
    await enable(t);
    const r = await call("POST", "/v1/settings/test-email", t.session, { to: "person@example.org" });
    expect(r.statusCode).toBe(200);
    expect(fake.emails).toHaveLength(1);
    const e = fake.emails[0]!;
    expect(e.from).toBe(`Acme Analytics <${SHARED}>`);
    expect(e.replyTo).toBe(t.email);
    expect(e.to).toEqual(["person@example.org"]);
    expect(e.headers["List-Unsubscribe"]).toMatch(/unsubscribe/);
    expect(e.key).toBe(`Bearer ${fake.apiKey}`);
  });

  it("uses the verified domain once there is one", async () => {
    offer();
    const t = await newTenant({ name: "Acme Analytics" });
    await setDomain(t, "mail.acme-test.dev", { from_local: "hello" });
    fake.setStatus("mail.acme-test.dev", "verified");
    await ageCheck(t);
    await get(t);
    await call("POST", "/v1/settings/test-email", t.session, { to: "person@example.org" });
    expect(fake.emails[0]!.from).toBe("Acme Analytics <hello@mail.acme-test.dev>");
  });

  it("says what to do when neither a provider nor managed sending is set up", async () => {
    offer();
    const t = await newTenant();
    const r = await call("POST", "/v1/settings/test-email", t.session, { to: "person@example.org" });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/Mailforge Sending/);
    expect(fake.emails).toHaveLength(0);
  });

  it("is not sent through managed sending when paused", async () => {
    offer();
    const t = await newTenant();
    await enable(t);
    await db.execute(sql`UPDATE managed_sending SET paused_at = now() WHERE tenant_id = ${t.id}::uuid`);
    expect((await call("POST", "/v1/settings/test-email", t.session, { to: "person@example.org" })).statusCode).toBe(400);
    expect(fake.emails).toHaveLength(0);
  });
});

describe("a paused workspace", () => {
  it("shows as not sending, with the reason in its own terms and no admin name; resolving an adapter gives nothing", async () => {
    offer();
    const t = await newTenant();
    await enable(t);
    await db.execute(sql`UPDATE managed_sending SET paused_at = now(), paused_reason = 'Too many bounces', paused_by = 'boss@platform.test' WHERE tenant_id = ${t.id}::uuid`);
    const g = (await get(t)).json();
    expect(g.uses).toBe("nothing");
    expect(g.managed.paused).toMatchObject({ reason: "Too many bounces", automatic: false });
    expect(JSON.stringify(g)).not.toContain("boss@platform.test");
    expect(await resolveManagedAdapter(db as never, t.id)).toBeNull();
  });
});

describe("the shared webhook (/webhooks/resend-platform)", () => {
  async function sentMessage(t: Tenant, providerId: string, to: string) {
    const [c] = await q<{ id: string }>(sql`INSERT INTO contacts (tenant_id, external_id, email, lifecycle_state, first_seen_at, last_seen_at) VALUES (${t.id}::uuid, ${"ext-" + counter++}, ${to}, 'engaged', now(), now()) RETURNING id`);
    const [f] = await q<{ id: string }>(sql`INSERT INTO flows (tenant_id, name, trigger_type, trigger_config, steps) VALUES (${t.id}::uuid, 'F', 'event', '{}'::jsonb, '[]'::jsonb) RETURNING id`);
    const [m] = await q<{ id: string }>(sql`INSERT INTO flow_memberships (tenant_id, contact_id, flow_id, current_step, status, entered_at) VALUES (${t.id}::uuid, ${c!.id}::uuid, ${f!.id}::uuid, 1, 'completed', now()) RETURNING id`);
    const [msg] = await q<{ id: string }>(sql`
      INSERT INTO lifecycle_messages (tenant_id, contact_id, flow_id, membership_id, flow_step_order, status, subject, recipient_address, provider_message_id, sent_at)
      VALUES (${t.id}::uuid, ${c!.id}::uuid, ${f!.id}::uuid, ${m!.id}::uuid, 1, 'sent', 's', ${to}, ${providerId}, now()) RETURNING id`);
    return msg!.id;
  }
  const post = (signed: { body: string; headers: Record<string, string> }) => app.inject({ method: "POST", url: "/webhooks/resend-platform", headers: signed.headers, payload: signed.body });
  const suppressed = (t: Tenant) => q<{ email: string; reason: string }>(sql`SELECT email, reason FROM suppressions WHERE tenant_id = ${t.id}::uuid`);
  const feedback = async (id: string) => (await q<{ feedback: string | null }>(sql`SELECT feedback FROM lifecycle_messages WHERE id = ${id}::uuid`))[0]!.feedback;

  it("a permanent bounce suppresses the address and marks the message, for the workspace that sent it", async () => {
    offer();
    const t = await newTenant();
    await enable(t);
    const id = await sentMessage(t, "re-msg-1", "gone@example.org");
    const r = await post(fake.signedWebhook({ type: "email.bounced", created_at: new Date().toISOString(), data: { email_id: "re-msg-1", bounce: { type: "Permanent", subType: "General" } } }));
    expect(r.statusCode).toBe(200);
    expect(await feedback(id)).toBe("bounced");
    expect(await suppressed(t)).toEqual([{ email: "gone@example.org", reason: "hard_bounce" }]);
  });

  it("a complaint suppresses; a temporary bounce marks the message but does not suppress", async () => {
    offer();
    const t = await newTenant();
    await enable(t);
    await sentMessage(t, "re-c", "angry@example.org");
    const tmp = await sentMessage(t, "re-t", "full@example.org");
    await post(fake.signedWebhook({ type: "email.complained", data: { email_id: "re-c" } }));
    await post(fake.signedWebhook({ type: "email.bounced", data: { email_id: "re-t", bounce: { type: "Transient" } } }));
    expect(await suppressed(t)).toEqual([{ email: "angry@example.org", reason: "complaint" }]);
    expect(await feedback(tmp)).toBe("bounced");
  });

  it("the address that is suppressed always comes from our own record, never from the payload", async () => {
    offer();
    const t = await newTenant();
    await enable(t);
    await sentMessage(t, "re-forged", "real@example.org");
    await post(fake.signedWebhook({ type: "email.complained", data: { email_id: "re-forged", to: ["victim@example.org"] } }));
    expect((await suppressed(t)).map((s) => s.email)).toEqual(["real@example.org"]);
  });

  it("rejects a bad signature, a wrong secret, a stale timestamp and a missing header, all with the same plain 400", async () => {
    offer();
    const t = await newTenant();
    await enable(t);
    const id = await sentMessage(t, "re-x", "a@example.org");
    const event = { type: "email.complained", data: { email_id: "re-x" } };
    const good = fake.signedWebhook(event);
    const bodies = [
      { body: good.body.replace("complained", "bounced"), headers: good.headers }, // tampered
      fake.signedWebhook(event, { secret: `whsec_${Buffer.from("some-other-secret-value-xxxxxxxx").toString("base64")}` }),
      fake.signedWebhook(event, { timestamp: Math.floor(Date.now() / 1000) - 3600 }),
      { body: good.body, headers: { "content-type": "application/json" } },
    ];
    for (const b of bodies) {
      const r = await post(b);
      expect(r.statusCode).toBe(400);
      expect(r.json()).toEqual({ error: "Invalid webhook signature." });
    }
    expect(await feedback(id)).toBeNull();
    expect(await suppressed(t)).toHaveLength(0);
  });

  it("is refused when no secret is configured or managed sending is not offered", async () => {
    offer();
    const t = await newTenant();
    await enable(t);
    await sentMessage(t, "re-y", "a@example.org");
    const signed = fake.signedWebhook({ type: "email.complained", data: { email_id: "re-y" } });
    delete process.env.MAILFORGE_MANAGED_RESEND_WEBHOOK_SECRET;
    expect((await post(signed)).statusCode).toBe(400);
    offer();
    process.env.MAILFORGE_MANAGED_SENDING = "false";
    expect((await post(signed)).statusCode).toBe(400);
    expect(await suppressed(t)).toHaveLength(0);
  });

  it("can never touch a workspace that uses its own provider, even with a valid signature and a real message id", async () => {
    offer();
    const own = await newTenant(); // never turned on managed sending
    const id = await sentMessage(own, "re-own", "a@example.org");
    const r = await post(fake.signedWebhook({ type: "email.complained", data: { email_id: "re-own" } }));
    expect(r.statusCode).toBe(200); // acknowledged, ignored
    expect(await feedback(id)).toBeNull();
    expect(await suppressed(own)).toHaveLength(0);
  });

  it("acknowledges unknown messages, unknown event types and junk without error, so Resend never retries forever", async () => {
    offer();
    const t = await newTenant();
    await enable(t);
    for (const event of [{ type: "email.complained", data: { email_id: "nope" } }, { type: "domain.updated", data: { id: "d" } }, { type: "email.sent", data: { email_id: "x" } }, { type: "email.complained", data: {} }, { type: "email.complained" }]) {
      expect((await post(fake.signedWebhook(event))).statusCode).toBe(200);
    }
    const bad = fake.signedWebhook({ x: 1 });
    expect((await post({ ...bad, body: "not json" })).statusCode).toBe(400); // unsigned body: signature check fails first
  });

  it("records delivery and open events on the message timeline, once even if Resend retries", async () => {
    offer();
    const t = await newTenant();
    await enable(t);
    const id = await sentMessage(t, "re-ev", "a@example.org");
    const ev = fake.signedWebhook({ type: "email.delivered", created_at: new Date().toISOString(), data: { email_id: "re-ev" } }, { id: "evt-1" });
    await post(ev);
    await post(ev);
    const events = await q<{ event_type: string }>(sql`SELECT event_type FROM message_events WHERE message_id = ${id}::uuid`);
    expect(events).toEqual([{ event_type: "delivered" }]);
  });
});

describe("data handling", () => {
  it("the export includes the workspace's sending setup (domain and DNS records, never a key)", async () => {
    offer();
    const t = await newTenant();
    await setDomain(t, "mail.acme-test.dev");
    const exp = await openWorkspaceExport(db as never, t.id);
    let text = "";
    for await (const chunk of exp!.chunks) text += chunk;
    const json = JSON.parse(text);
    expect(json.managed_sending).toHaveLength(1);
    expect(json.managed_sending[0]).toMatchObject({ domain: "mail.acme-test.dev" });
    expect(text).not.toContain(fake.apiKey);
  });

  it("erasing a workspace queues its domain for removal at Resend, and the sweeper removes it", async () => {
    offer();
    const t = await newTenant();
    await setDomain(t, "mail.acme-test.dev");
    const id = (await row(t))!.resend_domain_id as string;
    await db.execute(sql`DELETE FROM api_keys WHERE tenant_id = ${t.id}::uuid`);
    await purgeWorkspace(db as never, t.id, "admin_immediate");
    expect(await row(t)).toBeUndefined();
    expect((await q<{ resend_domain_id: string }>(sql`SELECT resend_domain_id FROM managed_domain_cleanup`)).map((r) => r.resend_domain_id)).toEqual([id]);
    expect(resendDomains()).toHaveLength(1); // still at Resend until swept
    const client = createResendDomainsClient({ apiKey: fake.apiKey, baseUrl: fake.baseUrl });
    expect(await sweepDomainCleanup(db as never, client)).toBe(1);
    expect(resendDomains()).toHaveLength(0);
  });

  it("the sweeper counts failures, leaves the entry for next time, and treats an already-gone domain as done", async () => {
    offer();
    const client = createResendDomainsClient({ apiKey: fake.apiKey, baseUrl: fake.baseUrl });
    await db.execute(sql`INSERT INTO managed_domain_cleanup (resend_domain_id, domain) VALUES ('ghost-1', 'ghost.acme-test.dev'), ('real-2', 'real.acme-test.dev')`);
    fake.failNext("/domains/real-2", 500, "internal", "boom");
    expect(await sweepDomainCleanup(db as never, client)).toBe(1); // ghost is gone already (404): done; real-2 failed
    const left = await q<{ resend_domain_id: string; attempts: number; last_error: string }>(sql`SELECT resend_domain_id, attempts, last_error FROM managed_domain_cleanup`);
    expect(left).toEqual([{ resend_domain_id: "real-2", attempts: 1, last_error: expect.stringMatching(/unavailable/) }]);
    expect(await sweepDomainCleanup(db as never, null)).toBe(0); // no key configured: does nothing
  });
});
