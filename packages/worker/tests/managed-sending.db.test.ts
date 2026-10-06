/**
 * Integration tests for managed sending in the worker: the transport resolver falls back
 * to the operator's Resend for a workspace with no provider of its own, and the real drain
 * sends through it. A fake Resend stands in for the real one.
 *
 * Needs a reachable Postgres via DATABASE_URL. Tenants have slugs starting with "msnd-w-".
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { sql } from "drizzle-orm";
import { encrypt, parseEncryptionKey } from "@mailforge/adapters";
import { buildTenantTransportResolver } from "../src/transport-resolver.js";
import { managedDailyLimit, resolveManagedTransport } from "../src/managed-sending.js";
import { makeDrainRunner } from "./drain-test-utils.js";
import { startFakeResend, type FakeResend } from "../../api/tests/helpers/fake-resend.js";

const TEST_DB_URL = process.env.DATABASE_URL;
if (!TEST_DB_URL) throw new Error("[managed-sending.test] DATABASE_URL is not set.");

const ENC_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const SIGNING_KEY = "test-unsubscribe-signing-key-do-not-use";
const SHARED = "notifications@mail.platform.test";
const MANAGED_ENV = ["MAILFORGE_MANAGED_RESEND_API_KEY", "MAILFORGE_MANAGED_RESEND_BASE_URL", "MAILFORGE_MANAGED_SHARED_FROM", "MAILFORGE_MANAGED_SHARED_DAILY_LIMIT", "MAILFORGE_MANAGED_SENDING"];

let pool: pg.Pool;
let lockClient: pg.PoolClient | undefined;
let db: ReturnType<typeof drizzle>;
let dbAvailable = false;
let fake: FakeResend;
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const k of [...MANAGED_ENV, "ENCRYPTION_KEY"]) saved[k] = process.env[k];
  process.env.ENCRYPTION_KEY = ENC_KEY;
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
});

afterEach(async () => {
  if (!dbAvailable) return;
  for (const k of MANAGED_ENV) delete process.env[k];
  fake.emails.length = 0;
  fake.requests.length = 0;
  for (const [id, d] of [...fake.domains]) if (d.name !== "mail.platform.test") fake.domains.delete(id);
  await cleanup();
});

afterAll(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  if (lockClient) {
    await lockClient.query("SELECT pg_advisory_unlock(7770001)");
    lockClient.release();
  }
  await pool?.end();
  await fake?.close();
});

function offer(extra: Record<string, string> = {}) {
  process.env.MAILFORGE_MANAGED_RESEND_API_KEY = fake.apiKey;
  process.env.MAILFORGE_MANAGED_RESEND_BASE_URL = fake.baseUrl;
  process.env.MAILFORGE_MANAGED_SHARED_FROM = SHARED;
  process.env.MAILFORGE_MANAGED_SHARED_DAILY_LIMIT = "100";
  for (const [k, v] of Object.entries(extra)) process.env[k] = v;
}

async function q<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  return (await db.execute(query)).rows as T[];
}

async function cleanup() {
  const ids = (await q<{ id: string }>(sql`SELECT id FROM tenants WHERE slug LIKE 'msnd-w-%'`)).map((r) => r.id);
  for (const id of ids) {
    for (const t of ["lifecycle_messages", "flow_memberships", "flows", "lifecycle_transitions", "contacts", "managed_sending", "transport_configs", "suppressions", "users"]) {
      await db.execute(sql.raw(`DELETE FROM ${t} WHERE tenant_id = '${id}'`));
    }
    await db.execute(sql`DELETE FROM scan_checkpoints WHERE tenant_id = ${id}::uuid`);
    await db.execute(sql`DELETE FROM tenants WHERE id = ${id}::uuid`);
  }
}

let n = 0;
async function newTenant(name = "Acme Analytics", settings: Record<string, unknown> = {}): Promise<string> {
  const slug = `msnd-w-${Date.now()}-${n++}`;
  const [t] = await q<{ id: string }>(sql`
    INSERT INTO tenants (name, slug, plan, settings) VALUES (${name}, ${slug}, 'scale', ${JSON.stringify({ postal_address: "1 Test Street", ...settings })}::jsonb) RETURNING id`);
  await db.execute(sql`INSERT INTO users (tenant_id, email, role) VALUES (${t!.id}::uuid, ${"owner-" + slug + "@msnd.example"}, 'owner')`);
  return t!.id;
}
const ownerOf = async (id: string) => (await q<{ email: string }>(sql`SELECT email FROM users WHERE tenant_id = ${id}::uuid LIMIT 1`))[0]!.email;

async function managed(tenantId: string, fields: Record<string, unknown> = {}) {
  const f = { domain: null, resend_domain_id: null, domain_status: "none", from_local: "hello", from_name: null, reply_to: null, enabled: true, paused_at: null, ...fields };
  await db.execute(sql`
    INSERT INTO managed_sending (tenant_id, enabled, domain, resend_domain_id, domain_status, from_local, from_name, reply_to, paused_at)
    VALUES (${tenantId}::uuid, ${f.enabled as boolean}, ${f.domain as string | null}, ${f.resend_domain_id as string | null}, ${f.domain_status as string}, ${f.from_local as string}, ${f.from_name as string | null}, ${f.reply_to as string | null}, ${f.paused_at as Date | null})
    ON CONFLICT (tenant_id) DO UPDATE SET enabled = EXCLUDED.enabled, domain = EXCLUDED.domain, domain_status = EXCLUDED.domain_status, from_local = EXCLUDED.from_local, from_name = EXCLUDED.from_name, reply_to = EXCLUDED.reply_to, paused_at = EXCLUDED.paused_at`);
}

const params = { to: "person@example.org", from: "ignored@ignored.test", subject: "Hi", bodyHtml: "<p>x</p>", bodyText: "x", messageId: "m-1" };

// ---------------------------------------------------------------------------

describe("resolveManagedTransport", () => {
  it("gives nothing when the operator does not offer it, the workspace never turned it on, or it switched it off", async () => {
    const t = await newTenant();
    expect(await resolveManagedTransport(db as never, t)).toBeNull(); // not offered
    offer();
    expect(await resolveManagedTransport(db as never, t)).toBeNull(); // no row
    await managed(t, { enabled: false });
    expect(await resolveManagedTransport(db as never, t)).toBeNull(); // turned off
    process.env.MAILFORGE_MANAGED_SENDING = "false";
    await managed(t);
    expect(await resolveManagedTransport(db as never, t)).toBeNull(); // operator switched managed sending off
  });

  it("gives nothing while paused, and nothing without a verified domain or a shared address", async () => {
    offer();
    const t = await newTenant();
    await managed(t, { paused_at: new Date() });
    expect(await resolveManagedTransport(db as never, t)).toBeNull();
    await managed(t, { domain: "mail.acme-test.dev", domain_status: "pending" });
    delete process.env.MAILFORGE_MANAGED_SHARED_FROM;
    expect(await resolveManagedTransport(db as never, t)).toBeNull();
  });

  it("sends from the shared address with the workspace's name and its owner as reply address, whatever sender the caller names", async () => {
    offer();
    const t = await newTenant("Acme Analytics");
    await managed(t);
    const adapter = (await resolveManagedTransport(db as never, t))!;
    const r = await adapter.send(params);
    expect(r.success).toBe(true);
    expect(fake.emails[0]).toMatchObject({ from: `Acme Analytics <${SHARED}>`, replyTo: await ownerOf(t), to: ["person@example.org"], key: `Bearer ${fake.apiKey}` });
    expect(JSON.stringify(fake.emails[0])).not.toContain("ignored");
  });

  it("uses the brand name, the brand reply address, and the workspace's own verified domain when it has one", async () => {
    offer();
    const t = await newTenant("Acme Analytics", { brand: { brand_name: "Acme Brand", reply_to: "support@acme-test.dev" } });
    await managed(t, { domain: "mail.acme-test.dev", domain_status: "verified", from_local: "news" });
    const created = await (await import("@mailforge/adapters")).createResendDomainsClient({ apiKey: fake.apiKey, baseUrl: fake.baseUrl }).createDomain("mail.acme-test.dev");
    if (!created.ok) throw new Error("fake create failed");
    fake.setStatus("mail.acme-test.dev", "verified");
    const adapter = (await resolveManagedTransport(db as never, t))!;
    expect((await adapter.send(params)).success).toBe(true);
    expect(fake.emails[0]).toMatchObject({ from: "Acme Brand <news@mail.acme-test.dev>", replyTo: "support@acme-test.dev" });
  });

  it("a stored from-name wins over the brand name, and a stored reply address over both", async () => {
    offer();
    const t = await newTenant("Acme Analytics", { brand: { brand_name: "Acme Brand", reply_to: "support@acme-test.dev" } });
    await managed(t, { from_name: "The Acme Team", reply_to: "hello@acme-test.dev" });
    await (await resolveManagedTransport(db as never, t))!.send(params);
    expect(fake.emails[0]).toMatchObject({ from: `The Acme Team <${SHARED}>`, replyTo: "hello@acme-test.dev" });
  });

  it("never lets a bad stored name or reply address through (header injection)", async () => {
    offer();
    const t = await newTenant();
    await managed(t, { from_name: "Acme\r\nBcc: evil@x.test", reply_to: "evil@x.test\r\nBcc: z@x.test" });
    await (await resolveManagedTransport(db as never, t))!.send(params);
    expect(fake.emails[0]!.from).not.toMatch(/[\r\n]/);
    expect(fake.emails[0]!.replyTo).toBe(await ownerOf(t)); // the bad reply address is ignored
  });
});

describe("the transport resolver the drain uses", () => {
  it("prefers a transport of their own; managed sending only when there is none", async () => {
    offer();
    const t = await newTenant();
    await managed(t);
    const resolver = buildTenantTransportResolver(db as never);
    const managedAdapter = await resolver(t);
    expect(managedAdapter).not.toBeNull();
    await managedAdapter!.send(params);
    expect(fake.emails).toHaveLength(1);

    const cfg = encrypt(JSON.stringify({ apiKey: "re_theirs" }), parseEncryptionKey(ENC_KEY));
    await db.execute(sql`INSERT INTO transport_configs (tenant_id, provider, config, is_active, from_email) VALUES (${t}::uuid, 'resend', ${cfg}, true, 'me@theirs.example')`);
    const own = await resolver(t);
    expect(own).not.toBeNull();
    expect(own).not.toBe(managedAdapter);
    fake.emails.length = 0;
    // Their own Resend key is theirs, and goes to the real Resend, never to the operator's account: nothing arrives at the fake.
    const real = globalThis.fetch;
    let calledUrl = "";
    globalThis.fetch = (async (u: string) => {
      calledUrl = String(u);
      return new Response(JSON.stringify({ id: "x" }), { status: 200 });
    }) as typeof fetch;
    try {
      await own!.send({ ...params, from: "me@theirs.example" });
    } finally {
      globalThis.fetch = real;
    }
    expect(calledUrl).toBe("https://api.resend.com/emails");
    expect(fake.emails).toHaveLength(0);
  });

  it("returns nothing for a workspace with neither", async () => {
    offer();
    const t = await newTenant();
    expect(await buildTenantTransportResolver(db as never)(t)).toBeNull();
  });
});

describe("managedDailyLimit", () => {
  it("caps only the shared address, at the operator's figure", async () => {
    offer({ MAILFORGE_MANAGED_SHARED_DAILY_LIMIT: "7" });
    const t = await newTenant();
    await managed(t);
    expect(await managedDailyLimit(db as never, t)).toBe(7);
    await managed(t, { domain: "mail.acme-test.dev", domain_status: "verified" });
    expect(await managedDailyLimit(db as never, t)).toBeNull(); // own domain: only the plan limits it
    await managed(t, { domain: "mail.acme-test.dev", domain_status: "failed" });
    expect(await managedDailyLimit(db as never, t)).toBe(7); // fell back to shared
  });

  it("is none when not offered, not enabled, paused, or never set up", async () => {
    const t = await newTenant();
    expect(await managedDailyLimit(db as never, t)).toBeNull();
    offer();
    expect(await managedDailyLimit(db as never, t)).toBeNull();
    await managed(t, { enabled: false });
    expect(await managedDailyLimit(db as never, t)).toBeNull();
    await managed(t, { paused_at: new Date() });
    expect(await managedDailyLimit(db as never, t)).toBeNull();
  });
});

describe("the real drain sending through managed sending", () => {
  async function approved(tenantId: string, count: number): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      const [c] = await q<{ id: string }>(sql`INSERT INTO contacts (tenant_id, external_id, email, lifecycle_state, first_seen_at, last_seen_at) VALUES (${tenantId}::uuid, ${"c" + i + "-" + n++}, ${`p${i}-${n}@example.org`}, 'engaged', now(), now()) RETURNING id`);
      const [f] = await q<{ id: string }>(sql`
        INSERT INTO flows (tenant_id, name, priority, trigger_type, trigger_config, steps, status, flow_class, compiled_plan)
        VALUES (${tenantId}::uuid, 'F', 0, 'lifecycle_transition', '{"from":"engaged","to":"at_risk"}'::jsonb,
                '[{"order":1,"action_type":"nurture_value","delay":"0d","window_policy":"immediate"}]'::jsonb, 'paused', 'nurture',
                '{"trigger":{"type":"lifecycle_transition","condition":{"from":"engaged","to":"at_risk"}},"steps":[{"order":1,"action_type":"nurture_value","delay":"0d","window_policy":"immediate"}]}'::jsonb) RETURNING id`);
      const [m] = await q<{ id: string }>(sql`INSERT INTO flow_memberships (tenant_id, contact_id, flow_id, current_step, status, entered_at, completed_at, exit_reason) VALUES (${tenantId}::uuid, ${c!.id}::uuid, ${f!.id}::uuid, 1, 'completed', now(), now(), 'completed') RETURNING id`);
      const [msg] = await q<{ id: string }>(sql`
        INSERT INTO lifecycle_messages (tenant_id, contact_id, flow_id, membership_id, flow_step_order, status, subject, body_html, body_text, approved_at)
        VALUES (${tenantId}::uuid, ${c!.id}::uuid, ${f!.id}::uuid, ${m!.id}::uuid, 1, 'approved', 'Hello', '<p>Hi</p>', 'Hi', now() - interval '1 hour') RETURNING id`);
      ids.push(msg!.id);
    }
    return ids;
  }
  const states = async (ids: string[]) => (await q<{ status: string; provider_message_id: string | null }>(sql`SELECT status, provider_message_id FROM lifecycle_messages WHERE id = ANY(string_to_array(${ids.join(",")}, ',')::uuid[]) ORDER BY created_at, id`));
  const run = async (tenantId: string) => {
    const adapter = await buildTenantTransportResolver(db as never)(tenantId);
    return makeDrainRunner(db as never, tenantId, adapter, SIGNING_KEY, "http://localhost:3000")(new Date());
  };

  it("sends the workspace's approved mail through the operator's Resend, as the workspace, with the unsubscribe headers", async () => {
    offer();
    const t = await newTenant("Acme Analytics");
    await managed(t);
    const ids = await approved(t, 2);
    const result = await run(t);
    expect(result.sent).toBe(2);
    expect(fake.emails).toHaveLength(2);
    for (const e of fake.emails) {
      expect(e.from).toBe(`Acme Analytics <${SHARED}>`);
      expect(e.replyTo).toBe("owner-" + (await q<{ slug: string }>(sql`SELECT slug FROM tenants WHERE id = ${t}::uuid`))[0]!.slug + "@msnd.example");
      expect(e.headers["List-Unsubscribe"]).toMatch(/unsubscribe/);
      expect(e.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    }
    const s = await states(ids);
    expect(s.every((x) => x.status === "sent" && x.provider_message_id)).toBe(true);
    // The provider id Resend gave is what the shared webhook will look the message up by.
    expect(s.map((x) => x.provider_message_id).sort()).toEqual(fake.emails.map((e) => e.id).sort());
  });

  it("holds the rest of the day's mail at the shared address's daily cap, queued for tomorrow, never failed", async () => {
    offer({ MAILFORGE_MANAGED_SHARED_DAILY_LIMIT: "2" });
    const t = await newTenant();
    await managed(t);
    const ids = await approved(t, 3);
    const result = await run(t);
    expect(result.sent).toBe(2);
    expect(fake.emails).toHaveLength(2);
    const s = await states(ids);
    expect(s.filter((x) => x.status === "sent")).toHaveLength(2);
    expect(s.filter((x) => x.status === "approved")).toHaveLength(1);
    const held = await q<{ scheduled_send_at: Date }>(sql`SELECT scheduled_send_at FROM lifecycle_messages WHERE status = 'approved' AND tenant_id = ${t}::uuid`);
    expect(new Date(held[0]!.scheduled_send_at).getTime()).toBeGreaterThan(Date.now() + 20 * 3_600_000);
  });

  it("a workspace on its own verified domain has no such cap", async () => {
    offer({ MAILFORGE_MANAGED_SHARED_DAILY_LIMIT: "1" });
    const t = await newTenant();
    const created = await (await import("@mailforge/adapters")).createResendDomainsClient({ apiKey: fake.apiKey, baseUrl: fake.baseUrl }).createDomain("mail.acme-test.dev");
    if (!created.ok) throw new Error("fake create failed");
    fake.setStatus("mail.acme-test.dev", "verified");
    await managed(t, { domain: "mail.acme-test.dev", domain_status: "verified" });
    await approved(t, 3);
    expect((await run(t)).sent).toBe(3);
    expect(fake.emails.every((e) => e.from.endsWith("<hello@mail.acme-test.dev>"))).toBe(true);
  });

  it("a paused workspace's mail is not touched: no attempt, no status change", async () => {
    offer();
    const t = await newTenant();
    await managed(t, { paused_at: new Date() });
    const ids = await approved(t, 2);
    const result = await run(t);
    expect(result.sent).toBe(0);
    expect(fake.emails).toHaveLength(0);
    expect((await states(ids)).every((x) => x.status === "approved")).toBe(true);
  });

  it("when the OPERATOR's account has a problem the customer's mail waits and is retried, not failed", async () => {
    offer();
    process.env.MAILFORGE_MANAGED_RESEND_API_KEY = "re_wrong_key"; // the operator's key is wrong: Resend answers 401
    const t = await newTenant();
    await managed(t);
    const ids = await approved(t, 1);
    const result = await run(t);
    expect(result.sent).toBe(0);
    const s = await states(ids);
    expect(s[0]!.status).not.toBe("failed");
    expect(s[0]!.status).toBe("sending"); // left for the reaper, which retries
    expect(fake.emails).toHaveLength(0);
  });

  it("a problem with the message itself (Resend rejects the recipient) fails just that message", async () => {
    offer();
    const t = await newTenant();
    await managed(t);
    const ids = await approved(t, 1);
    fake.failNext("/emails", 422, "validation_error", "Invalid `to` field.");
    await run(t);
    expect((await states(ids))[0]!.status).toBe("failed");
  });

  it("two workspaces on managed sending are kept apart: each sends as itself", async () => {
    offer();
    const a = await newTenant("Alpha Co");
    const b = await newTenant("Beta Co");
    await managed(a);
    await managed(b);
    await approved(a, 1);
    await approved(b, 1);
    await run(a);
    await run(b);
    expect(fake.emails.map((e) => e.from).sort()).toEqual([`Alpha Co <${SHARED}>`, `Beta Co <${SHARED}>`]);
  });
});
