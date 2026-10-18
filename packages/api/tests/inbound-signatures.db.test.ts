/**
 * Generic sources checked by the sender's own signature (an HMAC-SHA256 of the exact body, as Shopify, Tally, WooCommerce and
 * Cal.com send), and events named or identified by a request header. Real route, real database; the signatures are made here
 * the way those senders make them, not with the app's own code.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { createHmac, randomBytes } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { sql } from "drizzle-orm";
import { buildApp } from "../src/index.js";
import { tenants, users, sessions } from "@loomail/db/schema";

process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");
const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) throw new Error("[inbound-signatures.test] DATABASE_URL is not set.");

const SLUG = "test-signatures";
let pool: pg.Pool;
let db: ReturnType<typeof drizzle>;
let app: Awaited<ReturnType<typeof buildApp>>;
let tenant = "";
let cookie = "";
const made: string[] = [];

const api = async (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) => {
  const res = await app.inject({ method, url, headers: { cookie, ...(payload !== undefined ? { "content-type": "application/json" } : {}) }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  return { status: res.statusCode, body: res.json() as any };
};
const one = async (query: ReturnType<typeof sql>) => (await db.execute(query)).rows as Array<Record<string, any>>;
const eventsOf = async (email: string) =>
  one(sql`SELECT e.event_name FROM events e JOIN contacts c ON c.id = e.contact_id WHERE e.tenant_id = ${tenant} AND c.email = ${email} AND e.type = 'track' ORDER BY e.event_name`);

const hmac = (secret: string, body: string, enc: "hex" | "base64" = "base64") => createHmac("sha256", secret).update(body).digest(enc);
const post = async (sourceId: string, body: string, headers: Record<string, string>, contentType = "application/json", query = "") => {
  const res = await app.inject({ method: "POST", url: `/webhooks/in/${sourceId}${query}`, headers: { "content-type": contentType, ...headers }, payload: body });
  return { status: res.statusCode, body: res.json() as any };
};

async function newSource(config: Record<string, unknown>, secret?: string) {
  const res = await api("POST", "/v1/inbound-sources", { kind: "generic", name: "Signed", config, ...(secret !== undefined ? { signing_secret: secret } : {}) });
  if (res.status === 201) made.push(res.body.source.id);
  return res;
}

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: DB_URL, connectionTimeoutMillis: 3000 });
  db = drizzle(pool);
  const t = sql`(SELECT id FROM tenants WHERE slug = ${SLUG})`;
  for (const table of ["inbound_source_log", "inbound_sources", "contact_conflicts", "lifecycle_transitions", "events", "contacts", "sessions", "users"]) {
    await db.execute(sql`DELETE FROM ${sql.raw(table)} WHERE tenant_id IN ${t}`);
  }
  await db.execute(sql`DELETE FROM tenants WHERE slug = ${SLUG}`);
  const [tn] = await db.insert(tenants).values({ name: SLUG, slug: SLUG, plan: "free" }).returning({ id: tenants.id });
  const [u] = await db.insert(users).values({ tenantId: tn!.id, email: `owner@${SLUG}.test`, role: "owner" }).returning({ id: users.id });
  const [s] = await db.insert(sessions).values({ tenantId: tn!.id, userId: u!.id, expiresAt: new Date(Date.now() + 86400_000) }).returning({ id: sessions.id });
  tenant = tn!.id;
  cookie = `loomail_session=${s!.id}`;
  app = await buildApp({ db, logger: false });
  await app.ready();
});
afterEach(async () => {
  for (const id of made.splice(0)) {
    await db.execute(sql`DELETE FROM inbound_source_log WHERE source_id = ${id}`);
    await db.execute(sql`DELETE FROM inbound_sources WHERE id = ${id}`);
  }
});
afterAll(async () => {
  await app?.close();
  await pool?.end();
});

const SECRET = "shpss_" + randomBytes(16).toString("hex");
const SHOPIFY = {
  email_path: "email",
  event_name_header: "X-Shopify-Topic",
  event_id_header: "X-Shopify-Event-Id",
  verification: "signature",
  signature_header: "X-Shopify-Hmac-Sha256",
  signature_encoding: "base64",
  trait_paths: { first_name: "first_name" },
};
const customer = (email: string) => JSON.stringify({ id: 207119551, email, first_name: "Bob" });

describe("making a source that checks signatures", () => {
  it("keeps the secret sealed, makes no token, and never returns the secret", async () => {
    const r = await newSource(SHOPIFY, SECRET);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.token).toBeUndefined();
    expect(r.body.source).toMatchObject({ has_signing_secret: true, token_prefix: null });
    expect(JSON.stringify(r.body)).not.toContain(SECRET);
    const stored = (await one(sql`SELECT secret_sealed, token_hash FROM inbound_sources WHERE id = ${r.body.source.id}`))[0]!;
    expect(stored.token_hash).toBeNull();
    expect(stored.secret_sealed).toBeTruthy();
    expect(String(stored.secret_sealed)).not.toContain(SECRET);
  });
  it("needs the secret, and refuses a secret for a token source", async () => {
    const noSecret = await newSource(SHOPIFY);
    expect(noSecret.status).toBe(400);
    expect(JSON.stringify(noSecret.body)).toMatch(/signing secret/i);
    const tokenSource = await newSource({ email_path: "email", event_name: "x" }, SECRET);
    expect(tokenSource.status).toBe(400);
    const noHeader = await newSource({ email_path: "email", event_name: "x", verification: "signature" }, SECRET);
    expect(noHeader.status).toBe(400);
  });
  it("cannot change how it checks calls, but can take a new secret", async () => {
    const sig = await newSource(SHOPIFY, SECRET);
    const id = sig.body.source.id as string;
    const toToken = await api("PATCH", `/v1/inbound-sources/${id}`, { config: { email_path: "email", event_name: "x" } });
    expect(toToken.status).toBe(400);
    const tok = await newSource({ email_path: "email", event_name: "x" });
    const toSig = await api("PATCH", `/v1/inbound-sources/${tok.body.source.id}`, { config: { ...SHOPIFY } });
    expect(toSig.status).toBe(400);
    expect((await api("PATCH", `/v1/inbound-sources/${tok.body.source.id}`, { signing_secret: "x" })).status).toBe(400);
    const rotated = await api("PATCH", `/v1/inbound-sources/${id}`, { signing_secret: "a-new-secret" });
    expect(rotated.status).toBe(200);
    expect((await api("POST", `/v1/inbound-sources/${id}/rotate-token`)).status).toBe(400); // there is no token
  });
});

describe("receiving from a sender that signs", () => {
  it("accepts a correctly signed body and records the person, the header-named event and the trait", async () => {
    const { body: made1 } = await newSource(SHOPIFY, SECRET);
    const body = customer("sig1@example.com");
    const r = await post(made1.source.id, body, { "x-shopify-hmac-sha256": hmac(SECRET, body), "x-shopify-topic": "customers/create", "x-shopify-event-id": "evt-1" });
    expect(r, JSON.stringify(r.body)).toMatchObject({ status: 200, body: { ok: true } });
    expect((await eventsOf("sig1@example.com")).map((e) => e.event_name)).toEqual(["customers/create"]);
    expect((await one(sql`SELECT properties FROM contacts WHERE tenant_id = ${tenant} AND email = 'sig1@example.com'`))[0]!.properties).toMatchObject({ first_name: "Bob" });
  });

  it("refuses, with the one 401, a wrong signature, no signature, a body changed in flight, another header and the token", async () => {
    const { body: s } = await newSource(SHOPIFY, SECRET);
    const body = customer("sig2@example.com");
    const good = { "x-shopify-hmac-sha256": hmac(SECRET, body), "x-shopify-topic": "customers/create" };
    const results = await Promise.all([
      post(s.source.id, body, { ...good, "x-shopify-hmac-sha256": hmac("not-the-secret", body) }),
      post(s.source.id, body, { "x-shopify-topic": "customers/create" }),
      post(s.source.id, body.replace("sig2", "sig3"), good),
      post(s.source.id, body, { "x-other-signature": hmac(SECRET, body), "x-shopify-topic": "customers/create" }),
      post(s.source.id, body, { authorization: "Bearer mf_in_whatever", "x-shopify-topic": "customers/create" }, "application/json", "?token=mf_in_whatever"),
      post(s.source.id, body, { ...good, "x-shopify-hmac-sha256": hmac(SECRET, body, "hex") }), // wrong encoding for a base64 source
    ]);
    for (const r of results) expect(r).toMatchObject({ status: 401, body: { error: "Unauthorized." } });
    expect(await eventsOf("sig2@example.com")).toHaveLength(0);
    expect(await eventsOf("sig3@example.com")).toHaveLength(0);
  });

  it("a disabled source refuses a correct signature", async () => {
    const { body: s } = await newSource(SHOPIFY, SECRET);
    await api("PATCH", `/v1/inbound-sources/${s.source.id}`, { enabled: false });
    const body = customer("sig4@example.com");
    expect((await post(s.source.id, body, { "x-shopify-hmac-sha256": hmac(SECRET, body), "x-shopify-topic": "customers/create" })).status).toBe(401);
  });

  it("a new secret takes over at once: the old signature stops working", async () => {
    const { body: s } = await newSource(SHOPIFY, SECRET);
    await api("PATCH", `/v1/inbound-sources/${s.source.id}`, { signing_secret: "second-secret" });
    const body = customer("sig5@example.com");
    const topic = { "x-shopify-topic": "customers/create" };
    expect((await post(s.source.id, body, { ...topic, "x-shopify-hmac-sha256": hmac(SECRET, body) })).status).toBe(401);
    expect((await post(s.source.id, body, { ...topic, "x-shopify-hmac-sha256": hmac("second-secret", body) })).status).toBe(200);
  });

  it("takes the prefix a sender puts before the signature, and hex when the source says hex", async () => {
    const { body: s } = await newSource({ email_path: "email", event_name: "ping", verification: "signature", signature_header: "X-Hub-Signature-256", signature_encoding: "hex", signature_prefix: "sha256=" }, SECRET);
    const body = JSON.stringify({ email: "sig6@example.com" });
    expect((await post(s.source.id, body, { "x-hub-signature-256": "sha256=" + hmac(SECRET, body, "hex") })).status).toBe(200);
    expect((await post(s.source.id, body, { "x-hub-signature-256": hmac(SECRET, body, "hex") })).status).toBe(200); // the prefix is only stripped when present: the MAC itself still has to match
    expect((await post(s.source.id, body, { "x-hub-signature-256": "sha256=" + hmac(SECRET, body, "base64") })).status).toBe(401); // base64 where hex was set
    expect((await post(s.source.id, body, { "x-hub-signature-256": "sha256=" + hmac("wrong", body, "hex") })).status).toBe(401);
  });

  it("signs the exact bytes, so a form-encoded body works too, and a pretty-printed copy of JSON does not", async () => {
    const { body: s } = await newSource({ email_path: "email", event_name: "form", verification: "signature", signature_header: "X-Signature", signature_encoding: "either" }, SECRET);
    const form = "email=sig7%40example.com&plan=pro";
    expect((await post(s.source.id, form, { "x-signature": hmac(SECRET, form, "hex") }, "application/x-www-form-urlencoded")).status).toBe(200);
    const json = JSON.stringify({ email: "sig8@example.com" });
    const pretty = JSON.stringify({ email: "sig8@example.com" }, null, 2);
    expect((await post(s.source.id, pretty, { "x-signature": hmac(SECRET, json, "hex") })).status).toBe(401);
  });
});

describe("naming events and ids from headers", () => {
  it("one source records different topics as different events, each once however often it is sent", async () => {
    const { body: s } = await newSource(SHOPIFY, SECRET);
    const body = customer("topics@example.com");
    const send = (topic: string, id: string) => post(s.source.id, body, { "x-shopify-hmac-sha256": hmac(SECRET, body), "x-shopify-topic": topic, "x-shopify-event-id": id });
    await send("customers/create", "e-1");
    await send("customers/create", "e-1"); // a retry
    await send("customers/update", "e-2");
    await send("customers/update", "e-3"); // a second update is a second event
    expect((await eventsOf("topics@example.com")).map((e) => e.event_name)).toEqual(["customers/create", "customers/update", "customers/update"]);
  });

  it("the same sender id for two different events is not mistaken for a repeat (a booking created, then cancelled)", async () => {
    const { body: s } = await newSource({ email_path: "payload.attendees.0.email", event_name_path: "triggerEvent", event_id_path: "payload.uid", verification: "signature", signature_header: "X-Cal-Signature-256", signature_encoding: "either" }, SECRET);
    const make = (trigger: string) => JSON.stringify({ triggerEvent: trigger, payload: { uid: "booking-9", attendees: [{ email: "cal@example.com", name: "Guest" }] } });
    const send = (trigger: string) => {
      const body = make(trigger);
      return post(s.source.id, body, { "x-cal-signature-256": hmac(SECRET, body, "hex") });
    };
    await send("BOOKING_CREATED");
    await send("BOOKING_CREATED"); // a retry
    await send("BOOKING_CANCELLED");
    expect((await eventsOf("cal@example.com")).map((e) => e.event_name)).toEqual(["BOOKING_CANCELLED", "BOOKING_CREATED"]);
  });

  it("an X-Loomail-Event-Id the sender chose wins over the settings, and is used exactly as sent", async () => {
    const { body: s } = await newSource(SHOPIFY, SECRET);
    const body = customer("own@example.com");
    const send = (shopifyId: string) => post(s.source.id, body, { "x-shopify-hmac-sha256": hmac(SECRET, body), "x-shopify-topic": "customers/create", "x-shopify-event-id": shopifyId, "x-loomail-event-id": "mine" });
    await send("a");
    await send("b"); // a different Shopify id, the same Loomail id: a repeat
    expect(await eventsOf("own@example.com")).toHaveLength(1);
  });

  it("without the topic header there is no event name: the request is acknowledged and ignored", async () => {
    const { body: s } = await newSource({ email_path: "email", event_name_header: "X-Topic", verification: "signature", signature_header: "X-Sig" }, SECRET);
    const body = JSON.stringify({ email: "notopic@example.com" });
    const r = await post(s.source.id, body, { "x-sig": hmac(SECRET, body) });
    expect(r).toMatchObject({ status: 200, body: { ok: true, ignored: true } });
    expect(await eventsOf("notopic@example.com")).toHaveLength(0);
  });
});
