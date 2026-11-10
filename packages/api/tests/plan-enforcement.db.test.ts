/**
 * Integration tests for plan enforcement in the API: contact limits on ingest,
 * seat limits on invitations, trial handling, and GET /v1/plan.
 *
 * Needs a reachable Postgres via DATABASE_URL, like the other *.db tests.
 * Every tenant created here has a slug starting with "plan-enf-".
 */
import { createHash, randomBytes } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import { SESSION_COOKIE_NAME } from "../src/routes/auth.js";

const TEST_DB_URL = process.env.DATABASE_URL;
if (!TEST_DB_URL) throw new Error("[plan-enforcement.test] DATABASE_URL is not set.");

const DAY = 86_400_000;
let pool: pg.Pool;
let db: ReturnType<typeof drizzle>;
let dbAvailable = false;
let app: FastifyInstance;

interface Tenant {
  id: string;
  key: string;
  ownerId: string;
  session: string;
}

async function q<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  return (await db.execute(query)).rows as T[];
}

let counter = 0;
async function newTenant(plan: string, opts: { trialEndsAt?: Date | null; contacts?: number } = {}): Promise<Tenant> {
  const slug = `plan-enf-${Date.now()}-${counter++}`;
  const [t] = await q<{ id: string }>(
    sql`INSERT INTO tenants (name, slug, plan, trial_ends_at) VALUES (${slug}, ${slug}, ${plan}, ${opts.trialEndsAt ?? null}) RETURNING id`,
  );
  const id = t!.id;
  const [u] = await q<{ id: string }>(
    sql`INSERT INTO users (tenant_id, email, role) VALUES (${id}::uuid, ${slug + "@plan-enf.example"}, 'owner') RETURNING id`,
  );
  const [s] = await q<{ id: string }>(
    sql`INSERT INTO sessions (tenant_id, user_id, expires_at) VALUES (${id}::uuid, ${u!.id}::uuid, now() + interval '1 day') RETURNING id`,
  );
  const key = `mf_live_${randomBytes(24).toString("base64url")}`;
  await db.execute(sql`
    INSERT INTO api_keys (tenant_id, key_hash, prefix, label)
    VALUES (${id}::uuid, ${createHash("sha256").update(key).digest("hex")}, ${key.slice(0, 8)}, 'plan test')`);
  if (opts.contacts) await fillContacts(id, opts.contacts);
  return { id, key, ownerId: u!.id, session: s!.id };
}

async function fillContacts(tenantId: string, n: number): Promise<void> {
  await db.execute(sql`
    INSERT INTO contacts (tenant_id, external_id, lifecycle_state, first_seen_at, last_seen_at)
    SELECT ${tenantId}::uuid, 'seed-' || g, 'signed_up', now(), now() FROM generate_series(1, ${n}) g`);
}

async function contactCount(tenantId: string): Promise<number> {
  const [r] = await q<{ n: string }>(sql`SELECT count(*)::text AS n FROM contacts WHERE tenant_id = ${tenantId}::uuid`);
  return Number(r!.n);
}

async function cleanup(): Promise<void> {
  const ids = (await q<{ id: string }>(sql`SELECT id FROM tenants WHERE slug LIKE 'plan-enf-%'`)).map((r) => r.id);
  for (const id of ids) {
    // Children before parents: messages -> memberships -> flows, then contact data, then the account tables.
    for (const t of ["lifecycle_messages", "flow_memberships", "flows", "lifecycle_transitions", "events", "contact_conflicts", "contacts", "invites", "api_keys", "magic_link_tokens", "sessions", "users"]) {
      await db.execute(sql.raw(`DELETE FROM ${t} WHERE tenant_id = '${id}'`));
    }
    await db.execute(sql`DELETE FROM tenants WHERE id = ${id}::uuid`);
  }
}

const track = (t: Tenant, userId: string, extra: Record<string, unknown> = {}) =>
  app.inject({
    method: "POST",
    url: "/v1/track",
    headers: { authorization: `Bearer ${t.key}`, "content-type": "application/json" },
    payload: JSON.stringify({ userId, event: "something_happened", ...extra }),
  });

const identify = (t: Tenant, userId: string, traits: Record<string, unknown> = {}) =>
  app.inject({
    method: "POST",
    url: "/v1/identify",
    headers: { authorization: `Bearer ${t.key}`, "content-type": "application/json" },
    payload: JSON.stringify({ userId, traits }),
  });

