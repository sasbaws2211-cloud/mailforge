/**
 * Plan usage and limit checks for the API.
 *
 * Loads a tenant's plan row and its current usage, and offers the two checks
 * the API enforces: adding a contact and adding a team member. The rules live
 * in @mailforge/core (entitlements.ts); this file only fetches the numbers.
 *
 * When plan enforcement is off (the default) the checks return before touching
 * the database, so self-hosted installs pay nothing for any of this.
 *
 * Mirror side: PUBLIC (packages/api is mirrored).
 */
import { sql } from "drizzle-orm";
import {
  assertWithinLimit,
  entitlementsFor,
  plansEnforced,
  startOfMonthUtc,
  type Entitlements,
} from "@mailforge/core";
import type { Db } from "../plugins/db.js";

export interface Usage {
  /** Contacts the workspace holds. */
  contacts: number;
  /** Lifecycle emails sent so far this calendar month (UTC). */
  emailsThisMonth: number;
  /** Seats in use: active team members plus pending invitations. */
  seats: number;
  members: number;
  pendingInvites: number;
}

/** The tenant's entitlements right now (cheap: one row). */
export async function loadEntitlements(db: Db, tenantId: string, now: Date = new Date()): Promise<Entitlements> {
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

async function count(db: Db, query: ReturnType<typeof sql>): Promise<number> {
  const r = await db.execute<{ n: string }>(query);
  return Number(r.rows[0]?.n ?? 0);
}

export function countContacts(db: Db, tenantId: string): Promise<number> {
  return count(db, sql`SELECT count(*)::text AS n FROM contacts WHERE tenant_id = ${tenantId}::uuid`);
}

/** Lifecycle emails sent this calendar month (UTC). Account emails are not counted. */
export function countEmailsThisMonth(db: Db, tenantId: string, now: Date = new Date()): Promise<number> {
  return count(
    db,
    sql`SELECT count(*)::text AS n FROM lifecycle_messages
         WHERE tenant_id = ${tenantId}::uuid AND status = 'sent'
           AND sent_at >= ${startOfMonthUtc(now).toISOString()}::timestamptz`,
  );
}

export function countMembers(db: Db, tenantId: string): Promise<number> {
  return count(db, sql`SELECT count(*)::text AS n FROM users WHERE tenant_id = ${tenantId}::uuid AND deactivated_at IS NULL`);
}

export function countPendingInvites(db: Db, tenantId: string, now: Date = new Date()): Promise<number> {
  return count(
    db,
    sql`SELECT count(*)::text AS n FROM invites
         WHERE tenant_id = ${tenantId}::uuid AND accepted_at IS NULL AND expires_at > ${now.toISOString()}::timestamptz`,
  );
}

/** Current usage for a tenant. Counts only; no plan logic. */
export async function loadUsage(db: Db, tenantId: string, now: Date = new Date()): Promise<Usage> {
  const [contacts, emailsThisMonth, members, pendingInvites] = await Promise.all([
    countContacts(db, tenantId),
    countEmailsThisMonth(db, tenantId, now),
    countMembers(db, tenantId),
    countPendingInvites(db, tenantId, now),
  ]);
  return { contacts, emailsThisMonth, members, pendingInvites, seats: members + pendingInvites };
}

/** Throws PlanLimitError if the tenant cannot add one more contact. */
export async function assertCanCreateContact(db: Db, tenantId: string): Promise<void> {
  if (!plansEnforced()) return;
  const ent = await loadEntitlements(db, tenantId);
  if (ent.limits.contacts === null) return;
  assertWithinLimit(ent, "contacts", await countContacts(db, tenantId));
}

/** Throws PlanLimitError if the tenant cannot add one more team member (or invitation). */
export async function assertCanAddSeat(db: Db, tenantId: string): Promise<void> {
  if (!plansEnforced()) return;
  const ent = await loadEntitlements(db, tenantId);
  if (ent.limits.seats === null) return;
  const seats = (await countMembers(db, tenantId)) + (await countPendingInvites(db, tenantId));
  assertWithinLimit(ent, "seats", seats);
}
