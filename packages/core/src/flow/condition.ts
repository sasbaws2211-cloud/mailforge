/**
 * Flow conditions: the closed vocabulary a step's `condition` ("send only if...") and `exit_condition`
 * ("stop the flow if..."), and a plan-level exit, are written in.
 *
 * A condition is a LEAF or a GROUP of conditions:
 *
 *   leaf   { lifecycle_state: "at_risk" }                       the three original shapes, still valid:
 *          { lifecycle_state_not: "engaged" }                      lifecycle state is / is not X, and
 *          { event_since_step: "feature_used" }                    an event happened since reaching this step
 *          { field: "payment_status", op: "is", value: "paid" } anything a trigger audience can say (see audience.ts):
 *          { field: "plan" | "engagement_depth" | "has_email" | "trait", ... }
 *          { field: "event", name: "exported_report", op: "not_performed", within_days: 7 }
 *   group  { all: [ ...conditions ] }   every one holds
 *          { any: [ ...conditions ] }   at least one holds
 *
 * An event leaf says whether the contact did a named event, inside a window that must be stated:
 *   within_days: N          in the last N days
 *   since: "step"           since the contact reached this step
 *   since: "flow"           since the contact entered the flow
 * "performed" optionally takes min_count (at least that many times; default once); "not_performed" means none.
 *
 * Every object is strict, so a shape the engine does not know is refused rather than guessed at. Groups nest at
 * most MAX_CONDITION_DEPTH deep and hold at most MAX_CONDITION_LEAVES conditions in total.
 *
 * Mirror side: PUBLIC (packages/core is mirrored).
 */
import { z } from "zod";
import { audienceConditionSchema, type AudienceCondition } from "../audience.js";

export const MAX_CONDITION_LEAVES = 10;
export const MAX_CONDITION_DEPTH = 3;

const legacyLeafSchema = z.union([
  z.object({ lifecycle_state: z.string().min(1) }).strict(),
  z.object({ lifecycle_state_not: z.string().min(1) }).strict(),
  z.object({ event_since_step: z.string().min(1) }).strict(),
]);

export type LegacyCondition =
  | { lifecycle_state: string }
  | { lifecycle_state_not: string }
  | { event_since_step: string };

export const eventConditionSchema = z
  .object({
    field: z.literal("event"),
    name: z.string().min(1).max(100),
    op: z.enum(["performed", "not_performed"]),
    within_days: z.number().int().min(1).max(365).optional(),
    since: z.enum(["step", "flow"]).optional(),
    min_count: z.number().int().min(2).max(100).optional(),
  })
  .strict()
  .superRefine((c, ctx) => {
    const windows = (c.within_days !== undefined ? 1 : 0) + (c.since !== undefined ? 1 : 0);
    if (windows !== 1) {
      ctx.addIssue({ code: "custom", message: "an event condition needs exactly one of within_days or since" });
    }
    if (c.min_count !== undefined && c.op !== "performed") {
      ctx.addIssue({ code: "custom", message: "min_count only applies to 'performed'" });
    }
  });

export type EventCondition = z.infer<typeof eventConditionSchema>;

export type Condition =
  | LegacyCondition
  | AudienceCondition
  | EventCondition
  | { all: Condition[] }
  | { any: Condition[] };

const rawConditionSchema: z.ZodType<Condition, z.ZodTypeDef, unknown> = z.lazy(() =>
  z.union([
    legacyLeafSchema,
    audienceConditionSchema,
    eventConditionSchema,
    z.object({ all: z.array(rawConditionSchema).min(1).max(MAX_CONDITION_LEAVES) }).strict(),
    z.object({ any: z.array(rawConditionSchema).min(1).max(MAX_CONDITION_LEAVES) }).strict(),
  ]),
);

function isGroup(c: Condition): c is { all: Condition[] } | { any: Condition[] } {
  return typeof c === "object" && c !== null && ("all" in c || "any" in c);
}

/** Number of conditions in the tree (groups themselves do not count) and how deeply groups nest. */
export function conditionShape(c: Condition, depth = 0): { leaves: number; depth: number } {
  if (!isGroup(c)) return { leaves: 1, depth };
  const children = "all" in c ? c.all : c.any;
  let leaves = 0;
  let deepest = depth + 1;
  for (const child of children) {
    const s = conditionShape(child, depth + 1);
    leaves += s.leaves;
    deepest = Math.max(deepest, s.depth);
  }
  return { leaves, depth: deepest };
}

/** The condition schema with its size limits applied. This is what steps and exits are validated with. */
export const conditionSchema = rawConditionSchema.superRefine((c, ctx) => {
  const { leaves, depth } = conditionShape(c);
  if (leaves > MAX_CONDITION_LEAVES) {
    ctx.addIssue({ code: "custom", message: `a condition can hold at most ${MAX_CONDITION_LEAVES} checks in total` });
  }
  if (depth > MAX_CONDITION_DEPTH) {
    ctx.addIssue({ code: "custom", message: `conditions can nest at most ${MAX_CONDITION_DEPTH} groups deep` });
  }
});
