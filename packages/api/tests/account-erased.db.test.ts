/**
 * Integration tests for the note sent to workspace owners when a platform admin
 * erases their workspace immediately. The owners, their email transport and the
 * workspace name are destroyed by the erase, so the point of these tests is that
 * the note still goes out, and only when the erase really happened.
 *
 * Needs a reachable Postgres via DATABASE_URL, like the other *.db tests.
 * Every tenant created here has a slug starting with "acct-e-".
 */
import { createHash, randomBytes } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { TransportAdapter, TransportSendParams, TransportSendResult } from "@mailforge/adapters";
import { tenantTablesInDeleteOrder } from "@mailforge/db/purge";
import { buildApp } from "../src/index.js";
import { SESSION_COOKIE_NAME } from "../src/routes/auth.js";
import { buildWorkspaceErasedEmail } from "../src/account/deletion-email.js";

const TEST_DB_URL = process.env.DATABASE_URL;
if (!TEST_DB_URL) throw new Error("[account-erased.test] DATABASE_URL is not set.");

const ADMIN_EMAIL = "boss@acct-e.example";

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
const outbox = new Outbox();
const backup = new Outbox();

let pool: pg.Pool;
let db: ReturnType<typeof drizzle>;
let dbAvailable = false;
let appMail: FastifyInstance;
let appNoMail: FastifyInstance;

interface Tenant {
  id: string;
  slug: string;
  email: string;
  session: string;
}

async function q<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  return (await db.execute(query)).rows as T[];
}

let counter = 0;
async function newTenant(opts: { plan?: string; email?: string } = {}): Promise<Tenant> {
  const slug = `acct-e-${Date.now()}-${counter++}`;
  const email = opts.email ?? `${slug}@acct-e.example`;
  const [t] = await q<{ id: string }>(sql`INSERT INTO tenants (name, slug, plan) VALUES (${slug}, ${slug}, ${opts.plan ?? "free"}) RETURNING id`);
  const id = t!.id;
  const [u] = await q<{ id: string }>(sql`INSERT INTO users (tenant_id, email, role) VALUES (${id}::uuid, ${email}, 'owner') RETURNING id`);
  const [s] = await q<{ id: string }>(sql`INSERT INTO sessions (tenant_id, user_id, expires_at) VALUES (${id}::uuid, ${u!.id}::uuid, now() + interval '1 day') RETURNING id`);
  await db.execute(sql`INSERT INTO api_keys (tenant_id, key_hash, prefix, label) VALUES (${id}::uuid, ${createHash("sha256").update(randomBytes(16)).digest("hex")}, 'mf_live_', 'x')`);
  return { id, slug, email, session: s!.id };
}

async function cleanup(): Promise<void> {
  const ids = (await q<{ id: string }>(sql`SELECT id FROM tenants WHERE slug LIKE 'acct-e-%'`)).map((r) => r.id);
  for (const id of ids) {
    for (const t of await db.transaction(async (tx) => tenantTablesInDeleteOrder(tx as never))) {
      await db.execute(sql.raw(`DELETE FROM "${t}" WHERE tenant_id = '${id}'`));
    }
    await db.execute(sql`DELETE FROM tenants WHERE id = ${id}::uuid`);
  }
  await db.execute(sql`DELETE FROM deleted_workspaces WHERE slug LIKE 'acct-e-%'`);
  await db.execute(sql`DELETE FROM admin_audit_log WHERE detail->>'workspace_slug' LIKE 'acct-e-%'`);
}

const cookies = (t: Tenant) => ({ [SESSION_COOKIE_NAME]: t.session });
const erase = (a: FastifyInstance, admin: Tenant, t: Tenant, extra: Record<string, unknown> = {}) =>
  a.inject({ method: "POST", url: `/v1/admin/tenants/${t.id}/delete`, cookies: cookies(admin), payload: { confirm: t.slug, reason: "Legal erasure request", immediate: true, ...extra } });
