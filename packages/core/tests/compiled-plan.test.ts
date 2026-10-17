import { describe, it, expect } from "vitest";
import { compiledPlanSchema, stepConditionSchema } from "../src/flow/compiled-plan.js";
import { conditionSchema, conditionShape, MAX_CONDITION_LEAVES } from "../src/index.js";

describe("compiledPlanSchema", () => {
  const validPlan = {
    trigger: { type: "lifecycle_transition", condition: { from: "engaged", to: "at_risk" } },
    steps: [
      {
        order: 1,
        action_type: "nurture_value",
        delay: "0m",
        window_policy: "respect_window",
        kb_ref: "feature-list",
        brain_instruction: "Highlight features user has not tried.",
      },
      {
        order: 2,
        action_type: "nurture_reactivate",
        delay: "3d",
        window_policy: "respect_window",
        template_ref: "win-back-gentle",
        condition: { lifecycle_state: "at_risk" },
      },
    ],
    exit_conditions: [
      { event: "user_returned", lifecycle_state_change: { to: "engaged" } },
    ],
  };

  it("accepts a fully valid plan", () => {
    const result = compiledPlanSchema.safeParse(validPlan);
    expect(result.success).toBe(true);
  });

  it("accepts minimal plan (one step, no exit_conditions)", () => {
    const minimal = {
      trigger: { type: "event", condition: { event_name: "signup" } },
      steps: [{ order: 1, action_type: "onboard_welcome", delay: "0m" }],
    };
    const result = compiledPlanSchema.safeParse(minimal);
    expect(result.success).toBe(true);
  });

  it("rejects plan with empty steps array", () => {
    const noSteps = {
      trigger: { type: "event", condition: {} },
      steps: [],
    };
    const result = compiledPlanSchema.safeParse(noSteps);
    expect(result.success).toBe(false);
  });

  it("rejects step with invalid delay format", () => {
    const bad = {
      trigger: { type: "event", condition: {} },
      steps: [{ order: 1, action_type: "test", delay: "3 days" }],
    };
    const result = compiledPlanSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it("rejects step with fractional delay", () => {
    const bad = {
      trigger: { type: "event", condition: {} },
      steps: [{ order: 1, action_type: "test", delay: "1.5d" }],
    };
    const result = compiledPlanSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it("accepts valid delay formats", () => {
    for (const delay of ["0m", "1m", "30m", "2h", "7d", "100d"]) {
      const plan = {
        trigger: { type: "manual", condition: {} },
        steps: [{ order: 1, action_type: "test", delay }],
      };
      expect(compiledPlanSchema.safeParse(plan).success).toBe(true);
    }
  });

  it("rejects step with order < 1", () => {
    const bad = {
      trigger: { type: "event", condition: {} },
      steps: [{ order: 0, action_type: "test", delay: "0m" }],
    };
    const result = compiledPlanSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it("rejects step with empty action_type", () => {
    const bad = {
      trigger: { type: "event", condition: {} },
      steps: [{ order: 1, action_type: "", delay: "0m" }],
    };
    const result = compiledPlanSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it("rejects invalid trigger type", () => {
    const bad = {
      trigger: { type: "invalid_type", condition: {} },
      steps: [{ order: 1, action_type: "test", delay: "0m" }],
    };
    const result = compiledPlanSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it("accepts all valid trigger types", () => {
    for (const type of ["lifecycle_transition", "event", "segment", "manual"]) {
      const plan = {
        trigger: { type, condition: {} },
        steps: [{ order: 1, action_type: "test", delay: "0m" }],
      };
      expect(compiledPlanSchema.safeParse(plan).success).toBe(true);
    }
  });

  it("accepts window_policy values", () => {
    for (const wp of ["immediate", "respect_window"]) {
      const plan = {
        trigger: { type: "manual", condition: {} },
        steps: [{ order: 1, action_type: "test", delay: "0m", window_policy: wp }],
      };
      expect(compiledPlanSchema.safeParse(plan).success).toBe(true);
    }
  });

  it("rejects extra fields in exit_conditions (strict mode)", () => {
    const plan = {
      trigger: { type: "manual", condition: {} },
      steps: [{ order: 1, action_type: "test", delay: "0m" }],
      exit_conditions: [{ event: "x", extra_field: "not_allowed" }],
    };
    const result = compiledPlanSchema.safeParse(plan);
    expect(result.success).toBe(false);
  });

  it("rejects freeform condition shapes", () => {
    const plan = {
      trigger: { type: "manual", condition: {} },
      steps: [{
        order: 1,
        action_type: "test",
        delay: "0m",
        condition: { user_still_at_risk: true },
      }],
    };
    const result = compiledPlanSchema.safeParse(plan);
    expect(result.success).toBe(false);
  });
});

describe("stepConditionSchema", () => {
  it("accepts lifecycle_state condition", () => {
    const result = stepConditionSchema.safeParse({ lifecycle_state: "at_risk" });
    expect(result.success).toBe(true);
  });

  it("accepts lifecycle_state_not condition", () => {
    const result = stepConditionSchema.safeParse({ lifecycle_state_not: "engaged" });
    expect(result.success).toBe(true);
  });

  it("accepts event_since_step condition", () => {
    const result = stepConditionSchema.safeParse({ event_since_step: "feature_activated" });
    expect(result.success).toBe(true);
  });

  it("rejects empty string values", () => {
    expect(stepConditionSchema.safeParse({ lifecycle_state: "" }).success).toBe(false);
    expect(stepConditionSchema.safeParse({ lifecycle_state_not: "" }).success).toBe(false);
    expect(stepConditionSchema.safeParse({ event_since_step: "" }).success).toBe(false);
  });

  it("rejects unknown keys", () => {
    expect(stepConditionSchema.safeParse({ custom_key: "value" }).success).toBe(false);
    expect(stepConditionSchema.safeParse({ user_still_at_risk: true }).success).toBe(false);
  });

  it("rejects conditions with extra keys alongside a valid key", () => {
    const cond = { lifecycle_state: "at_risk", extra: "not_allowed" };
    expect(stepConditionSchema.safeParse(cond).success).toBe(false);
  });
});

describe("planExitConditionSchema (via compiledPlanSchema)", () => {
  it("accepts event-only exit condition", () => {
    const plan = {
      trigger: { type: "manual", condition: {} },
      steps: [{ order: 1, action_type: "test", delay: "0m" }],
      exit_conditions: [{ event: "user_returned" }],
    };
    expect(compiledPlanSchema.safeParse(plan).success).toBe(true);
  });

  it("accepts lifecycle_state_change-only exit condition", () => {
    const plan = {
      trigger: { type: "manual", condition: {} },
      steps: [{ order: 1, action_type: "test", delay: "0m" }],
      exit_conditions: [{ lifecycle_state_change: { to: "engaged" } }],
    };
    expect(compiledPlanSchema.safeParse(plan).success).toBe(true);
  });

  it("accepts combined event + lifecycle_state_change exit condition", () => {
    const plan = {
      trigger: { type: "manual", condition: {} },
      steps: [{ order: 1, action_type: "test", delay: "0m" }],
      exit_conditions: [{ event: "user_returned", lifecycle_state_change: { to: "engaged" } }],
    };
    expect(compiledPlanSchema.safeParse(plan).success).toBe(true);
  });

  it("rejects exit condition with no known keys", () => {
    const plan = {
      trigger: { type: "manual", condition: {} },
      steps: [{ order: 1, action_type: "test", delay: "0m" }],
      exit_conditions: [{ unknown_key: "value" }],
    };
    expect(compiledPlanSchema.safeParse(plan).success).toBe(false);
  });

  it("rejects exit condition with empty event string", () => {
    const plan = {
      trigger: { type: "manual", condition: {} },
      steps: [{ order: 1, action_type: "test", delay: "0m" }],
      exit_conditions: [{ event: "" }],
    };
    expect(compiledPlanSchema.safeParse(plan).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Richer conditions: contact fields, events, and all/any groups
// ---------------------------------------------------------------------------

describe("richer conditions", () => {
  const ok = (c: unknown) => expect(stepConditionSchema.safeParse(c).success).toBe(true);
  const bad = (c: unknown) => expect(stepConditionSchema.safeParse(c).success).toBe(false);

  it("still accepts the three original shapes", () => {
    ok({ lifecycle_state: "at_risk" });
    ok({ lifecycle_state_not: "engaged" });
    ok({ event_since_step: "feature_used" });
  });

  it("accepts anything a trigger audience can say", () => {
    ok({ field: "payment_status", op: "is", value: "paid" });
    ok({ field: "payment_status", op: "in", value: ["trial", "paid"] });
    ok({ field: "plan", op: "is_not", value: "Free" });
    ok({ field: "has_email", op: "is", value: true });
    ok({ field: "trait", key: "seats", op: "gt", value: 10 });
    ok({ field: "trait", key: "beta", op: "is_not_set" });
  });

  it("accepts event conditions with a stated window", () => {
    ok({ field: "event", name: "exported_report", op: "not_performed", within_days: 7 });
    ok({ field: "event", name: "logged_in", op: "performed", since: "step" });
    ok({ field: "event", name: "logged_in", op: "performed", since: "flow", min_count: 3 });
  });

  it("refuses an event condition without exactly one window, or with a misplaced min_count", () => {
    bad({ field: "event", name: "x", op: "performed" });
    bad({ field: "event", name: "x", op: "performed", within_days: 7, since: "flow" });
    bad({ field: "event", name: "x", op: "not_performed", within_days: 7, min_count: 2 });
    bad({ field: "event", name: "x", op: "performed", within_days: 0 });
    bad({ field: "event", name: "x", op: "performed", within_days: 400 });
    bad({ field: "event", name: "x", op: "performed", since: "yesterday" });
    bad({ field: "event", name: "", op: "performed", since: "step" });
    bad({ field: "event", name: "x", op: "performed", since: "step", sneaky: 1 });
  });

  it("accepts all/any groups, nested", () => {
    ok({ all: [{ lifecycle_state: "at_risk" }, { field: "plan", op: "is", value: "Pro" }] });
    ok({ any: [{ field: "payment_status", op: "is", value: "trial" }, { all: [{ lifecycle_state_not: "engaged" }, { event_since_step: "x" }] }] });
  });

  it("refuses empty groups, groups with extra keys, and mixed leaf/group objects", () => {
    bad({ all: [] });
    bad({ any: [] });
    bad({ all: [{ lifecycle_state: "x" }], extra: 1 });
    bad({ all: [{ lifecycle_state: "x" }], any: [{ lifecycle_state: "y" }] });
    bad({ all: [{ favourite_colour: "red" }] });
    bad({ all: "nope" });
  });

  it("limits how big a condition can get", () => {
    const leaf = { lifecycle_state: "x" };
    ok({ all: Array.from({ length: MAX_CONDITION_LEAVES }, () => leaf) });
    bad({ all: Array.from({ length: MAX_CONDITION_LEAVES + 1 }, () => leaf) });
    // 12 leaves split over two groups: each group is within bounds, the total is not
    bad({ all: [{ any: Array.from({ length: 6 }, () => leaf) }, { any: Array.from({ length: 6 }, () => leaf) }] });
    ok({ all: [{ any: [{ all: [leaf] }] }] }); // three deep
    bad({ all: [{ any: [{ all: [{ any: [leaf] }] }] }] }); // four deep
  });

  it("measures a condition's shape", () => {
    expect(conditionShape({ lifecycle_state: "x" })).toEqual({ leaves: 1, depth: 0 });
    expect(conditionShape({ all: [{ lifecycle_state: "x" }, { any: [{ lifecycle_state: "y" }, { lifecycle_state: "z" }] }] })).toEqual({ leaves: 3, depth: 2 });
  });

  it("works on steps and exits inside a whole plan", () => {
    const plan = {
      trigger: { type: "event", condition: {} },
      steps: [
        { order: 1, action_type: "nurture_value", delay: "0m", condition: { all: [{ field: "payment_status", op: "is", value: "paid" }, { field: "event", name: "x", op: "not_performed", within_days: 3 }] } },
        { order: 2, action_type: "nurture_value", delay: "1d", exit_condition: { field: "plan", op: "is", value: "Pro" } },
      ],
      exit_conditions: [{ condition: { any: [{ field: "payment_status", op: "is", value: "cancelled" }, { field: "event", name: "upgraded", op: "performed", since: "flow" }] } }],
    };
    expect(compiledPlanSchema.safeParse(plan).success).toBe(true);
  });

  it("a plan exit with a condition takes only that key", () => {
    const base = { trigger: { type: "manual", condition: {} }, steps: [{ order: 1, action_type: "x", delay: "0m" }] };
    expect(compiledPlanSchema.safeParse({ ...base, exit_conditions: [{ condition: { lifecycle_state: "x" }, event: "y" }] }).success).toBe(false);
    expect(compiledPlanSchema.safeParse({ ...base, exit_conditions: [{ condition: { nope: 1 } }] }).success).toBe(false);
  });

  it("conditionSchema and stepConditionSchema are the same thing", () => {
    expect(conditionSchema.safeParse({ lifecycle_state: "x" }).success).toBe(true);
    expect(stepConditionSchema).toBe(conditionSchema);
  });
});
