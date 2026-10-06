/**
 * Integration tests for data export and workspace deletion: what an export
 * contains (and never contains), the grace period, what a pending deletion
 * switches off, the permanent erasure, and the admin versions of all of it.
 *
 * Needs a reachable Postgres via DATABASE_URL, like the other *.db tests.
 * Every tenant created here has a slug starting with "acct-t-".
 */
import { createHash, randomBytes } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { purgeDueWorkspaces, purgeWorkspace, tenantTablesInDeleteOrder, KEPT_DETACHED } from "@mailforge/db/purge";
import { buildApp } from "../src/index.js";
import { SESSION_COOKIE_NAME } from "../src/routes/auth.js";
import { resetExportLimit } from "../src/routes/account.js";
import { EXPORT_EXCLUDED, EXPORT_TABLES } from "../src/account/export.js";
import { deletionGraceDays } from "../src/account/deletion.js";
import { createFlutterwaveClient } from "../src/billing/flutterwave.js";
import { startFakeFlutterwave, type FakeFlutterwave } from "./helpers/fake-flutterwave.js";

const TEST_DB_URL = process.env.DATABASE_URL;
if (!TEST_DB_URL) throw new Error("[account.test] DATABASE_URL is not set.");

const DAY = 86_400_000;
const ADMIN_EMAIL = "boss@acct-t.example";
let pool: pg.Pool;
let lockClient: pg.PoolClient | undefined;
let db: ReturnType<typeof drizzle>;
let dbAvailable = false;
let app: FastifyInstance;
let appBilling: FastifyInstance;
let fake: FakeFlutterwave;

interface Tenant {
  id: string;
  slug: string;
  email: string;
  userId: string;
  key: string;
  session: string;
  memberSession: string;
}

async function q<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  return (await db.execute(query)).rows as T[];
}
const n = async (query: ReturnType<typeof sql>) => Number((await q<{ n: string }>(query))[0]!.n);

const createdIds: string[] = [];
let counter = 0;
async function newTenant(opts: { plan?: string; email?: string } = {}): Promise<Tenant> {
  const slug = `acct-t-${Date.now()}-${counter++}`;
  const email = opts.email ?? `${slug}@acct-t.example`;
  const [t] = await q<{ id: string }>(sql`INSERT INTO tenants (name, slug, plan) VALUES (${slug}, ${slug}, ${opts.plan ?? "free"}) RETURNING id`);
  const id = t!.id;
  createdIds.push(id);
  const [u] = await q<{ id: string }>(sql`INSERT INTO users (tenant_id, email, role) VALUES (${id}::uuid, ${email}, 'owner') RETURNING id`);
  const [m] = await q<{ id: string }>(sql`INSERT INTO users (tenant_id, email, role) VALUES (${id}::uuid, ${"member-" + email}, 'member') RETURNING id`);
  const [s] = await q<{ id: string }>(sql`INSERT INTO sessions (tenant_id, user_id, expires_at) VALUES (${id}::uuid, ${u!.id}::uuid, now() + interval '1 day') RETURNING id`);
  const [ms] = await q<{ id: string }>(sql`INSERT INTO sessions (tenant_id, user_id, expires_at) VALUES (${id}::uuid, ${m!.id}::uuid, now() + interval '1 day') RETURNING id`);
  const key = `mf_live_${randomBytes(24).toString("base64url")}`;
  await db.execute(sql`INSERT INTO api_keys (tenant_id, key_hash, prefix, label) VALUES (${id}::uuid, ${createHash("sha256").update(key).digest("hex")}, ${key.slice(0, 8)}, 'acct test')`);
  return { id, slug, email, userId: u!.id, key, session: s!.id, memberSession: ms!.id };
}

