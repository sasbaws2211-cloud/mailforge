/**
 * Scan phase 3: step advancement and message creation.
 *
 * The per-membership logic (delay, conditions, message creation, advance or complete) is in
 * advance-core.ts, shared with the targeted job in advance-membership.ts. This file is the
 * scan around it: tenant loop, keyset pagination, checkpoints, and counters.
 *
 * Iterates all active flow memberships (checkpointed per-tenant), determines
 * whether the current step's delay has elapsed, evaluates conditions, creates
 * lifecycle_messages rows (status: pending_generation), advances current_step,
 * and completes the membership when steps run out.
 *
 * Key behaviors:
 *   - Delay for step 1 counts from membership.entered_at.
 *   - Delay for step N counts from when step N-1's message row was created.
 *   - Plan-level exit_conditions are evaluated before delay/step logic.
 *   - Step-level conditions are proceed-if gates evaluated after delay elapses.
 *   - Step-level exit_conditions fire an early exit if true after delay elapses.
 *   - Unrecognized condition shapes: membership stays active, unadvanced,
 *     condition_error recorded. Self-clears on next pass if the flow is recompiled.
 *   - If the flow is archived: exit the membership with reason "flow_archived".
 *   - If the flow is paused or compiled_plan is null: skip (recoverable state).
 *   - Crash-safe: unique index on (membership_id, flow_step_order) prevents
 *     duplicate messages. If a message exists but current_step was not advanced,
 *     the retry advances it without re-inserting.
 *
 * Checkpoint: uses scan_checkpoints table keyed by ("step_advancement", tenant_id).
 * Each batch updates the checkpoint. A stale checkpoint (older than 30 min) is
 * discarded with discard_count incremented and a warning logged.
 *
 * Mirror side: PUBLIC (packages/worker is mirrored).
 */
import { eq, and, gt } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { tenants, flowMemberships, scanCheckpoints } from "@loomail/db/schema";
import {
  advanceMembership,
  loadFlowPlanInfo,
  type AdvanceOutcome,
  type FlowPlanInfo,
} from "./advance-core.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Number of memberships fetched per keyset page. */
const BATCH_SIZE = 500;

/** Scan phase name for checkpoint keying. */
const PHASE_NAME = "step_advancement";

/** Stale checkpoint threshold: 30 minutes (2x the 15-min scan interval). */
const STALE_THRESHOLD_MS = 30 * 60 * 1000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Db = NodePgDatabase<Record<string, never>>;

export interface PhaseStepAdvancementResult {
  tenantsProcessed: number;
  membershipsEvaluated: number;
  messagesCreated: number;
  stepsAdvanced: number;
  stepsSkippedCondition: number;
  membershipsCompleted: number;
  membershipsExitedCondition: number;
  membershipsExitedArchived: number;
  membershipsSkippedPaused: number;
  membershipsStuckConditionError: number;
  /** Branches taken in branching (version 2) plans. */
  branchesTaken: number;
  staleCheckpointsDiscarded: number;
}

// ---------------------------------------------------------------------------
// Phase entry point
// ---------------------------------------------------------------------------

/**
 * Phase 3 of the scan: advance steps and create messages for all active
 * memberships. Returns aggregate stats for observability.
 *
 * @param db - Drizzle database instance.
 * @param now - Current time (injected for testability).
 * @param tenantIds - Optional tenant scope. When provided, only these tenants
 *   are processed. When omitted, all tenants are processed (production default).
 */
