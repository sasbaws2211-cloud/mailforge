/**
 * Compiled plan Zod schema - the validated shape of flows.compiled_plan.
 *
 * Derived from LOOMAIL_HANDOFF_V2.md section 5 (compiled plan example) and
 * the FlowStep type (task 10). Used by:
 *   - Task 11 (compilation worker): validates LLM output before storing.
 *   - Task 12 (execution engine): reads the plan for deterministic execution.
 *
 * The schema is strict on all fields including conditions. The condition
 * vocabulary is closed: exactly three step-level shapes and three plan-level
 * exit shapes. The execution engine (task 12d) evaluates these deterministically.
 *
 * Mirror side: PUBLIC (packages/core is mirrored).
 */
import { z } from "zod";
import { conditionSchema } from "./condition.js";
import { analyzePlanGraph, nodeTargetSchema } from "./plan-graph.js";

// ---------------------------------------------------------------------------
// Condition schemas (step-level)
// ---------------------------------------------------------------------------

/**
 * Step-level condition vocabulary. A condition is a proceed-if gate:
 * the step executes only when the condition evaluates to true.
 * If false, the step is skipped and the flow advances.
 *
 * The vocabulary (leaves such as lifecycle state, payment status, plan, traits and events, and all/any
 * groups of them) is defined in ./condition.ts. The three original shapes remain valid.
 */
export const stepConditionSchema = conditionSchema;

// ---------------------------------------------------------------------------
// Step schema
// ---------------------------------------------------------------------------

/**
 * A single step in the compiled execution plan.
 *
 * Required fields the LLM must always produce:
 *   - order: 1-based integer, unique within steps
 *   - action_type: from the action catalog (non-empty string)
 *   - delay: canonical format <int><m|h|d> (e.g. "0m", "3d", "2h")
 *
 * Optional fields (LLM may or may not produce):
 *   - window_policy: step-level override; defaults to flow-level if absent
 *   - template_ref: @template reference resolved from the prompt
 *   - kb_ref: @kb reference resolved from the prompt
 *   - brain_instruction: natural-language instruction for brain.draft()
 *   - condition: proceed-if gate (step executes only when true; skipped otherwise)
 *   - exit_condition: per-step exit trigger (if true, contact exits the flow)
 *   - next: (plan version 2 only) the order of the node to go to afterwards, or "end"
 */
export const compiledStepSchema = z.object({
  order: z.number().int().min(1),
  action_type: z.string().min(1),
  delay: z.string().regex(/^\d+(m|h|d)$/, {
    message: "delay must match format: <int><m|h|d> (e.g. '0m', '3d')",
  }),
  window_policy: z.enum(["immediate", "respect_window"]).optional(),
  template_ref: z.string().optional(),
  kb_ref: z.string().optional(),
  brain_instruction: z.string().optional(),
  condition: stepConditionSchema.optional(),
  exit_condition: stepConditionSchema.optional(),
  next: nodeTargetSchema.optional(),
});

// ---------------------------------------------------------------------------
// Branch schema (plan version 2)
// ---------------------------------------------------------------------------

/**
 * A fork. It sends nothing: after `delay` (counted from when the contact arrived here) it checks `condition`
 * and sends the contact to `then` if it holds, otherwise to `else`. Each is another node's order, or "end".
 * Shares the `order` id space with email steps.
 */
