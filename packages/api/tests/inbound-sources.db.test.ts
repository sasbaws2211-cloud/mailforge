/**
 * Inbound sources over HTTP: managing them, and receiving from a generic JSON sender and from Stripe.
 *
 * Management: create/list/patch/rotate/delete, validation, token shown once, tenant isolation, limit per workspace.
 * Receiving, generic: token by header / bearer / query, one indistinguishable 401 for every authentication failure,
 *   person by id or by email (matching an existing contact), traits, event, dedupe by event id, bad bodies.
 * Receiving, Stripe: signature and replay window, checkout then later events that carry no email (found by the
 *   remembered customer id), payment status and plan, duplicates not doubled, unknown types and unmatched people ignored.
 * The retention sweep deletes old log lines only.
 *
 * Requires local Postgres (DATABASE_URL).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHmac } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { sql } from "drizzle-orm";
import { buildApp } from "../src/index.js";
import { tenants, users, sessions } from "@loomail/db/schema";
import { sweepInboundLog } from "../../worker/src/inbound-retention.js";

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) throw new Error("[inbound-sources.test] DATABASE_URL is not set.");

let pool: pg.Pool;
let db: ReturnType<typeof drizzle>;
let dbAvailable = false;
let app: Awaited<ReturnType<typeof buildApp>>;
const SLUGS = ["test-inbound-a", "test-inbound-b"];
let tenantA = "";
let tenantB = "";
let cookieA = "";
let cookieB = "";

const api = async (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, cookie: string | null, payload?: unknown) => {
  const res = await app.inject({
    method,
    url,
    headers: { ...(cookie ? { cookie } : {}), ...(payload !== undefined ? { "content-type": "application/json" } : {}) },
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
  return { status: res.statusCode, body: res.json() as any };
};

/** Send to a source's public URL. `body` is sent as the exact text. */
const hook = async (sourceId: string, body: unknown, headers: Record<string, string> = {}, query = "") => {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  const res = await app.inject({ method: "POST", url: `/webhooks/in/${sourceId}${query}`, headers: { "content-type": "application/json", ...headers }, payload: text });
  return { status: res.statusCode, body: res.json() as any };
};

const one = async (query: ReturnType<typeof sql>) => (await db.execute(query)).rows as Array<Record<string, any>>;
const contactBy = async (tenant: string, externalId: string) =>
  (await one(sql`SELECT external_id, email, name, company, payment_status, properties FROM contacts WHERE tenant_id = ${tenant} AND external_id = ${externalId}`))[0];
const eventsOf = async (tenant: string, externalId: string) =>
  one(sql`SELECT e.event_name, e.properties, e.context, e.timestamp FROM events e JOIN contacts c ON c.id = e.contact_id WHERE e.tenant_id = ${tenant} AND c.external_id = ${externalId} AND e.type = 'track' ORDER BY e.timestamp, e.id`);
const logOf = async (sourceId: string) => one(sql`SELECT status, summary FROM inbound_source_log WHERE source_id = ${sourceId} ORDER BY created_at, id`);

const GENERIC = { event_name_path: "type", user_id_path: "data.id", email_path: "data.email", trait_paths: { company: "data.company", seats: "data.seats" } };
async function newGeneric(config: Record<string, unknown> = GENERIC, cookie = cookieA) {
  const res = await api("POST", "/v1/inbound-sources", cookie, { kind: "generic", name: "Typeform", config });
  expect(res.status).toBe(201);
  return { id: res.body.source.id as string, token: res.body.token as string };
}