const batch = (t: Tenant, items: unknown[]) =>
  app.inject({
    method: "POST",
    url: "/v1/batch",
    headers: { authorization: `Bearer ${t.key}`, "content-type": "application/json" },
    payload: JSON.stringify({ batch: items }),
  });

const asOwner = (t: Tenant) => ({ [SESSION_COOKIE_NAME]: t.session });
const invite = (t: Tenant, email: string) =>
  app.inject({ method: "POST", url: "/v1/team/invites", cookies: asOwner(t), payload: { email } });
const planOf = async (t: Tenant) =>
  (await app.inject({ method: "GET", url: "/v1/plan", cookies: asOwner(t) })).json();

function enforce(on: boolean): void {
  if (on) process.env.LOOMAIL_ENFORCE_PLANS = "true";
  else delete process.env.LOOMAIL_ENFORCE_PLANS;
}

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: TEST_DB_URL, connectionTimeoutMillis: 3000 });
  try {
    await pool.query("SELECT 1");
    db = drizzle(pool);
    dbAvailable = true;
  } catch (err) {
    if (process.env.CI === "true") throw new Error(`[plan-enforcement.test] DATABASE_URL not reachable in CI: ${(err as Error).message}`);
    console.warn("[plan-enforcement.test] DATABASE_URL not reachable - tests skipped.");
    return;
  }
  await cleanup();
  app = await buildApp({ logger: false, db, baseUrl: "http://localhost:3000", dashboardUrl: "http://localhost:3000" });
});

afterEach(async () => {
  enforce(false);
  if (dbAvailable) await cleanup();
});

afterAll(async () => {
  if (app) await app.close();
  await pool?.end();
});

// ---------------------------------------------------------------------------

describe("enforcement off (self-hosted default)", () => {
  it("a tenant with no plan, past any limit, can still add contacts and invite people when enforcement is off", async () => {
    if (!dbAvailable) return;
    enforce(false);
    const t = await newTenant("free", { contacts: 500 });
    expect((await track(t, "brand-new-user")).statusCode).toBe(200);
    expect(await contactCount(t.id)).toBe(501);
    expect((await invite(t, "someone@plan-enf.example")).statusCode).toBe(200);
  });

  it("GET /v1/plan reports not enforced, with no limits", async () => {
    if (!dbAvailable) return;
    const t = await newTenant("free", { contacts: 10 });
    const p = await planOf(t);
    expect(p.enforced).toBe(false);
    expect(p.meters.contacts).toEqual({ used: 10, limit: null, state: "unlimited" });
    expect(p.meters.seats.limit).toBeNull();
    expect(p.shows_powered_by).toBe(false);
  });
});

