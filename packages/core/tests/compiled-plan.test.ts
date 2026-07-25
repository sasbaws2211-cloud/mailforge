import { describe, it, expect } from "vitest";
import { compiledPlanSchema, stepConditionSchema } from "../src/flow/compiled-plan.js";

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