const STRIPE_SECRET = "whsec_" + "a1b2c3d4e5f6a7b8c9d0e1f2a3b4";
const stripePost = (sourceId: string, evt: unknown, opts: { secret?: string; t?: number; raw?: string } = {}) => {
  const raw = opts.raw ?? JSON.stringify(evt);
  const t = opts.t ?? Math.floor(Date.now() / 1000);
  const sig = createHmac("sha256", opts.secret ?? STRIPE_SECRET).update(`${t}.${raw}`).digest("hex");
  return hook(sourceId, raw, { "stripe-signature": `t=${t},v1=${sig}` });
};
let evtSeq = 0;
// Strictly increasing times, so events read back in the order they were sent.
const stripeEvt = (type: string, object: Record<string, unknown>, created?: number) => ({ id: `evt_test_${++evtSeq}`, type, created: created ?? Math.floor(Date.now() / 1000) - 600 + evtSeq, data: { object } });

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: DB_URL, connectionTimeoutMillis: 3000 });
  try {
    await pool.query("SELECT 1");
    db = drizzle(pool);
    dbAvailable = true;
  } catch (err) {
    if (process.env.CI === "true") throw err;
    console.warn("[inbound-sources.test] DATABASE_URL not reachable - skipped.");
    return;
  }
  for (const slug of SLUGS) {
    const t = sql`(SELECT id FROM tenants WHERE slug = ${slug})`;
    for (const table of ["inbound_source_log", "inbound_sources", "contact_conflicts", "lifecycle_transitions", "events", "contacts", "sessions", "users"]) {
      await db.execute(sql`DELETE FROM ${sql.raw(table)} WHERE tenant_id IN ${t}`);
    }
    await db.execute(sql`DELETE FROM tenants WHERE slug = ${slug}`);
  }
  const make = async (slug: string) => {
    const [t] = await db.insert(tenants).values({ name: slug, slug, plan: "free" }).returning({ id: tenants.id });
    const [u] = await db.insert(users).values({ tenantId: t!.id, email: `owner@${slug}.test`, role: "owner" }).returning({ id: users.id });
    const [s] = await db.insert(sessions).values({ tenantId: t!.id, userId: u!.id, expiresAt: new Date(Date.now() + 86400_000) }).returning({ id: sessions.id });
    return { id: t!.id, cookie: `loomail_session=${s!.id}` };
  };
  const a = await make(SLUGS[0]!);
  const b = await make(SLUGS[1]!);
  [tenantA, cookieA, tenantB, cookieB] = [a.id, a.cookie, b.id, b.cookie];
  app = await buildApp({ db, logger: false });
  await app.ready();
});

afterAll(async () => {
  if (app) await app.close();
  if (pool) await pool.end();
});