describe("contact limit on ingest (enforcement on)", () => {
  // The lifetime plan (1,000 customer profiles) is the cheap stand-in for "a plan with a limit to fill".
  it("lets a workspace reach exactly its limit, then refuses the next with a 402", async () => {
    if (!dbAvailable) return;
    enforce(true);
    const t = await newTenant("lifetime_1", { contacts: 998 });

    expect((await track(t, "n1")).statusCode).toBe(200); // 999
    expect((await track(t, "n2")).statusCode).toBe(200); // 1,000 (exactly the limit)
    expect(await contactCount(t.id)).toBe(1000);

    const refused = await track(t, "n3");
    expect(refused.statusCode).toBe(402);
    expect(refused.json()).toEqual({
      error: "Your Lifetime plan allows up to 1,000 customer profiles. Buy extra usage in Settings, under Plan, to add more.",
      code: "plan_limit",
      limit_kind: "contacts",
      limit: 1000,
      used: 1000,
      plan: "lifetime_1",
    });
    expect(await contactCount(t.id)).toBe(1000); // nothing was created
  });

  it("a workspace with no plan (trial over, nothing bought) can add nobody, with a message that says why", async () => {
    if (!dbAvailable) return;
    enforce(true);
    const t = await newTenant("free");
    const refused = await track(t, "first");
    expect(refused.statusCode).toBe(402);
    expect(refused.json()).toMatchObject({
      error: "Your free trial has ended. Subscribe to Essential to keep going. Your data is safe.",
      code: "plan_limit",
      limit: 0,
      used: 0,
      plan: "free",
    });
    expect(await contactCount(t.id)).toBe(0);
  });

  it("existing contacts keep working at the limit: events are still recorded", async () => {
    if (!dbAvailable) return;
    enforce(true);
    const t = await newTenant("lifetime_1", { contacts: 1000 });
    const res = await track(t, "seed-7", { event: "still_active" });
    expect(res.statusCode).toBe(200);
    const [e] = await q<{ n: string }>(
      sql`SELECT count(*)::text AS n FROM events WHERE tenant_id = ${t.id}::uuid AND event_name = 'still_active'`,
    );
    expect(e!.n).toBe("1");
    expect(await contactCount(t.id)).toBe(1000);
  });

  it("identify: a new contact is refused, an existing one can still be updated", async () => {
    if (!dbAvailable) return;
    enforce(true);
    const t = await newTenant("lifetime_1", { contacts: 1000 });
    const refused = await identify(t, "brand-new", { name: "Nobody" });
    expect(refused.statusCode).toBe(402);
    expect(refused.json().limit_kind).toBe("contacts");

    const ok = await identify(t, "seed-3", { name: "Ama Mensah" });
    expect(ok.statusCode).toBe(200);
    const [c] = await q<{ name: string }>(
      sql`SELECT name FROM contacts WHERE tenant_id = ${t.id}::uuid AND external_id = 'seed-3'`,
    );
    expect(c!.name).toBe("Ama Mensah");
  });

  it("batch: items for existing contacts and up to the limit succeed, the rest report plan_limit", async () => {
    if (!dbAvailable) return;
    enforce(true);
    const t = await newTenant("lifetime_1", { contacts: 999 });
    const res = await batch(t, [
      { type: "track", userId: "seed-1", event: "e" }, // existing
      { type: "track", userId: "fresh-a", event: "e" }, // 1,000th: allowed
      { type: "track", userId: "fresh-b", event: "e" }, // 1,001st: refused
      { type: "identify", userId: "fresh-c", traits: { name: "C" } }, // refused
    ]);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.received).toBe(2);
    expect(body.errors).toHaveLength(2);
    expect(body.errors.map((e: { index: number }) => e.index)).toEqual([2, 3]);
    for (const e of body.errors) {
      expect(e.code).toBe("plan_limit");
      expect(e.message).toContain("1,000 customer profiles");
    }
    expect(await contactCount(t.id)).toBe(1000);
  });

  it("a refused event leaves no trace, so retrying the same messageId after an upgrade works", async () => {
    if (!dbAvailable) return;
    enforce(true);
    const t = await newTenant("lifetime_1", { contacts: 1000 });
    const refused = await track(t, "late-joiner", { messageId: "retry-me-1" });
    expect(refused.statusCode).toBe(402);

    await db.execute(sql`UPDATE tenants SET plan = 'essential' WHERE id = ${t.id}::uuid`);
    const retry = await track(t, "late-joiner", { messageId: "retry-me-1" });
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toEqual({ success: true, deduplicated: false }); // not treated as a duplicate
    expect(await contactCount(t.id)).toBe(1001);
  });

  it("a running trial is limited like Essential (6,000), not like No plan (0)", async () => {
    if (!dbAvailable) return;
    enforce(true);
    const t = await newTenant("trial", { trialEndsAt: new Date(Date.now() + 5 * DAY), contacts: 600 });
    expect((await track(t, "trial-new")).statusCode).toBe(200);
  });

  it("the moment a trial ends the tenant has No plan: new contacts are refused, existing data stays", async () => {
    if (!dbAvailable) return;
    enforce(true);
    const t = await newTenant("trial", { trialEndsAt: new Date(Date.now() + 5 * DAY), contacts: 600 });
    expect((await track(t, "before-expiry")).statusCode).toBe(200);

    await db.execute(sql`UPDATE tenants SET trial_ends_at = now() - interval '1 second' WHERE id = ${t.id}::uuid`);
    const refused = await track(t, "after-expiry");
    expect(refused.statusCode).toBe(402);
    expect(refused.json().plan).toBe("free");
    expect(refused.json().limit).toBe(0);
    expect(refused.json().used).toBe(601); // 600 seeded + 1; nothing deleted, and over the No-plan limit
    expect(await contactCount(t.id)).toBe(601);
    // The people already there are still served.
    expect((await track(t, "seed-1")).statusCode).toBe(200);
  });

  it("a paid plan is limited at its own number, not at No plan's", async () => {
    if (!dbAvailable) return;
    enforce(true);
    const t = await newTenant("essential", { contacts: 5999 });
    expect((await track(t, "essential-last")).statusCode).toBe(200); // 6,000
    const refused = await track(t, "essential-over");
    expect(refused.statusCode).toBe(402);
    expect(refused.json()).toMatchObject({ plan: "essential", limit: 6000, used: 6000 });
  });

  it("an unknown stored plan is treated as No plan", async () => {
    if (!dbAvailable) return;
    enforce(true);
    const t = await newTenant("enterprise-legacy", { contacts: 5 });
    const refused = await track(t, "x");
    expect(refused.statusCode).toBe(402);
    expect(refused.json().plan).toBe("free");
  });

  it("one tenant's contacts never count against another's", async () => {
    if (!dbAvailable) return;
    enforce(true);
    const full = await newTenant("lifetime_1", { contacts: 1000 });
    const empty = await newTenant("lifetime_1");
    expect((await track(full, "x")).statusCode).toBe(402);
    expect((await track(empty, "x")).statusCode).toBe(200);
  });
});