/** A row in (almost) every tenant table, so erasure and export are tested against real foreign keys. */
async function seedRich(t: Tenant, tag = "rich"): Promise<{ contactId: string }> {
  const id = t.id;
  const [c] = await q<{ id: string }>(sql`INSERT INTO contacts (tenant_id, external_id, email, lifecycle_state) VALUES (${id}::uuid, ${"ext-" + tag}, ${tag + "@people.example"}, 'engaged') RETURNING id`);
  const cid = c!.id;
  const [ev] = await q<{ id: string }>(sql`INSERT INTO events (tenant_id, contact_id, type, event_name, timestamp) VALUES (${id}::uuid, ${cid}::uuid, 'track', 'did_a_thing', now()) RETURNING id`);
  await db.execute(sql`INSERT INTO contact_conflicts (tenant_id, contact_id, event_id, field, rejected_value) VALUES (${id}::uuid, ${cid}::uuid, ${ev!.id}::uuid, 'email', 'x')`);
  await db.execute(sql`INSERT INTO lifecycle_transitions (tenant_id, contact_id, from_state, to_state, transitioned_at) VALUES (${id}::uuid, ${cid}::uuid, 'new', 'engaged', now())`);
  const [f] = await q<{ id: string }>(sql`INSERT INTO flows (tenant_id, name, trigger_type, trigger_config, steps) VALUES (${id}::uuid, ${"Flow " + tag}, 'event', '{}'::jsonb, '[]'::jsonb) RETURNING id`);
  const [fm] = await q<{ id: string }>(sql`INSERT INTO flow_memberships (tenant_id, contact_id, flow_id, entered_at) VALUES (${id}::uuid, ${cid}::uuid, ${f!.id}::uuid, now()) RETURNING id`);
  const [msg] = await q<{ id: string }>(
    sql`INSERT INTO lifecycle_messages (tenant_id, contact_id, flow_id, membership_id, status, subject) VALUES (${id}::uuid, ${cid}::uuid, ${f!.id}::uuid, ${fm!.id}::uuid, 'sent', ${"Subject " + tag}) RETURNING id`,
  );
  await db.execute(sql`INSERT INTO message_events (tenant_id, message_id, event_type, occurred_at) VALUES (${id}::uuid, ${msg!.id}::uuid, 'delivered', now())`);
  await db.execute(sql`INSERT INTO templates (tenant_id, name, slug, subject, body_html) VALUES (${id}::uuid, 'T', ${"t-" + tag}, 'S', '<p>x</p>')`);
  await db.execute(sql`INSERT INTO kb_entries (tenant_id, title, content) VALUES (${id}::uuid, 'KB', 'knowledge')`);
  await db.execute(sql`INSERT INTO suppressions (tenant_id, email, reason) VALUES (${id}::uuid, ${"sup-" + tag + "@people.example"}, 'unsubscribed')`);
  await db.execute(sql`INSERT INTO transport_configs (tenant_id, provider, config, from_email) VALUES (${id}::uuid, 'resend', '{"apiKey":"SECRET-TRANSPORT-KEY"}'::jsonb, 'a@b.example')`);
  await db.execute(sql`INSERT INTO llm_configs (tenant_id, provider, config) VALUES (${id}::uuid, 'openai', 'SECRET-LLM-KEY')`);
  await db.execute(sql`INSERT INTO invites (tenant_id, email, token_hash, invited_by, expires_at) VALUES (${id}::uuid, 'inv@x.example', 'SECRET-INVITE-HASH', ${t.userId}::uuid, now() + interval '1 day')`);
  await db.execute(sql`INSERT INTO magic_link_tokens (tenant_id, user_id, token_hash, expires_at) VALUES (${id}::uuid, ${t.userId}::uuid, 'SECRET-LOGIN-HASH', now() + interval '1 day')`);
  await db.execute(sql`INSERT INTO retention_grid_snapshots (tenant_id, snapshot_date, tenure_bucket, recency_bucket, contact_count, paying_count) VALUES (${id}::uuid, current_date, 'a', 'b', 1, 0)`);
  await db.execute(sql`INSERT INTO scan_checkpoints (scan_phase, tenant_id, last_id, started_at) VALUES ('p', ${id}::uuid, ${cid}::uuid, now())`);
  await db.execute(sql`INSERT INTO subscriptions (tenant_id, provider, plan, interval, amount_cents, currency, status, customer_email, current_period_start, current_period_end)
    VALUES (${id}::uuid, 'flutterwave', 'growth', 'monthly', 4900, 'USD', 'ended', 'payer@x.example', now() - interval '60 days', now() - interval '30 days')`);
  await db.execute(sql`INSERT INTO billing_checkouts (tenant_id, tx_ref, plan, interval, amount_cents, customer_email, checkout_url) VALUES (${id}::uuid, ${"tx-" + id}, 'growth', 'monthly', 4900, 'payer@x.example', 'https://pay.example/SECRET-CHECKOUT')`);
  await db.execute(sql`INSERT INTO billing_events (provider, event_key, event_type, tenant_id, outcome) VALUES ('flutterwave', ${"charge:" + id}, 'charge.completed', ${id}::uuid, 'applied')`);
  await db.execute(sql`INSERT INTO admin_audit_log (actor_user_id, actor_email, action, tenant_id, detail) VALUES (${t.userId}::uuid, 'someone@x.example', 'suspend', ${id}::uuid, '{"reason":"earlier"}'::jsonb)`);
  return { contactId: cid };
}

async function cleanup(): Promise<void> {
  const ids = (await q<{ id: string }>(sql`SELECT id FROM tenants WHERE slug LIKE 'acct-t-%'`)).map((r) => r.id);
  for (const id of ids) {
    for (const t of await db.transaction(async (tx) => tenantTablesInDeleteOrder(tx as never))) {
      await db.execute(sql.raw(`DELETE FROM "${t}" WHERE tenant_id = '${id}'`));
    }
    await db.execute(sql`DELETE FROM tenants WHERE id = ${id}::uuid`);
  }
  await db.execute(sql`DELETE FROM deleted_workspaces WHERE slug LIKE 'acct-t-%'`);
  await db.execute(sql`DELETE FROM admin_audit_log WHERE detail->>'workspace_slug' LIKE 'acct-t-%'`);
  for (const id of createdIds) await db.execute(sql`DELETE FROM billing_events WHERE event_key = ${"charge:" + id}`);
  createdIds.length = 0;
}

const as = (s: string) => ({ [SESSION_COOKIE_NAME]: s });
const owner = (t: Tenant) => as(t.session);
const member = (t: Tenant) => as(t.memberSession);
const req = (a: FastifyInstance, method: "GET" | "POST" | "DELETE", url: string, cookies: Record<string, string>, payload?: unknown) =>
  a.inject({ method, url, cookies, payload: payload as object | undefined });
