/**
 * Integration tests for the email sent to workspace owners when deletion is
 * scheduled: who gets it, what it says, and that an email problem can never
 * stop or undo the deletion request.
 *
 * Needs a reachable Postgres via DATABASE_URL, like the other *.db tests.
 * Every tenant created here has a slug starting with "acct-n-".
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
import { buildDeletionCancelledEmail, buildDeletionScheduledEmail } from "../src/account/deletion-email.js";

const TEST_DB_URL = process.env.DATABASE_URL;
if (!TEST_DB_URL) throw new Error("[account-notice.test] DATABASE_URL is not set.");

const ADMIN_EMAIL = "boss@acct-n.example";

/** Records what would have been emailed. `mode` makes it fail or throw. */
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
let app: FastifyInstance;
let appMail: FastifyInstance;

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
  const slug = `acct-n-${Date.now()}-${counter++}`;
  const email = opts.email ?? `${slug}@acct-n.example`;
  const [t] = await q<{ id: string }>(sql`INSERT INTO tenants (name, slug, plan) VALUES (${slug}, ${slug}, ${opts.plan ?? "free"}) RETURNING id`);
  const id = t!.id;
  const [u] = await q<{ id: string }>(sql`INSERT INTO users (tenant_id, email, role) VALUES (${id}::uuid, ${email}, 'owner') RETURNING id`);
  const [s] = await q<{ id: string }>(sql`INSERT INTO sessions (tenant_id, user_id, expires_at) VALUES (${id}::uuid, ${u!.id}::uuid, now() + interval '1 day') RETURNING id`);
  await db.execute(sql`INSERT INTO api_keys (tenant_id, key_hash, prefix, label) VALUES (${id}::uuid, ${createHash("sha256").update(randomBytes(16)).digest("hex")}, 'mf_live_', 'x')`);
  return { id, slug, email, session: s!.id };
}

async function cleanup(): Promise<void> {
  const ids = (await q<{ id: string }>(sql`SELECT id FROM tenants WHERE slug LIKE 'acct-n-%'`)).map((r) => r.id);
  for (const id of ids) {
    for (const t of await db.transaction(async (tx) => tenantTablesInDeleteOrder(tx as never))) {
      await db.execute(sql.raw(`DELETE FROM "${t}" WHERE tenant_id = '${id}'`));
    }
    await db.execute(sql`DELETE FROM tenants WHERE id = ${id}::uuid`);
  }
  await db.execute(sql`DELETE FROM deleted_workspaces WHERE slug LIKE 'acct-n-%'`);
  await db.execute(sql`DELETE FROM admin_audit_log WHERE detail->>'workspace_slug' LIKE 'acct-n-%'`);
}

const cookies = (t: Tenant) => ({ [SESSION_COOKIE_NAME]: t.session });
const post = (a: FastifyInstance, url: string, t: Tenant, payload: unknown) => a.inject({ method: "POST", url, cookies: cookies(t), payload: payload as object });
const schedule = (t: Tenant, a: FastifyInstance = appMail) => post(a, "/v1/account/deletion", t, { confirm: t.slug });
const scheduledAt = async (id: string) =>
  (await q<{ deletion_scheduled_at: Date | null }>(sql`SELECT deletion_scheduled_at FROM tenants WHERE id = ${id}::uuid`))[0]!.deletion_scheduled_at;

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: TEST_DB_URL, connectionTimeoutMillis: 3000 });
  try {
    await pool.query("SELECT 1");
    db = drizzle(pool);
    dbAvailable = true;
  } catch (err) {
    if (process.env.CI === "true") throw new Error(`[account-notice.test] DATABASE_URL not reachable in CI: ${(err as Error).message}`);
    console.warn("[account-notice.test] DATABASE_URL not reachable - tests skipped.");
    return;
  }
  await cleanup();
  process.env.MAILFORGE_PLATFORM_ADMINS = ADMIN_EMAIL;
  const opts = { logger: false as const, db, baseUrl: "http://localhost:3000", dashboardUrl: "http://localhost:3000" };
  app = await buildApp(opts);
  appMail = await buildApp({
    ...opts,
    noticeTransports: [
      { adapter: outbox, fromEmail: "no-reply@platform.example", fromName: "Mailforge" },
      { adapter: backup, fromEmail: "backup@platform.example", fromName: null },
    ],
  });
});

beforeEach(() => {
  outbox.sent = [];
  outbox.mode = "ok";
  backup.sent = [];
  backup.mode = "ok";
});

afterEach(async () => {
  if (dbAvailable) await cleanup();
});

afterAll(async () => {
  delete process.env.MAILFORGE_PLATFORM_ADMINS;
  for (const a of [app, appMail]) if (a) await a.close();
  await pool?.end();
});

