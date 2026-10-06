/**
 * Integration tests for protecting the shared Resend account: automatic pause (and warning)
 * for a workspace on managed sending whose bounces or spam complaints get too high, and the
 * admin console's pause/resume.
 *
 * Needs a reachable Postgres via DATABASE_URL. Tenants have slugs starting with "mhl-t-".
 */
import { createHash, randomBytes } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import { SESSION_COOKIE_NAME } from "../src/routes/auth.js";
import { WARN_REPEAT_MS, pauseForHealth, buildAdminPauseNotice, buildSenderPausedEmail, buildSenderResumedEmail, buildSenderWarningEmail, checkSenderHealth } from "../src/sending/health.js";
import type { PlatformTransport } from "../src/platform-mailer.js";

const TEST_DB_URL = process.env.DATABASE_URL;
if (!TEST_DB_URL) throw new Error("[managed-health.test] DATABASE_URL is not set.");

const ADMIN_EMAIL = "boss@mhl-t.example";
const REASON = "Reviewed the list with the customer";

let pool: pg.Pool;
let lockClient: pg.PoolClient | undefined;
let db: ReturnType<typeof drizzle>;
let dbAvailable = false;
let app: FastifyInstance;
let failSends = false;
const mails: Array<{ to: string; subject: string; bodyText: string; bodyHtml: string }> = [];
const transport: PlatformTransport = {
  fromEmail: "no-reply@platform.test",
  fromName: null,
  adapter: {
    send: async (m: { to: string; subject: string; bodyText: string; bodyHtml: string }) => {
      if (failSends) return { success: false, error: "smtp down" };
      mails.push({ to: m.to, subject: m.subject, bodyText: m.bodyText, bodyHtml: m.bodyHtml });
      return { success: true, messageId: "id" };
    },
  } as never,
};
const opts = { transport, admins: ["ops@platform.test"], env: { BASE_URL: "https://app.example.com" } as NodeJS.ProcessEnv };

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: TEST_DB_URL, connectionTimeoutMillis: 3000 });
  try {
    await pool.query("SELECT 1");
    db = drizzle(pool);
    dbAvailable = true;
    lockClient = await pool.connect();
    await lockClient.query("SELECT pg_advisory_lock(7770001)");
  } catch (err) {
    if (process.env.CI === "true") throw new Error(`[managed-health.test] DATABASE_URL not reachable in CI: ${(err as Error).message}`);
    console.warn("[managed-health.test] DATABASE_URL not reachable - tests skipped.");
    return;
  }
  await cleanup();
  process.env.MAILFORGE_PLATFORM_ADMINS = ADMIN_EMAIL;
  app = await buildApp({ logger: false, db, baseUrl: "http://localhost:3000", dashboardUrl: "http://localhost:3000", noticeTransports: [transport] });
});

afterEach(async () => {
  if (!dbAvailable) return;
  mails.length = 0;
  failSends = false;
  await cleanup();
});

afterAll(async () => {
  delete process.env.MAILFORGE_PLATFORM_ADMINS;
  if (app) await app.close();
  if (lockClient) {
    await lockClient.query("SELECT pg_advisory_unlock(7770001)");
    lockClient.release();
  }
  await pool?.end();
});

interface Tenant {
  id: string;
  name: string;
  email: string;
  session: string;
}

async function q<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  return (await db.execute(query)).rows as T[];
}