export async function phaseStepAdvancement(
  db: Db,
  now: Date,
  tenantIds?: string[],
): Promise<PhaseStepAdvancementResult> {
  const stats: PhaseStepAdvancementResult = {
    tenantsProcessed: 0,
    membershipsEvaluated: 0,
    messagesCreated: 0,
    stepsAdvanced: 0,
    stepsSkippedCondition: 0,
    membershipsCompleted: 0,
    membershipsExitedCondition: 0,
    membershipsExitedArchived: 0,
    membershipsSkippedPaused: 0,
    membershipsStuckConditionError: 0,
    branchesTaken: 0,
    staleCheckpointsDiscarded: 0,
  };

  // Load tenants: use provided list or discover all.
  let tenantRows: { id: string }[];
  if (tenantIds && tenantIds.length > 0) {
    tenantRows = tenantIds.map((id) => ({ id }));
  } else {
    tenantRows = await db
      .select({ id: tenants.id })
      .from(tenants)
      .orderBy(tenants.id);
  }

  for (const tenant of tenantRows) {
    let tenantStats: TenantStepResult;
    try {
      tenantStats = await processTenantStepAdvancement(
        db,
        tenant.id,
        now,
      );
    } catch (err: unknown) {
      // If a tenant is deleted mid-scan, FK violations or missing-row errors
      // can occur on checkpoint insert. Skip gracefully.
      if (isFkViolation(err)) continue;
      throw err;
    }

    stats.membershipsEvaluated += tenantStats.membershipsEvaluated;
    stats.messagesCreated += tenantStats.messagesCreated;
    stats.stepsAdvanced += tenantStats.stepsAdvanced;
    stats.stepsSkippedCondition += tenantStats.stepsSkippedCondition;
    stats.membershipsCompleted += tenantStats.membershipsCompleted;
    stats.membershipsExitedCondition += tenantStats.membershipsExitedCondition;
    stats.membershipsExitedArchived += tenantStats.membershipsExitedArchived;
    stats.membershipsSkippedPaused += tenantStats.membershipsSkippedPaused;
    stats.membershipsStuckConditionError += tenantStats.membershipsStuckConditionError;
    stats.branchesTaken += tenantStats.branchesTaken;
    stats.staleCheckpointsDiscarded += tenantStats.staleCheckpointsDiscarded;
    stats.tenantsProcessed++;
  }

  return stats;
}

// ---------------------------------------------------------------------------
// Per-tenant processing
// ---------------------------------------------------------------------------

interface TenantStepResult {
  membershipsEvaluated: number;
  messagesCreated: number;
  stepsAdvanced: number;
  stepsSkippedCondition: number;
  membershipsCompleted: number;
  membershipsExitedCondition: number;
  membershipsExitedArchived: number;
  membershipsSkippedPaused: number;
  membershipsStuckConditionError: number;
  /** Branches taken in branching (version 2) plans. */
  branchesTaken: number;
  staleCheckpointsDiscarded: number;
}