// ---------------------------------------------------------------------------

describe("the email body", () => {
  const input = { workspaceName: "Acme", erasureDate: new Date("2026-10-11T07:36:00Z"), requestedBy: "o@acme.test", byAdmin: false, dashboardUrl: "https://app.example.com" };

  it("names the workspace, the day (UTC), who asked, and links back in", () => {
    const m = buildDeletionScheduledEmail(input, { brand: {}, tenantName: "Acme" });
    expect(m.subject).toBe('Your workspace "Acme" is scheduled for deletion');
    for (const body of [m.html, m.text]) {
      expect(body).toContain("Oct 11, 2026");
      expect(body).toContain("o@acme.test asked for");
      expect(body).toContain("https://app.example.com");
    }
  });

  it("the day is the UTC day even late in the evening", () => {
    const m = buildDeletionScheduledEmail({ ...input, erasureDate: new Date("2026-10-11T23:59:00Z") }, { brand: {}, tenantName: "Acme" });
    expect(m.text).toContain("Oct 11, 2026");
  });

  it("an admin request says so", () => {
    const m = buildDeletionScheduledEmail({ ...input, byAdmin: true, requestedBy: "root@svc.test" }, { brand: {}, tenantName: "Acme" });
    expect(m.text).toContain("A Mailforge administrator (root@svc.test) asked for");
  });

  it("escapes HTML in the name and the link, and flattens line breaks in the subject", () => {
    const m = buildDeletionScheduledEmail(
      { ...input, workspaceName: '<b>x</b>"\r\nBcc: e@x.test', dashboardUrl: 'https://a.example/?q="><script>' },
      { brand: {}, tenantName: "T" },
    );
    expect(m.html).not.toContain("<b>x</b>");
    expect(m.html).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(m.html).not.toContain('"><script>');
    expect(m.subject).not.toMatch(/[\r\n]/);
  });
});

describe("emailing the owners when deletion is scheduled", () => {
  it("emails the owner with the date, who asked, and a way back in", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    const res = await schedule(t);
    expect(res.statusCode).toBe(200);
    expect(outbox.sent).toHaveLength(1);
    const m = outbox.sent[0]!;
    expect(m.to).toBe(t.email);
    expect(m.from).toBe("no-reply@platform.example");
    expect(m.subject).toBe(`Your workspace "${t.slug}" is scheduled for deletion`);
    const day = new Date(res.json().scheduled_at).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
    for (const body of [m.bodyHtml, m.bodyText]) {
      expect(body).toContain(day);
      expect(body).toContain(t.email);
      expect(body).toContain("http://localhost:3000");
      expect(body).toContain("cancel");
    }
    // Account email: no marketing headers or footer.
    expect(m.headers).toEqual({});
    expect(m.bodyHtml).not.toMatch(/unsubscribe/i);
  });

  it("goes to every active owner, and to nobody else", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    await db.execute(sql`INSERT INTO users (tenant_id, email, role) VALUES (${t.id}::uuid, 'second-owner@acct-n.example', 'owner')`);
    await db.execute(sql`INSERT INTO users (tenant_id, email, role) VALUES (${t.id}::uuid, 'a-member@acct-n.example', 'member')`);
    await db.execute(sql`INSERT INTO users (tenant_id, email, role, deactivated_at) VALUES (${t.id}::uuid, 'gone-owner@acct-n.example', 'owner', now())`);
    await schedule(t);
    expect(outbox.sent.map((m) => m.to).sort()).toEqual([t.email, "second-owner@acct-n.example"].sort());
  });

  it("says a platform administrator asked when one did, and still reaches the owner", async () => {
    if (!dbAvailable) return;
    const admin = await newTenant({ email: ADMIN_EMAIL, plan: "growth" });
    const t = await newTenant();
    const res = await post(appMail, `/v1/admin/tenants/${t.id}/delete`, admin, { confirm: t.slug, reason: "Customer emailed support" });
    expect(res.statusCode).toBe(200);
    expect(outbox.sent).toHaveLength(1);
    expect(outbox.sent[0]!.to).toBe(t.email);
    expect(outbox.sent[0]!.bodyText).toContain(`administrator (${ADMIN_EMAIL})`);
  });

  it("escapes a hostile workspace name end to end", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    await db.execute(sql`UPDATE tenants SET name = ${"<img src=x onerror=alert(1)>\r\nBcc: evil@x.example"} WHERE id = ${t.id}::uuid`);
    await schedule(t);
    const m = outbox.sent[0]!;
    expect(m.bodyHtml).not.toContain("<img src=x");
    expect(m.bodyHtml).toContain("&lt;img src=x");
    expect(m.subject).not.toMatch(/[\r\n]/);
  });

  it("sends nothing when the request is refused: wrong confirmation or already scheduled", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    await post(appMail, "/v1/account/deletion", t, { confirm: "wrong" });
    expect(outbox.sent).toHaveLength(0);
    await schedule(t);
    expect(outbox.sent).toHaveLength(1);
    expect((await schedule(t)).statusCode).toBe(409);
    expect(outbox.sent).toHaveLength(1);
  });

  it("erasing immediately sends no scheduling email (it has its own notice, tested separately)", async () => {
    if (!dbAvailable) return;
    const admin = await newTenant({ email: ADMIN_EMAIL, plan: "growth" });
    const u = await newTenant();
    await post(appMail, `/v1/admin/tenants/${u.id}/delete`, admin, { confirm: u.slug, reason: "r", immediate: true });
    expect(outbox.sent.map((m) => m.subject)).toEqual([`Your workspace "${u.slug}" has been deleted`]);
  });

  it("an email problem never fails the request: the workspace is still scheduled", async () => {
    if (!dbAvailable) return;
    for (const mode of ["fail", "throw"] as const) {
      outbox.mode = mode;
      backup.mode = mode;
      const t = await newTenant();
      const res = await schedule(t);
      expect(res.statusCode, mode).toBe(200);
      expect(await scheduledAt(t.id), mode).not.toBeNull();
    }
  });

  it("falls back to the next sender when the first one fails or throws", async () => {
    if (!dbAvailable) return;
    outbox.mode = "fail";
    const t = await newTenant();
    await schedule(t);
    expect(outbox.sent).toHaveLength(0);
    expect(backup.sent).toHaveLength(1);
    expect(backup.sent[0]!.from).toBe("backup@platform.example");
    outbox.mode = "throw";
    await schedule(await newTenant());
    expect(backup.sent).toHaveLength(2);
  });

  it("one owner's failure does not stop the others", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    await db.execute(sql`INSERT INTO users (tenant_id, email, role) VALUES (${t.id}::uuid, 'second@acct-n.example', 'owner')`);
    const original = outbox.send.bind(outbox);
    outbox.send = async (p) => (p.to === t.email ? { success: false, error: "bounce", permanent: true } : original(p));
    backup.mode = "fail";
    try {
      expect((await schedule(t)).statusCode).toBe(200);
      expect(outbox.sent.map((m) => m.to)).toEqual(["second@acct-n.example"]);
    } finally {
      outbox.send = original;
    }
  });

  it("with no sender configured at all the request still succeeds", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    expect((await schedule(t, app)).statusCode).toBe(200);
    expect(await scheduledAt(t.id)).not.toBeNull();
    expect(outbox.sent).toHaveLength(0);
  });
});

