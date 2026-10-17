import { describe, it, expect } from "vitest";
import {
  segmentDefinitionSchema,
  countSegmentLeaves,
  segmentEventNames,
  isSegmentGroup,
  SEGMENT_MAX_LEAVES,
  SEGMENT_MAX_GROUP_LEAVES,
  SEGMENT_MAX_EVENT_DAYS,
  type SegmentDefinition,
} from "../src/index.js";

const ok = (d: unknown) => expect(segmentDefinitionSchema.safeParse(d).success).toBe(true);
const bad = (d: unknown) => expect(segmentDefinitionSchema.safeParse(d).success).toBe(false);

const paid = { field: "payment_status", op: "is", value: "paid" };
const pro = { field: "plan", op: "is", value: "Pro" };
const leaf = { field: "has_email", op: "is", value: true };

describe("a segment definition", () => {
  it("is a match plus rules", () => {
    ok({ match: "all", rules: [paid] });
    ok({ match: "any", rules: [paid, pro] });
  });

  it("needs a match and at least one rule, and nothing else", () => {
    bad({ rules: [paid] });
    bad({ match: "all" });
    bad({ match: "all", rules: [] });
    bad({ match: "some", rules: [paid] });
    bad({ match: "all", rules: [paid], name: "x" });
    bad("paid");
    bad(null);
  });
});

describe("the checks", () => {
  it("takes everything a trigger audience can say", () => {
    ok({ match: "all", rules: [paid, pro, { field: "engagement_depth", op: "in", value: ["power", "regular"] }, leaf] });
    ok({ match: "all", rules: [{ field: "trait", key: "seats", op: "gt", value: 10 }, { field: "trait", key: "beta", op: "is_not_set" }] });
  });

  it("lifecycle stage: is, is not, is one of; only real stages", () => {
    ok({ match: "all", rules: [{ field: "lifecycle_state", op: "is", value: "at_risk" }] });
    ok({ match: "all", rules: [{ field: "lifecycle_state", op: "is_not", value: "churned" }] });
    ok({ match: "all", rules: [{ field: "lifecycle_state", op: "in", value: ["at_risk", "dormant"] }] });
    bad({ match: "all", rules: [{ field: "lifecycle_state", op: "is", value: "happy" }] });
    bad({ match: "all", rules: [{ field: "lifecycle_state", op: "in", value: [] }] });
  });

  it("first seen and last seen: within or before N days", () => {
    ok({ match: "all", rules: [{ field: "first_seen", op: "within_days", days: 30 }] });
    ok({ match: "all", rules: [{ field: "last_seen", op: "before_days", days: 14 }] });
    ok({ match: "all", rules: [{ field: "last_seen", op: "before_days", days: 0 }] });
    bad({ match: "all", rules: [{ field: "last_seen", op: "before_days", days: -1 }] });
    bad({ match: "all", rules: [{ field: "last_seen", op: "before_days", days: 2.5 }] });
    bad({ match: "all", rules: [{ field: "last_seen", op: "before_days", days: 99999 }] });
    bad({ match: "all", rules: [{ field: "last_seen", op: "since", days: 3 }] });
    bad({ match: "all", rules: [{ field: "created_at", op: "within_days", days: 3 }] });
  });

  it("an event: did or did not do it, within a stated number of days", () => {
    ok({ match: "all", rules: [{ field: "event", name: "exported", op: "not_performed", within_days: 7 }] });
    ok({ match: "all", rules: [{ field: "event", name: "login", op: "performed", within_days: SEGMENT_MAX_EVENT_DAYS, min_count: 3 }] });
    bad({ match: "all", rules: [{ field: "event", name: "x", op: "performed" }] }); // a window is required
    bad({ match: "all", rules: [{ field: "event", name: "x", op: "performed", within_days: 0 }] });
    bad({ match: "all", rules: [{ field: "event", name: "x", op: "performed", within_days: SEGMENT_MAX_EVENT_DAYS + 1 }] });
    bad({ match: "all", rules: [{ field: "event", name: "x", op: "performed", since: "flow" }] }); // flow windows belong to flows
    bad({ match: "all", rules: [{ field: "event", name: "x", op: "not_performed", within_days: 7, min_count: 2 }] });
    bad({ match: "all", rules: [{ field: "event", name: "", op: "performed", within_days: 7 }] });
  });

  it("refuses shapes it does not know, and extra keys on known ones", () => {
    bad({ match: "all", rules: [{ field: "hair", op: "is", value: "red" }] });
    bad({ match: "all", rules: [{ ...paid, sneaky: 1 }] });
    bad({ match: "all", rules: [{ favourite: "colour" }] });
  });
});

describe("groups", () => {
  it("one group of checks with its own match is allowed", () => {
    ok({ match: "all", rules: [paid, { match: "any", rules: [pro, leaf] }] });
  });

  it("a group cannot hold another group: one level only", () => {
    bad({ match: "all", rules: [{ match: "any", rules: [paid, { match: "all", rules: [pro] }] }] });
  });

  it("a group needs a match and at least one check", () => {
    bad({ match: "all", rules: [{ rules: [paid] }] });
    bad({ match: "all", rules: [{ match: "any", rules: [] }] });
    bad({ match: "all", rules: [{ match: "any", rules: [paid], extra: 1 }] });
  });
});

describe("size limits", () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => ({ field: "trait", key: `k${i}`, op: "is_set" }));

  it("at most 20 checks at the top level", () => {
    ok({ match: "all", rules: many(SEGMENT_MAX_LEAVES) });
    bad({ match: "all", rules: many(SEGMENT_MAX_LEAVES + 1) });
  });

  it("at most 10 checks in a group, and 20 in total counting groups", () => {
    ok({ match: "all", rules: [{ match: "any", rules: many(SEGMENT_MAX_GROUP_LEAVES) }] });
    bad({ match: "all", rules: [{ match: "any", rules: many(SEGMENT_MAX_GROUP_LEAVES + 1) }] });
    // 2 groups of 10 = 20 checks: fine. 2 groups of 10 plus one more rule = 21: too many.
    ok({ match: "all", rules: [{ match: "any", rules: many(10) }, { match: "any", rules: many(10) }] });
    bad({ match: "all", rules: [{ match: "any", rules: many(10) }, { match: "any", rules: many(10) }, paid] });
  });
});

describe("helpers", () => {
  const def = (rules: unknown[]) => segmentDefinitionSchema.parse({ match: "all", rules }) as SegmentDefinition;

  it("counts checks, including those inside groups", () => {
    expect(countSegmentLeaves(def([paid]))).toBe(1);
    expect(countSegmentLeaves(def([paid, { match: "any", rules: [pro, leaf] }]))).toBe(3);
  });

  it("tells groups from checks", () => {
    const d = def([paid, { match: "any", rules: [pro] }]);
    expect(d.rules.map(isSegmentGroup)).toEqual([false, true]);
  });

  it("lists the event names a segment looks at, once each", () => {
    const d = def([
      { field: "event", name: "a", op: "performed", within_days: 3 },
      { match: "any", rules: [{ field: "event", name: "b", op: "not_performed", within_days: 3 }, { field: "event", name: "a", op: "performed", within_days: 9 }] },
      paid,
    ]);
    expect(segmentEventNames(d).sort()).toEqual(["a", "b"]);
    expect(segmentEventNames(def([paid]))).toEqual([]);
  });
});
