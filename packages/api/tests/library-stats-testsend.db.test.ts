/**
 * Ready-made flows, flow stats on the list, and per-step test sends. Runs against a real
 * database; the test send goes to a tiny local SMTP server so the real delivery path runs.
 *
 * Needs a reachable Postgres via DATABASE_URL, like the other *.db tests.
 * Every tenant created here has a slug starting with "libstat-".
 */
import net from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { tenantTablesInDeleteOrder } from "@loomail/db/purge";
import { LIBRARY_CATALOG } from "@loomail/core";
import { buildApp } from "../src/index.js";
import { SESSION_COOKIE_NAME } from "../src/routes/auth.js";

const TEST_DB_URL = process.env.DATABASE_URL;
if (!TEST_DB_URL) throw new Error("[library-stats-testsend.test] DATABASE_URL is not set.");

// ---- a minimal SMTP server that records what it is given -------------------------------------
interface Captured {
  to: string[];
  data: string;
}
const captured: Captured[] = [];
let smtp: net.Server;
let smtpPort = 0;

function startSmtp(): Promise<void> {
  smtp = net.createServer((sock) => {
    let inData = false;
    let buf = "";
    let cur: Captured = { to: [], data: "" };
    sock.write("220 test ESMTP\r\n");
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      for (;;) {
        if (inData) {
          const end = buf.indexOf("\r\n.\r\n");
          if (end === -1) return;
          cur.data = buf.slice(0, end);
          buf = buf.slice(end + 5);
          inData = false;
          captured.push(cur);
          cur = { to: [], data: "" };
          sock.write("250 queued\r\n");
          continue;
        }
        const nl = buf.indexOf("\r\n");
        if (nl === -1) return;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        const up = line.toUpperCase();
        if (up.startsWith("EHLO") || up.startsWith("HELO")) sock.write("250-test\r\n250 8BITMIME\r\n");
        else if (up.startsWith("MAIL FROM")) sock.write("250 ok\r\n");
        else if (up.startsWith("RCPT TO")) {
          cur.to.push(line.slice(line.indexOf("<") + 1, line.indexOf(">")));
          sock.write("250 ok\r\n");
        } else if (up === "DATA") {
          inData = true;
          sock.write("354 go\r\n");
        } else if (up.startsWith("QUIT")) {
          sock.write("221 bye\r\n");
          sock.end();
        } else sock.write("250 ok\r\n");
      }
    });
  });
  return new Promise((resolve) => smtp.listen(0, "127.0.0.1", () => {
    smtpPort = (smtp.address() as net.AddressInfo).port;
    resolve();
  }));
}

// ---- harness ---------------------------------------------------------------------------------
let pool: pg.Pool;
let db: ReturnType<typeof drizzle>;
let dbAvailable = false;
let app: FastifyInstance;
let counter = 0;

interface Tenant {
  id: string;
  session: string;
  email: string;
}

async function q<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  return (await db.execute(query)).rows as T[];
}

async function newTenant(): Promise<Tenant> {
  const slug = `libstat-${Date.now()}-${counter++}`;
  const [t] = await q<{ id: string }>(sql`INSERT INTO tenants (name, slug, plan) VALUES (${"Acme " + slug}, ${slug}, 'essential') RETURNING id`);
  const email = `${slug}@lib.example`;
  const [u] = await q<{ id: string }>(sql`INSERT INTO users (tenant_id, email, name, role) VALUES (${t!.id}::uuid, ${email}, 'Ama Mensah', 'owner') RETURNING id`);
  const [s] = await q<{ id: string }>(
    sql`INSERT INTO sessions (tenant_id, user_id, expires_at) VALUES (${t!.id}::uuid, ${u!.id}::uuid, now() + interval '1 day') RETURNING id`,
  );
  return { id: t!.id, session: s!.id, email };
}

async function cleanup(): Promise<void> {
  const ids = (await q<{ id: string }>(sql`SELECT id FROM tenants WHERE slug LIKE 'libstat-%'`)).map((r) => r.id);
  for (const id of ids) {
    for (const t of await db.transaction(async (tx) => tenantTablesInDeleteOrder(tx as never))) {
      await db.execute(sql.raw(`DELETE FROM "${t}" WHERE tenant_id = '${id}'`));
    }
    await db.execute(sql`DELETE FROM tenants WHERE id = ${id}::uuid`);
  }
}