const tenantRow = async (id: string) =>
  (await q<{ deletion_requested_at: Date | null; deletion_scheduled_at: Date | null; deletion_requested_by: string | null }>(
    sql`SELECT deletion_requested_at, deletion_scheduled_at, deletion_requested_by FROM tenants WHERE id = ${id}::uuid`,
  ))[0];
const exists = async (id: string) => (await n(sql`SELECT count(*)::text AS n FROM tenants WHERE id = ${id}::uuid`)) === 1;
const trackWith = (t: Tenant) =>
  app.inject({ method: "POST", url: "/v1/track", headers: { authorization: `Bearer ${t.key}`, "content-type": "application/json" }, payload: JSON.stringify({ userId: "u1", event: "e" }) });

/** Every table that carries a tenant_id, and how many rows have this id (or are detached). */
async function leftovers(id: string): Promise<Record<string, number>> {
  const tables = await q<{ name: string }>(sql`
    SELECT c.relname AS name FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
    WHERE ns.nspname = 'public' AND c.relkind IN ('r','p') AND NOT c.relispartition
      AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)`);
  const out: Record<string, number> = {};
  for (const t of tables) {
    const c = await n(sql.raw(`SELECT count(*)::text AS n FROM "${t.name}" WHERE tenant_id = '${id}'`));
    if (c > 0) out[t.name] = c;
  }
  const own = await n(sql`SELECT count(*)::text AS n FROM tenants WHERE id = ${id}::uuid`);
  if (own > 0) out.tenants = own;
  return out;
}

let admin: Tenant;

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
    if (process.env.CI === "true") throw new Error(`[account.test] DATABASE_URL not reachable in CI: ${(err as Error).message}`);
    console.warn("[account.test] DATABASE_URL not reachable - tests skipped.");
    return;
  }
  await cleanup();
  process.env.MAILFORGE_PLATFORM_ADMINS = ADMIN_EMAIL;
  fake = await startFakeFlutterwave();
  const opts = { logger: false as const, db, baseUrl: "http://localhost:3000", dashboardUrl: "http://localhost:3000" };
  app = await buildApp(opts);
  appBilling = await buildApp({
    ...opts,
    billing: { client: createFlutterwaveClient({ secretKey: fake.secretKey, baseUrl: fake.baseUrl }), webhookHash: "h", currency: "USD" },
  });
});

beforeEach(() => {
  resetExportLimit();
  fake?.reset();
});

afterEach(async () => {
  if (!dbAvailable) return;
  await cleanup();
});

afterAll(async () => {
  delete process.env.MAILFORGE_PLATFORM_ADMINS;
  delete process.env.MAILFORGE_DELETION_GRACE_DAYS;
  if (app) await app.close();
  if (appBilling) await appBilling.close();
  if (fake) await fake.close();
  if (lockClient) {
    await lockClient.query("SELECT pg_advisory_unlock(7770001)");
    lockClient.release();
  }
  await pool?.end();
});

const withAdmin = async () => (admin = await newTenant({ email: ADMIN_EMAIL, plan: "growth" }));