let counter = 0;
async function newTenant(opts: { name?: string; email?: string; managed?: boolean } = {}): Promise<Tenant> {
  const slug = `mhl-t-${Date.now()}-${counter++}`;
  const name = opts.name ?? `Workspace ${counter}`;
  const email = opts.email ?? `owner-${slug}@mhl.example`;
  const [t] = await q<{ id: string }>(sql`INSERT INTO tenants (name, slug, plan) VALUES (${name}, ${slug}, 'growth') RETURNING id`);
  const id = t!.id;
  const [u] = await q<{ id: string }>(sql`INSERT INTO users (tenant_id, email, role) VALUES (${id}::uuid, ${email}, 'owner') RETURNING id`);
  const [s] = await q<{ id: string }>(sql`INSERT INTO sessions (tenant_id, user_id, expires_at) VALUES (${id}::uuid, ${u!.id}::uuid, now() + interval '1 day') RETURNING id`);
  const key = `mf_live_${randomBytes(24).toString("base64url")}`;
  await db.execute(sql`INSERT INTO api_keys (tenant_id, key_hash, prefix, label) VALUES (${id}::uuid, ${createHash("sha256").update(key).digest("hex")}, ${key.slice(0, 8)}, 'mhl test')`);
  if (opts.managed !== false) await db.execute(sql`INSERT INTO managed_sending (tenant_id) VALUES (${id}::uuid)`);
  return { id, name, email, session: s!.id };
}

async function cleanup() {
  const ids = (await q<{ id: string }>(sql`SELECT id FROM tenants WHERE slug LIKE 'mhl-t-%'`)).map((r) => r.id);
  for (const id of ids) {
    for (const t of ["message_events", "lifecycle_messages", "flow_memberships", "flows", "contacts", "managed_sending", "admin_audit_log", "api_keys", "sessions", "users"]) {
      await db.execute(sql.raw(`DELETE FROM ${t} WHERE tenant_id = '${id}'`));
    }
    await db.execute(sql`DELETE FROM tenants WHERE id = ${id}::uuid`);
  }
}

/** Give a workspace `sent` sent emails in the window, of which some bounced hard and some drew complaints. */
async function traffic(t: Tenant, o: { sent: number; hard?: number; complaints?: number; soft?: number; ageDays?: number }) {
  const ageDays = o.ageDays ?? 1;
  const [f] = await q<{ id: string }>(sql`INSERT INTO flows (tenant_id, name, trigger_type, trigger_config, steps) VALUES (${t.id}::uuid, 'F', 'event', '{}'::jsonb, '[]'::jsonb) RETURNING id`);
  const tag = `x${counter++}-`;
  // One contact, membership and sent message per email (a message is unique per membership and step).
  const ids = (
    await q<{ id: string }>(sql`
      WITH c AS (
        INSERT INTO contacts (tenant_id, external_id, email, lifecycle_state, first_seen_at, last_seen_at)
        SELECT ${t.id}::uuid, ${tag} || g, 'p' || g || '-' || ${tag} || '@example.org', 'engaged', now(), now() FROM generate_series(1, ${o.sent}) g RETURNING id),
      m AS (
        INSERT INTO flow_memberships (tenant_id, contact_id, flow_id, current_step, status, entered_at)
        SELECT ${t.id}::uuid, c.id, ${f!.id}::uuid, 1, 'completed', now() FROM c RETURNING id, contact_id)
      INSERT INTO lifecycle_messages (tenant_id, contact_id, flow_id, membership_id, flow_step_order, status, subject, sent_at)
      SELECT ${t.id}::uuid, m.contact_id, ${f!.id}::uuid, m.id, 1, 'sent', 's', now() - (${ageDays} * interval '1 day') FROM m RETURNING id`)
  ).map((r) => r.id);
  const event = async (messageId: string, type: string, meta: Record<string, unknown> | null) =>
    db.execute(sql`INSERT INTO message_events (tenant_id, message_id, event_type, occurred_at, metadata) VALUES (${t.id}::uuid, ${messageId}::uuid, ${type}, now() - (${ageDays} * interval '1 day'), ${meta ? JSON.stringify(meta) : null}::jsonb)`);
  let i = 0;
  for (let k = 0; k < (o.hard ?? 0); k++) await event(ids[i++]!, "bounced", { bounce_type: "Permanent" });
  for (let k = 0; k < (o.soft ?? 0); k++) await event(ids[i++]!, "bounced", { bounce_type: "Transient" });
  for (let k = 0; k < (o.complaints ?? 0); k++) await event(ids[i++]!, "complained", null);
}

