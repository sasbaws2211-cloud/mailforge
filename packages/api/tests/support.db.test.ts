/**
 * Support requests, end to end over HTTP: a customer opens one from the dashboard, the operator answers it in the admin console,
 * the answer is emailed back. Real routes, real database, a recording email sender.
 *
 * Needs a reachable Postgres via DATABASE_URL. Every tenant created here has a slug starting with "sup-".
 */
import { randomBytes } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { sql } from "drizzle-orm";
import type { TransportAdapter, TransportSendParams, TransportSendResult } from "@loomail/adapters";
import { purgeWorkspace } from "@loomail/db/purge";
import { tenants, users, sessions } from "@loomail/db/schema";
import { buildApp } from "../src/index.js";
import { cleanPagePath, newTicketSchema } from "../src/support/logic.js";

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) throw new Error("[support.test] DATABASE_URL is not set.");

const ADMIN_EMAIL = "boss@sup.example";
const SUPPORT_EMAIL = "help@sup.example";

class Outbox implements TransportAdapter {
  sent: TransportSendParams[] = [];
  mode: "ok" | "fail" | "throw" = "ok";
  async send(p: TransportSendParams): Promise<TransportSendResult> {
    if (this.mode === "throw") throw new Error("smtp down");
    if (this.mode === "fail") return { success: false, error: "rejected" } as TransportSendResult;
    this.sent.push(p);
    return { success: true, providerMessageId: `m-${this.sent.length}` } as TransportSendResult;
  }
}
const outbox = new Outbox();

let pool: pg.Pool;
let db: ReturnType<typeof drizzle>;
let app: Awaited<ReturnType<typeof buildApp>>;
let appNoMail: Awaited<ReturnType<typeof buildApp>>;

interface Who {
  tenant: string;
  user: string;
  email: string;
  cookie: string;
}
const SLUGS = ["sup-a", "sup-b", "sup-c", "sup-d", "sup-ops"];
const who: Record<string, Who> = {};

async function member(slug: string, name: string, email: string, role: "owner" | "member", tenantId?: string): Promise<Who> {
  let tid = tenantId;
  if (!tid) {
    const [t] = await db.insert(tenants).values({ name, slug, plan: "free" }).returning({ id: tenants.id });
    tid = t!.id;
  }
  const [u] = await db.insert(users).values({ tenantId: tid, email, role }).returning({ id: users.id });
  const [s] = await db.insert(sessions).values({ tenantId: tid, userId: u!.id, expiresAt: new Date(Date.now() + 86400_000) }).returning({ id: sessions.id });
  return { tenant: tid, user: u!.id, email, cookie: `loomail_session=${s!.id}` };
}

