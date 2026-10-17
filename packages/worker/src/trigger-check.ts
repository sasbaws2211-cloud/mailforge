/**
 * Event-trigger flow enrollment job handler.
 *
 * Processes loomail.trigger-check jobs enqueued by the ingest route after each
 * track event. Evaluates which active event-triggered flows match the event
 * name, then runs the enrollment sequence for matching flows.
 *
 * This is the second enrollment path (the first is scan-enrollment.ts for
 * lifecycle-transition triggers). Both use the shared enrollContactInFlows
 * function which handles advisory locking and guards.
 *
 * Mirror side: PUBLIC (packages/worker is mirrored).
 */
import { eq, and, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { flows } from "@loomail/db/schema";
import {
  matchesEventTrigger,
  type EnrollableFlow,
  type TriggerCheckJobData,
} from "@loomail/core";
import { enrollContactInFlows } from "./enroll.js";
import { handleEventWatchers } from "./event-watchers.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Db = NodePgDatabase<Record<string, never>>;

export interface TriggerCheckResult {
  /** IDs of memberships successfully enrolled. */
  enrolledMembershipIds: string[];
  /**
   * IDs of memberships already in a flow that are waiting on this event (a wait-until fork, a goal, a plan-level
   * exit). The caller sends them through the advance job so they react now instead of on the next scan.
   */
  watchingMembershipIds: string[];
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Handle a single loomail.trigger-check job.
 *
 * Steps:
 *   1. Load active, compiled event-trigger flows for the tenant
 *   2. Filter to flows whose trigger_config.event matches the event name
 *   3. Run enrollment guards via enrollContactInFlows (advisory-locked)
 *   4. Find memberships already in flows that are waiting on this event (event-watchers.ts), and record goal
 *      conversions for people who have left their flow. This runs whether or not step 2 matched anything.
 *
 * Returns the enrolled and the watching membership IDs so the caller can chain targeted
 * step-advancement jobs.
 */
export async function handleTriggerCheck(
  data: TriggerCheckJobData,
  db: Db,
): Promise<TriggerCheckResult> {
  const { tenant_id, contact_id, event_name } = data;

  // Load active, compiled event-trigger flows for this tenant
  const tenantFlows = await db
    .select({
      id: flows.id,
      tenantId: flows.tenantId,
      priority: flows.priority,
      triggerType: flows.triggerType,
      triggerConfig: flows.triggerConfig,
      flowClass: flows.flowClass,
      reentryPolicy: flows.reentryPolicy,
      reentryCooldownDays: flows.reentryCooldownDays,
    })
    .from(flows)
    .where(
      and(
        eq(flows.tenantId, tenant_id),
        eq(flows.status, "active"),
        eq(flows.triggerType, "event"),
        eq(flows.compileStatus, "ready"),
        sql`${flows.compiledPlan} IS NOT NULL`,
      ),
    );

  // Filter to flows matching this event name
  const matchingFlows: EnrollableFlow[] = tenantFlows
    .filter((f) =>
      matchesEventTrigger(f as EnrollableFlow, event_name),
    )
    .map((f) => ({
      id: f.id,
      tenantId: f.tenantId,
      priority: f.priority ?? 0,
      triggerType: f.triggerType as "event",
      triggerConfig: f.triggerConfig,
      flowClass: (f.flowClass ?? "nurture") as "critical" | "nurture",
      reentryPolicy: (f.reentryPolicy ?? "cooldown") as "once" | "cooldown" | "every_time",
      reentryCooldownDays: f.reentryCooldownDays ?? 30,
    }));

  const now = new Date();
  let results: Awaited<ReturnType<typeof enrollContactInFlows>> = [];
  if (matchingFlows.length > 0) {
    // Enroll within a transaction (advisory lock acquired inside)
    await db.transaction(async (tx) => {
      results = await enrollContactInFlows(
        tx as unknown as Db,
        contact_id,
        tenant_id,
        matchingFlows,
        now,
      );
    });
  }

  // Collect successfully enrolled membership IDs
  const enrolledMembershipIds = results
    .filter((r) => r.enrolled)
    .map((r) => (r as { enrolled: true; membershipId: string }).membershipId);

  // Contacts already in flows who are waiting on this very event. A failure here must not lose the enrollment
  // above, and the 15-minute scan covers anything missed, so it is logged rather than thrown.
  let watchingMembershipIds: string[] = [];
  try {
    const watch = await handleEventWatchers(db, tenant_id, contact_id, event_name, now);
    watchingMembershipIds = watch.advanceMembershipIds.filter((id) => !enrolledMembershipIds.includes(id));
  } catch (err) {
    console.error(`[trigger-check] event watchers failed for contact ${contact_id}, event "${event_name}" (the scan will catch up):`, err);
  }

  return { enrolledMembershipIds, watchingMembershipIds };
}