// ===========================================================================
// Export
// ===========================================================================
describe("data export", () => {
  it("covers every table that holds tenant data: each is either exported or excluded for a stated reason", async () => {
    if (!dbAvailable) return;
    const order = await db.transaction(async (tx) => tenantTablesInDeleteOrder(tx as never));
    const covered = new Set([...EXPORT_TABLES.map((t) => t.table), ...Object.keys(EXPORT_EXCLUDED)]);
    expect(order.filter((t) => !covered.has(t)), "a new tenant table needs adding to EXPORT_TABLES or EXPORT_EXCLUDED").toEqual([]);
    // And nothing in the lists is stale.
    expect([...covered].filter((t) => !order.includes(t))).toEqual([]);
  });

  it("is a download of valid JSON holding the workspace's data", async () => {
    if (!dbAvailable) return;
    const t = await newTenant({ plan: "growth" });
    await seedRich(t);
    const res = await req(app, "GET", "/v1/account/export", owner(t));
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.headers["content-disposition"]).toMatch(new RegExp(`attachment; filename="${t.slug}-export-\\d{4}-\\d{2}-\\d{2}\\.json"`));
    expect(res.headers["cache-control"]).toBe("no-store");
    const doc = JSON.parse(res.body);
    expect(doc.export_version).toBe(1);
    expect(doc.workspace).toMatchObject({ id: t.id, slug: t.slug, plan: "growth" });
    expect(doc.team.map((u: { email: string }) => u.email).sort()).toEqual([t.email, `member-${t.email}`].sort());
    expect(doc.contacts).toHaveLength(1);
    expect(doc.contacts[0]).toMatchObject({ email: "rich@people.example", external_id: "ext-rich" });
    expect(doc.events).toHaveLength(1);
    expect(doc.flows[0].name).toBe("Flow rich");
    expect(doc.messages[0].subject).toBe("Subject rich");
    expect(doc.message_events).toHaveLength(1);
    expect(doc.email_templates).toHaveLength(1);
    expect(doc.knowledge_base[0].title).toBe("KB");
    expect(doc.suppressions[0].email).toBe("sup-rich@people.example");
    expect(doc.subscriptions[0]).toMatchObject({ plan: "growth", status: "ended" });
    expect(doc.email_transports[0]).toMatchObject({ provider: "resend", from_email: "a@b.example" });
    for (const key of ["lifecycle_transitions", "contact_conflicts", "retention_grid_snapshots", "flow_memberships", "api_keys", "llm_providers", "payment_attempts", "invites"]) {
      expect(doc[key].length, key).toBeGreaterThan(0);
    }
  });

  it("never contains a secret: key hashes, provider credentials, tokens, checkout links, sessions", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    await seedRich(t);
    const body = (await req(app, "GET", "/v1/account/export", owner(t))).body;
    for (const secret of [
      "SECRET-TRANSPORT-KEY", "SECRET-LLM-KEY", "SECRET-INVITE-HASH", "SECRET-LOGIN-HASH", "SECRET-CHECKOUT",
      createHash("sha256").update(t.key).digest("hex"), t.key, t.session, t.memberSession,
    ]) {
      expect(body, secret).not.toContain(secret);
    }
    const doc = JSON.parse(body);
    expect(doc.api_keys[0]).not.toHaveProperty("key_hash");
    expect(doc.api_keys[0]).toMatchObject({ prefix: t.key.slice(0, 8), label: "acct test" });
    expect(doc.email_transports[0]).not.toHaveProperty("config");
    expect(doc.knowledge_base[0]).not.toHaveProperty("embedding");
    expect(doc).not.toHaveProperty("sessions");
  });

  it("holds only this workspace's data, never another's", async () => {
    if (!dbAvailable) return;
    const a = await newTenant();
    const b = await newTenant();
    await seedRich(a, "alpha");
    await seedRich(b, "bravo");
    const bodyA = (await req(app, "GET", "/v1/account/export", owner(a))).body;
    expect(bodyA).toContain("alpha@people.example");
    expect(bodyA).not.toContain("bravo");
    expect(bodyA).not.toContain(b.id);
    expect(bodyA).not.toContain(b.email);
  });

  it("streams a big workspace completely, in batches (2,500 contacts, 2,500 events)", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    await db.execute(sql`INSERT INTO contacts (tenant_id, external_id, lifecycle_state) SELECT ${t.id}::uuid, 'bulk-' || g, 'engaged' FROM generate_series(1, 2500) g`);
    const first = (await q<{ id: string }>(sql`SELECT id FROM contacts WHERE tenant_id = ${t.id}::uuid LIMIT 1`))[0]!.id;
    await db.execute(sql`INSERT INTO events (tenant_id, contact_id, type, timestamp) SELECT ${t.id}::uuid, ${first}::uuid, 'track', now() FROM generate_series(1, 2500)`);
    const doc = JSON.parse((await req(app, "GET", "/v1/account/export", owner(t))).body);
    expect(doc.contacts).toHaveLength(2500);
    expect(new Set(doc.contacts.map((c: { id: string }) => c.id)).size).toBe(2500);
    expect(doc.events).toHaveLength(2500);
  });

  it("an empty workspace still exports as valid JSON", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    const doc = JSON.parse((await req(app, "GET", "/v1/account/export", owner(t))).body);
    expect(doc.contacts).toEqual([]);
    expect(doc.flows).toEqual([]);
  });

  it("is for owners only, needs a session, and is limited to a few an hour", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    expect((await app.inject({ method: "GET", url: "/v1/account/export" })).statusCode).toBe(401);
    expect((await req(app, "GET", "/v1/account/export", member(t))).statusCode).toBe(403);
    for (let i = 0; i < 5; i++) expect((await req(app, "GET", "/v1/account/export", owner(t))).statusCode).toBe(200);
    const limited = await req(app, "GET", "/v1/account/export", owner(t));
    expect(limited.statusCode).toBe(429);
    expect(limited.json().code).toBe("export_rate_limited");
    // Another workspace is not affected.
    const other = await newTenant();
    expect((await req(app, "GET", "/v1/account/export", owner(other))).statusCode).toBe(200);
  });
});