// ===========================================================================
describe("managing sources", () => {
  it("creates a generic source: the token is shown once and only its hash is kept", async () => {
    if (!dbAvailable) return;
    const { id, token } = await newGeneric();
    expect(token).toMatch(/^mf_in_[A-Za-z0-9_-]{32}$/);
    const row = (await one(sql`SELECT token_hash, token_prefix, secret_sealed FROM inbound_sources WHERE id = ${id}`))[0]!;
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.token_hash).not.toContain(token);
    expect(row.token_prefix).toBe(token.slice(0, 10));
    expect(row.secret_sealed).toBeNull();
    const list = await api("GET", "/v1/inbound-sources", cookieA);
    const listed = list.body.sources.find((s: any) => s.id === id);
    expect(listed).toMatchObject({ name: "Typeform", kind: "generic", enabled: true, token_prefix: token.slice(0, 10), has_signing_secret: false });
    expect(JSON.stringify(list.body)).not.toContain(token);
  });

  it("creates a Stripe source: the signing secret is sealed and never returned", async () => {
    if (!dbAvailable) return;
    const res = await api("POST", "/v1/inbound-sources", cookieA, { kind: "stripe", name: "Stripe", stripe_signing_secret: STRIPE_SECRET });
    expect(res.status).toBe(201);
    expect(res.body.token).toBeUndefined();
    expect(res.body.source).toMatchObject({ kind: "stripe", has_signing_secret: true, config: { user_id_metadata_key: "user_id" } });
    expect(JSON.stringify(res.body)).not.toContain(STRIPE_SECRET);
    const row = (await one(sql`SELECT secret_sealed, token_hash FROM inbound_sources WHERE id = ${res.body.source.id}`))[0]!;
    expect(row.token_hash).toBeNull();
    expect(row.secret_sealed).toBeTruthy();
  });

  it("validates: generic needs a person and something to do; Stripe needs a whsec_ secret; names are required", async () => {
    if (!dbAvailable) return;
    const bad = async (payload: unknown, path: string) => {
      const r = await api("POST", "/v1/inbound-sources", cookieA, payload);
      expect(r.status, JSON.stringify(payload)).toBe(400);
      expect(r.body.issues.map((i: any) => i.path).join(","), JSON.stringify(payload)).toContain(path);
    };
    await bad({ kind: "generic", name: "x", config: { event_name: "e" } }, "config.user_id_path");
    await bad({ kind: "generic", name: "x", config: { user_id_path: "id" } }, "config.event_name");
    await bad({ kind: "generic", name: "x", config: { user_id_path: "id", event_name: "e", nope: 1 } }, "config");
    await bad({ kind: "stripe", name: "x", stripe_signing_secret: "sk_live_123" }, "stripe_signing_secret");
    await bad({ kind: "stripe", name: "x" }, "stripe_signing_secret");
    await bad({ kind: "generic", name: "  ", config: GENERIC }, "name");
    await bad({ kind: "ftp", name: "x" }, "kind");
  });

  it("renames, disables, changes settings, and swaps a Stripe secret", async () => {
    if (!dbAvailable) return;
    const { id } = await newGeneric();
    const r = await api("PATCH", `/v1/inbound-sources/${id}`, cookieA, { name: "Renamed", enabled: false, config: { ...GENERIC, event_name: "x" } });
    expect(r.status).toBe(200);
    expect(r.body.source).toMatchObject({ name: "Renamed", enabled: false, config: { event_name: "x" } });
    expect((await api("PATCH", `/v1/inbound-sources/${id}`, cookieA, { config: { event_name: "no person" } })).status).toBe(400);
    expect((await api("PATCH", `/v1/inbound-sources/${id}`, cookieA, { stripe_signing_secret: STRIPE_SECRET })).status).toBe(400); // not a Stripe source
    expect((await api("PATCH", `/v1/inbound-sources/${id}`, cookieA, { surprise: 1 })).status).toBe(400);
  });

  it("is scoped to the workspace: another workspace cannot see, change, rotate, read the log of or delete it", async () => {
    if (!dbAvailable) return;
    const { id } = await newGeneric();
    expect((await api("GET", "/v1/inbound-sources", cookieB)).body.sources.find((s: any) => s.id === id)).toBeUndefined();
    expect((await api("PATCH", `/v1/inbound-sources/${id}`, cookieB, { name: "hijack" })).status).toBe(404);
    expect((await api("POST", `/v1/inbound-sources/${id}/rotate-token`, cookieB)).status).toBe(404);
    expect((await api("GET", `/v1/inbound-sources/${id}/log`, cookieB)).status).toBe(404);
    expect((await api("DELETE", `/v1/inbound-sources/${id}`, cookieB)).status).toBe(404);
    expect((await api("GET", "/v1/inbound-sources", null)).status).toBe(401);
    expect((await api("GET", "/v1/inbound-sources/not-a-uuid/log", cookieA)).status).toBe(404);
  });

  it("rotating gives a new token and the old one stops working; a Stripe source has no token to rotate", async () => {
    if (!dbAvailable) return;
    const { id, token } = await newGeneric();
    expect((await hook(id, { type: "t", data: { id: "rot-user" } }, { authorization: `Bearer ${token}` })).status).toBe(200);
    const rotated = await api("POST", `/v1/inbound-sources/${id}/rotate-token`, cookieA);
    expect(rotated.status).toBe(200);
    expect(rotated.body.token).not.toBe(token);
    expect((await hook(id, { type: "t", data: { id: "rot-user" } }, { authorization: `Bearer ${token}` })).status).toBe(401);
    expect((await hook(id, { type: "t", data: { id: "rot-user" } }, { authorization: `Bearer ${rotated.body.token}` })).status).toBe(200);
    const stripe = await api("POST", "/v1/inbound-sources", cookieA, { kind: "stripe", name: "S", stripe_signing_secret: STRIPE_SECRET });
    expect((await api("POST", `/v1/inbound-sources/${stripe.body.source.id}/rotate-token`, cookieA)).status).toBe(400);
  });

  it("deleting removes the source and its log, and its URL stops working", async () => {
    if (!dbAvailable) return;
    const { id, token } = await newGeneric();
    await hook(id, { type: "t", data: { id: "del-user" } }, { authorization: `Bearer ${token}` });
    expect(await logOf(id)).toHaveLength(1);
    expect((await api("DELETE", `/v1/inbound-sources/${id}`, cookieA)).body).toEqual({ deleted: true });
    expect(await logOf(id)).toHaveLength(0);
    expect((await hook(id, { type: "t", data: { id: "x" } }, { authorization: `Bearer ${token}` })).status).toBe(401);
  });

  it("caps the number of sources in a workspace", async () => {
    if (!dbAvailable) return;
    const t = (await db.insert(tenants).values({ name: "cap", slug: "test-inbound-cap", plan: "free" }).onConflictDoNothing().returning({ id: tenants.id }))[0];
    const tenantId = t?.id ?? (await one(sql`SELECT id FROM tenants WHERE slug = 'test-inbound-cap'`))[0]!.id;
    try {
      const [u] = await db.insert(users).values({ tenantId, email: "o@cap.test", role: "owner" }).returning({ id: users.id });
      const [s] = await db.insert(sessions).values({ tenantId, userId: u!.id, expiresAt: new Date(Date.now() + 86400_000) }).returning({ id: sessions.id });
      const cookie = `loomail_session=${s!.id}`;
      for (let i = 0; i < 20; i++) expect((await api("POST", "/v1/inbound-sources", cookie, { kind: "generic", name: `s${i}`, config: GENERIC })).status).toBe(201);
      expect((await api("POST", "/v1/inbound-sources", cookie, { kind: "generic", name: "one too many", config: GENERIC })).status).toBe(409);
    } finally {
      for (const table of ["inbound_source_log", "inbound_sources", "sessions", "users"]) await db.execute(sql`DELETE FROM ${sql.raw(table)} WHERE tenant_id = ${tenantId}`);
      await db.execute(sql`DELETE FROM tenants WHERE id = ${tenantId}`);
    }
  });
});

