/**
 * Segments: saved groups of contacts, described by rules.
 *
 * A segment is a DEFINITION, not a list. Membership is worked out from the rules whenever it is needed, so a
 * contact enters the segment when they start matching and leaves when they stop, with nothing to keep in sync.
 *
 *   { "match": "all",
 *     "rules": [
 *       { "field": "payment_status", "op": "is", "value": "paid" },
 *       { "field": "last_seen", "op": "before_days", "days": 14 },
 *       { "match": "any", "rules": [ { "field": "plan", "op": "is", "value": "Pro" },
 *                                    { "field": "trait", "key": "seats", "op": "gt", "value": 10 } ] } ] }
 *
 * `match` says whether all of the rules, or any one of them, must hold. A rule is one check (a LEAF) or one
 * group of checks with its own match. Groups do not nest further: one level is what people can read at a glance.
 *
 * Leaves:
 *   - everything a trigger audience can say (see audience.ts): payment status, plan, engagement, has an email, traits
 *   - lifecycle stage: is / is not / is one of
 *   - first seen / last seen: within the last N days, or more than N days ago
 *   - something they did: performed / not performed an event within the last N days (optionally at least N times)
 *
 * Every object is strict, so a shape the engine does not know is refused rather than guessed at. Turning a
 * definition into a database query is in @loomail/db (segments); this file only says what a valid one is.
 *
 * Mirror side: PUBLIC (packages/core is mirrored).
 */
import { z } from "zod";
import { audienceConditionSchema } from "./audience.js";

/** Most checks (leaves) in one segment, counting those inside the group. */
export const SEGMENT_MAX_LEAVES = 20;
/** Most checks inside one group. */
export const SEGMENT_MAX_GROUP_LEAVES = 10;
/** Longest event window, in days. Beyond this the event table would be scanned for too long. */
export const SEGMENT_MAX_EVENT_DAYS = 365;

export const SEGMENT_LIFECYCLE_STATES = [
  "signed_up",
  "activated",
  "engaged",
  "at_risk",
  "dormant",
  "churned",
  "resurrected",
] as const;

const lifecycleState = z.enum(SEGMENT_LIFECYCLE_STATES);

const lifecycleLeafSchema = z.union([
  z.object({ field: z.literal("lifecycle_state"), op: z.enum(["is", "is_not"]), value: lifecycleState }).strict(),
  z.object({ field: z.literal("lifecycle_state"), op: z.literal("in"), value: z.array(lifecycleState).min(1).max(7) }).strict(),
]);

/** "First seen" is when the contact first appeared; "last seen" is their most recent activity. */
const ageLeafSchema = z
  .object({
    field: z.enum(["first_seen", "last_seen"]),
    /** within_days: in the last N days. before_days: more than N days ago. */
    op: z.enum(["within_days", "before_days"]),
    days: z.number().int().min(0).max(3650),
  })
  .strict();

const eventLeafSchema = z
  .object({
    field: z.literal("event"),
    name: z.string().min(1).max(100),
    op: z.enum(["performed", "not_performed"]),
    within_days: z.number().int().min(1).max(SEGMENT_MAX_EVENT_DAYS),
    min_count: z.number().int().min(2).max(100).optional(),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (c.min_count !== undefined && c.op !== "performed") {
      ctx.addIssue({ code: "custom", message: "min_count only applies to 'performed'" });
    }
  });

export const segmentLeafSchema = z.union([audienceConditionSchema, lifecycleLeafSchema, ageLeafSchema, eventLeafSchema]);

export type SegmentLeaf = z.infer<typeof segmentLeafSchema>;

const matchSchema = z.enum(["all", "any"]);

export const segmentGroupSchema = z
  .object({
    match: matchSchema,
    rules: z.array(segmentLeafSchema).min(1).max(SEGMENT_MAX_GROUP_LEAVES),
  })
  .strict();

export type SegmentGroup = z.infer<typeof segmentGroupSchema>;
export type SegmentRule = SegmentLeaf | SegmentGroup;

export const segmentDefinitionSchema = z
  .object({
    match: matchSchema,
    rules: z.array(z.union([segmentLeafSchema, segmentGroupSchema])).min(1).max(SEGMENT_MAX_LEAVES),
  })
  .strict()
  .superRefine((def, ctx) => {
    if (countSegmentLeaves(def) > SEGMENT_MAX_LEAVES) {
      ctx.addIssue({ code: "custom", message: `a segment can have at most ${SEGMENT_MAX_LEAVES} checks in total` });
    }
  });

export type SegmentDefinition = z.infer<typeof segmentDefinitionSchema>;

/** A group is the only rule that has `rules`. */
export function isSegmentGroup(rule: SegmentRule): rule is SegmentGroup {
  return typeof rule === "object" && rule !== null && "rules" in rule;
}

/** Number of checks in a definition, counting those inside groups (groups themselves do not count). */
export function countSegmentLeaves(def: { rules: ReadonlyArray<SegmentRule> }): number {
  let n = 0;
  for (const rule of def.rules) n += isSegmentGroup(rule) ? rule.rules.length : 1;
  return n;
}

/** Event names a definition looks at, so a screen can warn if the app has never sent one. */
export function segmentEventNames(def: { rules: ReadonlyArray<SegmentRule> }): string[] {
  const names = new Set<string>();
  const visit = (rule: SegmentLeaf) => {
    if (rule.field === "event") names.add(rule.name);
  };
  for (const rule of def.rules) {
    if (isSegmentGroup(rule)) rule.rules.forEach(visit);
    else visit(rule);
  }
  return [...names];
}

// ---------------------------------------------------------------------------
// As a flow trigger
// ---------------------------------------------------------------------------

/**
 * A flow with trigger_type "segment" starts from either a saved segment, { segment_id }, or (the original form)
 * one cell of the retention grid, { tenure_bucket, recency_bucket } (see lifecycle/retention-grid.ts).
 */
export const savedSegmentTriggerSchema = z.object({ segment_id: z.string().uuid() }).strict();

export interface SavedSegmentTriggerConfig {
  segment_id: string;
}

/** Is this trigger_config the saved-segment form? */
export function isSavedSegmentTriggerConfig(value: unknown): value is SavedSegmentTriggerConfig {
  return savedSegmentTriggerSchema.safeParse(value).success;
}

/** The segment a trigger_config points at, or null when it is not the saved-segment form. */
export function savedSegmentIdOf(triggerConfig: unknown): string | null {
  return isSavedSegmentTriggerConfig(triggerConfig) ? triggerConfig.segment_id : null;
}