const call = async (which: "mail" | "nomail", method: "GET" | "POST", url: string, cookie: string | null, payload?: unknown) => {
  const res = await (which === "mail" ? app : appNoMail).inject({
    method,
    url,
    headers: { ...(cookie ? { cookie } : {}), ...(payload !== undefined ? { "content-type": "application/json" } : {}) },
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
  return { status: res.statusCode, body: res.json() as any, headers: res.headers };
};
const customer = (w: Who, method: "GET" | "POST", url: string, payload?: unknown) => call("mail", method, `/v1/support${url}`, w.cookie, payload);
const admin = (method: "GET" | "POST", url: string, payload?: unknown, who_ = "ops") => call("mail", method, `/v1/admin/support${url}`, who[who_]!.cookie, payload);
const one = async (query: ReturnType<typeof sql>) => (await db.execute(query)).rows as Array<Record<string, any>>;
const flush = () => new Promise((r) => setTimeout(r, 60)); // the notice to the operator is sent after the response

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: DB_URL, connectionTimeoutMillis: 3000 });
  db = drizzle(pool);
  for (const slug of SLUGS) {
    const t = sql`(SELECT id FROM tenants WHERE slug = ${slug})`;
    for (const table of ["support_messages", "support_tickets", "admin_audit_log", "sessions", "users"]) {
      await db.execute(sql`DELETE FROM ${sql.raw(table)} WHERE tenant_id IN ${t}`);
    }
    await db.execute(sql`DELETE FROM tenants WHERE slug = ${slug}`);
  }
  who.a1 = await member("sup-a", "Acme Co", "owner@acme.example", "owner");
  who.a2 = await member("sup-a", "Acme Co", "mate@acme.example", "member", who.a1.tenant);
  who.b1 = await member("sup-b", "Bravo Ltd", "owner@bravo.example", "owner");
  who.c1 = await member("sup-c", "Charlie Inc", "owner@charlie.example", "owner");
  who.d1 = await member("sup-d", "Delta Corp", "owner@delta.example", "owner");
  who.ops = await member("sup-ops", "Operator", ADMIN_EMAIL, "owner");
  await db.execute(sql`UPDATE tenants SET suspended_at = now(), suspended_reason = 'test' WHERE id = ${who.d1.tenant}`);

  process.env.LOOMAIL_PLATFORM_ADMINS = ADMIN_EMAIL;
  process.env.LOOMAIL_SUPPORT_EMAIL = SUPPORT_EMAIL;
  process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");
  const base = { logger: false as const, db, baseUrl: "http://localhost:3000", dashboardUrl: "http://localhost:3000" };
  app = await buildApp({ ...base, noticeTransports: [{ adapter: outbox, fromEmail: "no-reply@platform.example", fromName: "Loomail" }] });
  appNoMail = await buildApp(base);
  await app.ready();
  await appNoMail.ready();
});

afterAll(async () => {
  await app?.close();
  await appNoMail?.close();
  await pool?.end();
});
beforeEach(() => {
  outbox.sent = [];
  outbox.mode = "ok";
});

let teammates = 0;
/** A new person in workspace A, so tests that open several requests do not run into the per-person hourly limit. */
const opener = () => member("sup-a", "Acme Co", `person${++teammates}@acme.example`, "member", who.a1!.tenant);

const ticketBody = (over: Record<string, unknown> = {}) => ({ subject: "Cannot connect my database", message: "The SSH tunnel says the host key does not match.", category: "bug", page_url: "/integrate", ...over });

describe("the rules", () => {
  it("keeps only a path inside the dashboard as the page", () => {
    expect(cleanPagePath("/flows/123?tab=a")).toBe("/flows/123?tab=a");
    for (const bad of ["javascript:alert(1)", "//evil.example/x", "https://evil.example", "flows", "/has space", "/" + "a".repeat(400), 5, null, undefined]) expect(cleanPagePath(bad), String(bad)).toBeNull();
  });
  it("trims, joins a multi-line subject, and refuses what is too short or too long", () => {
    expect(newTicketSchema.parse({ subject: "  Hello\nthere  ", message: "  a message  " })).toMatchObject({ subject: "Hello there", message: "a message", category: "question" });
    expect(newTicketSchema.safeParse({ subject: "hi", message: "long enough" }).success).toBe(false);
    expect(newTicketSchema.safeParse({ subject: "Fine subject", message: "abcd" }).success).toBe(false);
    expect(newTicketSchema.safeParse({ subject: "x".repeat(151), message: "long enough" }).success).toBe(false);
    expect(newTicketSchema.safeParse({ subject: "Fine subject", message: "x".repeat(5001) }).success).toBe(false);
    expect(newTicketSchema.safeParse({ subject: "Fine subject", message: "long enough", category: "nope" }).success).toBe(false);
    expect(newTicketSchema.safeParse({ subject: "Fine subject", message: "long enough", extra: 1 }).success).toBe(false);
  });
});