// ===========================================================================
describe("receiving from a generic sender", () => {
  const payload = (over: Record<string, unknown> = {}) => ({ type: "form.submitted", data: { id: "g-user-1", email: "G.User@Example.com", company: "Acme", seats: 5, ...over } });

  it("accepts the token as a bearer, an X-Loomail-Token header, or ?token=, and records traits and the event", async () => {
    if (!dbAvailable) return;
    const { id, token } = await newGeneric();
    const a = await hook(id, payload(), { authorization: `Bearer ${token}` });
    expect(a).toMatchObject({ status: 200, body: { ok: true } });
    expect((await hook(id, payload({ id: "g-user-2", email: "g2@example.com" }), { "x-loomail-token": token })).status).toBe(200);
    expect((await hook(id, payload({ id: "g-user-3", email: "g3@example.com" }), {}, `?token=${token}`)).status).toBe(200);

    const c = await contactBy(tenantA, "g-user-1");
    // company is a built-in field (its own column); seats is a custom trait (properties).
    expect(c).toMatchObject({ email: "g.user@example.com", company: "Acme", properties: { seats: 5 } });
    const events = await eventsOf(tenantA, "g-user-1");
    expect(events.map((e) => e.event_name)).toEqual(["form.submitted"]);
    expect(events[0]!.properties).toMatchObject({ type: "form.submitted", data: { company: "Acme" } });
    expect(events[0]!.context).toMatchObject({ source: `inbound:${id}` });
    expect(await contactBy(tenantA, "g-user-2")).toBeTruthy();
    expect(await contactBy(tenantA, "g-user-3")).toBeTruthy();
    expect((await logOf(id)).map((l) => l.status)).toEqual(["processed", "processed", "processed"]);
  });

  it("every authentication failure is the same 401: no token, wrong token, disabled, unknown, not a uuid", async () => {
    if (!dbAvailable) return;
    const { id, token } = await newGeneric();
    const disabled = await newGeneric();
    await api("PATCH", `/v1/inbound-sources/${disabled.id}`, cookieA, { enabled: false });
    const failures = [
      await hook(id, payload()),
      await hook(id, payload(), { authorization: "Bearer wrong" }),
      await hook(id, payload(), { authorization: `Bearer ${token.slice(0, -1)}x` }),
      await hook(disabled.id, payload(), { authorization: `Bearer ${disabled.token}` }),
      await hook("00000000-0000-4000-8000-000000000000", payload(), { authorization: `Bearer ${token}` }),
      await hook("not-a-uuid", payload(), { authorization: `Bearer ${token}` }),
    ];
    for (const f of failures) expect(f).toEqual({ status: 401, body: { error: "Unauthorized." } });
    expect(await contactBy(tenantA, "g-user-1")).toBeTruthy(); // from the earlier test, and nothing new was added by these
    expect((await logOf(id)).every((l) => l.status === "rejected")).toBe(true);
  });

  it("a token for one source never works on another", async () => {
    if (!dbAvailable) return;
    const one1 = await newGeneric();
    const two = await newGeneric();
    expect((await hook(two.id, payload({ id: "cross" }), { authorization: `Bearer ${one1.token}` })).status).toBe(401);
    expect(await contactBy(tenantA, "cross")).toBeUndefined();
  });

  it("with only an email, matches an existing contact by that email, else creates one keyed by it", async () => {
    if (!dbAvailable) return;
    const { id, token } = await newGeneric({ event_name: "newsletter_signup", email_path: "email" });
    await hook(id, { email: "g.user@example.com" }, { authorization: `Bearer ${token}` }); // g-user-1 already has this email
    expect((await eventsOf(tenantA, "g-user-1")).map((e) => e.event_name)).toContain("newsletter_signup");
    await hook(id, { email: "Brand.New@Example.com" }, { authorization: `Bearer ${token}` });
    expect(await contactBy(tenantA, "brand.new@example.com")).toMatchObject({ email: "brand.new@example.com" });
  });

  it("never overwrites the email a contact already has", async () => {
    if (!dbAvailable) return;
    const { id, token } = await newGeneric({ event_name: "x", user_id_path: "uid", email_path: "email" });
    await hook(id, { uid: "g-user-1", email: "someone.else@example.com" }, { authorization: `Bearer ${token}` });
    expect((await contactBy(tenantA, "g-user-1"))!.email).toBe("g.user@example.com");
  });

  it("traits-only sources set traits and record no event", async () => {
    if (!dbAvailable) return;
    const { id, token } = await newGeneric({ user_id_path: "uid", trait_paths: { tier: "tier" } });
    const before = (await eventsOf(tenantA, "g-user-1")).length;
    expect((await hook(id, { uid: "g-user-1", tier: "gold" }, { authorization: `Bearer ${token}` })).status).toBe(200);
    expect((await contactBy(tenantA, "g-user-1"))!.properties).toMatchObject({ tier: "gold" });
    expect((await eventsOf(tenantA, "g-user-1")).length).toBe(before);
  });

  it("an event id header makes a repeat harmless", async () => {
    if (!dbAvailable) return;
    const { id, token } = await newGeneric();
    const send = () => hook(id, payload({ id: "g-dedupe", email: "dd@example.com" }), { authorization: `Bearer ${token}`, "x-loomail-event-id": "evt-77" });
    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(200);
    expect(await eventsOf(tenantA, "g-dedupe")).toHaveLength(1);
    expect((await logOf(id)).map((l) => l.summary).some((s) => s.includes("already recorded"))).toBe(true);
  });

  it("bad bodies: not JSON, not an object, and no person are 400; no event name is ignored", async () => {
    if (!dbAvailable) return;
    const { id, token } = await newGeneric();
    const auth = { authorization: `Bearer ${token}` };
    expect((await hook(id, "{not json", auth)).status).toBe(400);
    expect((await hook(id, "[1,2]", auth)).status).toBe(400);
    expect((await hook(id, { type: "x", data: {} }, auth)).status).toBe(400); // no person
    const ignored = await hook(id, { data: { id: "someone" } }, auth); // no event name at the path, none fixed, no traits... (traits absent too)
    expect(ignored.body).toEqual({ ok: true, ignored: true });
    const statuses = (await logOf(id)).map((l) => l.status);
    expect(statuses).toEqual(["rejected", "rejected", "rejected", "ignored"]);
  });

  it("the person is in the right workspace: tenant B sees none of this", async () => {
    if (!dbAvailable) return;
    expect(await contactBy(tenantB, "g-user-1")).toBeUndefined();
    expect(Number((await one(sql`SELECT count(*) AS n FROM contacts WHERE tenant_id = ${tenantB}`))[0]!.n)).toBe(0);
  });
});

