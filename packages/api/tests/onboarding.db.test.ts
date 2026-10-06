/**
 * Integration tests for customer onboarding: the progress route, the "later" switch,
 * the completion date, and the once-only welcome email.
 *
 * Needs a reachable Postgres via DATABASE_URL, like the other *.db tests.
 * Every tenant created here has a slug starting with "onb-".
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
import { sendWelcomeEmailOnce } from "../src/onboarding/welcome.js";
import { markOnboardingCompleted } from "../src/onboarding/state.js";
import { buildWelcomeEmail, goalWelcome } from "../src/transactional-email.js";
import { BUSINESS_MODEL_TEMPLATES, ONBOARDING_GOALS } from "@mailforge/core";

const TEST_DB_URL = process.env.DATABASE_URL;
if (!TEST_DB_URL) throw new Error("[onboarding.test] DATABASE_URL is not set.");

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
const platform = () => ({ adapter: outbox, fromEmail: "no-reply@platform.example", fromName: "Mailforge" });

let pool: pg.Pool;
let db: ReturnType<typeof drizzle>;
let dbAvailable = false;
let app: FastifyInstance;

interface Tenant {
  id: string;
  userId: string;
  email: string;
  session: string;
}

async function q<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  return (await db.execute(query)).rows as T[];
}

let counter = 0;
/** A workspace as signup makes it (settings.signup set) unless `signup: false`. */
async function newTenant(opts: { signup?: boolean; trialDays?: number | null; goal?: string } = {}): Promise<Tenant> {
  const slug = `onb-${Date.now()}-${counter++}`;
  const email = `${slug}@onb.example`;
  const settings = opts.signup === false ? {} : { signup: { plan_interest: "growth", at: new Date().toISOString(), ...(opts.goal ? { goal: opts.goal } : {}) } };
  const trial = opts.trialDays === undefined ? 14 : opts.trialDays;
  const [t] = await q<{ id: string }>(sql`
    INSERT INTO tenants (name, slug, plan, settings, trial_ends_at)
    VALUES (${"Brightpath <b>"}, ${slug}, 'trial', ${JSON.stringify(settings)}::jsonb,
            ${trial === null ? null : new Date(Date.now() + trial * 86_400_000).toISOString()})
    RETURNING id`);
  const id = t!.id;
  const [u] = await q<{ id: string }>(sql`INSERT INTO users (tenant_id, email, role) VALUES (${id}::uuid, ${email}, 'owner') RETURNING id`);
  const [s] = await q<{ id: string }>(sql`INSERT INTO sessions (tenant_id, user_id, expires_at) VALUES (${id}::uuid, ${u!.id}::uuid, now() + interval '1 day') RETURNING id`);
  return { id, userId: u!.id, email, session: s!.id };
}

async function cleanup(): Promise<void> {
  const ids = (await q<{ id: string }>(sql`SELECT id FROM tenants WHERE slug LIKE 'onb-%'`)).map((r) => r.id);
  for (const id of ids) {
    for (const t of await db.transaction(async (tx) => tenantTablesInDeleteOrder(tx as never))) {
      await db.execute(sql.raw(`DELETE FROM "${t}" WHERE tenant_id = '${id}'`));
    }
    await db.execute(sql`DELETE FROM tenants WHERE id = ${id}::uuid`);
  }
}

const cookies = (t: Tenant) => ({ [SESSION_COOKIE_NAME]: t.session });
const get = (t: Tenant) => app.inject({ method: "GET", url: "/v1/onboarding", cookies: cookies(t) });
const patch = (t: Tenant, payload: unknown) => app.inject({ method: "PATCH", url: "/v1/onboarding", cookies: cookies(t), payload: payload as object });
const doneIds = (body: { steps: { id: string; done: boolean }[] }) => body.steps.filter((s) => s.done).map((s) => s.id);
const stored = async (id: string) => (await q<{ o: Record<string, string> | null }>(sql`SELECT settings->'onboarding' AS o FROM tenants WHERE id = ${id}::uuid`))[0]!.o;