describe("opening a request", () => {
  it("needs a signed-in user", async () => {
    expect((await call("mail", "POST", "/v1/support/tickets", null, ticketBody())).status).toBe(401);
    expect((await call("mail", "GET", "/v1/support/tickets", null)).status).toBe(401);
  });

  it("saves it with its first message, and emails the operator with the requester as the reply address", async () => {
    const r = await customer(who.a1!, "POST", "/tickets", ticketBody());
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.ticket).toMatchObject({ subject: "Cannot connect my database", category: "bug", status: "open", page_url: "/integrate", requester: "owner@acme.example", last_message_by: "customer" });
    const stored = await one(sql`SELECT t.tenant_id, t.user_id, m.author, m.author_email, m.body FROM support_tickets t JOIN support_messages m ON m.ticket_id = t.id WHERE t.id = ${r.body.ticket.id}`);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ tenant_id: who.a1!.tenant, user_id: who.a1!.user, author: "customer", author_email: "owner@acme.example" });
    await flush();
    expect(outbox.sent).toHaveLength(1);
    const mail = outbox.sent[0]!;
    expect(mail).toMatchObject({ to: SUPPORT_EMAIL, replyTo: "owner@acme.example", from: "no-reply@platform.example" });
    expect(mail.subject).toBe("[Support] Cannot connect my database (Acme Co)");
    expect(mail.bodyText).toContain("The SSH tunnel says the host key does not match.");
    expect(mail.bodyText).toContain(`http://localhost:3000/admin/support/${r.body.ticket.id}`);
  });

  it("escapes what the customer typed in the email, and keeps it as plain text everywhere", async () => {
    const evil = `<script>alert("x")</script> & <img src=x onerror=1>`;
    const r = await customer(who.a1!, "POST", "/tickets", ticketBody({ subject: "Plain subject here", message: evil, page_url: "javascript:alert(1)" }));
    expect(r.status).toBe(201);
    expect(r.body.ticket.page_url).toBeNull();
    await flush();
    const mail = outbox.sent.at(-1)!;
    expect(mail.bodyHtml).not.toContain("<script>");
    expect(mail.bodyHtml).not.toContain("<img");
    expect(mail.bodyHtml).toContain("&lt;script&gt;");
    expect(mail.bodyText).toContain(evil); // the text copy is plain text
    const back = await customer(who.a1!, "GET", `/tickets/${r.body.ticket.id}`);
    expect(back.body.messages[0].body).toBe(evil);
  });

  it("is still saved when no support address or no sender is configured", async () => {
    const r = await call("nomail", "POST", "/v1/support/tickets", who.b1!.cookie, ticketBody({ subject: "Saved without any email" }));
    expect(r.status).toBe(201);
    expect(outbox.sent).toHaveLength(0);
    const saved = await one(sql`SELECT 1 FROM support_tickets WHERE id = ${r.body.ticket.id}`);
    expect(saved).toHaveLength(1);
    // and with a sender that fails
    outbox.mode = "throw";
    expect((await customer(who.b1!, "POST", "/tickets", ticketBody({ subject: "Sender is down right now" }))).status).toBe(201);
    outbox.mode = "fail";
    expect((await customer(who.b1!, "POST", "/tickets", ticketBody({ subject: "Sender refuses the mail" }))).status).toBe(201);
    await flush();
  });

  it("says what is wrong with a bad request", async () => {
    for (const bad of [{ subject: "hi", message: "long enough" }, { subject: "Fine subject", message: "" }, { subject: "Fine subject", message: "long enough", category: "x" }, {}, { subject: 5, message: [] }]) {
      const r = await customer(who.b1!, "POST", "/tickets", bad);
      expect(r.status, JSON.stringify(bad)).toBe(400);
      expect(r.body.issues.length).toBeGreaterThan(0);
    }
  });

  it("works for a suspended workspace (the time they most need it), when its other pages do not", async () => {
    const r = await customer(who.d1!, "POST", "/tickets", ticketBody({ subject: "Why is my workspace off?" }));
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect((await customer(who.d1!, "GET", "/tickets")).status).toBe(200);
    const other = await call("mail", "GET", "/v1/segments", who.d1!.cookie);
    expect(other.status).toBe(403);
  });
});