// ===========================================================================
describe("receiving from Stripe", () => {
  let source = "";
  const email = "stripe.customer@example.com";

  it("rejects a bad signature, a wrong secret, a stale timestamp and a body changed in flight, with the one 401", async () => {
    if (!dbAvailable) return;
    const res = await api("POST", "/v1/inbound-sources", cookieA, { kind: "stripe", name: "Stripe", config: { user_id_metadata_key: "app_user" }, stripe_signing_secret: STRIPE_SECRET });
    source = res.body.source.id;
    const evt = stripeEvt("invoice.paid", { customer: "cus_x", customer_email: email, amount_paid: 100 });
    const unauthorized = { status: 401, body: { error: "Unauthorized." } };
    expect(await stripePost(source, evt, { secret: "whsec_not_the_secret_at_all" })).toEqual(unauthorized);
    expect(await stripePost(source, evt, { t: Math.floor(Date.now() / 1000) - 3600 })).toEqual(unauthorized);
    expect(await hook(source, evt)).toEqual(unauthorized); // no signature header
    const raw = JSON.stringify(evt);
    const t = Math.floor(Date.now() / 1000);
    const sig = createHmac("sha256", STRIPE_SECRET).update(`${t}.${raw}`).digest("hex");
    expect(await hook(source, raw + " ", { "stripe-signature": `t=${t},v1=${sig}` })).toEqual(unauthorized);
    expect(await contactBy(tenantA, email)).toBeUndefined();
  });

  it("checkout creates the person by email and remembers the Stripe customer id", async () => {
    if (!dbAvailable) return;
    const r = await stripePost(source, stripeEvt("checkout.session.completed", { customer: "cus_100", customer_details: { email }, amount_total: 4900, currency: "usd", mode: "subscription", payment_status: "paid" }));
    expect(r).toMatchObject({ status: 200, body: { ok: true } });
    const c = await contactBy(tenantA, email);
    expect(c).toMatchObject({ email, properties: { stripe_customer_id: "cus_100" } });
    expect((await eventsOf(tenantA, email)).map((e) => e.event_name)).toEqual(["checkout_completed"]);
  });

  it("a later subscription event with NO email finds the person by the remembered customer id: paid, with a plan", async () => {
    if (!dbAvailable) return;
    const sub = { customer: "cus_100", status: "active", items: { data: [{ price: { id: "price_1", nickname: "Growth" } }] } };
    expect((await stripePost(source, stripeEvt("customer.subscription.created", sub))).status).toBe(200);
    const c = await contactBy(tenantA, email);
    expect(c).toMatchObject({ payment_status: "paid", properties: { plan: "Growth", stripe_customer_id: "cus_100" } });
    expect((await eventsOf(tenantA, email)).map((e) => e.event_name)).toEqual(["checkout_completed", "subscription_started"]);
  });

  it("a failed payment makes them past due; a paid invoice makes them paid again; cancelling cancels", async () => {
    if (!dbAvailable) return;
    await stripePost(source, stripeEvt("invoice.payment_failed", { customer: "cus_100", amount_due: 4900, currency: "usd", attempt_count: 1 }));
    expect((await contactBy(tenantA, email))!.payment_status).toBe("past_due");
    await stripePost(source, stripeEvt("invoice.paid", { customer: "cus_100", amount_paid: 4900, currency: "usd" }));
    expect((await contactBy(tenantA, email))!.payment_status).toBe("paid");
    await stripePost(source, stripeEvt("customer.subscription.deleted", { customer: "cus_100", status: "canceled", items: { data: [] } }));
    expect((await contactBy(tenantA, email))!.payment_status).toBe("cancelled");
    expect((await eventsOf(tenantA, email)).map((e) => e.event_name)).toEqual(["checkout_completed", "subscription_started", "payment_failed", "payment_succeeded", "subscription_cancelled"]);
  });

  it("a replayed event is acknowledged but recorded once", async () => {
    if (!dbAvailable) return;
    const evt = stripeEvt("invoice.payment_failed", { customer: "cus_100", amount_due: 1, currency: "usd", attempt_count: 2 });
    const before = (await eventsOf(tenantA, email)).length;
    expect((await stripePost(source, evt)).status).toBe(200);
    expect((await stripePost(source, evt)).status).toBe(200);
    expect((await eventsOf(tenantA, email)).length).toBe(before + 1);
  });

  it("uses the configured metadata key to find YOUR user id, and the event lands on that contact", async () => {
    if (!dbAvailable) return;
    await stripePost(source, stripeEvt("customer.subscription.created", { customer: "cus_200", status: "trialing", metadata: { app_user: "app-user-9", user_id: "wrong-key" }, items: { data: [{ price: { id: "p", nickname: "Pro" } }] } }));
    expect(await contactBy(tenantA, "app-user-9")).toMatchObject({ payment_status: "trial", properties: { plan: "Pro", stripe_customer_id: "cus_200" } });
    expect(await contactBy(tenantA, "wrong-key")).toBeUndefined();
  });

  it("client_reference_id identifies the person at checkout", async () => {
    if (!dbAvailable) return;
    await stripePost(source, stripeEvt("checkout.session.completed", { customer: "cus_300", client_reference_id: "ref-user-3", customer_details: { email: "ref3@example.com" } }));
    expect(await contactBy(tenantA, "ref-user-3")).toMatchObject({ email: "ref3@example.com", properties: { stripe_customer_id: "cus_300" } });
  });

  it("an event that cannot be matched to anyone is acknowledged and logged, not retried", async () => {
    if (!dbAvailable) return;
    const r = await stripePost(source, stripeEvt("customer.subscription.updated", { customer: "cus_unknown", status: "active" }));
    expect(r).toEqual({ status: 200, body: { ok: true, ignored: true } });
    const last = (await logOf(source)).at(-1)!;
    expect(last.status).toBe("ignored");
    expect(last.summary).toMatch(/Could not tell who/);
  });

  it("an event type Loomail does not use is acknowledged and ignored", async () => {
    if (!dbAvailable) return;
    const r = await stripePost(source, stripeEvt("charge.refunded", { customer: "cus_100" }));
    expect(r).toEqual({ status: 200, body: { ok: true, ignored: true } });
  });

  it("an event that arrives late cannot overwrite a newer payment status or plan, but is still recorded", async () => {
    if (!dbAvailable) return;
    const T = Math.floor(Date.now() / 1000) - 1000;
    const who = { app_user: "order-user" };
    const sub = (status: string, plan: string) => ({ customer: "cus_order", status, metadata: who, items: { data: [{ price: { id: "p", nickname: plan } }] } });
    await stripePost(source, stripeEvt("customer.subscription.updated", sub("active", "Growth"), T + 100));
    expect(await contactBy(tenantA, "order-user")).toMatchObject({ payment_status: "paid", properties: { plan: "Growth", stripe_status_at: T + 100 } });

    // A failure from BEFORE that, delivered late (an outage, a retry): it must not make them past due or change the plan.
    const late = await stripePost(source, stripeEvt("customer.subscription.updated", sub("past_due", "Starter"), T + 50));
    expect(late.status).toBe(200);
    expect(await contactBy(tenantA, "order-user")).toMatchObject({ payment_status: "paid", properties: { plan: "Growth", stripe_status_at: T + 100 } });
    const events = (await eventsOf(tenantA, "order-user")).map((e) => e.event_name);
    expect(events).toEqual(["subscription_updated", "subscription_updated"]); // both recorded
    const last = (await logOf(source)).at(-1)!;
    expect(last.status).toBe("processed");
    expect(last.summary).toMatch(/older than the current billing status/);

    // A genuinely newer one applies, and so does one from the same second.
    await stripePost(source, stripeEvt("invoice.payment_failed", { customer: "cus_order", attempt_count: 1, amount_due: 5, currency: "usd" }, T + 200));
    expect((await contactBy(tenantA, "order-user"))!.payment_status).toBe("past_due");
    await stripePost(source, stripeEvt("customer.subscription.updated", sub("active", "Growth"), T + 200));
    expect((await contactBy(tenantA, "order-user"))!.payment_status).toBe("paid");
  });

  it("two different events for one occurrence are recorded once; real repeats (attempts, updates) all count", async () => {
    if (!dbAvailable) return;
    const base = { customer: "cus_dups", customer_email: "dups@example.com" };
    // The same invoice paid: Stripe sends two distinct events.
    await stripePost(source, stripeEvt("invoice.paid", { id: "in_dup", ...base, amount_paid: 100, currency: "usd" }));
    await stripePost(source, stripeEvt("invoice.paid", { id: "in_dup", ...base, amount_paid: 100, currency: "usd" }));
    // Two real failed attempts on one invoice, plus a duplicate of the second.
    await stripePost(source, stripeEvt("invoice.payment_failed", { id: "in_dup2", ...base, attempt_count: 1, amount_due: 5 }));
    await stripePost(source, stripeEvt("invoice.payment_failed", { id: "in_dup2", ...base, attempt_count: 2, amount_due: 5 }));
    await stripePost(source, stripeEvt("invoice.payment_failed", { id: "in_dup2", ...base, attempt_count: 2, amount_due: 5 }));
    // Several real updates to one subscription.
    for (let i = 0; i < 3; i++) await stripePost(source, stripeEvt("customer.subscription.updated", { id: "sub_many", ...base, status: "active" }));
    const names = (await eventsOf(tenantA, "dups@example.com")).map((e) => e.event_name);
    expect(names.filter((n) => n === "payment_succeeded")).toHaveLength(1);
    expect(names.filter((n) => n === "payment_failed")).toHaveLength(2);
    expect(names.filter((n) => n === "subscription_updated")).toHaveLength(3);
  });

  it("a thin event is acknowledged, not rejected, and the log says to choose Snapshot", async () => {
    if (!dbAvailable) return;
    const thin = { id: "evt_thin_1", object: "v2.core.event", type: "v1.billing.meter.error_report_triggered", related_object: { id: "mtr_1", type: "billing.meter" } };
    expect(await stripePost(source, thin)).toEqual({ status: 200, body: { ok: true, ignored: true } });
    const last = (await logOf(source)).at(-1)!;
    expect(last.status).toBe("ignored");
    expect(last.summary).toMatch(/Snapshot/);
  });

  it("a correctly signed body that is not JSON is a 400", async () => {
    if (!dbAvailable) return;
    expect((await stripePost(source, null, { raw: "not json at all" })).status).toBe(400);
  });

  it("a Stripe event never leaks into another workspace", async () => {
    if (!dbAvailable) return;
    expect(Number((await one(sql`SELECT count(*) AS n FROM contacts WHERE tenant_id = ${tenantB}`))[0]!.n)).toBe(0);
  });
});