/** Put one flow, one contact and one event into a workspace; optionally a sent message. */
async function addActivity(t: Tenant, what: { activeFlow?: boolean; event?: boolean; sent?: boolean; messageStatus?: string }): Promise<void> {
  const [f] = await q<{ id: string }>(sql`INSERT INTO flows (tenant_id, name, trigger_type, trigger_config, steps, status) VALUES (${t.id}::uuid, 'F', 'event', '{}'::jsonb, '[]'::jsonb, ${what.activeFlow === false ? "draft" : "active"}) RETURNING id`);
  const [c] = await q<{ id: string }>(sql`INSERT INTO contacts (tenant_id, external_id, email, lifecycle_state) VALUES (${t.id}::uuid, ${"c" + counter}, ${"c" + counter++ + "@people.example"}, 'engaged') RETURNING id`);
  if (what.event) await db.execute(sql`INSERT INTO events (tenant_id, contact_id, type, event_name, timestamp) VALUES (${t.id}::uuid, ${c!.id}::uuid, 'track', 'signed_up', now())`);
  if (what.sent || what.messageStatus) {
    const [m] = await q<{ id: string }>(sql`INSERT INTO flow_memberships (tenant_id, contact_id, flow_id, entered_at) VALUES (${t.id}::uuid, ${c!.id}::uuid, ${f!.id}::uuid, now()) RETURNING id`);
    await db.execute(sql`INSERT INTO lifecycle_messages (tenant_id, contact_id, flow_id, membership_id, status, subject, sent_at) VALUES (${t.id}::uuid, ${c!.id}::uuid, ${f!.id}::uuid, ${m!.id}::uuid, ${what.messageStatus ?? "sent"}, 'Hi', now())`);
  }
}

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: TEST_DB_URL, connectionTimeoutMillis: 3000 });
  try {
    await pool.query("SELECT 1");
    db = drizzle(pool);
    dbAvailable = true;
  } catch (err) {
    if (process.env.CI === "true") throw new Error(`[onboarding.test] DATABASE_URL not reachable in CI: ${(err as Error).message}`);
    console.warn("[onboarding.test] DATABASE_URL not reachable - tests skipped.");
    return;
  }
  await cleanup();
  app = await buildApp({ logger: false, db, baseUrl: "http://localhost:3000", dashboardUrl: "http://localhost:3000" });
});

beforeEach(() => {
  outbox.sent = [];
  outbox.mode = "ok";
});

afterEach(async () => {
  delete process.env.MAILFORGE_ENFORCE_PLANS;
  delete process.env.MAILFORGE_MANAGED_SHARED_FROM;
  if (dbAvailable) await cleanup();
});

afterAll(async () => {
  if (app) await app.close();
  await pool?.end();
});

const it_ = (name: string, fn: () => Promise<void>) => it(name, async () => (dbAvailable ? fn() : undefined));

// ---------------------------------------------------------------------------

