/**
 * Webhook delivery: makes the calls that flows' webhook steps queued (flow_webhook_deliveries).
 *
 * Runs every minute. Each tick claims the deliveries that are due, calls each URL (signed, see
 * @loomail/adapters webhook-sender), and records what happened:
 *
 *   2xx                        succeeded.
 *   network error, timeout,
 *   408, 429, 5xx              try again later: after 1 minute, 5 minutes, 30 minutes, 2 hours, then 12 hours;
 *                              after the 6th attempt it is marked failed.
 *   any other answer           failed at once: the receiver said no, and asking again will not change that.
 *   address not allowed        failed at once (see the destination rules in webhook-sender).
 *
 * Claiming is a lease: the row's next_attempt_at moves 10 minutes ahead and attempts goes up before the call is made,
 * with FOR UPDATE SKIP LOCKED, so two workers never take the same row and a worker that dies mid-call only delays
 * that delivery. The receiver sees the same delivery id on every attempt (X-Loomail-Delivery) and can dedupe on it.
 *
 * A paused flow holds its deliveries without using up attempts; an archived flow fails them.
 *
 * Mirror side: PUBLIC (packages/worker is mirrored).
 */
import { and, eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { contacts, flows, flowWebhookDeliveries, webhookSecrets } from "@loomail/db/schema";
import {
  generateWebhookSecret,
  openWebhookSecret,
  sealWebhookSecret,
  sendWebhook,
  type WebhookHostPolicy,
  type WebhookSendResult,
} from "@loomail/adapters";

type Db = NodePgDatabase<Record<string, never>>;

/** Minutes to wait after the 1st, 2nd, ... failed attempt. */
export const WEBHOOK_BACKOFF_MINUTES: readonly number[] = [1, 5, 30, 120, 720];
/** The first call plus one retry for each backoff entry. */
export const WEBHOOK_MAX_ATTEMPTS = WEBHOOK_BACKOFF_MINUTES.length + 1;
/** How long a claimed delivery is held before another worker may take it, if the first one never reports back. */
const LEASE_MINUTES = 10;
/** Most deliveries one tick takes, and how many calls run at once. */
const TICK_LIMIT = 100;
const CONCURRENCY = 5;
/** How long a paused flow's deliveries wait before being looked at again. */
const PAUSED_RECHECK_MINUTES = 15;
/** Deliveries older than this are deleted by the hourly sweep. */
export const WEBHOOK_DELIVERY_RETENTION_DAYS = 30;

export interface WebhookTickResult {
  claimed: number;
  succeeded: number;
  retrying: number;
  failed: number;
  /** Held for a paused flow. */
  held: number;
}

export interface WebhookTickOptions {
  policy?: WebhookHostPolicy;
  /** Test hook: replaces the real HTTP call. */
  send?: typeof sendWebhook;
  encryptionKey?: string;
  limit?: number;
}

type Claimed = {
  id: string;
  tenant_id: string;
  flow_id: string;
  contact_id: string;
  step_order: number;
  url: string;
  attempts: number;
  created_at: Date;
};

const minutes = (m: number) => m * 60_000;

/** The workspace's signing secret, made on first use. */
async function secretFor(db: Db, tenantId: string, encryptionKey: string | undefined): Promise<string> {
  const read = async () =>
    (await db.select({ sealed: webhookSecrets.secretSealed }).from(webhookSecrets).where(eq(webhookSecrets.tenantId, tenantId)).limit(1))[0]?.sealed;
  let sealed = await read();
  if (!sealed) {
    await db
      .insert(webhookSecrets)
      .values({ tenantId, secretSealed: sealWebhookSecret(generateWebhookSecret(), encryptionKey) })
      .onConflictDoNothing();
    sealed = await read();
  }
  return openWebhookSecret(sealed!, encryptionKey);
}

export async function processWebhookDeliveries(db: Db, now: Date, opts: WebhookTickOptions = {}): Promise<WebhookTickResult> {
  const result: WebhookTickResult = { claimed: 0, succeeded: 0, retrying: 0, failed: 0, held: 0 };
  const send = opts.send ?? sendWebhook;
  const encryptionKey = opts.encryptionKey ?? process.env.ENCRYPTION_KEY;
  const lease = new Date(now.getTime() + minutes(LEASE_MINUTES));

  const claimed = (
    await db.execute<Claimed>(sql`
      UPDATE flow_webhook_deliveries d
      SET attempts = d.attempts + 1, next_attempt_at = ${lease}
      WHERE d.id IN (
        SELECT id FROM flow_webhook_deliveries
        WHERE status = 'pending' AND next_attempt_at <= ${now}
        ORDER BY next_attempt_at
        LIMIT ${opts.limit ?? TICK_LIMIT}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING d.id, d.tenant_id, d.flow_id, d.contact_id, d.step_order, d.url, d.attempts, d.created_at
    `)
  ).rows;
  result.claimed = claimed.length;

  const finish = (id: string, set: Partial<typeof flowWebhookDeliveries.$inferInsert>) =>
    db
      .update(flowWebhookDeliveries)
      .set(set)
      .where(and(eq(flowWebhookDeliveries.id, id), eq(flowWebhookDeliveries.status, "pending")));

  const one = async (d: Claimed): Promise<void> => {
    const [flow] = await db.select({ name: flows.name, status: flows.status }).from(flows).where(eq(flows.id, d.flow_id)).limit(1);
    if (!flow || flow.status === "archived") {
      await finish(d.id, { status: "failed", lastError: "The flow was archived before this call was made." });
      result.failed++;
      return;
    }
    if (flow.status !== "active") {
      // Paused or still a draft: hold it, and do not count this look as an attempt.
      await db
        .update(flowWebhookDeliveries)
        .set({ attempts: sql`${flowWebhookDeliveries.attempts} - 1`, nextAttemptAt: new Date(now.getTime() + minutes(PAUSED_RECHECK_MINUTES)) })
        .where(and(eq(flowWebhookDeliveries.id, d.id), eq(flowWebhookDeliveries.status, "pending")));
      result.held++;
      return;
    }
    const [contact] = await db
      .select({
        id: contacts.id,
        externalId: contacts.externalId,
        email: contacts.email,
        name: contacts.name,
        company: contacts.company,
        lifecycleState: contacts.lifecycleState,
        paymentStatus: contacts.paymentStatus,
        properties: contacts.properties,
      })
      .from(contacts)
      .where(eq(contacts.id, d.contact_id))
      .limit(1);
    if (!contact) {
      await finish(d.id, { status: "failed", lastError: "The person no longer exists." });
      result.failed++;
      return;
    }

    let outcome: WebhookSendResult;
    try {
      const secret = await secretFor(db, d.tenant_id, encryptionKey);
      const body = JSON.stringify({
        id: d.id,
        type: "flow.webhook",
        created_at: new Date(d.created_at).toISOString(),
        attempt: d.attempts,
        flow: { id: d.flow_id, name: flow.name },
        step: d.step_order,
        contact: {
          id: contact.id,
          user_id: contact.externalId,
          email: contact.email,
          name: contact.name,
          company: contact.company,
          lifecycle_state: contact.lifecycleState,
          payment_status: contact.paymentStatus,
          properties: contact.properties ?? {},
        },
      });
      outcome = await send({
        url: d.url,
        body,
        secret,
        policy: opts.policy,
        headers: { "X-Loomail-Event": "flow.webhook", "X-Loomail-Delivery": d.id },
      });
    } catch (err) {
      outcome = { ok: false, status: null, error: err instanceof Error ? err.message.slice(0, 200) : "Could not make the call.", retryable: false };
    }

    if (outcome.ok) {
      await finish(d.id, { status: "succeeded", deliveredAt: now, lastStatusCode: outcome.status, lastError: null });
      result.succeeded++;
    } else if (outcome.retryable && d.attempts < WEBHOOK_MAX_ATTEMPTS) {
      const wait = WEBHOOK_BACKOFF_MINUTES[d.attempts - 1] ?? WEBHOOK_BACKOFF_MINUTES[WEBHOOK_BACKOFF_MINUTES.length - 1]!;
      await finish(d.id, { nextAttemptAt: new Date(now.getTime() + minutes(wait)), lastStatusCode: outcome.status, lastError: outcome.error });
      result.retrying++;
    } else {
      await finish(d.id, { status: "failed", lastStatusCode: outcome.status, lastError: outcome.error });
      result.failed++;
    }
  };

  for (let i = 0; i < claimed.length; i += CONCURRENCY) {
    await Promise.all(claimed.slice(i, i + CONCURRENCY).map(one));
  }
  return result;
}

/** Delete finished deliveries past the retention period. Pending ones are never swept. */
export async function sweepWebhookDeliveries(db: Db, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - WEBHOOK_DELIVERY_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const r = await db.execute(sql`DELETE FROM flow_webhook_deliveries WHERE status <> 'pending' AND created_at < ${cutoff} RETURNING id`);
  return r.rows.length;
}
