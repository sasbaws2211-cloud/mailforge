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
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
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

  describe("Typeform and Zapier shapes", () => {
    // Typeform's official example (typeform.com/developers/webhooks/example-payload), trimmed of the form definition.
    const typeform = (over: { event_id?: string; hidden?: Record<string, string>; skipFirst?: boolean; email?: string } = {}) => {
      const answers = [
        { type: "text", text: "It's cold right now!", field: { id: "DlXFaesGBpoF", type: "long_text" } },
        { type: "email", email: over.email ?? "laura@example.com", field: { id: "SMEUb7VJz92Q", type: "email" } },
        { type: "text", text: "Laura", field: { id: "JwWggjAKtOkA", type: "short_text" } },
        { type: "choice", choice: { id: "4WIlUvKOl0UB", label: "London" }, field: { id: "k6TP9oLGgHjl", type: "multiple_choice" } },
      ];
      return {
        event_id: over.event_id ?? "LtWXD3crgy",
        event_type: "form_response",
        form_response: { form_id: "lT4Z3j", token: "a3a12ec6", calculated: { score: 9 }, hidden: over.hidden ?? { user_id: "tf-user-1" }, answers: over.skipFirst ? answers.slice(1) : answers },
      };
    };
    const TYPEFORM = {
      event_name_path: "event_type",
      event_id_path: "event_id",
      user_id_path: "form_response.hidden.user_id",
      email_path: "form_response.answers[type=email].email",
      trait_paths: { first_name: "form_response.answers[field.type=short_text].text", favourite_city: "form_response.answers[type=choice].choice.label", quiz_score: "form_response.calculated.score" },
    };

    // The workspace holds at most 20 sources: delete what each test made, so these do not crowd out the tests after them.
    const made: string[] = [];
    const mine = async (config: Record<string, unknown>) => {
      const s = await newGeneric(config);
      made.push(s.id);
      return s;
    };
    afterEach(async () => {
      if (!dbAvailable) return;
      for (const sid of made.splice(0)) {
        await db.execute(sql`DELETE FROM inbound_source_log WHERE source_id = ${sid}`);
        await db.execute(sql`DELETE FROM inbound_sources WHERE id = ${sid}`);
      }
    });

    it("records a Typeform submission with the token in the address and finds answers by type", async () => {
      if (!dbAvailable) return;
      const { id, token } = await mine(TYPEFORM);
      expect((await hook(id, typeform(), {}, `?token=${token}`)).status).toBe(200);
      expect(await contactBy(tenantA, "tf-user-1")).toMatchObject({ email: "laura@example.com", name: null, properties: { favourite_city: "London", quiz_score: 9 } });
      expect((await eventsOf(tenantA, "tf-user-1")).map((e) => e.event_name)).toEqual(["form_response"]);
    });

    it("a retry of the same Typeform event is recorded once, using the event_id in the body", async () => {
      if (!dbAvailable) return;
      const { id, token } = await mine(TYPEFORM);
      const body = typeform({ event_id: "evt-retry-1", hidden: { user_id: "tf-retry" } });
      expect((await hook(id, body, {}, `?token=${token}`)).status).toBe(200);
      expect((await hook(id, body, {}, `?token=${token}`)).status).toBe(200);
      expect(await eventsOf(tenantA, "tf-retry")).toHaveLength(1);
      // a different submission (a new event_id) from the same person is a new event
      expect((await hook(id, typeform({ event_id: "evt-retry-2", hidden: { user_id: "tf-retry" } }), {}, `?token=${token}`)).status).toBe(200);
      expect(await eventsOf(tenantA, "tf-retry")).toHaveLength(2);
    });

    it("an event id from the body does not collide across two sources", async () => {
      if (!dbAvailable) return;
      const a = await mine(TYPEFORM);
      const b = await mine(TYPEFORM);
      const body = typeform({ event_id: "same-id-everywhere", hidden: { user_id: "tf-two-sources" } });
      await hook(a.id, body, {}, `?token=${a.token}`);
      await hook(b.id, body, {}, `?token=${b.token}`);
      expect(await eventsOf(tenantA, "tf-two-sources")).toHaveLength(2);
    });

    it("the header wins over the body when both give an id", async () => {
      if (!dbAvailable) return;
      const { id, token } = await mine(TYPEFORM);
      const send = (eventId: string, headerId: string) => hook(id, typeform({ event_id: eventId, hidden: { user_id: "tf-header" } }), { "x-loomail-event-id": headerId }, `?token=${token}`);
      await send("body-1", "hdr-same");
      await send("body-2", "hdr-same"); // different body id, same header id: a repeat
      expect(await eventsOf(tenantA, "tf-header")).toHaveLength(1);
    });

    it("a skipped optional question does not lose the email or other answers", async () => {
      if (!dbAvailable) return;
      const { id, token } = await mine(TYPEFORM);
      expect((await hook(id, typeform({ skipFirst: true, hidden: { user_id: "tf-skip" }, email: "skipper@example.com" }), {}, `?token=${token}`)).status).toBe(200);
      expect(await contactBy(tenantA, "tf-skip")).toMatchObject({ email: "skipper@example.com", properties: { favourite_city: "London" } });
    });

    it("rejects an event_id_path that is empty or too long when the source is saved", async () => {
      const bad = await api("POST", "/v1/inbound-sources", cookieA, { kind: "generic", name: "x", config: { ...TYPEFORM, event_id_path: "" } });
      expect(bad.status).toBe(400);
      const long = await api("POST", "/v1/inbound-sources", cookieA, { kind: "generic", name: "x", config: { ...TYPEFORM, event_id_path: "a".repeat(201) } });
      expect(long.status).toBe(400);
    });

    it("accepts a form-encoded body (Zapier's Form payload type) and reads it like JSON", async () => {
      if (!dbAvailable) return;
      const { id, token } = await mine({ event_name_path: "event", user_id_path: "id", email_path: "email", trait_paths: { company: "company", seats: "seats" } });
      const form = "id=z-form-1&email=zee%40example.com&event=new_lead&company=Zee+Co&seats=5";
      const r = await hook(id, form, { "content-type": "application/x-www-form-urlencoded", authorization: `Bearer ${token}` });
      expect(r).toMatchObject({ status: 200, body: { ok: true } });
      expect(await contactBy(tenantA, "z-form-1")).toMatchObject({ email: "zee@example.com", company: "Zee Co", properties: { seats: "5" } }); // form values are text
      expect((await eventsOf(tenantA, "z-form-1")).map((e) => e.event_name)).toEqual(["new_lead"]);
    });

    it("a form-encoded body still has to carry the token, and a key sent twice becomes a list", async () => {
      if (!dbAvailable) return;
      const { id, token } = await mine({ event_name: "lead", user_id_path: "id", trait_paths: { tags: "tag" } });
      const noToken = await hook(id, "id=z-form-2&tag=a", { "content-type": "application/x-www-form-urlencoded" });
      expect(noToken.status).toBe(401);
      const ok = await hook(id, "id=z-form-2&tag=a&tag=b&__proto__=x", { "content-type": "application/x-www-form-urlencoded" }, `?token=${token}`);
      expect(ok.status).toBe(200);
      const ev = await eventsOf(tenantA, "z-form-2");
      expect(ev[0]!.properties).toMatchObject({ id: "z-form-2", tag: ["a", "b"] });
      expect(Object.prototype.hasOwnProperty.call(ev[0]!.properties, "__proto__")).toBe(false);
    });

    it("a form-encoded body to a Stripe source is a 400 that says to send JSON", async () => {
      if (!dbAvailable) return;
      const created = await api("POST", "/v1/inbound-sources", cookieA, { kind: "stripe", name: "S", stripe_signing_secret: STRIPE_SECRET });
      made.push(created.body.source.id);
      const raw = "a=1";
      const t = Math.floor(Date.now() / 1000);
      const sig = createHmac("sha256", STRIPE_SECRET).update(`${t}.${raw}`).digest("hex");
      const r = await hook(created.body.source.id, raw, { "content-type": "application/x-www-form-urlencoded", "stripe-signature": `t=${t},v1=${sig}` });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/JSON/);
    });
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

// ===========================================================================
describe("receiving from Paystack", () => {
  // A workspace holds at most 20 sources and the tests above made many: start these from none.
  beforeAll(async () => {
    if (dbAvailable) await db.execute(sql`DELETE FROM inbound_sources WHERE tenant_id = ${tenantA}`);
  });
  const SK = "sk_test_" + "a1b2c3d4e5f6a7b8c9d0";
  const nowIso = (offsetSec = 0) => new Date(Date.now() + offsetSec * 1000).toISOString();
  const charge = (email: string, over: Record<string, unknown> = {}) => ({
    event: "charge.success",
    data: { id: 1, status: "success", reference: `ref_${Math.random().toString(36).slice(2)}`, amount: 5000, currency: "NGN", paid_at: nowIso(-30), channel: "card", metadata: 0, customer: { email, customer_code: `CUS_${email.split("@")[0]}`, metadata: null }, plan: {}, ...over },
  });
  const sub = (event: string, email: string, status: string) => ({
    event,
    data: { status, subscription_code: `SUB_${email.split("@")[0]}`, plan: { name: "Growth", plan_code: "PLN_1", interval: "monthly", currency: "NGN" }, customer: { email, customer_code: `CUS_${email.split("@")[0]}` } },
  });
  const pspost = (id: string, body: unknown, headers: Record<string, string> = {}, query = "", remoteAddress?: string) => {
    const text = typeof body === "string" ? body : JSON.stringify(body);
    return app
      .inject({ method: "POST", url: `/webhooks/in/${id}${query}`, headers: { "content-type": "application/json", ...headers }, payload: text, ...(remoteAddress ? { remoteAddress } : {}) })
      .then((r) => ({ status: r.statusCode, body: r.json() as any }));
  };
  const signed = (id: string, body: unknown, key = SK) => {
    const raw = JSON.stringify(body);
    return pspost(id, raw, { "x-paystack-signature": createHmac("sha512", key).update(raw).digest("hex") });
  };

  let tokenSource = { id: "", token: "" };

  it("a token-mode source gives a token once; the address plus token works, a wrong one gets the one 401", async () => {
    if (!dbAvailable) return;
    const res = await api("POST", "/v1/inbound-sources", cookieA, { kind: "paystack", name: "Paystack" });
    expect(res.status).toBe(201);
    expect(res.body.token).toMatch(/^mf_in_/);
    expect(res.body.source).toMatchObject({ kind: "paystack", has_signing_secret: false, config: { verification: "token", require_paystack_ip: false, user_id_metadata_key: "user_id" } });
    tokenSource = { id: res.body.source.id, token: res.body.token };
    const body = charge("ps.one@example.com");
    expect((await pspost(tokenSource.id, body, {}, `?token=${tokenSource.token}`)).status).toBe(200);
    expect((await pspost(tokenSource.id, body, {}, "?token=wrong")).body).toEqual({ error: "Unauthorized." });
    expect((await pspost(tokenSource.id, body)).status).toBe(401);
    expect((await pspost(tokenSource.id, body, { authorization: `Bearer ${tokenSource.token}` })).status).toBe(200);
  });

  it("a payment makes them paid and remembers the customer code; a later event with that code but no usable email finds them", async () => {
    if (!dbAvailable) return;
    const url = `?token=${tokenSource.token}`;
    await pspost(tokenSource.id, charge("ps.two@example.com", { reference: "ref_two", metadata: { user_id: "app-ps-2" } }), {}, url);
    expect(await contactBy(tenantA, "app-ps-2")).toMatchObject({ email: "ps.two@example.com", payment_status: "paid", properties: { paystack_customer_code: "CUS_ps.two" } });
    // Same customer code, an unparsable email: matched through the remembered code, not email.
    const r = await pspost(tokenSource.id, { event: "subscription.disable", data: { status: "complete", subscription_code: "SUB_ps_two", plan: { name: "Growth" }, customer: { email: "bad", customer_code: "CUS_ps.two" } } }, {}, url);
    expect(r.status).toBe(200);
    expect((await contactBy(tenantA, "app-ps-2"))!.payment_status).toBe("cancelled");
    expect((await eventsOf(tenantA, "app-ps-2")).map((e) => e.event_name)).toEqual(["payment_succeeded", "subscription_cancelled"]);
  });

  it("subscription events: started and paid with the plan; not-renewing is an event only; failure is past due; a paid invoice is paid again", async () => {
    if (!dbAvailable) return;
    const url = `?token=${tokenSource.token}`;
    const email = "ps.three@example.com";
    const withCode = (event: string, status: string) => ({ ...sub(event, email, status), data: { ...sub(event, email, status).data, subscription_code: "SUB_three" } });
    await pspost(tokenSource.id, withCode("subscription.create", "active"), {}, url);
    expect(await contactBy(tenantA, email)).toMatchObject({ payment_status: "paid", properties: { plan: "Growth", paystack_subscription_code: "SUB_three" } });
    await pspost(tokenSource.id, withCode("subscription.not_renew", "non-renewing"), {}, url);
    expect((await contactBy(tenantA, email))!.payment_status).toBe("paid"); // still paid until the period ends
    await pspost(tokenSource.id, { event: "invoice.payment_failed", data: { invoice_code: "INV_3", amount: 5000, paid: false, status: "pending", created_at: nowIso(20), customer: { email, customer_code: "CUS_three" }, subscription: { subscription_code: "SUB_three" } } }, {}, url);
    expect((await contactBy(tenantA, email))!.payment_status).toBe("past_due");
    await pspost(tokenSource.id, { event: "invoice.update", data: { invoice_code: "INV_3", amount: 5000, paid: true, status: "success", paid_at: nowIso(40), customer: { email, customer_code: "CUS_three" }, transaction: { reference: "ref_inv3", currency: "NGN" } } }, {}, url);
    expect((await contactBy(tenantA, email))!.payment_status).toBe("paid");
    expect((await eventsOf(tenantA, email)).map((e) => e.event_name)).toEqual(["subscription_started", "subscription_not_renewing", "payment_failed", "invoice_paid"]);
  });

  it("a redelivery of an old event cannot undo what happened since (it is recorded once and does not touch the status)", async () => {
    if (!dbAvailable) return;
    const url = `?token=${tokenSource.token}`;
    const email = "ps.redeliver@example.com";
    const failed = { event: "invoice.payment_failed", data: { invoice_code: "INV_R", amount: 5000, paid: false, status: "pending", created_at: nowIso(-120), customer: { email, customer_code: "CUS_r" } } };
    await pspost(tokenSource.id, failed, {}, url);
    expect((await contactBy(tenantA, email))!.payment_status).toBe("past_due");
    await pspost(tokenSource.id, { event: "invoice.update", data: { invoice_code: "INV_R", amount: 5000, paid: true, paid_at: nowIso(-60), customer: { email, customer_code: "CUS_r" }, transaction: { reference: "ref_r" } } }, {}, url);
    expect((await contactBy(tenantA, email))!.payment_status).toBe("paid");
    // Paystack retries the old failure (we were down, say). It is byte-identical to the first.
    expect((await pspost(tokenSource.id, failed, {}, url)).status).toBe(200);
    expect((await contactBy(tenantA, email))!.payment_status).toBe("paid");
    expect((await eventsOf(tenantA, email)).map((e) => e.event_name)).toEqual(["payment_failed", "invoice_paid"]);
  });

  it("a late payment from before a cancellation cannot bring the subscription back to life", async () => {
    if (!dbAvailable) return;
    const url = `?token=${tokenSource.token}`;
    const email = "ps.late@example.com";
    await pspost(tokenSource.id, { ...sub("subscription.disable", email, "complete") }, {}, url); // arrives now: cancelled
    expect((await contactBy(tenantA, email))!.payment_status).toBe("cancelled");
    await pspost(tokenSource.id, charge(email, { reference: "ref_old", paid_at: nowIso(-3600) }), {}, url); // paid an hour ago, delivered late
    expect((await contactBy(tenantA, email))!.payment_status).toBe("cancelled");
    expect((await eventsOf(tenantA, email)).map((e) => e.event_name)).toContain("payment_succeeded"); // still recorded
    await pspost(tokenSource.id, charge(email, { reference: "ref_new", paid_at: nowIso(30) }), {}, url); // a genuinely newer payment: they came back
    expect((await contactBy(tenantA, email))!.payment_status).toBe("paid");
  });

  it("the same charge twice is one event; unused event types and unfinished charges are acknowledged and ignored", async () => {
    if (!dbAvailable) return;
    const url = `?token=${tokenSource.token}`;
    const body = charge("ps.dup@example.com", { reference: "ref_dup" });
    await pspost(tokenSource.id, body, {}, url);
    await pspost(tokenSource.id, body, {}, url);
    expect((await eventsOf(tenantA, "ps.dup@example.com")).filter((e) => e.event_name === "payment_succeeded")).toHaveLength(1);
    expect((await pspost(tokenSource.id, { event: "transfer.success", data: {} }, {}, url)).body).toEqual({ ok: true, ignored: true });
    expect((await pspost(tokenSource.id, charge("ps.dup@example.com", { status: "failed" }), {}, url)).body).toEqual({ ok: true, ignored: true });
  });

  it("a signature-mode source needs the secret key, seals it, and checks x-paystack-signature", async () => {
    if (!dbAvailable) return;
    const create = async (payload: unknown) => api("POST", "/v1/inbound-sources", cookieA, payload);
    expect((await create({ kind: "paystack", name: "P", config: { verification: "signature" } })).status).toBe(400);
    expect((await create({ kind: "paystack", name: "P", config: { verification: "signature" }, paystack_secret_key: "pk_live_xxxxxxxxxxxxxxxx" })).status).toBe(400);
    const res = await create({ kind: "paystack", name: "P sig", config: { verification: "signature" }, paystack_secret_key: SK });
    expect(res.status).toBe(201);
    expect(res.body.token).toBeUndefined();
    expect(res.body.source.has_signing_secret).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain(SK);
    const row = (await one(sql`SELECT secret_sealed, token_hash FROM inbound_sources WHERE id = ${res.body.source.id}`))[0]!;
    expect(row.token_hash).toBeNull();
    expect(row.secret_sealed).toBeTruthy();

    const id = res.body.source.id;
    const evt = charge("ps.sig@example.com", { reference: "ref_sig" });
    expect((await signed(id, evt)).status).toBe(200);
    expect(await contactBy(tenantA, "ps.sig@example.com")).toMatchObject({ payment_status: "paid" });
    const unauthorized = { status: 401, body: { error: "Unauthorized." } };
    expect(await signed(id, evt, "sk_test_the_wrong_key_entirely")).toEqual(unauthorized);
    expect(await pspost(id, evt)).toEqual(unauthorized); // no header
    expect(await pspost(id, JSON.stringify(evt), { "x-paystack-signature": createHmac("sha256", SK).update(JSON.stringify(evt)).digest("hex") })).toEqual(unauthorized); // wrong algorithm
    expect(await pspost(id, JSON.stringify(evt) + " ", { "x-paystack-signature": createHmac("sha512", SK).update(JSON.stringify(evt)).digest("hex") })).toEqual(unauthorized); // body changed
    // A token in the address does not stand in for the signature on a signature-mode source.
    expect((await pspost(id, evt, {}, "?token=anything")).status).toBe(401);
    expect((await api("POST", `/v1/inbound-sources/${id}/rotate-token`, cookieA)).status).toBe(400); // nothing to rotate
    const newKey = "sk_live_" + "z".repeat(20);
    expect((await api("PATCH", `/v1/inbound-sources/${id}`, cookieA, { paystack_secret_key: newKey })).status).toBe(200);
    expect((await signed(id, evt, newKey)).status).toBe(200); // the new key now verifies
    expect((await signed(id, evt)).status).toBe(401); // the old one no longer does
  });

  it("how a source verifies cannot be changed after it is made", async () => {
    if (!dbAvailable) return;
    const r = await api("PATCH", `/v1/inbound-sources/${tokenSource.id}`, cookieA, { config: { verification: "signature" } });
    expect(r.status).toBe(400);
    expect(r.body.issues[0].path).toBe("config.verification");
    expect((await api("PATCH", `/v1/inbound-sources/${tokenSource.id}`, cookieA, { paystack_secret_key: SK })).status).toBe(400); // token source holds no key
    expect((await api("PATCH", `/v1/inbound-sources/${tokenSource.id}`, cookieA, { config: { verification: "token", user_id_metadata_key: "uid" } })).status).toBe(200);
  });

  it("with the address check on, only the published Paystack addresses get through", async () => {
    if (!dbAvailable) return;
    const res = await api("POST", "/v1/inbound-sources", cookieA, { kind: "paystack", name: "P ip", config: { require_paystack_ip: true } });
    const id = res.body.source.id;
    const url = `?token=${res.body.token}`;
    const evt = charge("ps.ip@example.com", { reference: "ref_ip" });
    expect((await pspost(id, evt, {}, url, "52.31.139.75")).status).toBe(200);
    expect((await pspost(id, evt, {}, url, "::ffff:52.49.173.169")).status).toBe(200);
    expect((await pspost(id, evt, {}, url, "203.0.113.9")).status).toBe(401);
    expect((await logOf(id)).some((l) => l.status === "rejected" && /Paystack address/.test(l.summary))).toBe(true);
  });
});

// ===========================================================================
describe("receiving from Flutterwave", () => {
  beforeAll(async () => {
    if (dbAvailable) await db.execute(sql`DELETE FROM inbound_sources WHERE tenant_id = ${tenantA}`);
  });
  const nowIso = (offsetSec = 0) => new Date(Date.now() + offsetSec * 1000).toISOString();
  // Flutterwave customer ids are unique per customer, so each test person gets their own.
  const customerIds = new Map<string, number>();
  const customerIdOf = (email: string) => {
    if (!customerIds.has(email)) customerIds.set(email, 5000 + customerIds.size);
    return customerIds.get(email)!;
  };
  const chargeFw = (email: string, over: Record<string, unknown> = {}) => ({
    event: "charge.completed",
    data: { id: Math.floor(Math.random() * 1e9), tx_ref: "tx_1", amount: 100, currency: "NGN", status: "successful", payment_type: "card", created_at: nowIso(-30), customer: { id: customerIdOf(email), name: "A B", email }, ...over },
  });
  const fwpost = (id: string, body: unknown, headers: Record<string, string> = {}, query = "") =>
    app
      .inject({ method: "POST", url: `/webhooks/in/${id}${query}`, headers: { "content-type": "application/json", ...headers }, payload: JSON.stringify(body) })
      .then((r) => ({ status: r.statusCode, body: r.json() as any }));
  let src = { id: "", hash: "" };

  it("creating one gives a secret hash to paste into Flutterwave, shown once; verif-hash must equal it", async () => {
    if (!dbAvailable) return;
    const res = await api("POST", "/v1/inbound-sources", cookieA, { kind: "flutterwave", name: "Flutterwave" });
    expect(res.status).toBe(201);
    expect(res.body.token).toMatch(/^mf_fw_[A-Za-z0-9_-]{32}$/);
    expect(res.body.source).toMatchObject({ kind: "flutterwave", has_signing_secret: false, config: { user_id_metadata_key: "user_id" } });
    src = { id: res.body.source.id, hash: res.body.token };
    const row = (await one(sql`SELECT token_hash FROM inbound_sources WHERE id = ${src.id}`))[0]!;
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
    const evt = chargeFw("fw.one@example.com");
    expect((await fwpost(src.id, evt, { "verif-hash": src.hash })).status).toBe(200);
    const unauthorized = { status: 401, body: { error: "Unauthorized." } };
    expect(await fwpost(src.id, evt)).toEqual(unauthorized);
    expect(await fwpost(src.id, evt, { "verif-hash": "wrong" })).toEqual(unauthorized);
    expect(await fwpost(src.id, evt, {}, `?token=${src.hash}`)).toEqual(unauthorized); // Flutterwave sends a header, not a query
    expect(await fwpost(src.id, evt, { authorization: `Bearer ${src.hash}` })).toEqual(unauthorized);
  });

  it("a successful charge makes them paid and remembers the customer id; the same delivery twice is one event", async () => {
    if (!dbAvailable) return;
    const evt = chargeFw("fw.two@example.com", { id: 424242 });
    await fwpost(src.id, evt, { "verif-hash": src.hash });
    await fwpost(src.id, evt, { "verif-hash": src.hash });
    expect(await contactBy(tenantA, "fw.two@example.com")).toMatchObject({ payment_status: "paid", properties: { flutterwave_customer_id: String(customerIdOf("fw.two@example.com")) } });
    expect((await eventsOf(tenantA, "fw.two@example.com")).map((e) => e.event_name)).toEqual(["payment_succeeded"]);
  });

  it("a failed charge is an event only and never changes the status", async () => {
    if (!dbAvailable) return;
    await fwpost(src.id, chargeFw("fw.two@example.com", { id: 1001, status: "failed", processor_response: "insufficient funds", created_at: nowIso(-10) }), { "verif-hash": src.hash });
    expect((await contactBy(tenantA, "fw.two@example.com"))!.payment_status).toBe("paid");
    const events = await eventsOf(tenantA, "fw.two@example.com");
    expect(events.map((e) => e.event_name)).toEqual(["payment_succeeded", "payment_failed"]);
    expect(events[1]!.properties).toMatchObject({ reason: "insufficient funds" });
  });

  it("a stranger's failed charge creates a contact with the event and leaves them on the free status", async () => {
    if (!dbAvailable) return;
    await fwpost(src.id, chargeFw("fw.abandoned@example.com", { id: 2002, status: "failed" }), { "verif-hash": src.hash });
    expect(await contactBy(tenantA, "fw.abandoned@example.com")).toMatchObject({ payment_status: "free" });
  });

  it("subscription.cancelled finds the person by email alone and cancels them; a late older charge cannot undo it", async () => {
    if (!dbAvailable) return;
    const cancelled = { event: "subscription.cancelled", data: { status: "deactivated", currency: "NGN", amount: 200, customer: { email: "FW.Two@Example.com", full_name: "x" }, plan: { id: 10944, name: "month", interval: "monthly" } } };
    expect((await fwpost(src.id, cancelled, { "verif-hash": src.hash })).status).toBe(200);
    expect((await contactBy(tenantA, "fw.two@example.com"))!.payment_status).toBe("cancelled");
    await fwpost(src.id, chargeFw("fw.two@example.com", { id: 3003, created_at: nowIso(-7200) }), { "verif-hash": src.hash }); // an old charge delivered late
    expect((await contactBy(tenantA, "fw.two@example.com"))!.payment_status).toBe("cancelled");
    await fwpost(src.id, chargeFw("fw.two@example.com", { id: 3004, created_at: nowIso(60) }), { "verif-hash": src.hash }); // a new charge: they came back
    expect((await contactBy(tenantA, "fw.two@example.com"))!.payment_status).toBe("paid");
  });

  it("other events and unfinished charges are acknowledged and ignored; a body with no event name is a 400", async () => {
    if (!dbAvailable) return;
    const h = { "verif-hash": src.hash };
    expect((await fwpost(src.id, { event: "transfer.completed", data: { id: 1, status: "SUCCESSFUL" } }, h)).body).toEqual({ ok: true, ignored: true });
    expect((await fwpost(src.id, chargeFw("fw.pending@example.com", { status: "pending" }), h)).body).toEqual({ ok: true, ignored: true });
    expect((await fwpost(src.id, { id: 1, AmountRefunded: 5, status: "completed" }, h)).status).toBe(400); // a refund notice has no event name
  });

  it("rotating gives a new hash and the old one stops working", async () => {
    if (!dbAvailable) return;
    const r = await api("POST", `/v1/inbound-sources/${src.id}/rotate-token`, cookieA);
    expect(r.status).toBe(200);
    expect(r.body.token).toMatch(/^mf_fw_/);
    expect((await fwpost(src.id, chargeFw("fw.rot@example.com"), { "verif-hash": src.hash })).status).toBe(401);
    expect((await fwpost(src.id, chargeFw("fw.rot@example.com"), { "verif-hash": r.body.token })).status).toBe(200);
  });
});
