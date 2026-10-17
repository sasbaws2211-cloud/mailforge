/**
 * A flow's goal: what success looks like, so Loomail can say how many people who entered a flow got there.
 *
 * It is flow-level configuration (stored on the flow, not in the compiled plan), so it can be set or changed at
 * any time, even on an active flow, without recompiling. The condition uses the same vocabulary as everywhere
 * else. A contact converts when it holds within `window_days` of entering the flow; with `exit_on_conversion`
 * they also leave the flow at that moment, so someone who already succeeded is not mailed the rest.
 *
 * In a goal, `since: "step"` means `since: "flow"` (there is no step), exactly as in a plan-level exit.
 *
 * Mirror side: PUBLIC (packages/core is mirrored).
 */
import { z } from "zod";
import { stepConditionSchema } from "./compiled-plan.js";

export const GOAL_DEFAULT_WINDOW_DAYS = 30;
export const GOAL_MAX_WINDOW_DAYS = 90;

export const flowGoalSchema = z
  .object({
    name: z.string().trim().min(1, "give the goal a name").max(80, "at most 80 characters"),
    condition: stepConditionSchema,
    window_days: z.number().int().min(1).max(GOAL_MAX_WINDOW_DAYS).default(GOAL_DEFAULT_WINDOW_DAYS),
    exit_on_conversion: z.boolean().default(true),
  })
  .strict();

export type FlowGoal = z.infer<typeof flowGoalSchema>;

/** Reads a stored goal leniently: null when absent or no longer valid (so a bad row never breaks a scan). */
export function readFlowGoal(raw: unknown): FlowGoal | null {
  if (raw === null || raw === undefined) return null;
  const parsed = flowGoalSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
