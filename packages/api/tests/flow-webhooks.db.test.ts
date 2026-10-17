/**
 * Webhook steps over the API.
 *
 * POST /v1/flows/:id/plan
 *   - accepts a webhook step next to email steps; stores it without a template_ref and creates no template for it
 *   - email steps keep their old validation messages
 *   - a webhook step with copy, a bad URL, or a URL with credentials is a 400 naming the step
 *   - with the destination guard on, a localhost or private-address URL is refused at save time
 *   - works in a branching plan too
 * GET /v1/flows/:id/webhook-deliveries: counts and recent calls; another workspace's flow is a 404
 * GET/POST /v1/webhook-secret: owners only, stable until rotated, one per workspace
 *
 * Requires local Postgres (DATABASE_URL).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { sql } from "drizzle-orm";
import { buildApp } from "../src/index.js";
import { tenants, users, sessions, flows, contacts, flowMemberships, flowWebhookDeliveries } from "@loomail/db/schema";
import { compiledPlanSchema } from "@loomail/core";

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) throw new Error("[flow-webhooks.test] DATABASE_URL is not set.");

let pool: pg.Pool;
let db: ReturnType<typeof drizzle>;
let dbAvailable = false;
let app: Awaited<ReturnType<typeof buildApp>>;

const SLUGS = ["test-flow-webhooks-a", "test-flow-webhooks-b"];
let tenantA = "";
let tenantB = "";
let ownerA = "";
let memberA = "";
let ownerB = "";
let flowA = "";
let flowB = "";

const api = async (method: "GET" | "POST", url: string, cookie: string | null, payload?: unknown) => {
  const res = await app.inject({ method, url, headers: { ...(cookie ? { cookie } : {}), ...(payload !== undefined ? { "content-type": "application/json" } : {}) }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  return { status: res.statusCode, body: res.json() as any };
};
const one = async (query: ReturnType<typeof sql>) => (await db.execute(query)).rows as Array<Record<string, any>>;

const email = (order: number, extra: Record<string, unknown> = {}) => ({
  order,
  delay: "0m",
  action_type: "nurture_value",
  window_policy: "immediate",
  subject: `Subject ${order}`,
  body_html: `<p>Body ${order}</p>`,
  ...extra,
});
const hook = (order: number, url = "https://hooks.example.com/in", extra: Record<string, unknown> = {}) => ({ order, delay: "0m", webhook: { url }, ...extra });

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: DB_URL, connectionTimeoutMillis: 3000 });
  try {
    await pool.query("SELECT 1");
    db = drizzle(pool);
    dbAvailable = true;
  } catch (err) {
    if (process.env.CI === "true") throw err;
    console.warn("[flow-webhooks.test] DATABASE_URL not reachable - skipped.");
    return;
  }
  for (const slug of SLUGS) {
    const t = sql`(SELECT id FROM tenants WHERE slug = ${slug})`;
    for (const table of ["flow_webhook_deliveries", "webhook_secrets", "flow_memberships", "templates", "flows", "contacts", "sessions", "users"]) {
      await db.execute(sql`DELETE FROM ${sql.raw(table)} WHERE tenant_id IN ${t}`);
    }
    await db.execute(sql`DELETE FROM tenants WHERE slug = ${slug}`);
  }
  const make = async (slug: string, roles: Array<"owner" | "member">) => {
    const [t] = await db.insert(tenants).values({ name: slug, slug, plan: "free" }).returning({ id: tenants.id });
    const cookies: string[] = [];
    for (const [i, role] of roles.entries()) {
      const [u] = await db.insert(users).values({ tenantId: t!.id, email: `${role}${i}@${slug}.test`, role }).returning({ id: users.id });
      const [s] = await db.insert(sessions).values({ tenantId: t!.id, userId: u!.id, expiresAt: new Date(Date.now() + 86400_000) }).returning({ id: sessions.id });
      cookies.push(`loomail_session=${s!.id}`);
    }
    return { id: t!.id, cookies };
  };
  const a = await make(SLUGS[0]!, ["owner", "member"]);
  const b = await make(SLUGS[1]!, ["owner"]);
  [tenantA, tenantB] = [a.id, b.id];
  [ownerA, memberA] = a.cookies as [string, string];
  ownerB = b.cookies[0]!;
  const mkFlow = async (tenantId: string) =>
    (
      await db
        .insert(flows)
        .values({ tenantId, name: "Webhook flow", triggerType: "event", triggerConfig: { event: "x" }, steps: [], contentMode: "fixed_content", status: "draft" } as never)
        .returning({ id: flows.id })
    )[0]!.id;
  flowA = await mkFlow(tenantA);
  flowB = await mkFlow(tenantB);
  app = await buildApp({ db, logger: false });
  await app.ready();
});

afterAll(async () => {
  delete process.env.LOOMAIL_RESTRICT_WEBHOOK_HOSTS;
  if (app) await app.close();
  if (pool) await pool.end();
});

describe("POST /v1/flows/:id/plan with a webhook step", () => {
  it("accepts it next to emails, stores it without a template, and creates no template for it", async () => {
    if (!dbAvailable) return;
    const res = await api("POST", `/v1/flows/${flowA}/plan`, ownerA, { steps: [email(1), hook(2), email(3)] });
    expect(res.status).toBe(200);
    const plan = res.body.compiled_plan;
    expect(plan.steps.map((s: any) => [s.order, s.action_type, s.template_ref ?? null, s.webhook?.url ?? null])).toEqual([
      [1, "nurture_value", `flow-${flowA}-step-1`, null],
      [2, "webhook", null, "https://hooks.example.com/in"],
      [3, "nurture_value", `flow-${flowA}-step-3`, null],
    ]);
    expect(compiledPlanSchema.safeParse(plan).success).toBe(true);
    const slugs = (await one(sql`SELECT slug FROM templates WHERE tenant_id = ${tenantA} ORDER BY slug`)).map((r) => r.slug);
    expect(slugs).toEqual([`flow-${flowA}-step-1`, `flow-${flowA}-step-3`]);
    expect(res.body.compile_status).toBe("ready");
  });

  it("keeps a webhook step's delay, conditions and next pointer, in a branching plan", async () => {
    if (!dbAvailable) return;
    const res = await api("POST", `/v1/flows/${flowA}/plan`, ownerA, {
      version: 2,
      steps: [email(1, { next: 2 }), hook(2, "https://hooks.example.com/in", { delay: "1d", condition: { lifecycle_state: "engaged" }, next: "end" })],
    });
    expect(res.status).toBe(200);
    expect(res.body.compiled_plan.steps[1]).toMatchObject({ order: 2, delay: "1d", condition: { lifecycle_state: "engaged" }, next: "end", webhook: { url: "https://hooks.example.com/in" } });
  });

  it("a plan of only a webhook step is fine", async () => {
    if (!dbAvailable) return;
    expect((await api("POST", `/v1/flows/${flowA}/plan`, ownerA, { steps: [hook(1)] })).status).toBe(200);
  });

  it("email steps keep their old validation messages", async () => {
    if (!dbAvailable) return;
    const res = await api("POST", `/v1/flows/${flowA}/plan`, ownerA, { steps: [email(1, { subject: "", body_html: "" })] });
    expect(res.status).toBe(400);
    const msgs = res.body.issues.map((i: any) => `${i.path}: ${i.message}`);
    expect(msgs).toContain("steps.0.subject: Subject is required");
    expect(msgs).toContain("steps.0.body_html: Body HTML is required");
  });

  it("refuses a webhook step that also has copy, a bad URL, or a URL with credentials", async () => {
    if (!dbAvailable) return;
    const withCopy = await api("POST", `/v1/flows/${flowA}/plan`, ownerA, { steps: [hook(1, "https://hooks.example.com/in", { subject: "Hi" })] });
    expect(withCopy.status).toBe(400);
    expect(withCopy.body.issues[0].path).toBe("steps.0.webhook");

    for (const url of ["not a url", "ftp://hooks.example.com/in", "https://user:pw@hooks.example.com/in"]) {
      const res = await api("POST", `/v1/flows/${flowA}/plan`, ownerA, { steps: [email(1), hook(2, url)] });
      expect(res.status, url).toBe(400);
      expect(res.body.issues.map((i: any) => i.path), url).toContain("steps.1.webhook.url");
    }
  });

  it("with the destination guard on, refuses localhost and private addresses at save time", async () => {
    if (!dbAvailable) return;
    process.env.LOOMAIL_RESTRICT_WEBHOOK_HOSTS = "true";
    try {
      for (const url of ["https://localhost/in", "https://127.0.0.1/in", "https://169.254.169.254/latest", "https://10.0.0.5/in", "http://hooks.example.com/in"]) {
        const res = await api("POST", `/v1/flows/${flowA}/plan`, ownerA, { steps: [hook(1, url)] });
        expect(res.status, url).toBe(400);
        expect(res.body.issues[0].path).toBe("steps.0.webhook.url");
      }
      expect((await api("POST", `/v1/flows/${flowA}/plan`, ownerA, { steps: [hook(1, "https://hooks.example.com/in")] })).status).toBe(200);
    } finally {
      delete process.env.LOOMAIL_RESTRICT_WEBHOOK_HOSTS;
    }
  });

  it("with the guard off (self-hosted), a local address is allowed", async () => {
    if (!dbAvailable) return;
    expect((await api("POST", `/v1/flows/${flowA}/plan`, ownerA, { steps: [hook(1, "http://localhost:9000/in")] })).status).toBe(200);
  });
});

describe("GET /v1/flows/:id/webhook-deliveries", () => {
  it("returns counts and the recent calls, and is scoped to the workspace", async () => {
    if (!dbAvailable) return;
    let seq = 0;
    const mk = async (status: string, n: number) => {
      for (let i = 0; i < n; i++) {
        // One person per call: a person can be in a flow once at a time.
        const [c] = await db.insert(contacts).values({ tenantId: tenantA, externalId: `wh-c${++seq}`, email: `wh${seq}@example.com`, lifecycleState: "engaged" }).returning({ id: contacts.id });
        const [m] = await db.insert(flowMemberships).values({ tenantId: tenantA, contactId: c!.id, flowId: flowA, currentStep: 1, status: "active", enteredAt: new Date() }).returning({ id: flowMemberships.id });
        await db.insert(flowWebhookDeliveries).values({
          tenantId: tenantA, flowId: flowA, membershipId: m!.id, contactId: c!.id, stepOrder: 1, url: "https://hooks.example.com/in",
          status, attempts: status === "pending" ? 0 : 1, nextAttemptAt: new Date(), lastStatusCode: status === "failed" ? 404 : status === "succeeded" ? 200 : null,
          lastError: status === "failed" ? "The server answered 404." : null,
        });
      }
    };
    await mk("pending", 2);
    await mk("succeeded", 3);
    await mk("failed", 1);

    const res = await api("GET", `/v1/flows/${flowA}/webhook-deliveries`, memberA);
    expect(res.status).toBe(200);
    expect(res.body.counts).toEqual({ pending: 2, succeeded: 3, failed: 1 });
    expect(res.body.deliveries).toHaveLength(6);
    expect(res.body.deliveries.find((d: any) => d.status === "failed")).toMatchObject({ last_status_code: 404, last_error: "The server answered 404.", contact_email: expect.stringMatching(/^wh\d@example\.com$/), step_order: 1 });

    expect((await api("GET", `/v1/flows/${flowB}/webhook-deliveries`, ownerA)).status).toBe(404); // not A's flow
    expect((await api("GET", `/v1/flows/${flowA}/webhook-deliveries`, ownerB)).status).toBe(404);
    expect((await api("GET", `/v1/flows/${flowA}/webhook-deliveries`, null)).status).toBe(401);
    expect((await api("GET", `/v1/flows/not-a-uuid/webhook-deliveries`, ownerA)).status).toBe(404);
    const empty = await api("GET", `/v1/flows/${flowB}/webhook-deliveries`, ownerB);
    expect(empty.body).toEqual({ counts: { pending: 0, succeeded: 0, failed: 0 }, deliveries: [] });
  });
});

describe("the signing secret", () => {
  it("is made on first read, is the same every time, and is owners only", async () => {
    if (!dbAvailable) return;
    const first = await api("GET", "/v1/webhook-secret", ownerA);
    expect(first.status).toBe(200);
    expect(first.body.secret).toMatch(/^whsec_[0-9a-f]{48}$/);
    expect(first.body.rotated_at).toBeNull();
    expect((await api("GET", "/v1/webhook-secret", ownerA)).body.secret).toBe(first.body.secret);
    expect((await api("GET", "/v1/webhook-secret", memberA)).status).toBe(403);
    expect((await api("POST", "/v1/webhook-secret/rotate", memberA)).status).toBe(403);
    expect((await api("GET", "/v1/webhook-secret", null)).status).toBe(401);
  });

  it("rotating replaces it and records when; each workspace has its own", async () => {
    if (!dbAvailable) return;
    const before = (await api("GET", "/v1/webhook-secret", ownerA)).body.secret;
    const rotated = await api("POST", "/v1/webhook-secret/rotate", ownerA);
    expect(rotated.status).toBe(200);
    expect(rotated.body.secret).not.toBe(before);
    expect(rotated.body.rotated_at).not.toBeNull();
    expect((await api("GET", "/v1/webhook-secret", ownerA)).body.secret).toBe(rotated.body.secret);

    const other = (await api("GET", "/v1/webhook-secret", ownerB)).body.secret;
    expect(other).not.toBe(rotated.body.secret);
    const rows = await one(sql`SELECT secret_sealed FROM webhook_secrets WHERE tenant_id = ${tenantA}`);
    expect(rows).toHaveLength(1);
  });
});