describe("seat limit on invitations (enforcement on)", () => {
  it("No plan has one seat: the owner fills it, so inviting is refused with a 402", async () => {
    if (!dbAvailable) return;
    enforce(true);
    const t = await newTenant("free");
    const res = await invite(t, "teammate@plan-enf.example");
    expect(res.statusCode).toBe(402);
    expect(res.json()).toMatchObject({ code: "plan_limit", limit_kind: "seats", limit: 1, used: 1, plan: "free" });
    const [n] = await q<{ n: string }>(sql`SELECT count(*)::text AS n FROM invites WHERE tenant_id = ${t.id}::uuid`);
    expect(n!.n).toBe("0");
  });

  it("pending invitations hold a seat, so a second invite on a 2-seat plan with one member is one too many", async () => {
    if (!dbAvailable) return;
    enforce(true);
    const t = await newTenant("lifetime_1"); // 2 seats; the owner holds one
    // One invite takes the second seat...
    expect((await invite(t, "first@plan-enf.example")).statusCode).toBe(200);
    // ...so the next is refused, even though nobody has accepted yet.
    const second = await invite(t, "second@plan-enf.example");
    expect(second.statusCode).toBe(402);
    expect(second.json()).toMatchObject({ limit: 2, used: 2, plan: "lifetime_1" });
  });

  it("revoking an invitation frees the seat", async () => {
    if (!dbAvailable) return;
    enforce(true);
    const t = await newTenant("lifetime_1");
    await invite(t, "first@plan-enf.example");
    expect((await invite(t, "again@plan-enf.example")).statusCode).toBe(402);

    const [inv] = await q<{ id: string }>(sql`SELECT id FROM invites WHERE tenant_id = ${t.id}::uuid LIMIT 1`);
    const del = await app.inject({ method: "DELETE", url: `/v1/team/invites/${inv!.id}`, cookies: asOwner(t) });
    expect(del.statusCode).toBeLessThan(300);
    expect((await invite(t, "again@plan-enf.example")).statusCode).toBe(200);
  });

  it("deactivated members and expired invitations do not hold a seat", async () => {
    if (!dbAvailable) return;
    enforce(true);
    const t = await newTenant("lifetime_1");
    await db.execute(sql`INSERT INTO users (tenant_id, email, role, deactivated_at) VALUES (${t.id}::uuid, 'gone@plan-enf.example', 'member', now())`);
    await db.execute(sql`
      INSERT INTO invites (tenant_id, email, role, token_hash, invited_by, expires_at)
      VALUES (${t.id}::uuid, 'stale@plan-enf.example', 'member', 'h', ${t.ownerId}::uuid, now() - interval '1 day')`);
    // Only the owner holds a seat, so exactly one more invitation fits in 2.
    expect((await invite(t, "a@plan-enf.example")).statusCode).toBe(200);
    expect((await invite(t, "b@plan-enf.example")).statusCode).toBe(402);
  });

  it("an unlimited-seat plan (Essential) never refuses", async () => {
    if (!dbAvailable) return;
    enforce(true);
    const t = await newTenant("essential");
    for (let i = 0; i < 4; i++) expect((await invite(t, `p${i}@plan-enf.example`)).statusCode).toBe(200);
  });

  it("a member already on the team cannot be invited again (existing check still wins)", async () => {
    if (!dbAvailable) return;
    enforce(true);
    const t = await newTenant("free");
    const res = await invite(t, `${(await q<{ email: string }>(sql`SELECT email FROM users WHERE id = ${t.ownerId}::uuid`))[0]!.email}`);
    expect(res.statusCode).toBe(409);
  });
});

