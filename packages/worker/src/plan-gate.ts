/**
 * Plan gate for the drain: monthly email allowance and the credit line.
 *
 * The rules live in @mailforge/core (entitlements.ts); this file fetches the
 * tenant's plan row and this month's send count. With plan enforcement off
 * (the default) every function answers "unlimited" without touching the
 * database, so self-hosted installs are unaffected.
 *
 * Mirror side: PUBLIC (packages/worker is mirrored).
 */
import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  entitlementsFor,
  plansEnforced,
  startOfMonthUtc,
  type Entitlements,
} from "@mailforge/core";

type Db = NodePgDatabase<Record<string, never>>;

export async function loadTenantEntitlements(db: Db, tenantId: string, now: Date): Promise<Entitlements> {
  const r = await db.execute<{
    plan: string | null;
    trial_ends_at: Date | string | null;
    plan_paid_through: Date | string | null;
    ai_allowance_override: number | null;
  }>(sql`SELECT plan, trial_ends_at, plan_paid_through, ai_allowance_override FROM tenants WHERE id = ${tenantId}::uuid LIMIT 1`);
  const row = r.rows[0];
  return entitlementsFor({
    plan: row?.plan ?? null,
    trialEndsAt: row?.trial_ends_at ? new Date(row.trial_ends_at) : null,
    paidThrough: row?.plan_paid_through ? new Date(row.plan_paid_through) : null,
    aiTokensOverride: row?.ai_allowance_override ?? null,
    now,
  });
}

/**
 * How many more lifecycle emails this tenant may send this calendar month
 * (UTC), or null when there is no cap. Never negative: a tenant already over
 * (for example one that downgraded) has 0.
 */
export async function remainingMonthlyEmails(db: Db, tenantId: string, now: Date): Promise<number | null> {
  if (!plansEnforced()) return null;
  const ent = await loadTenantEntitlements(db, tenantId, now);
  const cap = ent.limits.emailsPerMonth;
  if (cap === null) return null;
  const r = await db.execute<{ n: string }>(sql`
    SELECT count(*)::text AS n FROM lifecycle_messages
    WHERE tenant_id = ${tenantId}::uuid AND status = 'sent'
      AND sent_at >= ${startOfMonthUtc(now).toISOString()}::timestamptz`);
  return Math.max(0, cap - Number(r.rows[0]?.n ?? 0));
}

/** The credit line for a tenant's emails (shared with the public pages; defined in core). */
export { poweredByFor } from "@mailforge/core";

/** Which of these tenants are suspended or scheduled for deletion. Nothing is sent for them. */
export async function suspendedTenantIds(db: Db, tenantIds: string[]): Promise<Set<string>> {
  if (tenantIds.length === 0) return new Set();
  const r = await db.execute<{ id: string }>(sql`
    SELECT id FROM tenants
    WHERE (suspended_at IS NOT NULL OR deletion_scheduled_at IS NOT NULL)
      AND id = ANY(string_to_array(${tenantIds.join(",")}, ',')::uuid[])`);
  return new Set(r.rows.map((row) => row.id));
}
