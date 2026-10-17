/**
 * Advance ONE membership by one step: the single implementation behind both the targeted job
 * (advance-membership.ts, run right after enrollment) and the 15-minute scan (scan-step-advancement.ts).
 *
 * It used to exist twice, in two files that had to be kept in step by hand. Now both callers load a
 * membership and a plan, call advanceMembership(), and turn the returned outcome into their own result
 * (the scan into counters, the targeted job into an AdvanceMembershipResult).
 *
 * What it does, in order:
 *   1. Flow archived: exit the membership. Flow paused or without a plan: leave it alone.
 *   2. Plan-level exit conditions (before any step logic).
 *   3. Find the current step; if the plan no longer has it, complete the membership.
 *   4. Delay: step 1 counts from entered_at; step N counts from step N-1's message (entered_at if that
 *      step was skipped). Not yet due: leave it alone.
 *   5. The step's own exit_condition, then its proceed-if condition (false: skip the step, no message).
 *   6. Create the message (ON CONFLICT DO NOTHING, so a crash and retry cannot duplicate it) and
 *      advance, or complete on the last step. Every update is compare-and-set on current_step.
 *
 * A condition the engine cannot read leaves the membership active and unadvanced, with the problem
 * written to condition_error; it clears itself once the flow is recompiled with a valid condition.
 *
 * Mirror side: PUBLIC (packages/worker is mirrored).
 */
import { eq, and, gte } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { contacts, events, flows, flowMemberships, lifecycleMessages } from "@loomail/db/schema";
import {
  parseDelay,
  delayToMs,
  stepTarget,
  type CompiledBranch,
  type CompiledStep,
  type NodeTarget,
} from "@loomail/core";
import {
  evaluateStepCondition,
  evaluatePlanExitCondition,
  formatConditionError,
  type ContactState,
  type EventChecker,
} from "./condition-evaluator.js";

type Db = NodePgDatabase<Record<string, never>>;

/** The columns of a membership the engine needs. */
export interface MembershipToAdvance {
  id: string;
  contactId: string;
  flowId: string;
  currentStep: number;
  enteredAt: Date;
  conditionError: string | null;
  /** When the contact arrived at currentStep. Only branching (version 2) plans use it; null until the first move. */
  stepEnteredAt: Date | null;
}

/** A flow's status and the parts of its compiled plan the engine reads. */
export interface FlowPlanInfo {
  status: string;
  steps: CompiledStep[] | null;
  exitConditions: unknown[] | null;
  /** 1: the original straight line. 2: may have branches and explicit `next` (see core's flow/plan-graph.ts). */
  version: 1 | 2;
  /** Forks, for a version 2 plan. */
  branches: CompiledBranch[] | null;
}

/** What happened to the membership. Callers translate this into their own counters or result shape. */
export type AdvanceOutcome = AdvanceOutcomeKind & {
  /** Branches passed through in this call (version 2 plans only; absent when none). */
  branchHops?: number;
};

type AdvanceOutcomeKind =
  /** The flow is archived: the membership was exited. */
  | { kind: "exited_archived" }
  /** The flow is paused or has no plan: nothing done, recoverable. */
  | { kind: "skipped_not_runnable" }
  /** The contact no longer exists: nothing done. */
  | { kind: "skipped_no_contact" }
  /** A condition could not be read: left active and unadvanced, with condition_error recorded. */
  | { kind: "stuck_condition_error" }
  /** A plan-level or step-level exit condition fired: the membership exited. */
  | { kind: "exited_condition" }
  /** The plan no longer has this step (it was recompiled shorter): the membership completed. */
  | { kind: "completed_step_missing" }
  /** The step's delay is not a valid delay: nothing done. */
  | { kind: "skipped_invalid_delay" }
  /** The step's delay has not elapsed yet: nothing done. */
  | { kind: "waiting_delay" }
  /** The step's proceed-if condition was false: no message; moved on (or completed, on the last step). */
  | { kind: "step_skipped_by_condition"; completed: boolean }
  /**
   * The step ran. `messageId` is set when this call created the message (null when it already existed from
   * an earlier crashed attempt). `completed` is true on the last step. `applied` is false when another
   * worker advanced the membership first.
   */
  | { kind: "step_done"; messageId: string | null; completed: boolean; applied: boolean }
  /**
   * Version 2 only: one or more branches were taken and nothing was sent in this call (the next node is not
   * due yet, or the flow ended). `completed` is true when a branch sent the contact to the end.
   */
  | { kind: "branch_taken"; completed: boolean; applied: boolean };