// ===========================================================================
// Scheduling deletion
// ===========================================================================
describe("asking to delete a workspace", () => {
  it("needs the owner and the exact workspace name, and schedules nothing otherwise", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    expect((await app.inject({ method: "POST", url: "/v1/account/deletion", payload: { confirm: t.slug } })).statusCode).toBe(401);
    expect((await req(app, "POST", "/v1/account/deletion", member(t), { confirm: t.slug })).statusCode).toBe(403);
    for (const confirm of [undefined, "", "wrong", t.slug.toUpperCase(), `${t.slug}x`, 5]) {
      const res = await req(app, "POST", "/v1/account/deletion", owner(t), { confirm });
      expect(res.statusCode, String(confirm)).toBe(400);
      expect(res.json().code).toBe("confirmation_mismatch");
    }
    expect((await tenantRow(t.id))!.deletion_scheduled_at).toBeNull();
  });

  it("starts the grace period, records who asked, and reports it", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    const before = Date.now();
    const res = await req(app, "POST", "/v1/account/deletion", owner(t), { confirm: ` ${t.slug} ` });
    expect(res.statusCode).toBe(200);
    const at = new Date(res.json().scheduled_at).getTime();
    expect(at - before).toBeGreaterThan(deletionGraceDays() * DAY - 5_000);
    expect(at - before).toBeLessThan(deletionGraceDays() * DAY + 10_000);
    const row = (await tenantRow(t.id))!;
    expect(row.deletion_requested_by).toBe(t.email);
    expect(row.deletion_requested_at).not.toBeNull();

    const status = (await req(app, "GET", "/v1/account/deletion", member(t))).json();
    expect(status).toMatchObject({ scheduled: true, requested_by: t.email, grace_days: 7, workspace: { slug: t.slug } });
    expect(status.scheduled_at).toBe(res.json().scheduled_at);
  });

  it("the grace period is configurable, within 1 to 90 days", () => {
    expect(deletionGraceDays({} as NodeJS.ProcessEnv)).toBe(7);
    expect(deletionGraceDays({ MAILFORGE_DELETION_GRACE_DAYS: "30" } as NodeJS.ProcessEnv)).toBe(30);
    for (const bad of ["0", "-3", "91", "abc", "", "2.5x"]) {
      const v = deletionGraceDays({ MAILFORGE_DELETION_GRACE_DAYS: bad } as NodeJS.ProcessEnv);
      expect(v === 7 || (bad === "2.5x" && v === 2), bad).toBe(true);
    }
  });

  it("cannot be scheduled twice, and the second attempt does not move the date", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    const first = (await req(app, "POST", "/v1/account/deletion", owner(t), { confirm: t.slug })).json().scheduled_at;
    const again = await req(app, "POST", "/v1/account/deletion", owner(t), { confirm: t.slug });
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe("already_scheduled");
    expect((await req(app, "GET", "/v1/account/deletion", owner(t))).json().scheduled_at).toBe(first);
  });

  it("switches the workspace off at once: dashboard API, ingest, and sign-in state, but not export or cancel", async () => {
    if (!dbAvailable) return;
    const t = await newTenant({ plan: "growth" });
    expect((await req(app, "GET", "/v1/plan", owner(t))).statusCode).toBe(200);
    expect((await trackWith(t)).statusCode).toBe(200);

    await req(app, "POST", "/v1/account/deletion", owner(t), { confirm: t.slug });

    for (const url of ["/v1/plan", "/v1/flows", "/v1/contacts"]) {
      const res = await req(app, "GET", url, owner(t));
      expect(res.statusCode, url).toBe(403);
      expect(res.json().code).toBe("workspace_pending_deletion");
    }
    expect((await req(app, "GET", "/v1/plan", member(t))).statusCode).toBe(403);
    const ingest = await trackWith(t);
    expect(ingest.statusCode).toBe(403);
    expect(ingest.json().code).toBe("workspace_pending_deletion");

    const me = (await req(app, "GET", "/auth/me", owner(t))).json();
    expect(me.pendingDeletion).toEqual(expect.any(String));
    expect((await req(app, "GET", "/v1/account/export", owner(t))).statusCode).toBe(200);
    expect((await req(app, "GET", "/v1/account/deletion", owner(t))).statusCode).toBe(200);
  });

  it("does not touch other workspaces", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    const other = await newTenant();
    await req(app, "POST", "/v1/account/deletion", owner(t), { confirm: t.slug });
    expect((await req(app, "GET", "/v1/plan", owner(other))).statusCode).toBe(200);
    expect((await trackWith(other)).statusCode).toBe(200);
    expect((await req(app, "GET", "/auth/me", owner(other))).json().pendingDeletion).toBeNull();
  });

  it("can be cancelled by the owner, which restores everything", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    await req(app, "POST", "/v1/account/deletion", owner(t), { confirm: t.slug });
    expect((await req(app, "DELETE", "/v1/account/deletion", member(t))).statusCode).toBe(403);
    expect((await req(app, "DELETE", "/v1/account/deletion", owner(t))).statusCode).toBe(200);
    const row = (await tenantRow(t.id))!;
    expect(row).toMatchObject({ deletion_requested_at: null, deletion_scheduled_at: null, deletion_requested_by: null });
    expect((await req(app, "GET", "/v1/plan", owner(t))).statusCode).toBe(200);
    expect((await trackWith(t)).statusCode).toBe(200);
    const again = await req(app, "DELETE", "/v1/account/deletion", owner(t));
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe("not_scheduled");
  });

  it("cancels a live subscription with the payment provider first, so nobody is charged for a doomed workspace", async () => {
    if (!dbAvailable) return;
    const t = await newTenant({ plan: "growth" });
    await db.execute(sql`INSERT INTO subscriptions (tenant_id, provider, plan, interval, amount_cents, currency, status, customer_email, current_period_start, current_period_end)
      VALUES (${t.id}::uuid, 'flutterwave', 'growth', 'monthly', 4900, 'USD', 'active', 'p@y.z', now(), now() + interval '1 month')`);
    const res = await req(appBilling, "POST", "/v1/account/deletion", owner(t), { confirm: t.slug });
    expect(res.statusCode).toBe(200);
    const [sub] = await q<{ status: string }>(sql`SELECT status FROM subscriptions WHERE tenant_id = ${t.id}::uuid`);
    expect(sub!.status).toBe("cancelled");
  });

  it("schedules nothing if the provider will not cancel the subscription", async () => {
    if (!dbAvailable) return;
    const t = await newTenant({ plan: "growth" });
    await db.execute(sql`INSERT INTO subscriptions (tenant_id, provider, plan, interval, amount_cents, currency, status, customer_email, provider_subscription_id, current_period_start, current_period_end)
      VALUES (${t.id}::uuid, 'flutterwave', 'growth', 'monthly', 4900, 'USD', 'active', 'p@y.z', '777', now(), now() + interval '1 month')`);
    fake.failNext("/subscriptions", 500);
    const res = await req(appBilling, "POST", "/v1/account/deletion", owner(t), { confirm: t.slug });
    expect(res.statusCode).toBe(502);
    expect((await tenantRow(t.id))!.deletion_scheduled_at).toBeNull();
    const [sub] = await q<{ status: string }>(sql`SELECT status FROM subscriptions WHERE tenant_id = ${t.id}::uuid`);
    expect(sub!.status).toBe("active");
  });

  it("a Free workspace with no subscription schedules fine with billing on", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    expect((await req(appBilling, "POST", "/v1/account/deletion", owner(t), { confirm: t.slug })).statusCode).toBe(200);
  });
});