const exists = async (id: string) => (await q<{ n: string }>(sql`SELECT count(*)::text AS n FROM tenants WHERE id = ${id}::uuid`))[0]!.n === "1";

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: TEST_DB_URL, connectionTimeoutMillis: 3000 });
  try {
    await pool.query("SELECT 1");
    db = drizzle(pool);
    dbAvailable = true;
  } catch (err) {
    if (process.env.CI === "true") throw new Error(`[account-erased.test] DATABASE_URL not reachable in CI: ${(err as Error).message}`);
    console.warn("[account-erased.test] DATABASE_URL not reachable - tests skipped.");
    return;
  }
  await cleanup();
  process.env.MAILFORGE_PLATFORM_ADMINS = ADMIN_EMAIL;
  const opts = { logger: false as const, db, baseUrl: "http://localhost:3000", dashboardUrl: "http://localhost:3000" };
  const noticeTransports = [
    { adapter: outbox, fromEmail: "no-reply@platform.example", fromName: "Mailforge" },
    { adapter: backup, fromEmail: "backup@platform.example", fromName: null },
  ];
  appMail = await buildApp({ ...opts, noticeTransports });
  appNoMail = await buildApp(opts);
});

beforeEach(() => {
  outbox.sent = [];
  outbox.mode = "ok";
  backup.sent = [];
  backup.mode = "ok";
});

afterEach(async () => {
  delete process.env.MAILFORGE_SUPPORT_EMAIL;
  if (dbAvailable) await cleanup();
});

afterAll(async () => {
  delete process.env.MAILFORGE_PLATFORM_ADMINS;
  for (const a of [appMail, appNoMail]) if (a) await a.close();
  await pool?.end();
});

// ---------------------------------------------------------------------------