describe("GET /v1/onboarding", () => {
  it_("needs a session", async () => {
    const r = await app.inject({ method: "GET", url: "/v1/onboarding" });
    expect(r.statusCode).toBe(401);
  });

  it_("starts a new workspace with one step done and the address next", async () => {
    const t = await newTenant();
    const r = await get(t);
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(doneIds(b)).toEqual(["workspace"]);
    expect(b.next).toBe("address");
    expect(b.done).toBe(1);
    expect(b.total).toBe(6);
    expect(b.complete).toBe(false);
    expect(b.dismissed).toBe(false);
    expect(b.has_ingest_key).toBe(false);
    expect(b.minutes_left).toBeGreaterThan(0);
  });

  it_("reports hosted only when plans are enforced", async () => {
    const t = await newTenant();
    expect((await get(t)).json().hosted).toBe(false);
    process.env.MAILFORGE_ENFORCE_PLANS = "true";
    expect((await get(t)).json().hosted).toBe(true);
  });

  it_("marks the address step from a saved postal address, and ignores a blank one", async () => {
    const t = await newTenant();
    await db.execute(sql`UPDATE tenants SET settings = settings || '{"postal_address":"   "}'::jsonb WHERE id = ${t.id}::uuid`);
    expect(doneIds((await get(t)).json())).toEqual(["workspace"]);
    await db.execute(sql`UPDATE tenants SET settings = settings || '{"postal_address":"1 Main St, Accra"}'::jsonb WHERE id = ${t.id}::uuid`);
    const b = (await get(t)).json();
    expect(doneIds(b)).toEqual(["workspace", "address"]);
    expect(b.next).toBe("sender");
  });

  it_("counts an own transport as a sender, but not an inactive one", async () => {
    const t = await newTenant();
    await db.execute(sql`INSERT INTO transport_configs (tenant_id, provider, config, is_active, from_email) VALUES (${t.id}::uuid, 'resend', '{}'::jsonb, false, 'a@b.example')`);
    expect(doneIds((await get(t)).json())).not.toContain("sender");
    await db.execute(sql`UPDATE transport_configs SET is_active = true WHERE tenant_id = ${t.id}::uuid`);
    expect(doneIds((await get(t)).json())).toContain("sender");
  });

  it_("counts Mailforge Sending as a sender only while switched on AND able to send", async () => {
    const t = await newTenant();
    process.env.MAILFORGE_MANAGED_SHARED_FROM = "hello@shared.example";
    await db.execute(sql`INSERT INTO managed_sending (tenant_id, enabled) VALUES (${t.id}::uuid, false)`);
    expect(doneIds((await get(t)).json())).not.toContain("sender");
    await db.execute(sql`UPDATE managed_sending SET enabled = true WHERE tenant_id = ${t.id}::uuid`);
    expect(doneIds((await get(t)).json())).toContain("sender");
  });

  it_("does not count Mailforge Sending that has nowhere to send from (no shared address, no verified domain)", async () => {
    const t = await newTenant();
    await db.execute(sql`INSERT INTO managed_sending (tenant_id, enabled) VALUES (${t.id}::uuid, true)`);
    expect(doneIds((await get(t)).json())).not.toContain("sender");
    await db.execute(sql`UPDATE managed_sending SET domain = 'mail.acme.example', domain_status = 'pending' WHERE tenant_id = ${t.id}::uuid`);
    expect(doneIds((await get(t)).json())).not.toContain("sender");
    await db.execute(sql`UPDATE managed_sending SET domain_status = 'verified' WHERE tenant_id = ${t.id}::uuid`);
    expect(doneIds((await get(t)).json())).toContain("sender");
  });

  it_("counts only an ACTIVE flow", async () => {
    const t = await newTenant();
    await addActivity(t, { activeFlow: false });
    expect(doneIds((await get(t)).json())).not.toContain("flow");
    await db.execute(sql`UPDATE flows SET status = 'active' WHERE tenant_id = ${t.id}::uuid`);
    expect(doneIds((await get(t)).json())).toContain("flow");
  });

  it_("counts a received event and a sent email, and sees an ingest key", async () => {
    const t = await newTenant();
    await db.execute(sql`INSERT INTO api_keys (tenant_id, key_hash, prefix, label) VALUES (${t.id}::uuid, ${createHash("sha256").update(randomBytes(8)).digest("hex")}, 'mf_live_', 'k')`);
    await addActivity(t, { event: true, sent: true });
    const b = (await get(t)).json();
    expect(b.has_ingest_key).toBe(true);
    expect(doneIds(b)).toEqual(expect.arrayContaining(["events", "email", "flow"]));
  });

  it_("ignores a revoked ingest key", async () => {
    const t = await newTenant();
    await db.execute(sql`INSERT INTO api_keys (tenant_id, key_hash, prefix, label, revoked_at) VALUES (${t.id}::uuid, ${createHash("sha256").update(randomBytes(8)).digest("hex")}, 'mf_live_', 'k', now())`);
    expect((await get(t)).json().has_ingest_key).toBe(false);
  });

  it_("never shows another workspace's progress, in either direction", async () => {
    const a = await newTenant();
    const b = await newTenant();
    await db.execute(sql`UPDATE tenants SET settings = settings || '{"postal_address":"x"}'::jsonb WHERE id = ${a.id}::uuid`);
    await addActivity(a, { event: true, sent: true });
    expect(doneIds((await get(b)).json())).toEqual(["workspace"]);
    expect(doneIds((await get(a)).json())).toEqual(expect.arrayContaining(["address", "flow", "events", "email"]));
  });

  it_("does not count an email that is queued, failed or pending as sent", async () => {
    for (const status of ["pending_approval", "approved", "failed", "suppressed"]) {
      const t = await newTenant();
      await addActivity(t, { messageStatus: status });
      expect(doneIds((await get(t)).json()), status).not.toContain("email");
    }
  });

  it_("records the completion date once, when hosted, and keeps it", async () => {
    const t = await newTenant();
    process.env.MAILFORGE_ENFORCE_PLANS = "true";
    process.env.MAILFORGE_MANAGED_SHARED_FROM = "hello@shared.example";
    await db.execute(sql`UPDATE tenants SET settings = settings || '{"postal_address":"x"}'::jsonb WHERE id = ${t.id}::uuid`);
    await db.execute(sql`INSERT INTO managed_sending (tenant_id, enabled) VALUES (${t.id}::uuid, true)`);
    await addActivity(t, { event: true, sent: true });
    const first = (await get(t)).json();
    expect(first.complete).toBe(true);
    expect(first.next).toBeNull();
    expect(first.completed_at).toBeTruthy();
    const date = first.completed_at;
    await new Promise((r) => setTimeout(r, 15));
    expect((await get(t)).json().completed_at).toBe(date);
  });

  it_("does not record a completion date on a self-hosted install", async () => {
    const t = await newTenant();
    process.env.MAILFORGE_MANAGED_SHARED_FROM = "hello@shared.example";
    await db.execute(sql`UPDATE tenants SET settings = settings || '{"postal_address":"x"}'::jsonb WHERE id = ${t.id}::uuid`);
    await db.execute(sql`INSERT INTO managed_sending (tenant_id, enabled) VALUES (${t.id}::uuid, true)`);
    await addActivity(t, { event: true, sent: true });
    const b = (await get(t)).json();
    expect(b.complete).toBe(true);
    expect(b.completed_at).toBeNull();
  });
});