const c = (t: Tenant) => ({ [SESSION_COOKIE_NAME]: t.session });
const install = (t: Tenant, id?: string) =>
  app.inject({ method: "POST", url: "/v1/library/install", cookies: c(t), payload: id ? { id } : {}, headers: { "content-type": "application/json" } });

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: TEST_DB_URL, connectionTimeoutMillis: 3000 });
  try {
    await pool.query("SELECT 1");
    db = drizzle(pool);
    dbAvailable = true;
  } catch (err) {
    if (process.env.CI === "true") throw new Error(`[library-stats-testsend.test] DATABASE_URL not reachable in CI: ${(err as Error).message}`);
    console.warn("[library-stats-testsend.test] DATABASE_URL not reachable - tests skipped.");
    return;
  }
  await cleanup();
  await startSmtp();
  app = await buildApp({ logger: false, db, baseUrl: "http://localhost:3000", dashboardUrl: "http://localhost:3000" });
});
beforeEach(() => {
  captured.length = 0;
  for (const k of ["PLATFORM_FROM_EMAIL", "PLATFORM_SMTP_HOST", "PLATFORM_SMTP_PORT", "PLATFORM_RESEND_API_KEY"]) delete process.env[k];
});
afterEach(async () => {
  if (dbAvailable) await cleanup();
});
afterAll(async () => {
  await app?.close();
  smtp?.close();
  await pool?.end();
});

describe("ready-made flows", () => {
  it("lists every catalog flow, installs one, refuses a repeat and an unknown id", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    const list = (await app.inject({ method: "GET", url: "/v1/library", cookies: c(t) })).json().flows as Array<{ id: string; installed: boolean; needs_event: string | null }>;
    expect(list.map((f) => f.id)).toEqual(LIBRARY_CATALOG.map((e) => e.id));
    expect(list.every((f) => f.installed === false)).toBe(true);

    const first = await install(t, "activation-nudge");
    expect(first.statusCode).toBe(200);
    expect(first.json().templatesCreated).toBe(2);
    expect((await install(t, "activation-nudge")).statusCode).toBe(409);
    expect((await install(t, "nope")).statusCode).toBe(400);
    // No id still means the welcome flow (what the home screen sends).
    expect((await install(t)).statusCode).toBe(200);

    const after = (await app.inject({ method: "GET", url: "/v1/library", cookies: c(t) })).json().flows as Array<{ id: string; installed: boolean; flow_id: string | null }>;
    expect(after.find((f) => f.id === "activation-nudge")).toMatchObject({ installed: true });
    expect(after.find((f) => f.id === "activation-nudge")!.flow_id).toBe(first.json().flowId);
    expect(after.find((f) => f.id === "win-back")!.installed).toBe(false);
  });

  it("every catalog flow installs as a ready draft that the API lets you switch on", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    for (const e of LIBRARY_CATALOG) {
      const r = await install(t, e.id);
      expect(r.statusCode, e.id).toBe(200);
      const flowId = r.json().flowId as string;
      const row = (await q<{ status: string; compile_status: string; source: string }>(sql`SELECT status, compile_status, source FROM flows WHERE id = ${flowId}::uuid`))[0]!;
      expect(row).toMatchObject({ status: "draft", compile_status: "ready", source: "library" });
      const on = await app.inject({ method: "PATCH", url: `/v1/flows/${flowId}`, cookies: c(t), payload: { status: "active" }, headers: { "content-type": "application/json" } });
      expect(on.statusCode, `${e.id}: ${on.body}`).toBe(200);
    }
    const tpls = await q<{ n: string }>(sql`SELECT count(*)::text AS n FROM templates WHERE tenant_id = ${t.id}::uuid`);
    const expected = new Set(LIBRARY_CATALOG.flatMap((e) => e.templates.map((x) => x.slug))).size;
    expect(Number(tpls[0]!.n)).toBe(expected);
  });
});