describe("a workspace's own requests", () => {
  it("lists a workspace's requests for everyone in it, and none of another workspace's", async () => {
    const mine = await customer(who.a1!, "POST", "/tickets", ticketBody({ subject: "Owner's question here" }));
    const list = await customer(who.a2!, "GET", "/tickets"); // a teammate
    expect(list.body.tickets.map((t: any) => t.id)).toContain(mine.body.ticket.id);
    const bravo = await customer(who.b1!, "GET", "/tickets");
    expect(bravo.body.tickets.map((t: any) => t.id)).not.toContain(mine.body.ticket.id);
  });

  it("refuses another workspace reading, replying to or closing a request, with a plain 404", async () => {
    const mine = await customer(await opener(), "POST", "/tickets", ticketBody({ subject: "Private to Acme here" }));
    const id = mine.body.ticket.id;
    expect((await customer(who.b1!, "GET", `/tickets/${id}`)).status).toBe(404);
    expect((await customer(who.b1!, "POST", `/tickets/${id}/reply`, { message: "hello there" })).status).toBe(404);
    expect((await customer(who.b1!, "POST", `/tickets/${id}/close`)).status).toBe(404);
    expect((await customer(who.a1!, "GET", "/tickets/not-a-uuid")).status).toBe(404);
    const still = await one(sql`SELECT status FROM support_tickets WHERE id = ${id}`);
    expect(still[0]!.status).toBe("open");
  });

  it("a customer's reply reopens an answered or closed request; closing it is the customer's choice too", async () => {
    const t = await customer(await opener(), "POST", "/tickets", ticketBody({ subject: "Reopen me when needed" }));
    const id = t.body.ticket.id;
    await admin("POST", `/${id}/reply`, { message: "We have fixed it.", close: true });
    expect((await one(sql`SELECT status FROM support_tickets WHERE id = ${id}`))[0]!.status).toBe("closed");
    const again = await customer(who.a2!, "POST", `/tickets/${id}/reply`, { message: "It broke again, sorry." });
    expect(again.body.ticket).toMatchObject({ status: "open", last_message_by: "customer", closed_at: null });
    const closed = await customer(who.a1!, "POST", `/tickets/${id}/close`);
    expect(closed.body.ticket.status).toBe("closed");
    expect((await customer(who.a1!, "POST", `/tickets/${id}/close`)).body.ticket.status).toBe("closed"); // closing twice is fine
  });
});

describe("abuse limits", () => {
  it("allows a few new requests an hour per person, then asks them to wait", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) codes.push((await customer(who.c1!, "POST", "/tickets", ticketBody({ subject: `Flood request ${i} here` }))).status);
    expect(codes.slice(0, 5)).toEqual([201, 201, 201, 201, 201]);
    expect(codes.slice(5)).toEqual([429, 429]);
    const limited = await customer(who.c1!, "POST", "/tickets", ticketBody());
    expect(limited.headers["retry-after"]).toBeTruthy();
    // another person, another workspace: unaffected
    expect((await customer(who.b1!, "POST", "/tickets", ticketBody({ subject: "Someone else is fine" }))).status).toBe(201);
  });

  it("caps the requests a workspace has waiting at once", async () => {
    await db.execute(sql`DELETE FROM support_messages WHERE tenant_id = ${who.b1!.tenant}`);
    await db.execute(sql`DELETE FROM support_tickets WHERE tenant_id = ${who.b1!.tenant}`);
    for (let i = 0; i < 20; i++) await db.execute(sql`INSERT INTO support_tickets (tenant_id, email, subject) VALUES (${who.b1!.tenant}, 'owner@bravo.example', ${"waiting " + i})`);
    const r = await customer(who.b1!, "POST", "/tickets", ticketBody({ subject: "One over the limit" }));
    expect(r.status).toBe(409);
    // closing one makes room
    await db.execute(sql`UPDATE support_tickets SET status = 'closed' WHERE id = (SELECT id FROM support_tickets WHERE tenant_id = ${who.b1!.tenant} LIMIT 1)`);
    expect((await customer(who.b1!, "POST", "/tickets", ticketBody({ subject: "Now there is room" }))).status).toBe(201);
  });
});