describe("waiting email warning", () => {
  const queue = async (t: Tenant) => addActivity(t, { messageStatus: "approved" });
  const info = async (t: Tenant) => {
    const b = (await get(t)).json();
    return { n: b.waiting_emails, why: b.waiting_reason };
  };

  it_("is silent when nothing is waiting, even with no sender", async () => {
    const t = await newTenant();
    expect(await info(t)).toEqual({ n: 0, why: null });
  });

  it_("says there is no sender when mail is queued and nothing is set up", async () => {
    const t = await newTenant({});
    await queue(t);
    expect(await info(t)).toEqual({ n: 1, why: "no_sender" });
  });

  it_("says a domain is needed when Mailforge Sending is on with nowhere to send from", async () => {
    const t = await newTenant();
    await queue(t);
    await db.execute(sql`INSERT INTO managed_sending (tenant_id, enabled) VALUES (${t.id}::uuid, true)`);
    expect(await info(t)).toEqual({ n: 1, why: "needs_domain" });
  });

  it_("says paused when Mailforge Sending is paused", async () => {
    const t = await newTenant();
    process.env.MAILFORGE_MANAGED_SHARED_FROM = "hello@shared.example";
    await db.execute(sql`UPDATE tenants SET settings = settings || '{"postal_address":"x"}'::jsonb WHERE id = ${t.id}::uuid`);
    await queue(t);
    await db.execute(sql`INSERT INTO managed_sending (tenant_id, enabled, paused_at, paused_reason, paused_by) VALUES (${t.id}::uuid, true, now(), 'x', 'auto')`);
    expect(await info(t)).toEqual({ n: 1, why: "paused" });
  });

  it_("says the address is missing when the sender is fine", async () => {
    const t = await newTenant();
    await queue(t);
    await db.execute(sql`INSERT INTO transport_configs (tenant_id, provider, config, is_active, from_email) VALUES (${t.id}::uuid, 'resend', '{}'::jsonb, true, 'a@b.example')`);
    expect(await info(t)).toEqual({ n: 1, why: "no_address" });
  });

  it_("is silent when mail is queued but everything needed is in place", async () => {
    const t = await newTenant();
    await queue(t);
    await db.execute(sql`UPDATE tenants SET settings = settings || '{"postal_address":"x"}'::jsonb WHERE id = ${t.id}::uuid`);
    await db.execute(sql`INSERT INTO transport_configs (tenant_id, provider, config, is_active, from_email) VALUES (${t.id}::uuid, 'resend', '{}'::jsonb, true, 'a@b.example')`);
    expect(await info(t)).toEqual({ n: 1, why: null });
  });

  it_("counts only approved mail: not sent, failed or awaiting approval", async () => {
    const t = await newTenant();
    for (const st of ["sent", "failed", "pending_approval", "suppressed"]) await addActivity(t, { messageStatus: st });
    expect(await info(t)).toEqual({ n: 0, why: null });
  });

  it_("never counts another workspace's queued mail", async () => {
    const a = await newTenant();
    const b = await newTenant();
    await queue(a);
    expect((await info(b)).n).toBe(0);
    expect((await info(a)).n).toBe(1);
  });
});

describe("markOnboardingCompleted", () => {
  it_("sets the date once and refuses to move it", async () => {
    const t = await newTenant();
    expect(await markOnboardingCompleted(db as never, t.id, new Date("2026-10-01T00:00:00Z"))).toBe(true);
    expect(await markOnboardingCompleted(db as never, t.id, new Date("2026-10-09T00:00:00Z"))).toBe(false);
    expect((await stored(t.id))?.completed_at).toBe("2026-10-01T00:00:00.000Z");
  });

  it_("lets only one of several simultaneous callers set it", async () => {
    const t = await newTenant();
    const rs = await Promise.all([1, 2, 3, 4].map(() => markOnboardingCompleted(db as never, t.id)));
    expect(rs.filter(Boolean)).toHaveLength(1);
  });
});