// ===========================================================================
// Erasure
// ===========================================================================
describe("erasing a workspace", () => {
  it("removes every row the workspace owns, in every table, and keeps only a tombstone", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    await seedRich(t);
    expect(Object.keys(await leftovers(t.id)).length).toBeGreaterThan(15);

    const r = await purgeWorkspace(db as never, t.id, "admin_immediate");
    expect(r).not.toBeNull();
    expect(r!.rowCounts).toMatchObject({ contacts: 1, events: 1, flows: 1, lifecycle_messages: 1, users: 2, sessions: 2, api_keys: 1, kb_entries: 1 });

    const left = await leftovers(t.id);
    expect(left, "nothing may still carry this workspace id").toEqual({});

    const [tomb] = await q<{ name: string; slug: string; how: string; owner_email_hash: string; row_counts: Record<string, number> }>(
      sql`SELECT name, slug, how, owner_email_hash, row_counts FROM deleted_workspaces WHERE id = ${t.id}::uuid`,
    );
    expect(tomb).toMatchObject({ slug: t.slug, how: "admin_immediate" });
    expect(tomb!.owner_email_hash).toBe(createHash("sha256").update(t.email.toLowerCase()).digest("hex"));
    expect(tomb!.row_counts.contacts).toBe(1);
    // The tombstone holds no email, no contact data.
    const raw = JSON.stringify(await q(sql`SELECT * FROM deleted_workspaces WHERE id = ${t.id}::uuid`));
    expect(raw).not.toContain(t.email);
    expect(raw).not.toContain("people.example");
  });

  it("keeps payment records for accounting, detached from the workspace, and keeps the audit trail readable", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    await seedRich(t);
    await purgeWorkspace(db as never, t.id, "grace_expired");
    const ev = await q<{ tenant_id: string | null; outcome: string }>(sql`SELECT tenant_id, outcome FROM billing_events WHERE event_key = ${"charge:" + t.id}`);
    expect(ev).toEqual([{ tenant_id: null, outcome: "applied" }]);
    const audit = await q<{ tenant_id: string | null; detail: Record<string, unknown> }>(sql`SELECT tenant_id, detail FROM admin_audit_log WHERE detail->>'workspace_slug' = ${t.slug}`);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.tenant_id).toBeNull();
    expect(audit[0]!.detail).toMatchObject({ reason: "earlier", workspace_name: t.slug, workspace_deleted: true });
    expect(KEPT_DETACHED).toEqual(["billing_events", "admin_audit_log"]);
    await db.execute(sql`DELETE FROM billing_events WHERE event_key = ${"charge:" + t.id}`);
  });

  it("never touches another workspace", async () => {
    if (!dbAvailable) return;
    const a = await newTenant();
    const b = await newTenant();
    await seedRich(a, "aaa");
    await seedRich(b, "bbb");
    const before = await leftovers(b.id);
    await purgeWorkspace(db as never, a.id, "grace_expired");
    expect(await leftovers(b.id)).toEqual(before);
    expect(await exists(b.id)).toBe(true);
    expect((await req(app, "GET", "/v1/plan", owner(b))).statusCode).toBe(200);
  });

  it("is all or nothing: if it fails part way, nothing at all is deleted", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    await seedRich(t);
    const before = await leftovers(t.id);
    // A table the purge does not know about holds a reference with no tenant_id: the delete must fail.
    await db.execute(sql`CREATE TABLE IF NOT EXISTS acct_t_blocker (id serial PRIMARY KEY, contact_id uuid REFERENCES contacts(id))`);
    const [c] = await q<{ id: string }>(sql`SELECT id FROM contacts WHERE tenant_id = ${t.id}::uuid`);
    await db.execute(sql`INSERT INTO acct_t_blocker (contact_id) VALUES (${c!.id}::uuid)`);
    try {
      await expect(purgeWorkspace(db as never, t.id, "grace_expired")).rejects.toThrow();
      expect(await leftovers(t.id)).toEqual(before);
      expect(await n(sql`SELECT count(*)::text AS n FROM deleted_workspaces WHERE id = ${t.id}::uuid`)).toBe(0);
      expect((await tenantRow(t.id))).toBeDefined();
    } finally {
      await db.execute(sql`DROP TABLE acct_t_blocker`);
    }
  });

  it("returns null for a workspace that is already gone", async () => {
    if (!dbAvailable) return;
    expect(await purgeWorkspace(db as never, "00000000-0000-0000-0000-000000000000", "grace_expired")).toBeNull();
  });

  it("after the grace period the sweep erases it; before, or after a cancel, it does not", async () => {
    if (!dbAvailable) return;
    const due = await newTenant();
    const notYet = await newTenant();
    const cancelled = await newTenant();
    const plain = await newTenant();
    for (const t of [due, notYet, cancelled]) {
      await seedRich(t, t.slug.slice(-3));
      await req(app, "POST", "/v1/account/deletion", owner(t), { confirm: t.slug });
    }
    await req(app, "DELETE", "/v1/account/deletion", owner(cancelled));
    // Make `due` overdue; leave `notYet` in the future.
    await db.execute(sql`UPDATE tenants SET deletion_scheduled_at = now() - interval '1 minute' WHERE id = ${due.id}::uuid`);

    const sweep = await purgeDueWorkspaces(db as never, new Date());
    expect(sweep.failed).toEqual([]);
    expect(sweep.purged.map((p) => p.tenantId)).toEqual([due.id]);
    expect(await exists(due.id)).toBe(false);
    expect(await leftovers(due.id)).toEqual({});
    expect(await exists(notYet.id)).toBe(true);
    expect(await exists(cancelled.id)).toBe(true);
    expect(await exists(plain.id)).toBe(true);
    expect((await q<{ how: string }>(sql`SELECT how FROM deleted_workspaces WHERE id = ${due.id}::uuid`))[0]!.how).toBe("grace_expired");

    // Time passes: the other scheduled one is now due too.
    const later = await purgeDueWorkspaces(db as never, new Date(Date.now() + 8 * DAY));
    expect(later.purged.map((p) => p.tenantId)).toEqual([notYet.id]);
    expect(await exists(cancelled.id)).toBe(true);
    expect(await exists(plain.id)).toBe(true);
  });

  it("a deletion cancelled after the sweep selected it is not carried out", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    await req(app, "POST", "/v1/account/deletion", owner(t), { confirm: t.slug });
    await db.execute(sql`UPDATE tenants SET deletion_scheduled_at = now() - interval '1 minute' WHERE id = ${t.id}::uuid`);
    // The owner changes their mind just before the purge transaction runs.
    await req(app, "DELETE", "/v1/account/deletion", owner(t));
    const r = await purgeWorkspace(db as never, t.id, "grace_expired", { onlyIfDueAt: new Date() });
    expect(r).toBeNull();
    expect(await exists(t.id)).toBe(true);
  });

  it("a signed-in session for an erased workspace stops working", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    await purgeWorkspace(db as never, t.id, "admin_immediate");
    expect((await req(app, "GET", "/auth/me", owner(t))).statusCode).toBe(401);
    expect((await req(app, "GET", "/v1/plan", owner(t))).statusCode).toBe(401);
    expect((await trackWith(t)).statusCode).toBe(401);
  });
});

