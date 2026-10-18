/**
 * The ready-made tool settings in the dashboard (apps/dashboard/src/inbound-presets.ts), run against the real receiving route.
 * Each preset carries a sample of what its tool sends, copied from the tool's documentation. For every one: save a source with
 * the preset's settings (as the dashboard builds them), post the sample the way the tool would (JSON, or form fields for
 * Gumroad) with the token in the address, and check the right person, event and traits land. A retry of a preset that names an
 * event id must be recorded once.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHmac, randomBytes } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { sql } from "drizzle-orm";
import { buildApp } from "../src/index.js";
import { tenants, users, sessions } from "@loomail/db/schema";
import { getPath } from "../src/inbound/mapping.js";
import { TOOL_PRESETS } from "../../../apps/dashboard/src/inbound-presets.js";
import { buildGenericConfig, emptyGenericForm } from "../../../apps/dashboard/src/inbound-sources.js";

process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");
const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) throw new Error("[inbound-presets.test] DATABASE_URL is not set.");

const SLUG = "test-presets";
let pool: pg.Pool;
let db: ReturnType<typeof drizzle>;
let app: Awaited<ReturnType<typeof buildApp>>;
let tenant = "";
let cookie = "";

const one = async (query: ReturnType<typeof sql>) => (await db.execute(query)).rows as Array<Record<string, any>>;

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

afterAll(async () => {
  await app?.close();
  await pool?.end();
});

describe.each(TOOL_PRESETS.map((p) => [p.label, p] as const))("preset: %s", (_label, preset) => {
  let sourceId = "";
  let token = "";

  const send = async () => {
    const form = preset.sampleAs === "form";
    const body = form ? new URLSearchParams(preset.sample as Record<string, string>).toString() : JSON.stringify(preset.sample);
    const res = await app.inject({
      method: "POST",
      url: `/webhooks/in/${sourceId}?token=${token}`,
      headers: { "content-type": form ? "application/x-www-form-urlencoded" : "application/json", ...(preset.sampleHeaders ?? {}) },
      payload: body,
    });
    return { status: res.statusCode, body: res.json() as any };
  };
  const eventCount = async () =>
    Number((await one(sql`SELECT count(*)::int AS n FROM events e JOIN contacts c ON c.id = e.contact_id WHERE e.tenant_id = ${tenant} AND c.email = ${preset.expect.email} AND e.event_name = ${preset.expect.event} AND e.type = 'track'`))[0]!.n);

  beforeAll(async () => {
    // Make room: a workspace holds a limited number of sources.
    await db.execute(sql`DELETE FROM inbound_source_log WHERE tenant_id = ${tenant}`);
    await db.execute(sql`DELETE FROM inbound_sources WHERE tenant_id = ${tenant}`);
    const built = buildGenericConfig({ ...emptyGenericForm(), ...preset.form });
    if (!built.ok) throw new Error(built.problems.join(" "));
    const res = await app.inject({ method: "POST", url: "/v1/inbound-sources", headers: { cookie, "content-type": "application/json" }, payload: { kind: "generic", name: preset.label, config: built.config } });
    expect(res.statusCode, res.body).toBe(201);
    sourceId = res.json().source.id;
    token = res.json().token;
  });

  it("the settings the dashboard builds are accepted, and the tool's sample is recorded with the token in the address", async () => {
    const r = await send();
    expect(r, JSON.stringify(r.body)).toMatchObject({ status: 200, body: { ok: true } });
    const contact = (await one(sql`SELECT email, name, properties FROM contacts WHERE tenant_id = ${tenant} AND email = ${preset.expect.email}`))[0];
    expect(contact, "the person should exist").toBeTruthy();
    expect(await eventCount()).toBe(1);
  });

  it("reads each trait the preset names from the sample", async () => {
    for (const t of preset.form.traits ?? []) {
      expect(getPath(preset.sample, t.path), `${t.name} <- ${t.path}`).not.toBeUndefined();
    }
    const contact = (await one(sql`SELECT name, properties FROM contacts WHERE tenant_id = ${tenant} AND email = ${preset.expect.email}`))[0]!;
    for (const t of preset.form.traits ?? []) {
      const value = getPath(preset.sample, t.path);
      const stored = t.name === "name" ? contact.name : contact.properties?.[t.name];
      expect(String(stored), t.name).toBe(String(value));
    }
  });

  if (preset.form.eventIdPath) {
    it("a retry of the same delivery is recorded once", async () => {
      expect(await send()).toMatchObject({ status: 200 });
      expect(await send()).toMatchObject({ status: 200 });
      expect(await eventCount()).toBe(1);
    });
  }

  if (preset.signature) {
    it("can be checked by the tool's own signature instead of a token, with the settings the dashboard builds", async () => {
      const sig = preset.signature!;
      const built = buildGenericConfig({
        ...emptyGenericForm(),
        ...preset.form,
        verification: "signature",
        signatureHeader: sig.header,
        signatureEncoding: sig.encoding,
        signaturePrefix: sig.prefix ?? "",
      });
      if (!built.ok) throw new Error(built.problems.join(" "));
      const secret = "test-signing-secret-" + preset.id;
      const created = await app.inject({ method: "POST", url: "/v1/inbound-sources", headers: { cookie, "content-type": "application/json" }, payload: { kind: "generic", name: `${preset.label} signed`, config: built.config, signing_secret: secret } });
      expect(created.statusCode, created.body).toBe(201);
      expect(created.json().token).toBeUndefined();
      const id = created.json().source.id as string;
      const body = JSON.stringify(preset.sample);
      const sign = (key: string) => createHmac("sha256", key).update(body).digest(sig.encoding === "base64" ? "base64" : "hex");
      const headers = { "content-type": "application/json", ...(preset.sampleHeaders ?? {}) };
      const before = await eventCount();
      const bad = await app.inject({ method: "POST", url: `/webhooks/in/${id}`, headers: { ...headers, [sig.header]: (sig.prefix ?? "") + sign("not-the-secret") }, payload: body });
      expect(bad.statusCode).toBe(401);
      const good = await app.inject({ method: "POST", url: `/webhooks/in/${id}`, headers: { ...headers, [sig.header]: (sig.prefix ?? "") + sign(secret) }, payload: body });
      expect(good.statusCode, good.body).toBe(200);
      expect(await eventCount()).toBe(before + 1);
    });
  }

  it("is refused without the token", async () => {
    const res = await app.inject({ method: "POST", url: `/webhooks/in/${sourceId}`, headers: { "content-type": "application/json", ...(preset.sampleHeaders ?? {}) }, payload: JSON.stringify(preset.sample) });
    expect(res.statusCode).toBe(401);
  });
});
