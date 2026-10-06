/**
 * Managed sending for the worker: build the adapter that sends a workspace's mail
 * through the operator's Resend account, and say how much it may send a day.
 *
 * Only used for a workspace with no transport of its own (the resolver tries
 * transport_configs first). Returns null, and so leaves the workspace's messages
 * untouched, whenever managed sending cannot send for it right now: the operator does
 * not offer it, the workspace has not turned it on, it is paused, or there is no
 * sender yet (no verified domain and no shared address).
 *
 * Mirror side: PUBLIC (packages/worker is mirrored).
 */
import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { ManagedResendAdapter, type TransportAdapter } from "@mailforge/adapters";
import { chooseManagedSender, isDomainStatus, isValidReplyAddress, managedSendingConfigFromEnv, type ManagedSendingConfig } from "@mailforge/core";

type Db = NodePgDatabase<Record<string, never>>;
type Env = Record<string, string | undefined>;

interface Row extends Record<string, unknown> {
  enabled: boolean;
  domain: string | null;
  domain_status: string;
  from_local: string;
  from_name: string | null;
  reply_to: string | null;
  paused_at: Date | string | null;
  tenant_name: string;
  brand_name: string | null;
  brand_reply_to: string | null;
  owner_email: string | null;
}

async function loadRow(db: Db, tenantId: string): Promise<Row | null> {
  const r = await db.execute<Row>(sql`
    SELECT m.enabled, m.domain, m.domain_status, m.from_local, m.from_name, m.reply_to, m.paused_at,
           t.name AS tenant_name,
           t.settings -> 'brand' ->> 'brand_name' AS brand_name,
           t.settings -> 'brand' ->> 'reply_to' AS brand_reply_to,
           (SELECT u.email FROM users u WHERE u.tenant_id = t.id AND u.role = 'owner' AND u.deactivated_at IS NULL ORDER BY u.created_at LIMIT 1) AS owner_email
    FROM managed_sending m JOIN tenants t ON t.id = m.tenant_id
    WHERE m.tenant_id = ${tenantId}::uuid LIMIT 1`);
  return r.rows[0] ?? null;
}

function senderFor(row: Row, cfg: ManagedSendingConfig) {
  const reply = [row.reply_to, row.brand_reply_to, row.owner_email].find((v) => isValidReplyAddress(v)) ?? null;
  return chooseManagedSender({
    domain: row.domain,
    domainStatus: isDomainStatus(row.domain_status) ? row.domain_status : "none",
    fromLocal: row.from_local,
    fromName: row.from_name ?? row.brand_name,
    fallbackName: row.tenant_name,
    replyTo: reply,
    sharedFrom: cfg.sharedFrom,
  });
}

/** The adapter for a workspace's managed sending, or null when it cannot send right now. */
export async function resolveManagedTransport(db: Db, tenantId: string, env: Env = process.env): Promise<TransportAdapter | null> {
  const cfg = managedSendingConfigFromEnv(env);
  if (!cfg.enabled || !cfg.apiKey) return null;
  const row = await loadRow(db, tenantId);
  if (!row || !row.enabled || row.paused_at) return null;
  const sender = senderFor(row, cfg);
  if (!sender.ok) return null;
  return new ManagedResendAdapter({
    apiKey: cfg.apiKey,
    baseUrl: cfg.baseUrl,
    fromEmail: sender.fromEmail,
    fromName: sender.fromName,
    replyTo: sender.replyTo,
  });
}

/**
 * Emails per day this workspace may send through managed sending, or null for no extra cap. Only the
 * shared operator address is capped: a workspace on its own verified domain carries its own reputation
 * and is limited only by its plan.
 */
export async function managedDailyLimit(db: Db, tenantId: string, env: Env = process.env): Promise<number | null> {
  const cfg = managedSendingConfigFromEnv(env);
  if (!cfg.enabled) return null;
  const row = await loadRow(db, tenantId);
  if (!row || !row.enabled || row.paused_at) return null;
  const sender = senderFor(row, cfg);
  return sender.ok && sender.mode === "shared" ? cfg.sharedDailyLimit : null;
}