// ===========================================================================
// Platform admin versions
// ===========================================================================
describe("platform admin: export and deletion", () => {
  it("non-admins get a plain 404 on all three routes and nothing changes", async () => {
    if (!dbAvailable) return;
    const intruder = await newTenant();
    const victim = await newTenant();
    await seedRich(victim);
    for (const [method, url, payload] of [
      ["GET", `/v1/admin/tenants/${victim.id}/export`, undefined],
      ["POST", `/v1/admin/tenants/${victim.id}/delete`, { confirm: victim.slug, reason: "x", immediate: true }],
      ["POST", `/v1/admin/tenants/${victim.id}/cancel-deletion`, { reason: "x" }],
    ] as const) {
      expect((await req(app, method, url, owner(intruder), payload)).statusCode, url).toBe(404);
    }
    expect(await exists(victim.id)).toBe(true);
    expect((await tenantRow(victim.id))!.deletion_scheduled_at).toBeNull();
  });

  it("exports a customer's data on their behalf, and records that it did", async () => {
    if (!dbAvailable) return;
    const a = await withAdmin();
    const t = await newTenant();
    await seedRich(t);
    const res = await req(app, "GET", `/v1/admin/tenants/${t.id}/export`, owner(a));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).contacts).toHaveLength(1);
    expect(res.body).not.toContain("SECRET-TRANSPORT-KEY");
    const [entry] = await q<{ action: string; actor_email: string }>(sql`SELECT action, actor_email FROM admin_audit_log WHERE tenant_id = ${t.id}::uuid AND action = 'export_data'`);
    expect(entry).toMatchObject({ actor_email: ADMIN_EMAIL });
    expect((await req(app, "GET", "/v1/admin/tenants/00000000-0000-0000-0000-000000000000/export", owner(a))).statusCode).toBe(404);
  });

  it("scheduling needs the slug and a reason, refuses your own workspace, and is audited", async () => {
    if (!dbAvailable) return;
    const a = await withAdmin();
    const t = await newTenant();
    const url = `/v1/admin/tenants/${t.id}/delete`;
    expect((await req(app, "POST", url, owner(a), { confirm: t.slug })).json().code).toBe("reason_required");
    expect((await req(app, "POST", url, owner(a), { confirm: "nope", reason: "r" })).json().code).toBe("confirmation_mismatch");
    expect((await req(app, "POST", `/v1/admin/tenants/${a.id}/delete`, owner(a), { confirm: a.slug, reason: "r" })).json().code).toBe("own_workspace");
    expect((await req(app, "POST", `/v1/admin/tenants/${a.id}/delete`, owner(a), { confirm: a.slug, reason: "r", immediate: true })).statusCode).toBe(400);
    expect((await tenantRow(t.id))!.deletion_scheduled_at).toBeNull();
    expect(await exists(a.id)).toBe(true);

    const ok = await req(app, "POST", url, owner(a), { confirm: t.slug, reason: "Customer emailed support" });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ ok: true, deleted: false });
    expect(ok.json().workspace.deletion_scheduled_at).toEqual(expect.any(String));
    expect((await tenantRow(t.id))!.deletion_requested_by).toBe(ADMIN_EMAIL);
    expect((await req(app, "POST", url, owner(a), { confirm: t.slug, reason: "again" })).json().code).toBe("already_scheduled");
    expect((await req(app, "GET", "/v1/plan", owner(t))).statusCode).toBe(403);
    const acts = (await q<{ action: string }>(sql`SELECT action FROM admin_audit_log WHERE tenant_id = ${t.id}::uuid ORDER BY created_at`)).map((r) => r.action);
    expect(acts).toEqual(["schedule_deletion"]);
  });

  it("an admin can cancel a scheduled deletion, with a reason", async () => {
    if (!dbAvailable) return;
    const a = await withAdmin();
    const t = await newTenant();
    const url = `/v1/admin/tenants/${t.id}/cancel-deletion`;
    expect((await req(app, "POST", url, owner(a), { reason: "r" })).json().code).toBe("not_scheduled");
    await req(app, "POST", `/v1/admin/tenants/${t.id}/delete`, owner(a), { confirm: t.slug, reason: "r" });
    expect((await req(app, "POST", url, owner(a), {})).json().code).toBe("reason_required");
    expect((await req(app, "POST", url, owner(a), { reason: "Customer changed their mind" })).statusCode).toBe(200);
    expect((await tenantRow(t.id))!.deletion_scheduled_at).toBeNull();
    expect((await req(app, "GET", "/v1/plan", owner(t))).statusCode).toBe(200);
  });

  it("immediate deletion erases now, leaves a readable audit entry with no workspace link, and cannot be undone", async () => {
    if (!dbAvailable) return;
    const a = await withAdmin();
    const t = await newTenant();
    await seedRich(t);
    const res = await req(app, "POST", `/v1/admin/tenants/${t.id}/delete`, owner(a), { confirm: t.slug, reason: "Legal erasure request", immediate: true });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, deleted: true });
    expect(await exists(t.id)).toBe(false);
    expect(await leftovers(t.id)).toEqual({});

    const entries = await q<{ tenant_id: string | null; action: string; detail: { workspace_slug: string; reason: string; rows_erased: Record<string, number> } }>(
      sql`SELECT tenant_id, action, detail FROM admin_audit_log WHERE detail->>'workspace_slug' = ${t.slug} AND action = 'delete_workspace'`,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]!.tenant_id).toBeNull();
    expect(entries[0]!.detail.reason).toBe("Legal erasure request");
    expect(entries[0]!.detail.rows_erased.contacts).toBe(1);

    const shown = (await req(app, "GET", "/v1/admin/audit?limit=5", owner(a))).json().entries;
    expect(shown[0]).toMatchObject({ action: "delete_workspace", tenant_id: null });
    expect((await req(app, "GET", `/v1/admin/tenants/${t.id}`, owner(a))).statusCode).toBe(404);
    expect((await req(app, "POST", `/v1/admin/tenants/${t.id}/delete`, owner(a), { confirm: t.slug, reason: "again", immediate: true })).statusCode).toBe(404);
  });

  it("immediate deletion of a paying customer cancels their subscription first; if that fails, nothing is deleted", async () => {
    if (!dbAvailable) return;
    const a = await withAdmin();
    const t = await newTenant({ plan: "growth" });
    await db.execute(sql`INSERT INTO subscriptions (tenant_id, provider, plan, interval, amount_cents, currency, status, customer_email, provider_subscription_id, current_period_start, current_period_end)
      VALUES (${t.id}::uuid, 'flutterwave', 'growth', 'monthly', 4900, 'USD', 'active', 'p@y.z', '555', now(), now() + interval '1 month')`);
    fake.failNext("/subscriptions", 500);
    const bad = await req(appBilling, "POST", `/v1/admin/tenants/${t.id}/delete`, owner(a), { confirm: t.slug, reason: "r", immediate: true });
    expect(bad.statusCode).toBe(502);
    expect(await exists(t.id)).toBe(true);

    const good = await req(appBilling, "POST", `/v1/admin/tenants/${t.id}/delete`, owner(a), { confirm: t.slug, reason: "r", immediate: true });
    expect(good.statusCode).toBe(200);
    expect(await exists(t.id)).toBe(false);
    expect(fake.callsTo("PUT", "/v3/subscriptions").length + fake.callsTo("PUT", "/subscriptions").length).toBeGreaterThan(0);
  });

  it("the console shows the pending deletion on the workspace", async () => {
    if (!dbAvailable) return;
    const a = await withAdmin();
    const t = await newTenant();
    await req(app, "POST", "/v1/account/deletion", owner(t), { confirm: t.slug });
    const d = (await req(app, "GET", `/v1/admin/tenants/${t.id}`, owner(a))).json();
    expect(d.workspace).toMatchObject({ deletion_requested_by: t.email });
    expect(d.workspace.deletion_scheduled_at).toEqual(expect.any(String));
  });
});
