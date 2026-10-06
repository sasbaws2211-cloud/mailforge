/**
 * Scheduling and cancelling workspace deletion.
 *
 * Deleting is two steps on purpose. Asking for it switches the workspace off
 * (nothing sends, the API refuses keys, only export and "cancel" still work) and
 * starts a grace period. When the period ends the worker erases everything for
 * good (see @mailforge/db/purge). Until then one click undoes it.
 *
 * A live subscription is cancelled with the payment provider first, so a customer
 * is never charged for a workspace that is about to disappear. If that fails
 * nothing is scheduled.
 *
 * Mirror side: PUBLIC (packages/api is mirrored).
 */
import { eq, sql } from "drizzle-orm";
import { tenants } from "@mailforge/db/schema";
import type { Db } from "../plugins/db.js";
import type { BillingRuntime } from "../billing/config.js";
import { BillingError, cancelSubscriptionForTenant } from "../billing/service.js";

export const DEFAULT_DELETION_GRACE_DAYS = 7;

/** Days between asking and erasure: MAILFORGE_DELETION_GRACE_DAYS (1 to 90), default 7. */
export function deletionGraceDays(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number.parseInt(env.MAILFORGE_DELETION_GRACE_DAYS ?? "", 10);
  return Number.isInteger(n) && n >= 1 && n <= 90 ? n : DEFAULT_DELETION_GRACE_DAYS;
}

export interface DeletionStatus {
  scheduled: boolean;
  requestedAt: Date | null;
  scheduledAt: Date | null;
  requestedBy: string | null;
}

export async function deletionStatus(db: Db, tenantId: string): Promise<DeletionStatus> {
  const [t] = await db
    .select({ r: tenants.deletionRequestedAt, s: tenants.deletionScheduledAt, b: tenants.deletionRequestedBy })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  return { scheduled: !!t?.s, requestedAt: t?.r ?? null, scheduledAt: t?.s ?? null, requestedBy: t?.b ?? null };
}

/**
 * Switch the workspace off and set the erasure date. Returns the date, or null if a
 * deletion was already scheduled (nothing changes). Throws BillingError when the
 * subscription cannot be cancelled with the provider.
 */
export async function scheduleDeletion(
  db: Db,
  billing: BillingRuntime | undefined,
  input: { tenantId: string; requestedBy: string; now?: Date; graceDays?: number },
): Promise<Date | null> {
  const now = input.now ?? new Date();
  const days = input.graceDays ?? deletionGraceDays();

  if (billing?.enabled && billing.client) {
    try {
      await cancelSubscriptionForTenant(db, billing.client, input.tenantId, now);
    } catch (err) {
      // "No active subscription" is the normal case for Free workspaces and already-cancelled ones.
      if (!(err instanceof BillingError && err.code === "no_subscription")) throw err;
    }
  }

  const scheduledAt = new Date(now.getTime() + days * 86_400_000);
  const r = await db.execute(sql`
    UPDATE tenants
    SET deletion_requested_at = ${now.toISOString()}::timestamptz,
        deletion_scheduled_at = ${scheduledAt.toISOString()}::timestamptz,
        deletion_requested_by = ${input.requestedBy}
    WHERE id = ${input.tenantId}::uuid AND deletion_scheduled_at IS NULL`);
  return (r.rowCount ?? 0) > 0 ? scheduledAt : null;
}

/** Undo a scheduled deletion. True if there was one to undo. */
export async function cancelDeletion(db: Pick<Db, "execute">, tenantId: string): Promise<boolean> {
  const r = await db.execute(sql`
    UPDATE tenants
    SET deletion_requested_at = NULL, deletion_scheduled_at = NULL, deletion_requested_by = NULL
    WHERE id = ${tenantId}::uuid AND deletion_scheduled_at IS NOT NULL`);
  return (r.rowCount ?? 0) > 0;
}