describe("PATCH /v1/onboarding", () => {
  it_("dismisses and brings it back", async () => {
    const t = await newTenant();
    expect((await patch(t, { dismissed: true })).statusCode).toBe(200);
    expect((await get(t)).json().dismissed).toBe(true);
    expect((await patch(t, { dismissed: false })).statusCode).toBe(200);
    expect((await get(t)).json().dismissed).toBe(false);
    expect((await stored(t.id))?.dismissed_at).toBeUndefined();
  });

  it_("refuses a bad body and changes nothing", async () => {
    const t = await newTenant();
    for (const bad of [{}, { dismissed: "yes" }, { dismissed: 1 }, []]) {
      expect((await patch(t, bad)).statusCode).toBe(400);
    }
    expect((await get(t)).json().dismissed).toBe(false);
  });

  it_("keeps every other setting, including the signup record and the welcome mark", async () => {
    const t = await newTenant();
    await db.execute(sql`UPDATE tenants SET settings = settings || '{"postal_address":"keep me","onboarding":{"welcome_sent_at":"2026-10-05T00:00:00Z"}}'::jsonb WHERE id = ${t.id}::uuid`);
    await patch(t, { dismissed: true });
    const [row] = await q<{ s: Record<string, unknown> }>(sql`SELECT settings AS s FROM tenants WHERE id = ${t.id}::uuid`);
    expect(row!.s.postal_address).toBe("keep me");
    expect(row!.s.signup).toBeTruthy();
    expect((row!.s.onboarding as Record<string, string>).welcome_sent_at).toBe("2026-10-05T00:00:00Z");
    expect((row!.s.onboarding as Record<string, string>).dismissed_at).toBeTruthy();
  });

  it_("works on a workspace whose settings are empty", async () => {
    const t = await newTenant({ signup: false });
    await db.execute(sql`UPDATE tenants SET settings = NULL WHERE id = ${t.id}::uuid`);
    expect((await patch(t, { dismissed: true })).statusCode).toBe(200);
    expect((await get(t)).json().dismissed).toBe(true);
  });
});

describe("welcome email", () => {
  it_("sends once to the signed-in user, from the platform sender, and marks it", async () => {
    const t = await newTenant();
    const r = await sendWelcomeEmailOnce(db as never, t.id, t.userId, { dashboardUrl: "https://app.example.com", transport: platform() });
    expect(r).toBe("sent");
    expect(outbox.sent).toHaveLength(1);
    const m = outbox.sent[0]!;
    expect(m.to).toBe(t.email);
    expect(m.from).toBe("no-reply@platform.example");
    expect(m.subject).toMatch(/^Welcome to Mailforge/);
    expect(m.bodyHtml).toContain("https://app.example.com");
    expect(m.bodyText).toContain("https://app.example.com");
    expect((await stored(t.id))?.welcome_sent_at).toBeTruthy();
  });

  it_("does not send a second time", async () => {
    const t = await newTenant();
    const o = { dashboardUrl: "https://app.example.com", transport: platform() };
    expect(await sendWelcomeEmailOnce(db as never, t.id, t.userId, o)).toBe("sent");
    expect(await sendWelcomeEmailOnce(db as never, t.id, t.userId, o)).toBe("skipped");
    expect(outbox.sent).toHaveLength(1);
  });

  it_("sends exactly one when two sign-ins race", async () => {
    const t = await newTenant();
    const o = { dashboardUrl: "https://app.example.com", transport: platform() };
    const rs = await Promise.all([1, 2, 3, 4].map(() => sendWelcomeEmailOnce(db as never, t.id, t.userId, o)));
    expect(rs.filter((x) => x === "sent")).toHaveLength(1);
    expect(outbox.sent).toHaveLength(1);
  });

  it_("never goes to a workspace that did not come through signup", async () => {
    const t = await newTenant({ signup: false });
    expect(await sendWelcomeEmailOnce(db as never, t.id, t.userId, { dashboardUrl: "https://x.example", transport: platform() })).toBe("skipped");
    expect(outbox.sent).toHaveLength(0);
    expect(await stored(t.id)).toBeNull();
  });

  it_("sends nothing and claims nothing when there is no platform sender", async () => {
    const t = await newTenant();
    expect(await sendWelcomeEmailOnce(db as never, t.id, t.userId, { dashboardUrl: "https://x.example", transport: null })).toBe("skipped");
    expect(await stored(t.id)).toBeNull();
  });

  it_("gives the claim back when delivery is refused, so the next sign-in retries", async () => {
    const t = await newTenant();
    const o = { dashboardUrl: "https://x.example", transport: platform() };
    outbox.mode = "fail";
    expect(await sendWelcomeEmailOnce(db as never, t.id, t.userId, o)).toBe("failed");
    expect((await stored(t.id))?.welcome_sent_at).toBeUndefined();
    outbox.mode = "ok";
    expect(await sendWelcomeEmailOnce(db as never, t.id, t.userId, o)).toBe("sent");
  });

  it_("gives the claim back and does not throw when the sender throws", async () => {
    const t = await newTenant();
    outbox.mode = "throw";
    expect(await sendWelcomeEmailOnce(db as never, t.id, t.userId, { dashboardUrl: "https://x.example", transport: platform() })).toBe("failed");
    expect((await stored(t.id))?.welcome_sent_at).toBeUndefined();
  });

  it_("keeps the dismissed mark when it releases a claim", async () => {
    const t = await newTenant();
    await patch(t, { dismissed: true });
    outbox.mode = "fail";
    await sendWelcomeEmailOnce(db as never, t.id, t.userId, { dashboardUrl: "https://x.example", transport: platform() });
    expect((await stored(t.id))?.dismissed_at).toBeTruthy();
  });

  it_("skips (and releases) when the user no longer exists", async () => {
    const t = await newTenant();
    const r = await sendWelcomeEmailOnce(db as never, t.id, "00000000-0000-0000-0000-000000000000", { dashboardUrl: "https://x.example", transport: platform() });
    expect(r).toBe("skipped");
    expect(outbox.sent).toHaveLength(0);
    expect((await stored(t.id))?.welcome_sent_at).toBeUndefined();
  });
});