describe("the erased-workspace email body", () => {
  const input = { workspaceName: "Acme", erasedBy: "root@svc.test", erasedAt: new Date("2026-10-11T23:30:00Z"), supportEmail: "help@svc.test" };

  it("names the workspace, the administrator and the UTC day, and says it cannot be recovered", () => {
    const m = buildWorkspaceErasedEmail(input, { brand: {}, tenantName: "Acme" });
    expect(m.subject).toBe('Your workspace "Acme" has been deleted');
    for (const body of [m.html, m.text]) {
      expect(body).toContain("root@svc.test");
      expect(body).toContain("Oct 11, 2026");
      expect(body).toContain("cannot be recovered");
      expect(body).toContain("help@svc.test");
    }
  });

  it("has no sign-in link or button: there is nothing left to sign in to", () => {
    const m = buildWorkspaceErasedEmail(input, { brand: {}, tenantName: "Acme" });
    expect(m.html).not.toMatch(/<a /i);
    expect(m.text).not.toMatch(/https?:\/\//);
  });

  it("falls back to a general line when no support address is set", () => {
    const m = buildWorkspaceErasedEmail({ ...input, supportEmail: null }, { brand: {}, tenantName: "Acme" });
    expect(m.text).toContain("contact the service operator");
  });

  it("escapes the name and flattens subject line breaks", () => {
    const evil = "<i>x</i>" + String.fromCharCode(13, 10) + "Bcc: e@x.test";
    const m = buildWorkspaceErasedEmail({ ...input, workspaceName: evil }, { brand: {}, tenantName: "T" });
    expect(m.html).not.toContain("<i>x</i>");
    expect(m.html).toContain("&lt;i&gt;x&lt;/i&gt;");
    expect(m.subject).not.toMatch(/[\r\n]/);
  });
});

describe("emailing the owners after an immediate erase", () => {
  it("still reaches the owner after the workspace, its users and its transport are gone", async () => {
    if (!dbAvailable) return;
    const admin = await newTenant({ email: ADMIN_EMAIL, plan: "growth" });
    const t = await newTenant();
    const res = await erase(appMail, admin, t);
    expect(res.statusCode).toBe(200);
    expect(res.json().deleted).toBe(true);
    expect(await exists(t.id)).toBe(false);
    expect((await q<{ n: string }>(sql`SELECT count(*)::text AS n FROM users WHERE email = ${t.email}`))[0]!.n).toBe("0");

    expect(outbox.sent).toHaveLength(1);
    const m = outbox.sent[0]!;
    expect(m.to).toBe(t.email);
    expect(m.from).toBe("no-reply@platform.example");
    expect(m.subject).toBe(`Your workspace "${t.slug}" has been deleted`);
    expect(m.bodyText).toContain(ADMIN_EMAIL);
    expect(m.bodyText).toContain(t.slug);
    expect(m.headers).toEqual({});
    expect(m.bodyHtml).not.toMatch(/unsubscribe/i);
    // Providers de-duplicate on the message id, so it names what the mail is and who it is for.
    expect(m.messageId).toMatch(new RegExp(`^deletion-erased-${t.id}-\\d+-${t.email}$`));
  });

  it("goes to every active owner, and to no member or removed owner", async () => {
    if (!dbAvailable) return;
    const admin = await newTenant({ email: ADMIN_EMAIL, plan: "growth" });
    const t = await newTenant();
    await db.execute(sql`INSERT INTO users (tenant_id, email, role) VALUES (${t.id}::uuid, 'second@acct-e.example', 'owner')`);
    await db.execute(sql`INSERT INTO users (tenant_id, email, role) VALUES (${t.id}::uuid, 'member@acct-e.example', 'member')`);
    await db.execute(sql`INSERT INTO users (tenant_id, email, role, deactivated_at) VALUES (${t.id}::uuid, 'gone@acct-e.example', 'owner', now())`);
    await erase(appMail, admin, t);
    expect(outbox.sent.map((m) => m.to).sort()).toEqual([t.email, "second@acct-e.example"].sort());
  });

  it("includes the support address when the operator has set one", async () => {
    if (!dbAvailable) return;
    process.env.MAILFORGE_SUPPORT_EMAIL = "help@svc.example";
    const admin = await newTenant({ email: ADMIN_EMAIL, plan: "growth" });
    const t = await newTenant();
    await erase(appMail, admin, t);
    expect(outbox.sent[0]!.bodyText).toContain("help@svc.example");
  });

  it("is sent only when the workspace was really erased", async () => {
    if (!dbAvailable) return;
    const admin = await newTenant({ email: ADMIN_EMAIL, plan: "growth" });
    const t = await newTenant();
    const url = `/v1/admin/tenants/${t.id}/delete`;
    const post = (payload: object) => appMail.inject({ method: "POST", url, cookies: cookies(admin), payload });
    expect((await post({ confirm: "wrong", reason: "r", immediate: true })).statusCode).toBe(400);
    expect((await post({ confirm: t.slug, immediate: true })).statusCode).toBe(400);
    expect((await appMail.inject({ method: "POST", url: `/v1/admin/tenants/${admin.id}/delete`, cookies: cookies(admin), payload: { confirm: admin.slug, reason: "r", immediate: true } })).statusCode).toBe(400);
    const stranger = await newTenant();
    expect((await appMail.inject({ method: "POST", url, cookies: cookies(stranger), payload: { confirm: t.slug, reason: "r", immediate: true } })).statusCode).toBe(404);
    expect(outbox.sent).toHaveLength(0);
    expect(await exists(t.id)).toBe(true);
  });

  it("an email problem never undoes or fails the erase", async () => {
    if (!dbAvailable) return;
    const admin = await newTenant({ email: ADMIN_EMAIL, plan: "growth" });
    for (const mode of ["fail", "throw"] as const) {
      outbox.mode = mode;
      backup.mode = mode;
      const t = await newTenant();
      const res = await erase(appMail, admin, t);
      expect(res.statusCode, mode).toBe(200);
      expect(await exists(t.id), mode).toBe(false);
    }
  });

  it("falls back to the next sender, and with no sender at all the erase still succeeds", async () => {
    if (!dbAvailable) return;
    const admin = await newTenant({ email: ADMIN_EMAIL, plan: "growth" });
    outbox.mode = "fail";
    const t = await newTenant();
    await erase(appMail, admin, t);
    expect(backup.sent.map((m) => m.to)).toEqual([t.email]);
    const u = await newTenant();
    expect((await erase(appNoMail, admin, u)).statusCode).toBe(200);
    expect(await exists(u.id)).toBe(false);
  });

  it("leaves the audit entry and the tombstone as before", async () => {
    if (!dbAvailable) return;
    const admin = await newTenant({ email: ADMIN_EMAIL, plan: "growth" });
    const t = await newTenant();
    await erase(appMail, admin, t);
    const audit = await q<{ action: string }>(sql`SELECT action FROM admin_audit_log WHERE detail->>'workspace_slug' = ${t.slug}`);
    expect(audit.map((a) => a.action)).toEqual(["delete_workspace"]);
    expect((await q<{ how: string }>(sql`SELECT how FROM deleted_workspaces WHERE id = ${t.id}::uuid`))[0]!.how).toBe("admin_immediate");
  });
});