const sending = async (t: Tenant) => (await q<{ paused_at: Date | null; paused_reason: string | null; paused_by: string | null; warned_at: Date | null }>(sql`SELECT paused_at, paused_reason, paused_by, warned_at FROM managed_sending WHERE tenant_id = ${t.id}::uuid`))[0]!;
const audit = (t: Tenant) => q<{ action: string; actor_email: string; detail: Record<string, unknown> }>(sql`SELECT action, actor_email, detail FROM admin_audit_log WHERE tenant_id = ${t.id}::uuid ORDER BY created_at, id`);
const NOW = () => new Date();
import { senderHealth as senderHealthOf } from "@mailforge/core";

// ---------------------------------------------------------------------------

describe("automatic pause", () => {
  it("pauses a workspace whose complaints are too high: stops it at once, records why, tells the owner and the operator", async () => {
    const t = await newTenant({ name: "Spammy Co" });
    await traffic(t, { sent: 1000, complaints: 4 }); // 0.4%
    const r = await checkSenderHealth(db as never, NOW(), opts);
    expect(r.paused).toEqual([t.id]);

    const s = await sending(t);
    expect(s.paused_at).not.toBeNull();
    expect(s.paused_by).toBe("auto");
    expect(s.paused_reason).toMatch(/4 spam complaints out of 1000 emails \(0\.40%\)/);

    const a = await audit(t);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ action: "managed_sending_auto_pause", actor_email: "system (sender health)" });
    expect(a[0]!.detail).toMatchObject({ sent: 1000, complaints: 4, hard_bounces: 0, window_days: 7 });

    const owner = mails.filter((m) => m.to === t.email);
    expect(owner).toHaveLength(1);
    expect(owner[0]!.subject).toBe("Email sending paused for Spammy Co");
    expect(owner[0]!.bodyText).toMatch(/nothing was deleted/i);
    expect(owner[0]!.bodyText).toMatch(/4 spam complaints/);
    const ops = mails.filter((m) => m.to === "ops@platform.test");
    expect(ops).toHaveLength(1);
    expect(ops[0]!.subject).toBe("Managed sending paused: Spammy Co");
    expect(ops[0]!.bodyText).toContain(`https://app.example.com/admin/tenants/${t.id}`);
  });

  it("pauses on permanent bounces (addresses that do not exist), but not on temporary ones", async () => {
    const stale = await newTenant();
    const fine = await newTenant();
    await traffic(stale, { sent: 400, hard: 30 }); // 7.5%
    await traffic(fine, { sent: 400, soft: 60 }); // 15% but only temporary
    const r = await checkSenderHealth(db as never, NOW(), opts);
    expect(r.paused).toEqual([stale.id]);
    expect((await sending(stale)).paused_reason).toMatch(/30 addresses that do not exist out of 400 emails \(7\.5%\)/);
    expect((await sending(fine)).paused_at).toBeNull();
  });

  it("never judges a workspace with too little volume, however bad it looks", async () => {
    const t = await newTenant();
    await traffic(t, { sent: 40, hard: 30, complaints: 10 });
    const r = await checkSenderHealth(db as never, NOW(), opts);
    expect(r).toMatchObject({ checked: expect.any(Number), paused: [], warned: [] });
    expect((await sending(t)).paused_at).toBeNull();
    expect(mails).toHaveLength(0);
  });

  it("leaves healthy workspaces alone and only counts the last seven days", async () => {
    const healthy = await newTenant();
    const old = await newTenant();
    await traffic(healthy, { sent: 1000, complaints: 1, hard: 10 }); // 0.1% and 1%
    await traffic(old, { sent: 1000, complaints: 50, ageDays: 10 }); // terrible, but ten days ago
    const r = await checkSenderHealth(db as never, NOW(), opts);
    expect(r.paused).toEqual([]);
    expect((await sending(old)).paused_at).toBeNull();
    expect(mails).toHaveLength(0);
  });

  it("only looks at workspaces on managed sending that are switched on and not already paused", async () => {
    const own = await newTenant({ managed: false });
    const off = await newTenant();
    const already = await newTenant();
    for (const t of [own, off, already]) await traffic(t, { sent: 1000, complaints: 20 });
    await db.execute(sql`UPDATE managed_sending SET enabled = false WHERE tenant_id = ${off.id}::uuid`);
    await db.execute(sql`UPDATE managed_sending SET paused_at = now() - interval '1 day', paused_reason = 'by hand', paused_by = 'boss' WHERE tenant_id = ${already.id}::uuid`);
    const r = await checkSenderHealth(db as never, NOW(), opts);
    expect(r.paused).toEqual([]);
    expect((await sending(already)).paused_reason).toBe("by hand"); // untouched
    expect(await audit(already)).toHaveLength(0);
    expect(mails).toHaveLength(0);
  });

  it("pauses once even if two checks run at the same moment: one pause, one audit row, one set of emails", async () => {
    const t = await newTenant();
    await traffic(t, { sent: 1000, complaints: 5 });
    // Several checks at once (as with more than one server process): only one may pause it.
    const results = await Promise.all(Array.from({ length: 8 }, () => checkSenderHealth(db as never, NOW(), opts)));
    expect(results.flatMap((r) => r.paused)).toEqual([t.id]);
    expect(await audit(t)).toHaveLength(1);
    expect(mails.filter((m) => m.to === t.email)).toHaveLength(1);
  });

  it("the pause step itself is exactly-once: a second caller with a stale view gets false, writes nothing and mails nothing", async () => {
    const t = await newTenant();
    await traffic(t, { sent: 1000, complaints: 5 });
    const h = senderHealthOf(1000, 0, 5);
    expect(await pauseForHealth(db as never, t.id, h, NOW())).toBe(true);
    expect(await pauseForHealth(db as never, t.id, h, NOW())).toBe(false);
    expect(await pauseForHealth(db as never, t.id, h, NOW())).toBe(false);
    expect(await audit(t)).toHaveLength(1);
    expect((await sending(t)).paused_by).toBe("auto");
  });

  it("still pauses when no email can be sent: protecting the account matters more than the notice", async () => {
    const t = await newTenant();
    await traffic(t, { sent: 1000, complaints: 5 });
    const r = await checkSenderHealth(db as never, NOW(), { ...opts, transport: null });
    expect(r.paused).toEqual([t.id]);
    expect((await sending(t)).paused_at).not.toBeNull();
    expect(mails).toHaveLength(0);
  });

  it("a failed email does not stop the pause or crash the check", async () => {
    const t = await newTenant();
    await traffic(t, { sent: 1000, complaints: 5 });
    failSends = true;
    expect((await checkSenderHealth(db as never, NOW(), opts)).paused).toEqual([t.id]);
  });

  it("pausing makes the workspace's sender unavailable at once, so nothing more goes out", async () => {
    const t = await newTenant();
    await traffic(t, { sent: 1000, complaints: 5 });
    await checkSenderHealth(db as never, NOW(), opts);
    const { resolveManagedAdapter } = await import("../src/sending/context.js");
    process.env.MAILFORGE_MANAGED_RESEND_API_KEY = "re_x";
    process.env.MAILFORGE_MANAGED_SHARED_FROM = "n@mail.platform.test";
    try {
      expect(await resolveManagedAdapter(db as never, t.id)).toBeNull();
    } finally {
      delete process.env.MAILFORGE_MANAGED_RESEND_API_KEY;
      delete process.env.MAILFORGE_MANAGED_SHARED_FROM;
    }
  });
});