describe("GET /v1/plan", () => {
  it("requires a signed-in session", async () => {
    if (!dbAvailable) return;
    const res = await app.inject({ method: "GET", url: "/v1/plan" });
    expect(res.statusCode).toBe(401);
  });

  it("describes a running trial", async () => {
    if (!dbAvailable) return;
    enforce(true);
    const t = await newTenant("trial", { trialEndsAt: new Date(Date.now() + 9 * DAY - 3_600_000), contacts: 100 });
    const p = await planOf(t);
    expect(p.enforced).toBe(true);
    expect(p.plan).toMatchObject({ id: "essential", name: "Essential" });
    expect(p.stored_plan).toBe("trial");
    expect(p.trial).toMatchObject({ active: true, expired: false, days_left: 9 });
    expect(p.meters.contacts).toEqual({ used: 100, limit: 6000, state: "ok" });
    expect(p.meters.seats).toMatchObject({ used: 1, limit: null, members: 1, pending_invites: 0 });
    expect(p.shows_powered_by).toBe(false);
    // Only plans a customer can buy are listed.
    expect(p.plans.map((x: { id: string }) => x.id)).toEqual(["essential"]);
    expect(p.plans.filter((x: { current: boolean }) => x.current).map((x: { id: string }) => x.id)).toEqual(["essential"]);
  });

  it("describes an expired trial as No plan, with the powered-by link", async () => {
    if (!dbAvailable) return;
    enforce(true);
    const t = await newTenant("trial", { trialEndsAt: new Date(Date.now() - DAY) });
    const p = await planOf(t);
    expect(p.plan.id).toBe("free");
    expect(p.trial).toMatchObject({ active: false, expired: true, days_left: 0 });
    expect(p.shows_powered_by).toBe(true);
  });

  it("flags meters as ok, near, at limit and over", async () => {
    if (!dbAvailable) return;
    enforce(true);
    const states = async (contacts: number) => {
      const t = await newTenant("lifetime_1", { contacts });
      return (await planOf(t)).meters.contacts.state;
    };
    expect(await states(100)).toBe("ok");
    expect(await states(799)).toBe("ok");
    expect(await states(800)).toBe("near"); // 80%
    expect(await states(999)).toBe("near");
    expect(await states(1000)).toBe("at_limit");
    expect(await states(1001)).toBe("over");
  });

  it("counts this month's sent emails and says when the allowance resets", async () => {
    if (!dbAvailable) return;
    enforce(true);
    const t = await newTenant("lifetime_1", { contacts: 1 });
    const [c] = await q<{ id: string }>(sql`SELECT id FROM contacts WHERE tenant_id = ${t.id}::uuid LIMIT 1`);
    const [f] = await q<{ id: string }>(sql`
      INSERT INTO flows (tenant_id, name, priority, trigger_type, trigger_config, steps, status, flow_class)
      VALUES (${t.id}::uuid, 'f', 0, 'event', '{}'::jsonb, '[]'::jsonb, 'paused', 'nurture') RETURNING id`);
    const [m] = await q<{ id: string }>(sql`
      INSERT INTO flow_memberships (tenant_id, contact_id, flow_id, current_step, status, entered_at)
      VALUES (${t.id}::uuid, ${c!.id}::uuid, ${f!.id}::uuid, 1, 'completed', now()) RETURNING id`);
    const mk = (step: number, status: string, sentAt: string) => db.execute(sql`
      INSERT INTO lifecycle_messages (tenant_id, contact_id, flow_id, membership_id, flow_step_order, status, sent_at)
      VALUES (${t.id}::uuid, ${c!.id}::uuid, ${f!.id}::uuid, ${m!.id}::uuid, ${step}, ${status}, ${sentAt}::timestamptz)`);
    await mk(1, "sent", new Date().toISOString()); // counts
    await mk(2, "sent", new Date().toISOString()); // counts
    await mk(3, "approved", new Date().toISOString()); // not sent: does not count
    await mk(4, "sent", "2020-01-15T00:00:00Z"); // an old month: does not count

    const p = await planOf(t);
    expect(p.meters.emails.used).toBe(2);
    expect(p.meters.emails.limit).toBe(10000);
    const resets = new Date(p.meters.emails.resets_at);
    expect(resets.getUTCDate()).toBe(1);
    expect(resets.getTime()).toBeGreaterThan(Date.now());
  });

  it("a member (not only an owner) can read the plan", async () => {
    if (!dbAvailable) return;
    enforce(true);
    const t = await newTenant("free");
    const [mu] = await q<{ id: string }>(sql`INSERT INTO users (tenant_id, email, role) VALUES (${t.id}::uuid, 'mem@plan-enf.example', 'member') RETURNING id`);
    const [ms] = await q<{ id: string }>(sql`INSERT INTO sessions (tenant_id, user_id, expires_at) VALUES (${t.id}::uuid, ${mu!.id}::uuid, now() + interval '1 day') RETURNING id`);
    const res = await app.inject({ method: "GET", url: "/v1/plan", cookies: { [SESSION_COOKIE_NAME]: ms!.id } });
    expect(res.statusCode).toBe(200);
  });
});

