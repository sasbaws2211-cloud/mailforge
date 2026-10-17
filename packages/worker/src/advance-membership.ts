/**
 * Targeted step advancement: process a single membership's current step.
 *
 * Enqueued immediately after enrollment succeeds (trigger-check or scan-enrollment).
 * Eliminates the 15-min scan wait for freshly enrolled contacts. The periodic
 * scan remains as a safety net.
 *
 * The step logic is the same code the scan runs (advance-core.ts); this file only
 * loads one membership by ID and reports what happened in its own result shape.
 *
 * Safety:
 *   - CAS on current_step prevents double-advance if both targeted and cron fire.
 *   - ON CONFLICT DO NOTHING on message insert prevents duplicates.
 *   - If the membership is not active (already completed/exited), returns immediately.
 *
 * Mirror side: PUBLIC (packages/worker is mirrored).
 */
import { eq, and } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { flowMemberships } from "@loomail/db/schema";
import type { AdvanceMembershipJobData } from "@loomail/core";
import { advanceMembership, loadFlowPlanInfo } from "./advance-core.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Db = NodePgDatabase<Record<string, never>>;

export interface AdvanceMembershipResult {
  /** Whether a message was created for this step. */
  messageCreated: boolean;
  /** Whether the membership was advanced to the next step. */
  advanced: boolean;
  /** Whether the membership completed (no more steps). */
  completed: boolean;
  /** Whether the membership was exited by a condition. */
  exited: boolean;
  /** Whether nothing was done (delay not elapsed, flow paused, condition unreadable, ...). */
  skipped: boolean;
  /** The ID of the created message, if any. */
  messageId?: string;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Handle a single loomail.advance-membership job.
 *
 * Processes the current step of the specified membership. If the step's delay
 * has elapsed (for step 1 with delay "0h" this is always true at enrollment
 * time), creates a pending_generation message and advances the step.
 *
 * Returns the result for observability and chaining (the caller can enqueue
 * a process-message job if a message was created).
 */
export async function handleAdvanceMembership(
  data: AdvanceMembershipJobData,
  db: Db,
): Promise<AdvanceMembershipResult> {
  const { tenant_id: tenantId, membership_id: membershipId } = data;
  const now = new Date();

  const result: AdvanceMembershipResult = {
    messageCreated: false,
    advanced: false,
    completed: false,
    exited: false,
    skipped: false,
  };

  const membershipRows = await db
    .select({
      id: flowMemberships.id,
      contactId: flowMemberships.contactId,
      flowId: flowMemberships.flowId,
      currentStep: flowMemberships.currentStep,
      enteredAt: flowMemberships.enteredAt,
      conditionError: flowMemberships.conditionError,
      stepEnteredAt: flowMemberships.stepEnteredAt,
      status: flowMemberships.status,
    })
    .from(flowMemberships)
    .where(and(eq(flowMemberships.id, membershipId), eq(flowMemberships.tenantId, tenantId)))
    .limit(1);

  // Only an active membership is processed.
  if (membershipRows.length === 0 || membershipRows[0]!.status !== "active") {
    result.skipped = true;
    return result;
  }

  const membership = membershipRows[0]!;
  const flow = await loadFlowPlanInfo(db, membership.flowId);
  const outcome = await advanceMembership(db, tenantId, membership, flow, now);

  switch (outcome.kind) {
    case "exited_archived":
    case "exited_condition":
      result.exited = true;
      break;
    case "completed_step_missing":
      result.completed = true;
      break;
    case "step_skipped_by_condition":
      if (outcome.completed) result.completed = true;
      else result.advanced = true;
      break;
    case "branch_taken":
      // A branching plan sent the contact on without an email, or to the end.
      if (outcome.completed) result.completed = true;
      else result.advanced = true;
      break;
    case "step_done":
      if (outcome.messageId !== null) {
        result.messageCreated = true;
        result.messageId = outcome.messageId;
      }
      if (outcome.completed) result.completed = true;
      else if (outcome.applied) result.advanced = true;
      break;
    case "skipped_not_runnable":
    case "skipped_no_contact":
    case "stuck_condition_error":
    case "skipped_invalid_delay":
    case "waiting_delay":
      result.skipped = true;
      break;
  }

  return result;
}