// ===========================================================================
// The email when deletion is cancelled
// ===========================================================================
describe("the cancellation email body", () => {
  const input = { workspaceName: "Acme", cancelledBy: "o@acme.test", byAdmin: false, dashboardUrl: "https://app.example.com" };

  it("says who cancelled, that nothing was erased, and links back in", () => {
    const m = buildDeletionCancelledEmail(input, { brand: {}, tenantName: "Acme" });
    expect(m.subject).toBe('Deletion of your workspace "Acme" was cancelled');
    for (const body of [m.html, m.text]) {
      expect(body).toContain("o@acme.test cancelled the scheduled deletion");
      expect(body).toContain("Nothing was erased");
      expect(body).toContain("https://app.example.com");
    }
  });

  it("an admin cancellation says so", () => {
    const m = buildDeletionCancelledEmail({ ...input, byAdmin: true, cancelledBy: "root@svc.test" }, { brand: {}, tenantName: "Acme" });
    expect(m.text).toContain("A Mailforge administrator (root@svc.test) cancelled");
  });

  it("escapes the name and flattens subject line breaks", () => {
    const m = buildDeletionCancelledEmail({ ...input, workspaceName: "<i>x</i>\r\nBcc: e@x.test" }, { brand: {}, tenantName: "T" });
    expect(m.html).not.toContain("<i>x</i>");
    expect(m.subject).not.toMatch(/[\r\n]/);
  });
});