describe("warning before a pause", () => {
  it("tells the owner once when a workspace is halfway to a pause, pausing nothing", async () => {
    const t = await newTenant({ name: "Drifting Co" });
    await traffic(t, { sent: 1000, complaints: 2 }); // 0.2%: over half of 0.3%, under it
    const r = await checkSenderHealth(db as never, NOW(), opts);
    expect(r).toMatchObject({ paused: [], warned: [t.id] });
    expect((await sending(t)).paused_at).toBeNull();
    expect((await sending(t)).warned_at).not.toBeNull();
    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({ to: t.email, subject: "Your email sending needs attention: Drifting Co" });
    expect(mails[0]!.bodyText).toMatch(/Nothing has been paused/);
    expect(mails.some((m) => m.to === "ops@platform.test")).toBe(false); // the operator is only told about pauses
  });

  it("does not repeat inside three days, repeats after, and is not marked as told if the email failed", async () => {
    const t = await newTenant();
    await traffic(t, { sent: 1000, complaints: 2 });
    failSends = true;
    expect((await checkSenderHealth(db as never, NOW(), opts)).warned).toEqual([]);
    expect((await sending(t)).warned_at).toBeNull();
    failSends = false;
    expect((await checkSenderHealth(db as never, NOW(), opts)).warned).toEqual([t.id]);
    mails.length = 0;
    expect((await checkSenderHealth(db as never, NOW(), opts)).warned).toEqual([]);
    expect(mails).toHaveLength(0);
    expect((await checkSenderHealth(db as never, new Date(Date.now() + WARN_REPEAT_MS + 1000), opts)).warned).toEqual([t.id]);
  });

  it("a warned workspace that then crosses the line is paused", async () => {
    const t = await newTenant();
    await traffic(t, { sent: 1000, complaints: 2 });
    await checkSenderHealth(db as never, NOW(), opts);
    await traffic(t, { sent: 0, complaints: 0 });
    await db.execute(sql`INSERT INTO message_events (tenant_id, message_id, event_type, occurred_at) SELECT tenant_id, id, 'complained', now() FROM lifecycle_messages WHERE tenant_id = ${t.id}::uuid AND id NOT IN (SELECT message_id FROM message_events WHERE tenant_id = ${t.id}::uuid) LIMIT 3`);
    expect((await checkSenderHealth(db as never, NOW(), opts)).paused).toEqual([t.id]);
  });
});