async function processTenantStepAdvancement(
  db: Db,
  tenantId: string,
  now: Date,
): Promise<TenantStepResult> {
  const stats: TenantStepResult = {
    membershipsEvaluated: 0,
    messagesCreated: 0,
    stepsAdvanced: 0,
    stepsSkippedCondition: 0,
    membershipsCompleted: 0,
    membershipsExitedCondition: 0,
    membershipsExitedArchived: 0,
    membershipsSkippedPaused: 0,
    membershipsStuckConditionError: 0,
    branchesTaken: 0,
    staleCheckpointsDiscarded: 0,
  };

  // Resolve checkpoint
  let lastId: string | null = null;
  const checkpoint = await db
    .select()
    .from(scanCheckpoints)
    .where(
      and(
        eq(scanCheckpoints.scanPhase, PHASE_NAME),
        eq(scanCheckpoints.tenantId, tenantId),
      ),
    )
    .limit(1);

  if (checkpoint.length > 0) {
    const cp = checkpoint[0]!;
    const age = now.getTime() - cp.startedAt.getTime();
    if (age > STALE_THRESHOLD_MS) {
      // Stale checkpoint - discard and start fresh
      const newCount = cp.discardCount + 1;
      await db
        .update(scanCheckpoints)
        .set({
          lastId: "00000000-0000-0000-0000-000000000000",
          startedAt: now,
          discardCount: newCount,
        })
        .where(
          and(
            eq(scanCheckpoints.scanPhase, PHASE_NAME),
            eq(scanCheckpoints.tenantId, tenantId),
          ),
        );
      console.warn(
        `[scan] step-advancement: stale checkpoint discarded for tenant ${tenantId} ` +
          `(started ${age}ms ago, threshold ${STALE_THRESHOLD_MS}ms). ` +
          `Phase did not complete in previous run. discard_count=${newCount}`,
      );
      stats.staleCheckpointsDiscarded++;
      lastId = null;
    } else {
      lastId = cp.lastId;
    }
  } else {
    // No checkpoint - create one to track this pass
    await db.insert(scanCheckpoints).values({
      scanPhase: PHASE_NAME,
      tenantId,
      lastId: "00000000-0000-0000-0000-000000000000",
      startedAt: now,
      discardCount: 0,
    }).onConflictDoNothing();
  }

  const startTime = Date.now();

  // Flow plan cache: avoid re-fetching the same flow's plan per batch
  const flowPlanCache = new Map<string, FlowPlanInfo>();

  // eslint-disable-next-line no-constant-condition
  while (true) {
    // Keyset pagination on active memberships for this tenant
    const whereConditions = [
      eq(flowMemberships.tenantId, tenantId),
      eq(flowMemberships.status, "active"),
    ];
    if (lastId !== null) {
      whereConditions.push(gt(flowMemberships.id, lastId));
    }

    const batch = await db
      .select({
        id: flowMemberships.id,
        contactId: flowMemberships.contactId,
        flowId: flowMemberships.flowId,
        currentStep: flowMemberships.currentStep,
        enteredAt: flowMemberships.enteredAt,
        conditionError: flowMemberships.conditionError,
        stepEnteredAt: flowMemberships.stepEnteredAt,
      })
      .from(flowMemberships)
      .where(and(...whereConditions))
      .orderBy(flowMemberships.id)
      .limit(BATCH_SIZE);

    if (batch.length === 0) break;

    for (const membership of batch) {
      stats.membershipsEvaluated++;

      // The flow's status and plan, cached for the rest of this pass.
      let flowInfo = flowPlanCache.get(membership.flowId);
      if (!flowInfo) {
        flowInfo = await loadFlowPlanInfo(db, membership.flowId);
        flowPlanCache.set(membership.flowId, flowInfo);
      }

      // The step logic itself lives in advance-core.ts, shared with the targeted job.
      tally(stats, await advanceMembership(db, tenantId, membership, flowInfo, now));
    }

    // Update checkpoint after each batch
    lastId = batch[batch.length - 1]!.id;
    await db
      .update(scanCheckpoints)
      .set({ lastId })
      .where(
        and(
          eq(scanCheckpoints.scanPhase, PHASE_NAME),
          eq(scanCheckpoints.tenantId, tenantId),
        ),
      );

    // If batch was smaller than BATCH_SIZE, we've exhausted this tenant
    if (batch.length < BATCH_SIZE) break;
  }

  // Full pass completed - delete the checkpoint row (start fresh next run)
  await db
    .delete(scanCheckpoints)
    .where(
      and(
        eq(scanCheckpoints.scanPhase, PHASE_NAME),
        eq(scanCheckpoints.tenantId, tenantId),
      ),
    );

  const duration = Date.now() - startTime;
  if (stats.membershipsEvaluated > 0) {
    console.log(
      `[scan] step-advancement: full pass completed for tenant ${tenantId} ` +
        `in ${duration}ms (${stats.membershipsEvaluated} memberships)`,
    );
  }

  return stats;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Turn what happened to one membership into this scan's counters. */
function tally(stats: TenantStepResult, outcome: AdvanceOutcome): void {
  stats.branchesTaken += outcome.branchHops ?? 0;
  switch (outcome.kind) {
    case "exited_archived":
      stats.membershipsExitedArchived++;
      break;
    case "skipped_not_runnable":
      stats.membershipsSkippedPaused++;
      break;
    case "stuck_condition_error":
      stats.membershipsStuckConditionError++;
      break;
    case "exited_condition":
      stats.membershipsExitedCondition++;
      break;
    case "completed_step_missing":
      stats.membershipsCompleted++;
      break;
    case "step_skipped_by_condition":
      if (outcome.completed) stats.membershipsCompleted++;
      else stats.stepsSkippedCondition++;
      break;
    case "step_done":
      if (outcome.messageId !== null) stats.messagesCreated++;
      if (outcome.applied) {
        if (outcome.completed) stats.membershipsCompleted++;
        else stats.stepsAdvanced++;
      }
      break;
    case "branch_taken":
      if (outcome.completed) stats.membershipsCompleted++;
      break;
    case "skipped_no_contact":
    case "skipped_invalid_delay":
    case "waiting_delay":
      break;
  }
}

/**
 * Check if an error is a Postgres foreign key violation (code 23503).
 * Used to gracefully handle tenants deleted mid-scan.
 * Drizzle may wrap the pg error, so check both the error itself and its cause.
 */
function isFkViolation(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  // Direct pg error
  if ("code" in err && (err as { code: string }).code === "23503") return true;
  // Drizzle wraps the original error as .cause
  if ("cause" in err) {
    const cause = (err as { cause: unknown }).cause;
    if (cause && typeof cause === "object" && "code" in cause) {
      return (cause as { code: string }).code === "23503";
    }
  }
  return false;
}