describe("emailing the owners when deletion is cancelled", () => {
  const cancel = (t: Tenant, a: FastifyInstance = appMail) => a.inject({ method: "DELETE", url: "/v1/account/deletion", cookies: cookies(t) });

  it("tells the owner it was cancelled, and who did it", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    await schedule(t);
    outbox.sent = [];
    expect((await cancel(t)).statusCode).toBe(200);
    expect(outbox.sent).toHaveLength(1);
    const m = outbox.sent[0]!;
    expect(m.to).toBe(t.email);
    expect(m.subject).toBe(`Deletion of your workspace "${t.slug}" was cancelled`);
    expect(m.bodyText).toContain(`${t.email} cancelled the scheduled deletion`);
    expect(m.headers).toEqual({});
    expect(m.bodyHtml).not.toMatch(/unsubscribe/i);
  });

  it("reaches the other owners too, so nobody can quietly undo a deletion", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    await db.execute(sql`INSERT INTO users (tenant_id, email, role) VALUES (${t.id}::uuid, 'second-owner@acct-n.example', 'owner')`);
    await db.execute(sql`INSERT INTO users (tenant_id, email, role) VALUES (${t.id}::uuid, 'a-member@acct-n.example', 'member')`);
    await schedule(t);
    outbox.sent = [];
    await cancel(t);
    expect(outbox.sent.map((m) => m.to).sort()).toEqual([t.email, "second-owner@acct-n.example"].sort());
  });

  it("sends nothing when there was nothing to cancel, or the caller may not cancel", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    expect((await cancel(t)).statusCode).toBe(409);
    expect(outbox.sent).toHaveLength(0);
    await schedule(t);
    outbox.sent = [];
    const [m] = await q<{ id: string }>(sql`INSERT INTO users (tenant_id, email, role) VALUES (${t.id}::uuid, 'member@acct-n.example', 'member') RETURNING id`);
    const [ms] = await q<{ id: string }>(sql`INSERT INTO sessions (tenant_id, user_id, expires_at) VALUES (${t.id}::uuid, ${m!.id}::uuid, now() + interval '1 day') RETURNING id`);
    const res = await appMail.inject({ method: "DELETE", url: "/v1/account/deletion", cookies: { [SESSION_COOKIE_NAME]: ms!.id } });
    expect(res.statusCode).toBe(403);
    expect(outbox.sent).toHaveLength(0);
    expect(await scheduledAt(t.id)).not.toBeNull();
  });

  it("an admin cancelling says so, and the owner is told", async () => {
    if (!dbAvailable) return;
    const admin = await newTenant({ email: ADMIN_EMAIL, plan: "growth" });
    const t = await newTenant();
    await schedule(t);
    outbox.sent = [];
    const res = await post(appMail, `/v1/admin/tenants/${t.id}/cancel-deletion`, admin, { reason: "Customer asked" });
    expect(res.statusCode).toBe(200);
    expect(outbox.sent).toHaveLength(1);
    expect(outbox.sent[0]!.to).toBe(t.email);
    expect(outbox.sent[0]!.bodyText).toContain(`administrator (${ADMIN_EMAIL}) cancelled`);
  });

  it("an admin request that is refused (no reason, nothing scheduled) sends nothing", async () => {
    if (!dbAvailable) return;
    const admin = await newTenant({ email: ADMIN_EMAIL, plan: "growth" });
    const t = await newTenant();
    expect((await post(appMail, `/v1/admin/tenants/${t.id}/cancel-deletion`, admin, { reason: "r" })).statusCode).toBe(409);
    await schedule(t);
    outbox.sent = [];
    expect((await post(appMail, `/v1/admin/tenants/${t.id}/cancel-deletion`, admin, {})).statusCode).toBe(400);
    expect(outbox.sent).toHaveLength(0);
  });

  it("each schedule and each cancel is its own email, across a change of mind", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    await schedule(t);
    await cancel(t);
    await schedule(t);
    expect(outbox.sent.map((m) => m.subject)).toEqual([
      `Your workspace "${t.slug}" is scheduled for deletion`,
      `Deletion of your workspace "${t.slug}" was cancelled`,
      `Your workspace "${t.slug}" is scheduled for deletion`,
    ]);
    // Each carries its own message id (providers de-duplicate on it), named for what it is.
    const ids = outbox.sent.map((m) => m.messageId);
    expect(new Set(ids).size).toBe(3);
    expect(ids.map((i) => i.split("-").slice(0, 2).join("-"))).toEqual(["deletion-scheduled", "deletion-cancelled", "deletion-scheduled"]);
  });

  it("an email problem never stops the cancellation: the workspace is restored anyway", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    await schedule(t);
    outbox.mode = "throw";
    backup.mode = "fail";
    expect((await cancel(t)).statusCode).toBe(200);
    expect(await scheduledAt(t.id)).toBeNull();
    expect((await appMail.inject({ method: "GET", url: "/v1/plan", cookies: cookies(t) })).statusCode).toBe(200);
  });

  it("falls back to the next sender, and with no sender at all still succeeds", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    await schedule(t);
    outbox.mode = "fail";
    await cancel(t);
    expect(backup.sent.map((m) => m.subject)).toEqual([`Deletion of your workspace "${t.slug}" was cancelled`]);
    const u = await newTenant();
    await schedule(u, app);
    expect((await cancel(u, app)).statusCode).toBe(200);
  });
});
