import { describe, it, expect } from "vitest";
import { compile } from "../src/compile.js";
import type { LlmProvider, CompletionOptions, CompletionResult } from "../src/providers/types.js";
import type { CompilePromptContext } from "../src/prompts/compile.js";

// ---------------------------------------------------------------------------
// Mock provider factory
// ---------------------------------------------------------------------------

function mockProvider(response: string, usage?: CompletionResult["usage"]): LlmProvider {
  return {
    async complete(_opts: CompletionOptions): Promise<CompletionResult> {
      return { content: response, usage };
    },
  };
}

function failingProvider(error: Error): LlmProvider {
  return {
    async complete(): Promise<CompletionResult> {
      throw error;
    },
  };
}

// ---------------------------------------------------------------------------
// Test context
// ---------------------------------------------------------------------------

const baseCtx: CompilePromptContext = {
  promptSource: "When a user moves from Engaged to At Risk, send them a personalized email.",
  triggerType: "lifecycle_transition",
  triggerConfig: { from: "engaged", to: "at_risk" },
  availableTemplates: ["win-back-gentle"],
  availableKbEntries: ["feature-list"],
};

// ---------------------------------------------------------------------------
// Valid compiled plan examples
// ---------------------------------------------------------------------------

const validPlan = {
  trigger: { type: "lifecycle_transition", condition: { from: "engaged", to: "at_risk" } },
  steps: [
    {
      order: 1,
      action_type: "nurture_value",
      delay: "0m",
      window_policy: "respect_window",
      kb_ref: "feature-list",
      brain_instruction: "Highlight features the user has not tried yet.",
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("compile()", () => {
  it("returns a validated plan on valid LLM output", async () => {
    const provider = mockProvider(JSON.stringify(validPlan));
    const result = await compile(provider, baseCtx);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.trigger.type).toBe("lifecycle_transition");
      expect(result.plan.steps).toHaveLength(2);
      expect(result.plan.steps[0]!.action_type).toBe("nurture_value");
      expect(result.plan.steps[1]!.delay).toBe("3d");
      expect(result.plan.exit_conditions).toHaveLength(1);
    }
  });

  it("returns usage info when provider supplies it", async () => {
    const usage = { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 };
    const provider = mockProvider(JSON.stringify(validPlan), usage);
    const result = await compile(provider, baseCtx);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.usage).toEqual(usage);
    }
  });

  it("fails gracefully when LLM returns invalid JSON", async () => {
    const provider = mockProvider("This is not JSON at all");
    const result = await compile(provider, baseCtx);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("invalid JSON");
    }
  });

  it("fails when LLM returns JSON that does not match schema", async () => {
    const invalidPlan = {
      trigger: { type: "lifecycle_transition", condition: {} },
      steps: [], // min 1 step required
    };
    const provider = mockProvider(JSON.stringify(invalidPlan));
    const result = await compile(provider, baseCtx);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("validation failed");
    }
  });

  it("fails when step has invalid delay format", async () => {
    const badDelay = {
      trigger: { type: "lifecycle_transition", condition: {} },
      steps: [{ order: 1, action_type: "nurture_value", delay: "invalid" }],
    };
    const provider = mockProvider(JSON.stringify(badDelay));
    const result = await compile(provider, baseCtx);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("delay");
    }
  });

  it("fails when step is missing action_type", async () => {
    const noAction = {
      trigger: { type: "lifecycle_transition", condition: {} },
      steps: [{ order: 1, delay: "0m" }],
    };
    const provider = mockProvider(JSON.stringify(noAction));
    const result = await compile(provider, baseCtx);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("validation failed");
    }
  });

  it("fails gracefully when LLM call throws", async () => {
    const provider = failingProvider(new Error("Rate limited"));
    const result = await compile(provider, baseCtx);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("LLM call failed");
      expect(result.error).toContain("Rate limited");
    }
  });

  it("accepts a plan with minimal fields (no optional fields)", async () => {
    const minimal = {
      trigger: { type: "event", condition: { event_name: "signup" } },
      steps: [
        { order: 1, action_type: "onboard_welcome", delay: "0m" },
      ],
    };
    const provider = mockProvider(JSON.stringify(minimal));
    const result = await compile(provider, baseCtx);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.steps[0]!.window_policy).toBeUndefined();
      expect(result.plan.exit_conditions).toBeUndefined();
    }
  });

  it("rejects extra fields in exit_conditions (strict schema)", async () => {
    const planWithExtra = {
      ...validPlan,
      exit_conditions: [
        { event: "converted", custom_field: "not_allowed" },
      ],
    };
    const provider = mockProvider(JSON.stringify(planWithExtra));
    const result = await compile(provider, baseCtx);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("validation failed");
    }
  });
});