// ===========================================================================
describe("the log and its retention", () => {
  it("the log endpoint returns the latest lines, newest first, and the sweep removes only old ones", async () => {
    if (!dbAvailable) return;
    const { id, token } = await newGeneric();
    for (let i = 0; i < 3; i++) await hook(id, { type: "t", data: { id: `log-user-${i}` } }, { authorization: `Bearer ${token}` });
    const log = await api("GET", `/v1/inbound-sources/${id}/log`, cookieA);
    expect(log.status).toBe(200);
    expect(log.body.log).toHaveLength(3);
    expect(log.body.log[0]).toMatchObject({ status: "processed", summary: expect.stringContaining("log-user-2") });

    await db.execute(sql`UPDATE inbound_source_log SET created_at = now() - interval '31 days' WHERE source_id = ${id} AND summary LIKE '%log-user-0%'`);
    await db.execute(sql`UPDATE inbound_source_log SET created_at = now() - interval '29 days' WHERE source_id = ${id} AND summary LIKE '%log-user-1%'`);
    expect(await sweepInboundLog(db as never, new Date())).toBeGreaterThanOrEqual(1);
    const after = (await api("GET", `/v1/inbound-sources/${id}/log`, cookieA)).body.log.map((l: any) => l.summary);
    expect(after).toHaveLength(2);
    expect(after.some((s: string) => s.includes("log-user-0"))).toBe(false);
  });
});