describe("the admin console", () => {
  it("is a plain 404 for everyone who is not a platform admin, workspace owners included", async () => {
    const t = await customer(await opener(), "POST", "/tickets", ticketBody({ subject: "Nobody else may see" }));
    for (const w of [who.a1!, who.b1!]) {
      expect((await call("mail", "GET", "/v1/admin/support", w.cookie)).status).toBe(404);
      expect((await call("mail", "GET", `/v1/admin/support/${t.body.ticket.id}`, w.cookie)).status).toBe(404);
      expect((await call("mail", "POST", `/v1/admin/support/${t.body.ticket.id}/reply`, w.cookie, { message: "I am not staff" })).status).toBe(404);
    }
    expect((await call("mail", "GET", "/v1/admin/support", null)).status).toBe(401); // not signed in at all: the app's own gate
  });

  it("lists requests across workspaces, longest-waiting first, with counts, and can filter and search", async () => {
    const list = await admin("GET", "?status=open&limit=100");
    expect(list.status).toBe(200);
    expect(list.body.counts.open).toBeGreaterThan(0);
    const times = list.body.tickets.map((t: any) => Date.parse(t.last_message_at));
    expect([...times].sort((a, b) => a - b)).toEqual(times); // oldest first
    const acme = await admin("GET", "?status=all&q=acme");
    expect(acme.body.tickets.length).toBeGreaterThan(0);
    for (const t of acme.body.tickets) expect(t.workspace.name.toLowerCase() + t.requester + t.subject.toLowerCase()).toMatch(/acme/);
    expect(acme.body.tickets[0]).toMatchObject({ workspace: { name: "Acme Co", slug: "sup-a", plan: "free" } });
    expect((await admin("GET", "?status=all&q=%25")).body.tickets).toHaveLength(0); // a % is searched for, not a wildcard
    const bravoOnly = await admin("GET", "?status=all&q=bravo.example");
    for (const t of bravoOnly.body.tickets) expect(t.requester).toContain("bravo.example");
  });

  it("shows one request with its thread, the workspace and the requester's email", async () => {
    const o = await opener();
    const t = await customer(o, "POST", "/tickets", ticketBody({ subject: "Thread view test here" }));
    const r = await admin("GET", `/${t.body.ticket.id}`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ticket: { subject: "Thread view test here", page_url: "/integrate" }, workspace: { name: "Acme Co", slug: "sup-a" } });
    expect(r.body.messages).toHaveLength(1);
    expect(r.body.messages[0]).toMatchObject({ author: "customer", author_email: o.email });
    expect((await admin("GET", "/not-a-uuid")).status).toBe(404);
    expect((await admin("GET", "/00000000-0000-4000-8000-000000000000")).status).toBe(404);
  });

  it("answers: marks it answered, emails the requester with a link to the thread, and records an audit row", async () => {
    const t = await customer(who.a2!, "POST", "/tickets", ticketBody({ subject: "Please answer this one" }));
    const id = t.body.ticket.id;
    await flush();
    outbox.sent = [];
    const r = await admin("POST", `/${id}/reply`, { message: "Thanks for the report.\nWe re-pinned the host key for you." });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ ok: true, status: "answered", emailed: true });

    expect(outbox.sent).toHaveLength(1);
    expect(outbox.sent[0]).toMatchObject({ to: "mate@acme.example", replyTo: SUPPORT_EMAIL, subject: "Re: Please answer this one" });
    expect(outbox.sent[0]!.bodyText).toContain("We re-pinned the host key for you.");
    expect(outbox.sent[0]!.bodyText).toContain(`http://localhost:3000/support/${id}`);

    const mine = await customer(who.a1!, "GET", `/tickets/${id}`); // anyone in the workspace sees the thread
    expect(mine.body.ticket).toMatchObject({ status: "answered", last_message_by: "staff" });
    expect(mine.body.messages.map((m: any) => m.author)).toEqual(["customer", "staff"]);
    expect(mine.body.messages[1].author_email).toBeNull(); // staff are "support", never an email
    expect(JSON.stringify(mine.body)).not.toContain(ADMIN_EMAIL);

    const audit = await one(sql`SELECT action, actor_email, detail FROM admin_audit_log WHERE tenant_id = ${who.a1!.tenant} AND action = 'support_reply' ORDER BY created_at DESC LIMIT 1`);
    expect(audit[0]).toMatchObject({ action: "support_reply", actor_email: ADMIN_EMAIL });
    expect(audit[0]!.detail).toMatchObject({ ticket_id: id, closed: false });
    expect(JSON.stringify(audit[0]!.detail)).not.toContain("re-pinned"); // the thread keeps the words, the audit log only that it happened
  });

  it("answers and closes in one step, and a closed request can be reopened or closed by hand", async () => {
    const t = await customer(await opener(), "POST", "/tickets", ticketBody({ subject: "Close this after answering" }));
    const id = t.body.ticket.id;
    expect((await admin("POST", `/${id}/reply`, { message: "All done.", close: true })).body.status).toBe("closed");
    expect((await one(sql`SELECT status, closed_at FROM support_tickets WHERE id = ${id}`))[0]).toMatchObject({ status: "closed" });
    expect((await admin("POST", `/${id}/status`, { status: "open" })).body.status).toBe("open");
    expect((await one(sql`SELECT closed_at FROM support_tickets WHERE id = ${id}`))[0]!.closed_at).toBeNull();
    expect((await admin("POST", `/${id}/status`, { status: "closed" })).body.status).toBe("closed");
    const actions = await one(sql`SELECT action FROM admin_audit_log WHERE tenant_id = ${who.a1!.tenant} AND detail->>'ticket_id' = ${id} ORDER BY created_at`);
    expect(actions.map((a) => a.action)).toEqual(["support_reply", "support_reopen", "support_close"]);
    expect((await admin("POST", `/${id}/status`, { status: "answered" })).status).toBe(400);
  });

  it("keeps the answer even when the email cannot be sent, and says so", async () => {
    const t = await customer(await opener(), "POST", "/tickets", ticketBody({ subject: "Email will fail here" }));
    await flush();
    outbox.mode = "fail";
    const r = await admin("POST", `/${t.body.ticket.id}/reply`, { message: "Answer that cannot be mailed." });
    expect(r.status).toBe(200);
    expect(r.body.emailed).toBe(false);
    const thread = await customer(who.a1!, "GET", `/tickets/${t.body.ticket.id}`);
    expect(thread.body.messages.at(-1).body).toBe("Answer that cannot be mailed.");
  });

  it("refuses an empty or oversized answer and a request that does not exist", async () => {
    const t = await customer(await opener(), "POST", "/tickets", ticketBody({ subject: "Validation of answers" }));
    expect((await admin("POST", `/${t.body.ticket.id}/reply`, { message: "   " })).status).toBe(400);
    expect((await admin("POST", `/${t.body.ticket.id}/reply`, { message: "x".repeat(5001) })).status).toBe(400);
    expect((await admin("POST", `/${t.body.ticket.id}/reply`, { message: "ok", sneaky: true })).status).toBe(400);
    expect((await admin("POST", "/00000000-0000-4000-8000-000000000000/reply", { message: "hello" })).status).toBe(404);
  });
});

describe("erasing a workspace", () => {
  it("takes its requests and messages with it", async () => {
    const t = await customer(who.c1!, "GET", "/tickets");
    expect(t.body.tickets.length).toBeGreaterThan(0);
    await purgeWorkspace(db as never, who.c1!.tenant, "admin_immediate");
    expect(await one(sql`SELECT 1 FROM support_tickets WHERE tenant_id = ${who.c1!.tenant}`)).toHaveLength(0);
    expect(await one(sql`SELECT 1 FROM support_messages WHERE tenant_id = ${who.c1!.tenant}`)).toHaveLength(0);
  });
});