export const compiledBranchSchema = z
  .object({
    order: z.number().int().min(1),
    delay: z.string().regex(/^\d+(m|h|d)$/, {
      message: "delay must match format: <int><m|h|d> (e.g. '0m', '3d')",
    }),
    condition: stepConditionSchema,
    then: nodeTargetSchema,
    else: nodeTargetSchema,
    /**
     * Wait-until mode. The `delay` becomes "wait at most this long": on every pass before it is over the
     * condition is also checked, and as soon as it holds the contact goes to `then`. If the time runs out first
     * the usual check decides. Absent or false: the fork waits the whole delay, as before.
     */
    early: z.boolean().optional(),
  })
  .strict()
  .superRefine((b, ctx) => {
    if (b.early !== true) return;
    const m = /^(\d+)(m|h|d)$/.exec(b.delay);
    const ms = m ? Number(m[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "m" | "h" | "d"] : null;
    if (ms === null || ms <= 0) {
      ctx.addIssue({ code: "custom", path: ["delay"], message: "a wait-until fork needs a delay above zero: how long to wait at most" });
    } else if (ms > BRANCH_MAX_WAIT_DAYS * 86_400_000) {
      ctx.addIssue({ code: "custom", path: ["delay"], message: `a wait-until fork can wait at most ${BRANCH_MAX_WAIT_DAYS} days` });
    }
  });

/** The longest a wait-until fork may wait. */
export const BRANCH_MAX_WAIT_DAYS = 90;

// ---------------------------------------------------------------------------
// Exit condition schema (plan-level)
// ---------------------------------------------------------------------------

/**
 * A plan-level exit condition. When any of these fire, the contact exits the
 * flow entirely regardless of which step they are on.
 *
 * Shapes:
 *   0. { condition: <Condition> } - exit when any condition from the vocabulary holds
 *   1. { event: "<name>" } - exit when event occurs during the membership
 *   2. { lifecycle_state_change: { to: "<state>" } } - exit on state transition
 *   3. Both keys present - exit when BOTH are true (AND)
 */
export const planExitConditionSchema = z.union([
  z.object({ event: z.string().min(1) }).strict(),
  z.object({ lifecycle_state_change: z.object({ to: z.string().min(1) }).strict() }).strict(),
  z.object({
    event: z.string().min(1),
    lifecycle_state_change: z.object({ to: z.string().min(1) }).strict(),
  }).strict(),
  // Any condition from the vocabulary in ./condition.ts, judged from when the membership entered the flow.
  z.object({ condition: stepConditionSchema }).strict(),
]);

// ---------------------------------------------------------------------------
// Trigger schema (confirmation of the flow trigger in compiled form)
// ---------------------------------------------------------------------------

export const compiledTriggerSchema = z.object({
  type: z.enum(["lifecycle_transition", "event", "segment", "manual"]),
  condition: z.record(z.unknown()),
});

// ---------------------------------------------------------------------------
// Full compiled plan schema
// ---------------------------------------------------------------------------

/**
 * The top-level compiled plan stored in flows.compiled_plan.
 *
 * Structure:
 *   - version: absent for a straight-line flow, 2 for one with branches
 *   - trigger: confirms the trigger type and condition from the prompt
 *   - steps: ordered array of execution steps (min 1)
 *   - branches: (version 2) forks that choose the next node by a condition
 *   - exit_conditions: optional plan-level exit triggers
 */
export const compiledPlanSchema = z
  .object({
    /** Absent: the original straight line. 2: may use `branches` and `next` (see ./plan-graph.ts). */
    version: z.literal(2).optional(),
    trigger: compiledTriggerSchema,
    steps: z.array(compiledStepSchema).min(1),
    branches: z.array(compiledBranchSchema).optional(),
    exit_conditions: z.array(planExitConditionSchema).optional(),
  })
  .superRefine((plan, ctx) => {
    for (const message of analyzePlanGraph(plan)) {
      ctx.addIssue({ code: "custom", message });
    }
  });

// ---------------------------------------------------------------------------
// Exported types
// ---------------------------------------------------------------------------

export type CompiledPlan = z.infer<typeof compiledPlanSchema>;
export type CompiledStep = z.infer<typeof compiledStepSchema>;
export type CompiledBranch = z.infer<typeof compiledBranchSchema>;
export type CompiledTrigger = z.infer<typeof compiledTriggerSchema>;
export type PlanExitCondition = z.infer<typeof planExitConditionSchema>;
export type StepCondition = z.infer<typeof stepConditionSchema>;
