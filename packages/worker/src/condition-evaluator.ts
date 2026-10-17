/**
 * Condition evaluator for flow step conditions and plan-level exit conditions.
 *
 * Evaluates the closed vocabulary of condition shapes against contact state
 * and event history. Returns a discriminated result:
 *   - { outcome: "pass" } - condition is true, proceed
 *   - { outcome: "fail" } - condition is false, skip/do-not-exit
 *   - { outcome: "unknown_shape", message: string } - unrecognizable condition
 *
 * The evaluator is pure logic over its inputs. I/O (event queries) is handled
 * by the caller and passed in via the EventChecker interface.
 *
 * Mirror side: PUBLIC (packages/worker is mirrored).
 */
import {
  stepConditionSchema,
  planExitConditionSchema,
  audienceConditionHolds,
  type AudienceCondition,
  type AudienceContact,
  type Condition,
  type EventCondition,
} from "@loomail/core";

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export type ConditionResult =
  | { outcome: "pass" }
  | { outcome: "fail" }
  | { outcome: "unknown_shape"; message: string };

// ---------------------------------------------------------------------------
// Context passed to the evaluator
// ---------------------------------------------------------------------------

/**
 * The contact state conditions are judged against. Only lifecycleState is required; the rest
 * (what a trigger audience can look at) is read when a condition asks for it, and a field that
 * was not supplied counts as not set.
 */
export interface ContactState extends Partial<AudienceContact> {
  lifecycleState: string;
}

/**
 * Interface for asking about a contact's events. The caller provides an implementation backed by
 * a DB query.
 */
export interface EventChecker {
  /**
   * Returns true if an event with the given name occurred for the contact
   * since the reference time.
   */
  hasEventSince(eventName: string, since: Date): Promise<boolean>;
  /**
   * How many times the event occurred since the reference time, counting no further than `limit`
   * (so a check for "at least 3" never reads more than 3 rows). Optional: without it, only
   * "at least once" style checks can be evaluated.
   */
  countEventsSince?(eventName: string, since: Date, limit: number): Promise<number>;
}

/** Times a condition may need besides the step's own reference time. All optional, for older callers. */
export interface EvaluationTimes {
  /** "Now": the end of a within_days window. Defaults to the current time. */
  now?: Date;
  /** When the contact entered the flow, for `since: "flow"`. Defaults to the reference time. */
  enteredAt?: Date;
}

const DAY_MS = 86_400_000;

/** A condition that parsed fine but cannot be evaluated with what the caller supplied. */
class UnsupportedCondition extends Error {}

function audienceView(contact: ContactState): AudienceContact {
  return {
    paymentStatus: contact.paymentStatus ?? null,
    engagementDepth: contact.engagementDepth ?? null,
    email: contact.email ?? null,
    properties: contact.properties ?? null,
  };
}

async function eventHolds(
  c: EventCondition,
  events: EventChecker,
  referenceSince: Date,
  times: EvaluationTimes,
): Promise<boolean> {
  const since =
    c.within_days !== undefined
      ? new Date((times.now ?? new Date()).getTime() - c.within_days * DAY_MS)
      : c.since === "flow"
        ? (times.enteredAt ?? referenceSince)
        : referenceSince;

  const needed = c.op === "performed" ? (c.min_count ?? 1) : 1;
  let count: number;
  if (needed <= 1) {
    count = (await events.hasEventSince(c.name, since)) ? 1 : 0;
  } else if (events.countEventsSince) {
    count = await events.countEventsSince(c.name, since, needed);
  } else {
    throw new UnsupportedCondition("counting events is not available here");
  }
  return c.op === "performed" ? count >= needed : count === 0;
}

/** Evaluate one parsed condition. Groups short-circuit, so later checks (and their queries) are skipped. */
async function conditionHolds(
  c: Condition,
  contact: ContactState,
  events: EventChecker,
  referenceSince: Date,
  times: EvaluationTimes,
): Promise<boolean> {
  if ("all" in c) {
    for (const child of c.all) {
      if (!(await conditionHolds(child, contact, events, referenceSince, times))) return false;
    }
    return true;
  }
  if ("any" in c) {
    for (const child of c.any) {
      if (await conditionHolds(child, contact, events, referenceSince, times)) return true;
    }
    return false;
  }
  if ("lifecycle_state" in c) return contact.lifecycleState === c.lifecycle_state;
  if ("lifecycle_state_not" in c) return contact.lifecycleState !== c.lifecycle_state_not;
  if ("event_since_step" in c) return events.hasEventSince(c.event_since_step, referenceSince);
  if (c.field === "event") return eventHolds(c, events, referenceSince, times);
  return audienceConditionHolds(c as AudienceCondition, audienceView(contact));
}

// ---------------------------------------------------------------------------
// Step-level condition evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluate a step-level condition (proceed-if gate).
 *
 * Semantics:
 *   - pass: condition is true, the step should proceed (or exit fires)
 *   - fail: condition is false, the step should be skipped (or exit does not fire)
 *   - unknown_shape: the condition cannot be interpreted
 *
 * @param condition - The raw condition value from the compiled plan step
 * @param contact - Current contact state
 * @param eventChecker - Async event lookup
 * @param referenceSince - The time from which event_since_step is measured
 */