/** Steps of a compiled plan, read leniently (conditions are checked later, so a bad one can be reported). */
export function extractSteps(compiledPlan: unknown): CompiledStep[] | null {
  if (compiledPlan === null || compiledPlan === undefined) return null;
  if (typeof compiledPlan !== "object") return null;
  const plan = compiledPlan as Record<string, unknown>;
  if (!Array.isArray(plan.steps)) return null;
  return plan.steps as CompiledStep[];
}

/** Plan-level exit conditions, or null when absent or empty. */
export function extractExitConditions(compiledPlan: unknown): unknown[] | null {
  if (compiledPlan === null || compiledPlan === undefined) return null;
  if (typeof compiledPlan !== "object") return null;
  const plan = compiledPlan as Record<string, unknown>;
  if (!Array.isArray(plan.exit_conditions)) return null;
  if (plan.exit_conditions.length === 0) return null;
  return plan.exit_conditions;
}

/** 2 for a branching plan, otherwise 1. */
export function extractVersion(compiledPlan: unknown): 1 | 2 {
  if (compiledPlan === null || typeof compiledPlan !== "object") return 1;
  return (compiledPlan as Record<string, unknown>).version === 2 ? 2 : 1;
}

/** Forks of a branching plan, read leniently like the steps. */
export function extractBranches(compiledPlan: unknown): CompiledBranch[] | null {
  if (compiledPlan === null || typeof compiledPlan !== "object") return null;
  const plan = compiledPlan as Record<string, unknown>;
  return Array.isArray(plan.branches) ? (plan.branches as CompiledBranch[]) : null;
}

/** Load a flow's status and plan. A flow that no longer exists is treated as archived. */
export async function loadFlowPlanInfo(db: Db, flowId: string): Promise<FlowPlanInfo> {
  const rows = await db
    .select({ status: flows.status, compiledPlan: flows.compiledPlan })
    .from(flows)
    .where(eq(flows.id, flowId))
    .limit(1);
  if (rows.length === 0) return { status: "archived", steps: null, exitConditions: null, version: 1, branches: null };
  const raw = rows[0]!;
  return {
    status: raw.status ?? "draft",
    steps: extractSteps(raw.compiledPlan),
    exitConditions: extractExitConditions(raw.compiledPlan),
    version: extractVersion(raw.compiledPlan),
    branches: extractBranches(raw.compiledPlan),
  };
}