describe("credit line on the public unsubscribe pages", () => {
  const SIGNING_KEY = "plan-enforcement-test-signing-key-do-not-use";
  let savedKey: string | undefined;
  let savedSite: string | undefined;

  const pageFor = async (t: Tenant) => {
    const { generateUnsubscribeToken } = await import("@loomail/adapters");
    const token = generateUnsubscribeToken(t.id, "00000000-0000-4000-8000-000000000000", SIGNING_KEY);
    return app.inject({ method: "GET", url: `/unsubscribe?token=${encodeURIComponent(token)}` });
  };

  beforeAll(() => {
    savedKey = process.env.UNSUBSCRIBE_SIGNING_KEY;
    savedSite = process.env.LOOMAIL_SITE_URL;
    process.env.UNSUBSCRIBE_SIGNING_KEY = SIGNING_KEY;
    process.env.LOOMAIL_SITE_URL = "https://loomail.example";
  });
  afterAll(() => {
    if (savedKey === undefined) delete process.env.UNSUBSCRIBE_SIGNING_KEY;
    else process.env.UNSUBSCRIBE_SIGNING_KEY = savedKey;
    if (savedSite === undefined) delete process.env.LOOMAIL_SITE_URL;
    else process.env.LOOMAIL_SITE_URL = savedSite;
  });

  it("a workspace with no plan: its page links back to the site", async () => {
    if (!dbAvailable) return;
    enforce(true);
    const res = await pageFor(await newTenant("free"));
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('class="credit"');
    expect(res.body).toContain('href="https://loomail.example"');
    expect(res.body).toContain("Sent with Loomail");
  });

  it("a paid or trial workspace's page does not", async () => {
    if (!dbAvailable) return;
    enforce(true);
    expect((await pageFor(await newTenant("essential"))).body).not.toContain('class="credit"');
    const trial = await newTenant("trial", { trialEndsAt: new Date(Date.now() + 3 * DAY) });
    expect((await pageFor(trial)).body).not.toContain('class="credit"');
  });

  it("an expired trial has no plan again, so the credit returns", async () => {
    if (!dbAvailable) return;
    enforce(true);
    const t = await newTenant("trial", { trialEndsAt: new Date(Date.now() - DAY) });
    expect((await pageFor(t)).body).toContain('class="credit"');
  });

  it("with enforcement off nobody gets it", async () => {
    if (!dbAvailable) return;
    enforce(false);
    expect((await pageFor(await newTenant("free"))).body).not.toContain('class="credit"');
  });

  it("the invalid-link page never carries it (it reveals nothing about any tenant)", async () => {
    if (!dbAvailable) return;
    enforce(true);
    const res = await app.inject({ method: "GET", url: "/unsubscribe?token=not-a-token" });
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain('class="credit"');
  });
});
