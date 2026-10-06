/**
 * Managed sending domains: keep a workspace's sending-domain record in step with Resend,
 * and clean up domains that no longer have an owner.
 *
 * Mirror side: PUBLIC (packages/api is mirrored).
 */
import { and, eq, lt, sql } from "drizzle-orm";
import { managedDomainCleanup, managedSending } from "@mailforge/db/schema";
import type { ResendDomain, ResendDomainsClient } from "@mailforge/adapters";
import type { Db } from "../plugins/db.js";
import type { SendingRow } from "./context.js";

/** A pending domain is not re-checked with Resend more often than this. */
export const DOMAIN_REFRESH_MIN_MS = 20_000;

/** After this many failed removals a domain is left in the queue and shown to the operator. */
const MAX_CLEANUP_ATTEMPTS = 20;

/** Write what Resend says about the domain onto the workspace's row. */
export async function applyDomainState(db: Db, tenantId: string, domain: ResendDomain, now: Date = new Date()): Promise<void> {
  await db
    .update(managedSending)
    .set({
      domainStatus: domain.status,
      dnsRecords: domain.records,
      domainCheckedAt: now,
      // Keep the first time it was seen verified; clear it if Resend later says it is not.
      domainVerifiedAt: domain.status === "verified" ? sql`COALESCE(${managedSending.domainVerifiedAt}, ${now.toISOString()}::timestamptz)` : null,
      updatedAt: now,
    })
    .where(and(eq(managedSending.tenantId, tenantId), eq(managedSending.resendDomainId, domain.id)));
}

/**
 * Re-read the domain from Resend if it is not verified yet and was not checked just now.
 * Returns true when it asked Resend. Errors are swallowed: the stored state simply stays as it was.
 */
export async function refreshDomainIfDue(db: Db, client: ResendDomainsClient, row: SendingRow, now: Date = new Date()): Promise<boolean> {
  if (!row.resendDomainId || row.domainStatus === "verified" || row.domainStatus === "none") return false;
  if (row.domainCheckedAt && now.getTime() - row.domainCheckedAt.getTime() < DOMAIN_REFRESH_MIN_MS) return false;
  const r = await client.getDomain(row.resendDomainId);
  if (r.ok) await applyDomainState(db, row.tenantId, r.value, now);
  return true;
}

/**
 * Remove a domain from Resend. A domain Resend does not know is already gone. Anything else (Resend
 * down, key problem) puts it in the cleanup queue so it is not left behind.
 */
export async function removeResendDomain(db: Db, client: ResendDomainsClient | null, resendDomainId: string, domain: string | null): Promise<void> {
  if (client) {
    const r = await client.deleteDomain(resendDomainId);
    if (r.ok || r.kind === "not_found") return;
  }
  await db
    .insert(managedDomainCleanup)
    .values({ resendDomainId, domain })
    .onConflictDoNothing();
}

/** Remove queued domains from Resend, one try each. Returns how many were removed. Never throws. */
export async function sweepDomainCleanup(db: Db, client: ResendDomainsClient | null, log?: { warn: (o: unknown, m?: string) => void }): Promise<number> {
  if (!client) return 0;
  let removed = 0;
  try {
    const due = await db.select().from(managedDomainCleanup).where(lt(managedDomainCleanup.attempts, MAX_CLEANUP_ATTEMPTS)).limit(25);
    for (const item of due) {
      const r = await client.deleteDomain(item.resendDomainId);
      if (r.ok || r.kind === "not_found") {
        await db.delete(managedDomainCleanup).where(eq(managedDomainCleanup.resendDomainId, item.resendDomainId));
        removed++;
      } else {
        await db
          .update(managedDomainCleanup)
          .set({ attempts: sql`${managedDomainCleanup.attempts} + 1`, lastError: `${r.kind}${r.status ? ` ${r.status}` : ""}` })
          .where(eq(managedDomainCleanup.resendDomainId, item.resendDomainId));
        log?.warn({ domain: item.domain, kind: r.kind }, "Could not remove a sending domain from Resend; will retry");
      }
    }
  } catch (err) {
    log?.warn({ error: err instanceof Error ? err.message : String(err) }, "Sending-domain cleanup failed");
  }
  return removed;
}