export async function advanceMembership(
  db: Db,
  tenantId: string,
  membership: MembershipToAdvance,
  flow: FlowPlanInfo,
  now: Date,
): Promise<AdvanceOutcome> {
  // Archived flow: exit the membership.
  if (flow.status === "archived") {
    await db
      .update(flowMemberships)
      .set({ status: "exited", exitedAt: now, exitReason: "flow_archived" })
      .where(and(eq(flowMemberships.id, membership.id), eq(flowMemberships.status, "active")));
    return { kind: "exited_archived" };
  }

  // Paused flow or no plan: leave it alone (recoverable).
  if (flow.status === "paused" || flow.steps === null) {
    return { kind: "skipped_not_runnable" };
  }

  const clearError = membership.conditionError !== null ? { conditionError: null } : {};
  const recordError = async (message: string) => {
    // Written only when it differs from what is stored, so repeat passes do not churn the row.
    if (membership.conditionError !== message) {
      await db.update(flowMemberships).set({ conditionError: message }).where(eq(flowMemberships.id, membership.id));
    }
  };
  const exitMembership = async () => {
    await db
      .update(flowMemberships)
      .set({ status: "exited", exitedAt: now, exitReason: "condition_met", ...clearError })
      .where(and(eq(flowMemberships.id, membership.id), eq(flowMemberships.status, "active")));
  };

  // Condition inputs: the contact's current state, and a way to ask "did this event happen since...".
  const contactRow = await db
    .select({
      lifecycleState: contacts.lifecycleState,
      paymentStatus: contacts.paymentStatus,
      engagementDepth: contacts.engagementDepth,
      email: contacts.email,
      properties: contacts.properties,
    })
    .from(contacts)
    .where(eq(contacts.id, membership.contactId))
    .limit(1);
  if (contactRow.length === 0) {
    return { kind: "skipped_no_contact" };
  }
  const contactState: ContactState = contactRow[0]!;
  const eventChecker: EventChecker = {
    async hasEventSince(eventName: string, since: Date): Promise<boolean> {
      const found = await db
        .select({ id: events.id })
        .from(events)
        .where(
          and(
            eq(events.contactId, membership.contactId),
            eq(events.eventName, eventName),
            gte(events.timestamp, since),
          ),
        )
        .limit(1);
      return found.length > 0;
    },
    async countEventsSince(eventName: string, since: Date, limit: number): Promise<number> {
      // Reads at most `limit` rows: "at least 3 times" never needs more than 3.
      const found = await db
        .select({ id: events.id })
        .from(events)
        .where(
          and(
            eq(events.contactId, membership.contactId),
            eq(events.eventName, eventName),
            gte(events.timestamp, since),
          ),
        )
        .limit(limit);
      return found.length;
    },
  };
  const times = { now, enteredAt: membership.enteredAt };

  // Plan-level exit conditions come before any step logic.
  if (flow.exitConditions && flow.exitConditions.length > 0) {
    let exitFired = false;
    let conditionErrorMsg: string | null = null;
    for (const ec of flow.exitConditions) {
      const result = await evaluatePlanExitCondition(ec, contactState, eventChecker, membership.enteredAt, times);
      if (result.outcome === "unknown_shape") {
        conditionErrorMsg = formatConditionError({ type: "plan_exit" }, result.message);
        break;
      }
      if (result.outcome === "pass") {
        exitFired = true;
        break;
      }
    }
    if (conditionErrorMsg !== null) {
      await recordError(conditionErrorMsg);
      return { kind: "stuck_condition_error" };
    }
    if (exitFired) {
      await exitMembership();
      return { kind: "exited_condition" };
    }
  }

  // A branching plan has its own path through the steps; a straight-line plan carries on below, unchanged.
  if (flow.version === 2) {
    return advanceBranching({ db, tenantId, membership, flow: { ...flow, steps: flow.steps }, now, contactState, eventChecker, times, recordError, exitMembership });
  }

  // The current step. If the plan was recompiled with fewer steps, there is nothing left to do.
  const steps = flow.steps;
  const currentStepDef = steps.find((s) => s.order === membership.currentStep);
  if (!currentStepDef) {
    await db
      .update(flowMemberships)
      .set({ status: "completed", completedAt: now, exitReason: "completed", ...clearError })
      .where(and(eq(flowMemberships.id, membership.id), eq(flowMemberships.status, "active")));
    return { kind: "completed_step_missing" };
  }

  // The delay counts from entry (step 1) or from the previous step's message (the entry time if that
  // step was skipped, so the delay has by then elapsed).
  let referenceTime: Date;
  if (membership.currentStep === 1) {
    referenceTime = membership.enteredAt;
  } else {
    const prevMessage = await db
      .select({ createdAt: lifecycleMessages.createdAt })
      .from(lifecycleMessages)
      .where(
        and(
          eq(lifecycleMessages.membershipId, membership.id),
          eq(lifecycleMessages.flowStepOrder, membership.currentStep - 1),
        ),
      )
      .limit(1);
    referenceTime =
      prevMessage.length === 0 || !prevMessage[0]!.createdAt ? membership.enteredAt : prevMessage[0]!.createdAt;
  }

  const delay = parseDelay(currentStepDef.delay);
  if (delay === null) {
    // Compilation validates delays, so this should not happen; do nothing rather than guess.
    return { kind: "skipped_invalid_delay" };
  }
  if (now.getTime() - referenceTime.getTime() < delayToMs(delay)) {
    // Not due. Getting this far means the plan read fine, so any old condition error is stale.
    if (membership.conditionError !== null) {
      await db.update(flowMemberships).set({ conditionError: null }).where(eq(flowMemberships.id, membership.id));
    }
    return { kind: "waiting_delay" };
  }

  // The step's own exit condition.
  if (currentStepDef.exit_condition !== undefined) {
    const exitResult = await evaluateStepCondition(currentStepDef.exit_condition, contactState, eventChecker, referenceTime, times);
    if (exitResult.outcome === "unknown_shape") {
      await recordError(
        formatConditionError({ type: "step_exit_condition", stepOrder: membership.currentStep }, exitResult.message),
      );
      return { kind: "stuck_condition_error" };
    }
    if (exitResult.outcome === "pass") {
      await exitMembership();
      return { kind: "exited_condition" };
    }
  }

  const isLastStep = membership.currentStep >= steps.length;

  // The step's proceed-if condition: false means skip the step (no message) and move on.
  if (currentStepDef.condition !== undefined) {
    const condResult = await evaluateStepCondition(currentStepDef.condition, contactState, eventChecker, referenceTime, times);
    if (condResult.outcome === "unknown_shape") {
      await recordError(
        formatConditionError({ type: "step_condition", stepOrder: membership.currentStep }, condResult.message),
      );
      return { kind: "stuck_condition_error" };
    }
    if (condResult.outcome === "fail") {
      if (isLastStep) {
        await db
          .update(flowMemberships)
          .set({
            status: "completed",
            completedAt: now,
            exitReason: "completed",
            currentStep: membership.currentStep,
            ...clearError,
          })
          .where(
            and(
              eq(flowMemberships.id, membership.id),
              eq(flowMemberships.status, "active"),
              eq(flowMemberships.currentStep, membership.currentStep),
            ),
          );
      } else {
        await db
          .update(flowMemberships)
          .set({ currentStep: membership.currentStep + 1, ...clearError })
          .where(
            and(
              eq(flowMemberships.id, membership.id),
              eq(flowMemberships.status, "active"),
              eq(flowMemberships.currentStep, membership.currentStep),
            ),
          );
      }
      return { kind: "step_skipped_by_condition", completed: isLastStep };
    }
  }

  // Everything passed: create the message. ON CONFLICT DO NOTHING makes a retry after a crash safe.
  const inserted = await db
    .insert(lifecycleMessages)
    .values({
      tenantId,
      contactId: membership.contactId,
      flowId: membership.flowId,
      membershipId: membership.id,
      flowStepOrder: membership.currentStep,
      status: "pending_generation",
      brainActionType: currentStepDef.action_type,
    })
    .onConflictDoNothing()
    .returning({ id: lifecycleMessages.id });
  const messageId = inserted.length > 0 ? inserted[0]!.id : null;

  // Move on whether or not the message was new: if it already existed, an earlier attempt crashed
  // before advancing, and advancing is what is left to do. Compare-and-set stops a double advance.
  const updated = await db
    .update(flowMemberships)
    .set(
      isLastStep
        ? { status: "completed", completedAt: now, exitReason: "completed", currentStep: membership.currentStep, ...clearError }
        : { currentStep: membership.currentStep + 1, ...clearError },
    )
    .where(
      and(
        eq(flowMemberships.id, membership.id),
        eq(flowMemberships.status, "active"),
        eq(flowMemberships.currentStep, membership.currentStep),
      ),
    )
    .returning({ id: flowMemberships.id });

  return { kind: "step_done", messageId, completed: isLastStep, applied: updated.length > 0 };
}