describe("the admin console: pause and resume by hand", () => {
  const post = (admin: Tenant, t: Tenant, body: Record<string, unknown>) => app.inject({ method: "POST", url: `/v1/admin/tenants/${t.id}/managed-sending`, cookies: { [SESSION_COOKIE_NAME]: admin.session }, payload: body });
  const detail = (admin: Tenant, t: Tenant) => app.inject({ method: "GET", url: `/v1/admin/tenants/${t.id}`, cookies: { [SESSION_COOKIE_NAME]: admin.session } });
  const newAdmin = () => newTenant({ email: ADMIN_EMAIL, managed: false });

  it("pauses with a reason (audited, owner told), then resumes (audited, owner told, warning cleared)", async () => {
    const admin = await newAdmin();
    const t = await newTenant({ name: "Acme Co" });
    expect((await post(admin, t, { action: "pause", reason: "Investigating complaints" })).statusCode).toBe(200);
    expect(await sending(t)).toMatchObject({ paused_by: ADMIN_EMAIL, paused_reason: "Investigating complaints" });
    expect(mails.filter((m) => m.to === t.email).map((m) => m.subject)).toEqual(["Email sending paused for Acme Co"]);
    expect(mails[0]!.bodyText).toMatch(/paused by the service operator/);

    await db.execute(sql`UPDATE managed_sending SET warned_at = now() WHERE tenant_id = ${t.id}::uuid`);
    mails.length = 0;
    expect((await post(admin, t, { action: "resume", reason: REASON })).statusCode).toBe(200);
    expect(await sending(t)).toMatchObject({ paused_at: null, paused_reason: null, paused_by: null, warned_at: null });
    expect(mails.map((m) => m.subject)).toEqual(["Email sending resumed for Acme Co"]);

    const a = await audit(t);
    expect(a.map((x) => x.action)).toEqual(["managed_sending_pause", "managed_sending_resume"]);
    expect(a[0]).toMatchObject({ actor_email: ADMIN_EMAIL, detail: { reason: "Investigating complaints", before: { paused: false } } });
    expect(a[1]!.detail).toMatchObject({ reason: REASON, before: { paused: true, paused_by: ADMIN_EMAIL } });
  });

  it("an automatic pause can be resumed by an admin, who sees who paused it and why", async () => {
    const admin = await newAdmin();
    const t = await newTenant();
    await traffic(t, { sent: 1000, complaints: 5 });
    await checkSenderHealth(db as never, NOW(), opts);
    const d = (await detail(admin, t)).json();
    expect(d.sending).toMatchObject({ enabled: true, paused: { by: "auto", reason: expect.stringMatching(/spam complaints/) } });
    expect((await post(admin, t, { action: "resume", reason: REASON })).statusCode).toBe(200);
    expect((await detail(admin, t)).json().sending.paused).toBeNull();
  });

  it("is validated: a known action, a reason, a workspace on managed sending, and the right state", async () => {
    const admin = await newAdmin();
    const t = await newTenant();
    const none = await newTenant({ managed: false });
    expect((await post(admin, t, { action: "explode", reason: REASON })).json().code).toBe("invalid_action");
    expect((await post(admin, t, { action: "pause" })).json().code).toBe("reason_required");
    expect((await post(admin, t, { action: "pause", reason: "x".repeat(301) })).statusCode).toBe(400);
    expect((await post(admin, none, { action: "pause", reason: REASON })).json().code).toBe("not_enabled");
    expect((await post(admin, t, { action: "resume", reason: REASON })).json().code).toBe("not_paused");
    await post(admin, t, { action: "pause", reason: REASON });
    expect((await post(admin, t, { action: "pause", reason: REASON })).json().code).toBe("already_paused");
    expect((await app.inject({ method: "POST", url: "/v1/admin/tenants/00000000-0000-4000-8000-000000000000/managed-sending", cookies: { [SESSION_COOKIE_NAME]: admin.session }, payload: { action: "pause", reason: REASON } })).statusCode).toBe(404);
  });

  it("only platform admins can: everyone else gets a plain 404, even the workspace's own owner", async () => {
    const t = await newTenant();
    const r = await post(t, t, { action: "resume", reason: REASON });
    expect(r.statusCode).toBe(404);
    expect((await sending(t)).paused_at).toBeNull();
  });

  it("the workspace page shows the sending status, or nothing for a workspace that never used it", async () => {
    const admin = await newAdmin();
    const used = await newTenant();
    const never = await newTenant({ managed: false });
    expect((await detail(admin, used)).json().sending).toMatchObject({ enabled: true, domain: null, domain_status: "none", paused: null });
    expect((await detail(admin, never)).json().sending).toBeNull();
  });
});

describe("the emails", () => {
  it("say what happened, that nothing is lost, and what to do, without account details or thresholds", () => {
    const m = buildSenderPausedEmail("Acme", ["4 spam complaints out of 1000 emails (0.40%)"], true);
    expect(m.text).toMatch(/nothing was deleted/i);
    expect(m.text).toMatch(/ask support to resume/i);
    expect(m.text + m.subject).not.toMatch(/resend|account|threshold|0\.3%|5%/i);
    expect(buildSenderPausedEmail("Acme", ["by hand"], false).text).toMatch(/paused by the service operator\. Reason: by hand/);
    expect(buildSenderWarningEmail("Acme", ["x"]).text).toMatch(/Nothing has been paused/);
    expect(buildSenderResumedEmail("Acme").text).toMatch(/resumed/);
  });

  it("escape what they quote", () => {
    const m = buildAdminPauseNotice("A <b>&</b> Co", { sent: 1, hardBounces: 0, complaints: 1, reasons: ["<script>"] }, "https://x.test/?a=1&b=<2>");
    expect(m.html).not.toContain("<script>");
    expect(m.html).not.toContain("<b>");
    expect(m.html).toContain("&lt;script&gt;");
    expect(m.html).toContain("&amp;");
  });
});
