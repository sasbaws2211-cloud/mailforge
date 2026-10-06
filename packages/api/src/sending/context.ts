/**
 * Managed sending, API side: load a workspace's managed-sending row together with what is
 * needed to decide who its mail is sent as, and build the adapter for it.
 *
 * The worker has its own copy of the adapter logic (packages/worker/src/managed-sending.ts);
 * the two are kept in step on purpose, like the plan checks, because the API and the worker
 * do not depend on each other.
 *
 * Mirror side: PUBLIC (packages/api is mirrored).
 */
import { sql } from "drizzle-orm";
import { ManagedResendAdapter, createResendDomainsClient, type DnsRecord, type ResendDomainsClient, type TransportAdapter } from "@mailforge/adapters";
import {
  chooseManagedSender,
  isDomainStatus,
  isValidReplyAddress,
  managedSendingConfigFromEnv,
  type DomainStatus,
  type ManagedSender,
  type ManagedSendingConfig,
} from "@mailforge/core";
import type { Db } from "../plugins/db.js";

export interface SendingRow {
  tenantId: string;
  enabled: boolean;
  domain: string | null;
  resendDomainId: string | null;
  domainStatus: DomainStatus;
  dnsRecords: DnsRecord[] | null;
  fromLocal: string;
  fromName: string | null;
  replyTo: string | null;
  domainAddedAt: Date | null;
  domainVerifiedAt: Date | null;
  domainCheckedAt: Date | null;
  pausedAt: Date | null;
  pausedReason: string | null;
  pausedBy: string | null;
  warnedAt: Date | null;
  tenantName: string;
  brandName: string | null;
  brandReplyTo: string | null;
  ownerEmail: string | null;
}

interface RawRow extends Record<string, unknown> {
  tenant_id: string;
  enabled: boolean;
  domain: string | null;
  resend_domain_id: string | null;
  domain_status: string;
  dns_records: DnsRecord[] | null;
  from_local: string;
  from_name: string | null;
  reply_to: string | null;
  domain_added_at: Date | string | null;
  domain_verified_at: Date | string | null;
  domain_checked_at: Date | string | null;
  paused_at: Date | string | null;
  paused_reason: string | null;
  paused_by: string | null;
  warned_at: Date | string | null;
  tenant_name: string;
  brand_name: string | null;
  brand_reply_to: string | null;
  owner_email: string | null;
}

const d = (v: Date | string | null): Date | null => (v === null ? null : v instanceof Date ? v : new Date(v));

/** A workspace's managed-sending row with its name, brand and owner, or null when it never turned it on. */
export async function loadSendingRow(db: Db, tenantId: string): Promise<SendingRow | null> {
  const r = await db.execute<RawRow>(sql`
    SELECT m.tenant_id, m.enabled, m.domain, m.resend_domain_id, m.domain_status, m.dns_records, m.from_local, m.from_name, m.reply_to,
           m.domain_added_at, m.domain_verified_at, m.domain_checked_at, m.paused_at, m.paused_reason, m.paused_by, m.warned_at,
           t.name AS tenant_name,
           t.settings -> 'brand' ->> 'brand_name' AS brand_name,
           t.settings -> 'brand' ->> 'reply_to' AS brand_reply_to,
           (SELECT u.email FROM users u WHERE u.tenant_id = t.id AND u.role = 'owner' AND u.deactivated_at IS NULL ORDER BY u.created_at LIMIT 1) AS owner_email
    FROM managed_sending m JOIN tenants t ON t.id = m.tenant_id
    WHERE m.tenant_id = ${tenantId}::uuid LIMIT 1`);
  const x = r.rows[0];
  if (!x) return null;
  return {
    tenantId: x.tenant_id,
    enabled: x.enabled,
    domain: x.domain,
    resendDomainId: x.resend_domain_id,
    domainStatus: isDomainStatus(x.domain_status) ? x.domain_status : "none",
    dnsRecords: Array.isArray(x.dns_records) ? x.dns_records : null,
    fromLocal: x.from_local,
    fromName: x.from_name,
    replyTo: x.reply_to,
    domainAddedAt: d(x.domain_added_at),
    domainVerifiedAt: d(x.domain_verified_at),
    domainCheckedAt: d(x.domain_checked_at),
    pausedAt: d(x.paused_at),
    pausedReason: x.paused_reason,
    pausedBy: x.paused_by,
    warnedAt: d(x.warned_at),
    tenantName: x.tenant_name,
    brandName: x.brand_name,
    brandReplyTo: x.brand_reply_to,
    ownerEmail: x.owner_email,
  };
}

/** Who this workspace's managed mail would be sent as right now. */
export function senderFor(row: SendingRow, cfg: ManagedSendingConfig): ManagedSender {
  const reply = [row.replyTo, row.brandReplyTo, row.ownerEmail].find((v) => isValidReplyAddress(v)) ?? null;
  return chooseManagedSender({
    domain: row.domain,
    domainStatus: row.domainStatus,
    fromLocal: row.fromLocal,
    fromName: row.fromName ?? row.brandName,
    fallbackName: row.tenantName,
    replyTo: reply,
    sharedFrom: cfg.sharedFrom,
  });
}

/** The adapter for a workspace's managed sending, or null when it cannot send right now. */
export async function resolveManagedAdapter(db: Db, tenantId: string, env: NodeJS.ProcessEnv = process.env): Promise<TransportAdapter | null> {
  const cfg = managedSendingConfigFromEnv(env);
  if (!cfg.enabled || !cfg.apiKey) return null;
  const row = await loadSendingRow(db, tenantId);
  if (!row || !row.enabled || row.pausedAt) return null;
  const sender = senderFor(row, cfg);
  if (!sender.ok) return null;
  return new ManagedResendAdapter({ apiKey: cfg.apiKey, baseUrl: cfg.baseUrl, fromEmail: sender.fromEmail, fromName: sender.fromName, replyTo: sender.replyTo });
}

/** The operator's Resend domains client, or null when managed sending is not offered. */
export function domainsClientFromEnv(env: NodeJS.ProcessEnv = process.env): ResendDomainsClient | null {
  const cfg = managedSendingConfigFromEnv(env);
  return cfg.enabled && cfg.apiKey ? createResendDomainsClient({ apiKey: cfg.apiKey, baseUrl: cfg.baseUrl }) : null;
}