// ---------------------------------------------------------------------------
// Branching plans (version 2)
// ---------------------------------------------------------------------------

/** Most branches passed through in one call: plans are checked for loops when saved, so this only ever stops a corrupt one. */
const MAX_BRANCH_HOPS = 25;

interface BranchingContext {
  db: Db;
  tenantId: string;
  membership: MembershipToAdvance;
  flow: FlowPlanInfo & { steps: CompiledStep[] };
  now: Date;
  contactState: ContactState;
  eventChecker: EventChecker;
  times: { now: Date; enteredAt: Date };
  recordError: (message: string) => Promise<void>;
  exitMembership: () => Promise<void>;
}

/**
 * Advance a contact through a version 2 plan. The contact is at a NODE (an email step or a fork); each call
 * handles the node it is at, and keeps going through forks that are due so a decision never waits for the next
 * scan. It stops after sending an email (one message per call, so the caller can hand that message on), or when
 * the next node is not due, or when the flow ends.
 *
 * Delays count from when the contact ARRIVED at the node (step_entered_at, or entry for the first node), and a
 * fork's own `event ... since: "step"` measures from that arrival too. Every move is compare-and-set on
 * current_step, so two workers cannot both move the same contact.
 */
async function advanceBranching(c: BranchingContext): Promise<AdvanceOutcome> {
  const { db, tenantId, flow, now } = c;
  const graph = { steps: flow.steps, branches: flow.branches ?? [] };

  let at = c.membership.currentStep;
  let arrivedAt = c.membership.stepEnteredAt ?? c.membership.enteredAt;
  let staleError = c.membership.conditionError; // cleared by the first move that succeeds
  let hops = 0;
  const done = <T extends AdvanceOutcomeKind>(o: T): AdvanceOutcome => (hops > 0 ? { ...o, branchHops: hops } : o);

  /** Move the contact to `target` (or finish the flow), only if nobody else has moved it. */
  const moveTo = async (target: NodeTarget): Promise<boolean> => {
    const clear = staleError !== null ? { conditionError: null } : {};
    const updated = await db
      .update(flowMemberships)
      .set(
        target === "end"
          ? { status: "completed", completedAt: now, exitReason: "completed", currentStep: at, ...clear }
          : { currentStep: target, stepEnteredAt: now, ...clear },
      )
      .where(
        and(
          eq(flowMemberships.id, c.membership.id),
          eq(flowMemberships.status, "active"),
          eq(flowMemberships.currentStep, at),
        ),
      )
      .returning({ id: flowMemberships.id });
    if (updated.length === 0) return false;
    staleError = null;
    return true;
  };

  for (;;) {
    const stepDef = graph.steps.find((s) => s.order === at);
    const branchDef = stepDef ? undefined : graph.branches.find((b) => b.order === at);

    // The plan no longer has this node (it was recompiled): nothing left to do.
    if (!stepDef && !branchDef) {
      await db
        .update(flowMemberships)
        .set({ status: "completed", completedAt: now, exitReason: "completed", ...(staleError !== null ? { conditionError: null } : {}) })
        .where(and(eq(flowMemberships.id, c.membership.id), eq(flowMemberships.status, "active")));
      return done({ kind: "completed_step_missing" });
    }

    const delay = parseDelay((stepDef ?? branchDef)!.delay);
    if (delay === null) return done({ kind: "skipped_invalid_delay" });
    const due = now.getTime() - arrivedAt.getTime() >= delayToMs(delay);
    // A wait-until fork is looked at before its time is up: it goes on early the moment its condition holds.
    const waitingEarly = !due && branchDef?.early === true;
    if (!due && !waitingEarly) {
      // Not due. The plan read fine, so any old condition error is stale.
      if (staleError !== null) {
        await db.update(flowMemberships).set({ conditionError: null }).where(eq(flowMemberships.id, c.membership.id));
        staleError = null;
      }
      return done(hops > 0 ? { kind: "branch_taken", completed: false, applied: true } : { kind: "waiting_delay" });
    }

    // A fork: check its condition and go one way or the other. No email.
    if (branchDef) {
      const result = await evaluateStepCondition(branchDef.condition, c.contactState, c.eventChecker, arrivedAt, c.times);
      if (waitingEarly && result.outcome === "fail") {
        // Still waiting: the thing has not happened yet and there is time left.
        if (staleError !== null) {
          await db.update(flowMemberships).set({ conditionError: null }).where(eq(flowMemberships.id, c.membership.id));
          staleError = null;
        }
        return done(hops > 0 ? { kind: "branch_taken", completed: false, applied: true } : { kind: "waiting_delay" });
      }
      if (result.outcome === "unknown_shape") {
        await c.recordError(formatConditionError({ type: "step_condition", stepOrder: at }, result.message));
        return done({ kind: "stuck_condition_error" });
      }
      if (hops >= MAX_BRANCH_HOPS) {
        await c.recordError("plan: too many branches in a row (does the plan loop?)");
        return done({ kind: "stuck_condition_error" });
      }
      const target = result.outcome === "pass" ? branchDef.then : branchDef.else;
      if (!(await moveTo(target))) return done({ kind: "waiting_delay" }); // someone else moved it first
      hops++;
      if (target === "end") return done({ kind: "branch_taken", completed: true, applied: true });
      at = target;
      arrivedAt = now;
      continue;
    }

    // An email step.
    const step = stepDef!;
    if (step.exit_condition !== undefined) {
      const exitResult = await evaluateStepCondition(step.exit_condition, c.contactState, c.eventChecker, arrivedAt, c.times);
      if (exitResult.outcome === "unknown_shape") {
        await c.recordError(formatConditionError({ type: "step_exit_condition", stepOrder: at }, exitResult.message));
        return done({ kind: "stuck_condition_error" });
      }
      if (exitResult.outcome === "pass") {
        await c.exitMembership();
        return done({ kind: "exited_condition" });
      }
    }

    const target = stepTarget(graph, step);

    if (step.condition !== undefined) {
      const condResult = await evaluateStepCondition(step.condition, c.contactState, c.eventChecker, arrivedAt, c.times);
      if (condResult.outcome === "unknown_shape") {
        await c.recordError(formatConditionError({ type: "step_condition", stepOrder: at }, condResult.message));
        return done({ kind: "stuck_condition_error" });
      }
      if (condResult.outcome === "fail") {
        // Skip this email (no message) and move on to where it would have gone next.
        await moveTo(target);
        return done({ kind: "step_skipped_by_condition", completed: target === "end" });
      }
    }

    const inserted = await db
      .insert(lifecycleMessages)
      .values({
        tenantId,
        contactId: c.membership.contactId,
        flowId: c.membership.flowId,
        membershipId: c.membership.id,
        flowStepOrder: at,
        status: "pending_generation",
        brainActionType: step.action_type,
      })
      .onConflictDoNothing()
      .returning({ id: lifecycleMessages.id });
    const messageId = inserted.length > 0 ? inserted[0]!.id : null;

    const applied = await moveTo(target);
    return done({ kind: "step_done", messageId, completed: target === "end", applied });
  }
}
