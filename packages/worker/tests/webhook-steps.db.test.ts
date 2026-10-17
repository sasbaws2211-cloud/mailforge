/**
 * Webhook steps: the engine queues a call instead of a message, and the delivery job makes it.
 *
 * Engine:
 *   - a webhook step creates one delivery (no message) and moves on, in a straight-line plan and a branching one
 *   - it honours its delay and its proceed-if condition, and completes the flow on the last step
 *   - repeating the advance never queues a second call
 * Delivery:
 *   - success, retry with backoff, giving up after the last attempt, and failing at once on a refusal
 *   - a paused flow holds its calls without using attempts; an archived flow fails them
 *   - two workers at once never take the same call
 *   - the payload is signed with the workspace's secret, made on first use, and carries the delivery id
 *   - the URL queued is the URL at the time, not whatever the plan says later
 *   - old finished calls are swept, pending ones never
 *
 * Requires local Postgres (see enrollment.db.test.ts for DATABASE_URL).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { eq, sql } from "drizzle-orm";
import { openWebhookSecret, type WebhookSendResult } from "@loomail/adapters";
import { tenants, contacts, flows, flowMemberships, flowWebhookDeliveries, lifecycleMessages, webhookSecrets } from "@loomail/db/schema";
import { handleAdvanceMembership } from "../src/advance-membership.js";
import { phaseStepAdvancement } from "../src/scan-step-advancement.js";
import {
  processWebhookDeliveries,
  sweepWebhookDeliveries,
  WEBHOOK_BACKOFF_MINUTES,
  WEBHOOK_MAX_ATTEMPTS,
} from "../src/webhook-delivery.js";

const TEST_DB_URL = process.env.DATABASE_URL;
if (!TEST_DB_URL) throw new Error("[webhook-steps.test] DATABASE_URL is not set (see enrollment.db.test.ts).");

const SLUG = "test-webhook-steps";
const HOUR = 3_600_000;
const MIN = 60_000;

let pool: pg.Pool;
let db: ReturnType<typeof drizzle>;
let dbAvailable = false;
let tenantId: string;

const TABLES = ["flow_webhook_deliveries", "webhook_secrets", "flow_split_choices", "flow_conversions", "lifecycle_messages", "flow_memberships", "flows", "events", "contacts"];
const wipe = async () => {
  for (const table of TABLES) await db.execute(sql.raw(`DELETE FROM ${table} WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = '${SLUG}')`));
};

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: TEST_DB_URL, connectionTimeoutMillis: 3000, max: 10 });
  try {
    await pool.query("SELECT 1");
    db = drizzle(pool);
    dbAvailable = true;
  } catch {
    console.warn("[webhook-steps.test] DATABASE_URL not reachable - tests skipped.");
    return;
  }
  await wipe();
  await db.execute(sql.raw(`DELETE FROM tenants WHERE slug = '${SLUG}'`));
  const [t] = await db.insert(tenants).values({ name: "Webhook steps", slug: SLUG, plan: "free" }).returning({ id: tenants.id });
  tenantId = t!.id;
});
beforeEach(async () => {
  if (dbAvailable) await wipe();
});
afterAll(async () => {
  if (dbAvailable) {
    await wipe();
    await db.execute(sql.raw(`DELETE FROM tenants WHERE slug = '${SLUG}'`));
  }
  await pool.end();
});

const URL_A = "https://hooks.example.com/loomail";
const hook = (order: number, extra: Record<string, unknown> = {}) => ({ order, action_type: "webhook", delay: "0m", window_policy: "immediate", webhook: { url: URL_A }, ...extra });
const email = (order: number, extra: Record<string, unknown> = {}) => ({ order, action_type: "nurture_value", delay: "0m", window_policy: "immediate", template_ref: `t${order}`, ...extra });
const straight = (...steps: unknown[]) => ({ trigger: { type: "event", condition: {} }, steps });

async function mkFlow(plan: unknown, status = "active") {
  const [f] = await db
    .insert(flows)
    .values({ tenantId, name: "Webhook flow", triggerType: "event", triggerConfig: { event: "x" }, steps: [], status, compileStatus: "ready", compiledPlan: plan, approvalMode: "require" } as never)
    .returning({ id: flows.id });
  return f!.id;
}
async function mkMembership(flowId: string, over: { entered?: Date; properties?: Record<string, unknown> } = {}) {
  const [c] = await db
    .insert(contacts)
    .values({ tenantId, externalId: `c-${randomUUID()}`, email: `${randomUUID()}@x.test`, name: "Ada", lifecycleState: "engaged", properties: over.properties ?? { seats: 4 }, firstSeenAt: new Date(), lastSeenAt: new Date() })
    .returning({ id: contacts.id });
  const entered = over.entered ?? new Date(Date.now() - HOUR);
  const [m] = await db
    .insert(flowMemberships)
    .values({ tenantId, contactId: c!.id, flowId, currentStep: 1, status: "active", enteredAt: entered, stepEnteredAt: entered })
    .returning({ id: flowMemberships.id });
  return { membershipId: m!.id, contactId: c!.id };
}
const advance = (membershipId: string) => handleAdvanceMembership({ tenant_id: tenantId, membership_id: membershipId } as never, db);
const deliveriesOf = (membershipId: string) => db.select().from(flowWebhookDeliveries).where(eq(flowWebhookDeliveries.membershipId, membershipId));
const messagesOf = (membershipId: string) => db.select().from(lifecycleMessages).where(eq(lifecycleMessages.membershipId, membershipId));
const membership = async (id: string) => (await db.select().from(flowMemberships).where(eq(flowMemberships.id, id)))[0]!;

// ===========================================================================
describe("the engine at a webhook step", () => {
  it("queues one call and no message, then completes the flow (straight line, last step)", async () => {
    if (!dbAvailable) return;
    const { membershipId, contactId } = await mkMembership(await mkFlow(straight(hook(1))));
    await advance(membershipId);
    const rows = await deliveriesOf(membershipId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "pending", attempts: 0, stepOrder: 1, url: URL_A, contactId });
    expect(await messagesOf(membershipId)).toHaveLength(0);
    expect((await membership(membershipId)).status).toBe("completed");
  });

  it("moves on to the next step after a webhook, which then sends its email (straight line)", async () => {
    if (!dbAvailable) return;
    const { membershipId } = await mkMembership(await mkFlow(straight(hook(1), email(2))));
    await advance(membershipId);
    expect(await deliveriesOf(membershipId)).toHaveLength(1);
    expect((await membership(membershipId)).currentStep).toBe(2);
    await advance(membershipId);
    expect((await messagesOf(membershipId)).map((m) => m.flowStepOrder)).toEqual([2]);
  });

  it("works inside a branching plan: email, then a webhook, then the end", async () => {
    if (!dbAvailable) return;
    const plan = { version: 2, trigger: { type: "event", condition: {} }, steps: [email(1, { next: 2 }), hook(2, { next: "end" })] };
    const { membershipId } = await mkMembership(await mkFlow(plan));
    await advance(membershipId);
    expect((await messagesOf(membershipId)).map((m) => m.flowStepOrder)).toEqual([1]);
    await advance(membershipId);
    expect(await deliveriesOf(membershipId)).toHaveLength(1);
    expect((await deliveriesOf(membershipId))[0]!.stepOrder).toBe(2);
    expect((await membership(membershipId)).status).toBe("completed");
  });

  it("a webhook can sit after a fork's path", async () => {
    if (!dbAvailable) return;
    const plan = {
      version: 2,
      trigger: { type: "event", condition: {} },
      steps: [hook(2, { next: "end" }), email(3, { next: "end" })],
      branches: [{ order: 1, delay: "0m", condition: { lifecycle_state: "engaged" }, then: 2, else: 3 }],
    };
    const { membershipId } = await mkMembership(await mkFlow(plan));
    await advance(membershipId);
    expect(await deliveriesOf(membershipId)).toHaveLength(1);
    expect(await messagesOf(membershipId)).toHaveLength(0);
  });

  it("waits for its delay", async () => {
    if (!dbAvailable) return;
    const { membershipId } = await mkMembership(await mkFlow(straight(hook(1, { delay: "2d" }))), { entered: new Date(Date.now() - HOUR) });
    await advance(membershipId);
    expect(await deliveriesOf(membershipId)).toHaveLength(0);
    expect((await membership(membershipId)).status).toBe("active");
  });

  it("is skipped when its proceed-if condition is false, and fires when it is true", async () => {
    if (!dbAvailable) return;
    const cond = { lifecycle_state: "churned" };
    const skipped = await mkMembership(await mkFlow(straight(hook(1, { condition: cond }))));
    await advance(skipped.membershipId);
    expect(await deliveriesOf(skipped.membershipId)).toHaveLength(0);
    expect((await membership(skipped.membershipId)).status).toBe("completed");

    const fires = await mkMembership(await mkFlow(straight(hook(1, { condition: { lifecycle_state: "engaged" } }))));
    await advance(fires.membershipId);
    expect(await deliveriesOf(fires.membershipId)).toHaveLength(1);
  });

  it("advancing again, by the targeted job or the scan, never queues a second call", async () => {
    if (!dbAvailable) return;
    const { membershipId } = await mkMembership(await mkFlow(straight(hook(1), email(2, { delay: "30d" }))));
    await advance(membershipId);
    await advance(membershipId);
    await phaseStepAdvancement(db, new Date(), [tenantId]);
    await Promise.all([advance(membershipId), advance(membershipId)]);
    expect(await deliveriesOf(membershipId)).toHaveLength(1);
  });
});

// ===========================================================================
describe("the delivery job", () => {
  const ok: WebhookSendResult = { ok: true, status: 200, error: null, retryable: false };
  const fail = (status: number | null, retryable: boolean, error = "nope"): WebhookSendResult => ({ ok: false, status, error, retryable });

  async function queued(opts: { flowStatus?: string } = {}) {
    const flowId = await mkFlow(straight(hook(1)), opts.flowStatus ?? "active");
    const { membershipId } = await mkMembership(flowId);
    await db.insert(flowWebhookDeliveries).values({ tenantId, flowId, membershipId, contactId: (await membership(membershipId)).contactId, stepOrder: 1, url: URL_A, nextAttemptAt: new Date(Date.now() - MIN) });
    const [row] = await deliveriesOf(membershipId);
    return { row: row!, flowId, membershipId };
  }
  const reload = async (id: string) => (await db.select().from(flowWebhookDeliveries).where(eq(flowWebhookDeliveries.id, id)))[0]!;

  it("delivers, records success, and signs the payload with the workspace secret (made on first use)", async () => {
    if (!dbAvailable) return;
    const { row } = await queued();
    const calls: Array<{ url: string; body: string; secret: string; headers?: Record<string, string> }> = [];
    const r = await processWebhookDeliveries(db, new Date(), {
      encryptionKey: undefined,
      send: async (i) => (calls.push({ url: i.url, body: i.body, secret: i.secret, headers: i.headers }), ok),
    });
    expect(r).toMatchObject({ claimed: 1, succeeded: 1, retrying: 0, failed: 0 });
    const done = await reload(row.id);
    expect(done).toMatchObject({ status: "succeeded", attempts: 1, lastStatusCode: 200, lastError: null });
    expect(done.deliveredAt).not.toBeNull();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(URL_A);
    expect(calls[0]!.headers).toMatchObject({ "X-Loomail-Delivery": row.id, "X-Loomail-Event": "flow.webhook" });
    const payload = JSON.parse(calls[0]!.body);
    expect(payload).toMatchObject({ id: row.id, type: "flow.webhook", attempt: 1, step: 1, flow: { name: "Webhook flow" }, contact: { name: "Ada", lifecycle_state: "engaged", properties: { seats: 4 } } });
    // The secret was made, stored sealed, and is the one that signed.
    const [stored] = await db.select().from(webhookSecrets).where(eq(webhookSecrets.tenantId, tenantId));
    expect(stored).toBeTruthy();
    expect(openWebhookSecret(stored!.secretSealed, undefined)).toBe(calls[0]!.secret);
  });

  it("every call in a workspace is signed with the same secret, stored once", async () => {
    if (!dbAvailable) return;
    await queued();
    await queued();
    const secrets: string[] = [];
    await processWebhookDeliveries(db, new Date(), { send: async (i) => (secrets.push(i.secret), ok) });
    expect(secrets).toHaveLength(2);
    expect(new Set(secrets).size).toBe(1);
    const [count] = (await db.execute(sql`SELECT count(*)::int AS n FROM webhook_secrets WHERE tenant_id = ${tenantId}`)).rows as Array<{ n: number }>;
    expect(count!.n).toBe(1);
  });

  it("retries a retryable failure on the backoff schedule, then gives up after the last attempt", async () => {
    if (!dbAvailable) return;
    const { row } = await queued();
    let now = new Date();
    for (let attempt = 1; attempt <= WEBHOOK_MAX_ATTEMPTS; attempt++) {
      const r = await processWebhookDeliveries(db, now, { send: async () => fail(503, true, "The server answered 503.") });
      expect(r.claimed).toBe(1);
      const after = await reload(row.id);
      expect(after.attempts).toBe(attempt);
      if (attempt < WEBHOOK_MAX_ATTEMPTS) {
        expect(after.status).toBe("pending");
        expect(after.nextAttemptAt.getTime()).toBe(now.getTime() + WEBHOOK_BACKOFF_MINUTES[attempt - 1]! * MIN);
        // Not due a second early.
        expect((await processWebhookDeliveries(db, new Date(after.nextAttemptAt.getTime() - 1000), { send: async () => ok })).claimed).toBe(0);
        now = after.nextAttemptAt;
      } else {
        expect(after).toMatchObject({ status: "failed", lastStatusCode: 503 });
      }
    }
    expect(WEBHOOK_MAX_ATTEMPTS).toBe(6);
  });

  it("a refusal that will not change fails at once, with the reason recorded", async () => {
    if (!dbAvailable) return;
    const { row } = await queued();
    const r = await processWebhookDeliveries(db, new Date(), { send: async () => fail(404, false, "The server answered 404.") });
    expect(r.failed).toBe(1);
    expect(await reload(row.id)).toMatchObject({ status: "failed", attempts: 1, lastStatusCode: 404, lastError: "The server answered 404." });
  });

  it("a send that throws is recorded as a failure, not a crash", async () => {
    if (!dbAvailable) return;
    const { row } = await queued();
    const r = await processWebhookDeliveries(db, new Date(), { send: async () => { throw new Error("boom"); } });
    expect(r.failed).toBe(1);
    expect((await reload(row.id)).status).toBe("failed");
  });

  it("a paused flow holds its calls without using attempts; an archived one fails them", async () => {
    if (!dbAvailable) return;
    const paused = await queued({ flowStatus: "paused" });
    const r1 = await processWebhookDeliveries(db, new Date(), { send: async () => ok });
    expect(r1).toMatchObject({ held: 1, succeeded: 0 });
    const held = await reload(paused.row.id);
    expect(held).toMatchObject({ status: "pending", attempts: 0 });
    expect(held.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());

    await db.update(flows).set({ status: "active" }).where(eq(flows.id, paused.flowId));
    const r2 = await processWebhookDeliveries(db, new Date(Date.now() + HOUR), { send: async () => ok });
    expect(r2.succeeded).toBe(1);

    const archived = await queued({ flowStatus: "archived" });
    const r3 = await processWebhookDeliveries(db, new Date(), { send: async () => ok });
    expect(r3.failed).toBe(1);
    expect(await reload(archived.row.id)).toMatchObject({ status: "failed" });
  });

  it("two workers at once never take the same call", async () => {
    if (!dbAvailable) return;
    for (let i = 0; i < 6; i++) await queued();
    let calls = 0;
    const send = async () => (calls++, new Promise<WebhookSendResult>((res) => setTimeout(() => res(ok), 20)));
    const [a, b] = await Promise.all([processWebhookDeliveries(db, new Date(), { send }), processWebhookDeliveries(db, new Date(), { send })]);
    expect(a.claimed + b.claimed).toBe(6);
    expect(calls).toBe(6);
  });

  it("a worker that died mid-call only delays it: the lease expires and it is taken again", async () => {
    if (!dbAvailable) return;
    const { row } = await queued();
    // The state a claim leaves behind: attempt counted, held for 10 minutes. The worker never reports back.
    await db.execute(sql`UPDATE flow_webhook_deliveries SET attempts = 1, next_attempt_at = now() + interval '10 minutes' WHERE id = ${row.id}`);
    expect((await processWebhookDeliveries(db, new Date(), { send: async () => ok })).claimed).toBe(0); // still leased
    const later = await processWebhookDeliveries(db, new Date(Date.now() + 11 * MIN), { send: async () => ok });
    expect(later.succeeded).toBe(1);
    expect((await reload(row.id)).attempts).toBe(2);
  });

  it("calls the URL queued, not whatever the plan says now", async () => {
    if (!dbAvailable) return;
    const { membershipId } = await mkMembership(await mkFlow(straight(hook(1))));
    await advance(membershipId);
    await db.update(flows).set({ compiledPlan: straight(hook(1, { webhook: { url: "https://changed.example.com/x" } })) as never }).where(eq(flows.tenantId, tenantId));
    const urls: string[] = [];
    await processWebhookDeliveries(db, new Date(), { send: async (i) => (urls.push(i.url), ok) });
    expect(urls).toEqual([URL_A]);
  });

  it("sweeps old finished calls and never a pending one", async () => {
    if (!dbAvailable) return;
    const a = await queued();
    const b = await queued();
    const c = await queued();
    await db.execute(sql`UPDATE flow_webhook_deliveries SET status = 'succeeded', created_at = now() - interval '31 days' WHERE id = ${a.row.id}`);
    await db.execute(sql`UPDATE flow_webhook_deliveries SET status = 'failed', created_at = now() - interval '5 days' WHERE id = ${b.row.id}`);
    await db.execute(sql`UPDATE flow_webhook_deliveries SET created_at = now() - interval '90 days' WHERE id = ${c.row.id}`); // still pending
    expect(await sweepWebhookDeliveries(db, new Date())).toBe(1);
    expect((await deliveriesOf(a.membershipId)).length).toBe(0);
    expect((await deliveriesOf(b.membershipId)).length).toBe(1);
    expect((await deliveriesOf(c.membershipId)).length).toBe(1);
  });
});