describe("flow stats", () => {
  it("reports sends, opens and health per flow, and flags a quiet or bouncing flow", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    const mk = async (id: string) => (await install(t, id)).json().flowId as string;
    const draft = await mk("win-back");
    const waiting = await mk("first-win");
    const healthy = await mk("activation-nudge");
    const bouncing = await mk("upgrade-nudge");
    const quiet = await mk("at-risk-checkin");
    for (const id of [waiting, healthy, bouncing, quiet]) {
      await app.inject({ method: "PATCH", url: `/v1/flows/${id}`, cookies: c(t), payload: { status: "active" }, headers: { "content-type": "application/json" } });
    }
    // Make the "quiet" flow old enough to be judged.
    await db.execute(sql`UPDATE flows SET updated_at = now() - interval '10 days' WHERE id = ${quiet}::uuid`);

    const [contact] = await q<{ id: string }>(sql`
      INSERT INTO contacts (tenant_id, external_id, email, lifecycle_state) VALUES (${t.id}::uuid, 'c1', 'c1@x.example', 'signed_up') RETURNING id`);
    const memb = async (flowId: string) =>
      (await q<{ id: string }>(sql`
        INSERT INTO flow_memberships (tenant_id, contact_id, flow_id, status, entered_at)
        VALUES (${t.id}::uuid, ${contact!.id}::uuid, ${flowId}::uuid, 'completed', now()) RETURNING id`))[0]!.id;
    const msg = (flowId: string, membershipId: string, feedback: string | null) =>
      db.execute(sql`
        INSERT INTO lifecycle_messages (tenant_id, contact_id, flow_id, membership_id, status, sent_at, feedback, created_at)
        VALUES (${t.id}::uuid, ${contact!.id}::uuid, ${flowId}::uuid, ${membershipId}::uuid, 'sent', now() - interval '1 day', ${feedback}, now() - interval '1 day')`);
    const mh = await memb(healthy);
    for (let i = 0; i < 4; i++) await msg(healthy, mh, i < 2 ? "opened" : null);
    const mb = await memb(bouncing);
    for (let i = 0; i < 30; i++) await msg(bouncing, mb, i < 6 ? "bounced" : null);

    const res = await app.inject({ method: "GET", url: "/v1/flows/stats", cookies: c(t) });
    expect(res.statusCode).toBe(200);
    const s = res.json().stats as Record<string, { sent_30d: number; opened_30d: number; health: string; health_note: string | null }>;
    expect(s[draft]!.health).toBe("draft");
    expect(s[waiting]!.health).toBe("waiting");
    expect(s[healthy]).toMatchObject({ sent_30d: 4, opened_30d: 2, health: "ok" });
    expect(s[bouncing]!.health).toBe("attention");
    expect(s[bouncing]!.health_note).toMatch(/bounced/);
    expect(s[quiet]!.health).toBe("quiet");
  });
});

describe("test send of a flow step", () => {
  const sendTest = (t: Tenant, flowId: string, order: number) =>
    app.inject({ method: "POST", url: `/v1/flows/${flowId}/steps/${order}/test-send`, cookies: c(t), payload: {}, headers: { "content-type": "application/json" } });

  it("says so when there is no sender at all", async () => {
    if (!dbAvailable) return;
    const t = await newTenant();
    const flowId = (await install(t, "first-win")).json().flowId as string;
    const r = await sendTest(t, flowId, 1);
    expect(r.statusCode).toBe(503);
    expect(r.json().code).toBe("no_sender");
  });

  it("sends the step, rendered for the signed-in person, only to them", async () => {
    if (!dbAvailable) return;
    process.env.PLATFORM_FROM_EMAIL = "no-reply@platform.example";
    process.env.PLATFORM_SMTP_HOST = "127.0.0.1";
    process.env.PLATFORM_SMTP_PORT = String(smtpPort);
    const t = await newTenant();
    const flowId = (await install(t, "first-win")).json().flowId as string;
    const r = await sendTest(t, flowId, 1);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().sent_to).toBe(t.email);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.to).toEqual([t.email]);
    const raw = captured[0]!.data;
    expect(raw).toMatch(/Subject: \[Test\]/i);
    expect(raw).toContain("Ama"); // {{contact.first_name}} resolved from the signed-in person
    expect(raw).toContain("This is a test of step 1");
    expect(raw).not.toContain("{{");
  });

  it("explains AI steps, unknown steps and other workspaces' flows", async () => {
    if (!dbAvailable) return;
    process.env.PLATFORM_FROM_EMAIL = "no-reply@platform.example";
    process.env.PLATFORM_SMTP_HOST = "127.0.0.1";
    process.env.PLATFORM_SMTP_PORT = String(smtpPort);
    const a = await newTenant();
    const b = await newTenant();
    const flowId = (await install(a, "first-win")).json().flowId as string;
    expect((await sendTest(a, flowId, 9)).statusCode).toBe(404);
    expect((await sendTest(b, flowId, 1)).statusCode).toBe(404); // not b's flow
    // An AI-written step has no fixed text.
    await db.execute(sql`
      UPDATE flows SET compiled_plan = jsonb_set(compiled_plan, '{steps,0}', (compiled_plan->'steps'->0) - 'template_ref' || '{"brain_instruction":"write something"}'::jsonb)
      WHERE id = ${flowId}::uuid`);
    const r = await sendTest(a, flowId, 1);
    expect(r.statusCode).toBe(422);
    expect(r.json().code).toBe("ai_step");
    expect(captured).toHaveLength(0);
  });
});