describe("welcome email content", () => {
  const base = { brand: {}, tenantName: "Acme", dashboardUrl: "https://app.example.com", supportEmail: "help@example.com" };

  it("states the days left on the trial", () => {
    const m = buildWelcomeEmail({ ...base, trialDaysLeft: 14 });
    expect(m.text).toContain("14 more days");
    expect(m.html).toContain("14 more days");
    expect(buildWelcomeEmail({ ...base, trialDaysLeft: 1 }).text).toContain("1 more day.");
  });

  it("says nothing about a trial when there is none or it ended", () => {
    for (const d of [null, 0]) expect(buildWelcomeEmail({ ...base, trialDaysLeft: d }).text).not.toMatch(/trial/i);
  });

  it("lists the three first steps and the support address", () => {
    const m = buildWelcomeEmail({ ...base, trialDaysLeft: 14 });
    for (const s of ["business address", "how email is sent", "Welcome flow"]) expect(m.text).toContain(s);
    expect(m.text).toContain("help@example.com");
  });

  it("leaves out the support line when none is configured", () => {
    expect(buildWelcomeEmail({ ...base, supportEmail: null, trialDaysLeft: 14 }).text).not.toContain("Stuck on anything");
  });

  it("escapes a hostile workspace name and URL in the HTML", () => {
    const m = buildWelcomeEmail({ ...base, tenantName: "<script>alert(1)</script>", dashboardUrl: 'https://x.example/"onmouseover="x', trialDaysLeft: 3 });
    expect(m.html).not.toContain("<script>alert(1)</script>");
    expect(m.html).not.toContain('"onmouseover="x');
  });

  it("carries no sign-in token and no unsubscribe link: it is transactional", () => {
    const m = buildWelcomeEmail({ ...base, trialDaysLeft: 14 });
    expect(m.html).not.toMatch(/token=/);
    expect(m.html.toLowerCase()).not.toContain("unsubscribe");
  });
});

describe("goal and suggestion", () => {
  const withGoal = async (goal: string | null, businessModel: string | null = null) => {
    const t = await newTenant();
    if (goal) await db.execute(sql`UPDATE tenants SET settings = jsonb_set(settings, '{signup,goal}', ${JSON.stringify(goal)}::jsonb) WHERE id = ${t.id}::uuid`);
    if (businessModel) await db.execute(sql`UPDATE tenants SET business_model = ${businessModel} WHERE id = ${t.id}::uuid`);
    return (await get(t)).json();
  };

  it_("suggests the trial flows for a trial goal", async () => {
    const b = await withGoal("convert_trials");
    expect(b.goal).toBe("convert_trials");
    expect(b.goal_suggestion).toMatchObject({ template_id: "time_limited_trial", name: "Time-Limited Trial", applied: false });
    expect(b.goal_suggestion.flow_count).toBeGreaterThan(0);
  });
  it_("suggests freemium flows for a free-plan goal", async () => {
    const b = await withGoal("upgrade_free");
    expect(b.goal_suggestion).toMatchObject({ template_id: "freemium", applied: false });
  });
  it_("suggests nothing extra for welcome, explore or no goal", async () => {
    for (const g of ["welcome", "explore", null]) {
      const b = await withGoal(g);
      expect(b.goal_suggestion, String(g)).toBeNull();
      expect(b.goal).toBe(g);
    }
  });
  it_("marks the suggestion applied once any template has been applied", async () => {
    expect((await withGoal("convert_trials", "freemium")).goal_suggestion.applied).toBe(true);
  });
  it_("ignores a goal value we do not know", async () => {
    const b = await withGoal("hacked");
    expect(b.goal).toBeNull();
    expect(b.goal_suggestion).toBeNull();
  });
});