export async function evaluateStepCondition(
  condition: unknown,
  contact: ContactState,
  eventChecker: EventChecker,
  referenceSince: Date,
  times: EvaluationTimes = {},
): Promise<ConditionResult> {
  // Validate shape against the schema
  const parsed = stepConditionSchema.safeParse(condition);
  if (!parsed.success) {
    return {
      outcome: "unknown_shape",
      message: `unrecognized condition shape: ${JSON.stringify(condition)}`,
    };
  }

  try {
    const holds = await conditionHolds(parsed.data, contact, eventChecker, referenceSince, times);
    return holds ? { outcome: "pass" } : { outcome: "fail" };
  } catch (err) {
    if (err instanceof UnsupportedCondition) {
      return { outcome: "unknown_shape", message: `${err.message}: ${JSON.stringify(condition)}` };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Plan-level exit condition evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluate a single plan-level exit condition.
 *
 * Semantics:
 *   - pass: exit condition is met, the contact should exit the flow
 *   - fail: exit condition is not met
 *   - unknown_shape: the condition cannot be interpreted
 *
 * @param exitCondition - A single exit_conditions entry from the compiled plan
 * @param contact - Current contact state
 * @param eventChecker - Async event lookup
 * @param membershipEnteredAt - The time the membership was entered (for event lookups)
 * @param times - Optional "now" for within_days windows
 */
export async function evaluatePlanExitCondition(
  exitCondition: unknown,
  contact: ContactState,
  eventChecker: EventChecker,
  membershipEnteredAt: Date,
  times: EvaluationTimes = {},
): Promise<ConditionResult> {
  if (
    exitCondition === null ||
    exitCondition === undefined ||
    typeof exitCondition !== "object"
  ) {
    return {
      outcome: "unknown_shape",
      message: `exit condition is not an object: ${JSON.stringify(exitCondition)}`,
    };
  }

  // { condition: <any condition from the vocabulary> }: judged from when the membership entered the flow
  // (so "since the step" and "since the flow" mean the same here: there is no step yet).
  if ("condition" in (exitCondition as Record<string, unknown>)) {
    const parsed = planExitConditionSchema.safeParse(exitCondition);
    if (!parsed.success || !("condition" in parsed.data)) {
      return {
        outcome: "unknown_shape",
        message: `unrecognized exit condition shape: ${JSON.stringify(exitCondition)}`,
      };
    }
    return evaluateStepCondition(parsed.data.condition, contact, eventChecker, membershipEnteredAt, {
      ...times,
      enteredAt: membershipEnteredAt,
    });
  }

  const ec = exitCondition as Record<string, unknown>;
  const hasEvent = typeof ec.event === "string" && ec.event.length > 0;
  const hasStateChange =
    ec.lifecycle_state_change !== null &&
    ec.lifecycle_state_change !== undefined &&
    typeof ec.lifecycle_state_change === "object" &&
    typeof (ec.lifecycle_state_change as Record<string, unknown>).to === "string" &&
    ((ec.lifecycle_state_change as Record<string, unknown>).to as string).length > 0;

  // Must have at least one of the two known keys
  if (!hasEvent && !hasStateChange) {
    return {
      outcome: "unknown_shape",
      message: `exit condition has no recognized keys: ${JSON.stringify(exitCondition)}`,
    };
  }

  // Check for unknown extra keys
  const knownKeys = new Set(["event", "lifecycle_state_change"]);
  const extraKeys = Object.keys(ec).filter((k) => !knownKeys.has(k));
  if (extraKeys.length > 0) {
    return {
      outcome: "unknown_shape",
      message: `exit condition has unknown keys [${extraKeys.join(", ")}]: ${JSON.stringify(exitCondition)}`,
    };
  }

  // Evaluate event part
  let eventPasses = true;
  if (hasEvent) {
    eventPasses = await eventChecker.hasEventSince(ec.event as string, membershipEnteredAt);
  }

  // Evaluate lifecycle_state_change part
  let stateChangePasses = true;
  if (hasStateChange) {
    const targetState = (ec.lifecycle_state_change as { to: string }).to;
    // lifecycle_state_change: { to: S } means "contact has transitioned to S"
    // We check whether the contact is currently in that state. This is an
    // approximation: the contact could have transitioned to S and then away.
    // But for the scan's purposes, being in state S now is the observable signal.
    stateChangePasses = contact.lifecycleState === targetState;
  }

  // Both parts must be true (AND semantics for combined conditions)
  if (eventPasses && stateChangePasses) {
    return { outcome: "pass" };
  }
  return { outcome: "fail" };
}

// ---------------------------------------------------------------------------
// Error message formatter
// ---------------------------------------------------------------------------

/**
 * Format a condition error message for storage in flow_memberships.condition_error.
 * Includes the step order (or "plan-level") and the offending shape.
 */
export function formatConditionError(
  location: { type: "step_condition" | "step_exit_condition" | "plan_exit"; stepOrder?: number },
  message: string,
): string {
  switch (location.type) {
    case "step_condition":
      return `step ${location.stepOrder} condition: ${message}`;
    case "step_exit_condition":
      return `step ${location.stepOrder} exit_condition: ${message}`;
    case "plan_exit":
      return `plan-level exit_conditions: ${message}`;
  }
}