describe("POST /v1/onboarding/sample-event", () => {
  const sample = (t: Tenant, payload: unknown = {}) =>
    app.inject({ method: "POST", url: "/v1/onboarding/sample-event", cookies: cookies(t), payload: payload as object });
  const contacts = (t: Tenant) =>
    q<{ external_id: string; email: string | null; properties: Record<string, unknown> | null }>(sql`SELECT external_id, email, properties FROM contacts WHERE tenant_id = ${t.id}::uuid`);
  const eventNames = async (t: Tenant) =>
    (await q<{ type: string; event_name: string | null }>(sql`SELECT type, event_name FROM events WHERE tenant_id = ${t.id}::uuid ORDER BY timestamp, id`)).map((e) => `${e.type}:${e.event_name ?? ""}`);

  it_("needs a session", async () => {
    const r = await app.inject({ method: "POST", url: "/v1/onboarding/sample-event", payload: {} });
    expect(r.statusCode).toBe(401);
  });

  it_("records a signed_up event for the caller's own address, with no API key", async () => {
    const t = await newTenant();
    expect((await q(sql`SELECT 1 FROM api_keys WHERE tenant_id = ${t.id}::uuid`)).length).toBe(0);
    const r = await sample(t);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ ok: true, sent_to: t.email, repeat: false });
    const c = await contacts(t);
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ external_id: "sample-event-user", email: t.email });
    expect(await eventNames(t)).toEqual(["identify:", "track:signed_up"]);
  });

  it_("marks the sample as a sample on the event", async () => {
    const t = await newTenant();
    await sample(t);
    const [e] = await q<{ properties: Record<string, unknown> }>(sql`SELECT properties FROM events WHERE tenant_id = ${t.id}::uuid AND event_name = 'signed_up'`);
    expect(e!.properties).toEqual({ sample: true });
  });

  it_("completes the first-event step", async () => {
    const t = await newTenant();
    expect(doneIds((await get(t)).json())).not.toContain("events");
    await sample(t);
    expect(doneIds((await get(t)).json())).toContain("events");
  });

  it_("can never be pointed at someone else's address", async () => {
    const t = await newTenant();
    const r = await sample(t, { email: "victim@elsewhere.example", userId: "someone-else", to: "victim@elsewhere.example" });
    expect(r.json().sent_to).toBe(t.email);
    const c = await contacts(t);
    expect(c.map((x) => x.email)).toEqual([t.email]);
    expect(c.map((x) => x.external_id)).toEqual(["sample-event-user"]);
  });

  it_("uses the owner's first name when there is one", async () => {
    const t = await newTenant();
    await db.execute(sql`UPDATE users SET name = 'Ama Boateng' WHERE id = ${t.userId}::uuid`);
    await sample(t);
    expect((await contacts(t))[0]!.properties).toMatchObject({ first_name: "Ama" });
  });

  it_("reuses the one contact on repeats and says it is a repeat", async () => {
    const t = await newTenant();
    await sample(t);
    const r = await sample(t);
    expect(r.json().repeat).toBe(true);
    expect(await contacts(t)).toHaveLength(1);
    expect((await eventNames(t)).filter((e) => e === "track:signed_up")).toHaveLength(2);
  });

  it_("reports whether a flow is active and whether mail can go out", async () => {
    const t = await newTenant();
    expect(await sample(t).then((r) => r.json())).toMatchObject({ flow_active: false, sender_ready: false });
    const t2 = await newTenant();
    await db.execute(sql`INSERT INTO flows (tenant_id, name, trigger_type, trigger_config, steps, status) VALUES (${t2.id}::uuid, 'F', 'event', '{}'::jsonb, '[]'::jsonb, 'active')`);
    await db.execute(sql`INSERT INTO transport_configs (tenant_id, provider, config, is_active, from_email) VALUES (${t2.id}::uuid, 'resend', '{}'::jsonb, true, 'a@b.example')`);
    expect(await sample(t2).then((r) => r.json())).toMatchObject({ flow_active: true, sender_ready: true });
  });

  it_("allows five an hour per workspace, then answers 429 with a wait", async () => {
    const t = await newTenant();
    for (let i = 0; i < 5; i++) expect((await sample(t)).statusCode).toBe(200);
    const r = await sample(t);
    expect(r.statusCode).toBe(429);
    expect(Number(r.headers["retry-after"])).toBeGreaterThan(0);
    const other = await newTenant();
    expect((await sample(other)).statusCode).toBe(200);
  });

  it_("answers 402 at the contact limit instead of adding a contact", async () => {
    const t = await newTenant();
    process.env.MAILFORGE_ENFORCE_PLANS = "true";
    await db.execute(sql`UPDATE tenants SET plan = 'free', trial_ends_at = NULL WHERE id = ${t.id}::uuid`);
    await db.execute(sql`INSERT INTO contacts (tenant_id, external_id, lifecycle_state) SELECT ${t.id}::uuid, 'bulk-' || g, 'engaged' FROM generate_series(1, 500) g`);
    const r = await sample(t);
    expect(r.statusCode).toBe(402);
    expect(r.json()).toMatchObject({ code: "plan_limit", limit_kind: "contacts" });
    expect((await contacts(t)).some((c) => c.external_id === "sample-event-user")).toBe(false);
  });

  it_("keeps each workspace's sample to itself", async () => {
    const a = await newTenant();
    const b = await newTenant();
    await sample(a);
    expect(await contacts(b)).toHaveLength(0);
  });
});

describe("goal-specific welcome email", () => {
  const base = { brand: {}, tenantName: "Acme", dashboardUrl: "https://app.example.com", supportEmail: "help@example.com", trialDaysLeft: 14 };
  const names = (id: "time_limited_trial" | "freemium") => BUSINESS_MODEL_TEMPLATES[id].flows.map((f) => f.name);

  it("says nothing goal-specific for explore, no goal, or an unknown goal", () => {
    for (const goal of ["explore", null, undefined, "hacked" as never]) {
      const m = buildWelcomeEmail({ ...base, goal });
      expect(m.text, String(goal)).not.toContain("You said");
      expect(m.text, String(goal)).not.toContain("After that");
    }
  });

  it("welcome goal: reflects it back and points at the Welcome flow, with no extra template", () => {
    const m = buildWelcomeEmail({ ...base, goal: "welcome" });
    expect(m.text).toContain("You said you want to welcome new signups");
    expect(m.html).toContain("You said you want to welcome new signups");
    expect(m.text).not.toContain("After that");
  });

  it("trial goal: names every real trial flow and says they are drafts", () => {
    const m = buildWelcomeEmail({ ...base, goal: "convert_trials" });
    expect(m.text).toContain("You said you want to turn trial users into paying customers");
    expect(m.text).toContain("After that.");
    for (const n of names("time_limited_trial")) {
      expect(m.text).toContain(n);
      expect(m.html).toContain(n.replace(/&/g, "&amp;"));
    }
    expect(m.text).toContain("drafts");
    expect(m.text).toContain("nothing sends until you switch each one on");
  });

  it("free-plan goal: names the real freemium flows, not the trial ones", () => {
    const m = buildWelcomeEmail({ ...base, goal: "upgrade_free" });
    expect(m.text).toContain("You said you want to move free users to a paid plan");
    for (const n of names("freemium")) expect(m.text).toContain(n);
    for (const n of names("time_limited_trial").filter((x) => !names("freemium").includes(x))) expect(m.text).not.toContain(n);
  });

  it("keeps the three steps, the button, the support line and the subject for every goal", () => {
    for (const goal of [...ONBOARDING_GOALS, null]) {
      const m = buildWelcomeEmail({ ...base, goal });
      for (const s of ["business address", "how email is sent", "Welcome flow"]) expect(m.text, `${goal}`).toContain(s);
      expect(m.html).toContain("Open your workspace");
      expect(m.text).toContain("help@example.com");
      expect(m.subject).toBe("Welcome to Mailforge: your first email in 20 minutes");
    }
  });

  it("goalWelcome only promises flows from a template that exists", () => {
    for (const g of ONBOARDING_GOALS) {
      const w = goalWelcome(g);
      if (w?.next) expect(w.next).toMatch(/Home page: .+\. They are created as drafts/);
    }
  });

  it("is still transactional: no token, no unsubscribe link", () => {
    const m = buildWelcomeEmail({ ...base, goal: "convert_trials" });
    expect(m.html).not.toMatch(/token=/);
    expect(m.html.toLowerCase()).not.toContain("unsubscribe");
  });

  it_("is sent with the goal the workspace chose at signup", async () => {
    const t = await newTenant({ goal: "convert_trials" });
    expect(await sendWelcomeEmailOnce(db as never, t.id, t.userId, { dashboardUrl: "https://x.example", transport: platform() })).toBe("sent");
    const m = outbox.sent[0]!;
    expect(m.bodyText).toContain("turn trial users into paying customers");
    expect(m.bodyHtml).toContain("After that.");
  });

  it_("sends the general welcome when no goal was chosen", async () => {
    const t = await newTenant();
    await sendWelcomeEmailOnce(db as never, t.id, t.userId, { dashboardUrl: "https://x.example", transport: platform() });
    expect(outbox.sent[0]!.bodyText).not.toContain("You said");
  });

  it_("ignores a goal value in the database that we do not know", async () => {
    const t = await newTenant({ goal: "<script>alert(1)</script>" });
    await sendWelcomeEmailOnce(db as never, t.id, t.userId, { dashboardUrl: "https://x.example", transport: platform() });
    const m = outbox.sent[0]!;
    expect(m.bodyText).not.toContain("You said");
    expect(m.bodyHtml).not.toContain("<script>alert(1)</script>");
  });

  it_("sends the right goal to each of two workspaces", async () => {
    const a = await newTenant({ goal: "welcome" });
    const b = await newTenant({ goal: "upgrade_free" });
    await sendWelcomeEmailOnce(db as never, a.id, a.userId, { dashboardUrl: "https://x.example", transport: platform() });
    await sendWelcomeEmailOnce(db as never, b.id, b.userId, { dashboardUrl: "https://x.example", transport: platform() });
    expect(outbox.sent.find((m) => m.to === a.email)!.bodyText).toContain("welcome new signups");
    expect(outbox.sent.find((m) => m.to === b.email)!.bodyText).toContain("move free users to a paid plan");
  });
});
