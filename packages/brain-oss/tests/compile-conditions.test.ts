/**
 * The compile prompt's condition vocabulary must stay true to what the engine accepts.
 *
 * The AI is told which condition shapes exist (prompts/compile.ts) and its output is validated against the
 * real schema (core's flow/condition.ts). If the two drift apart, either the AI is taught shapes the engine
 * refuses, or the engine accepts shapes the AI never uses. These tests tie them together.
 */
import { describe, it, expect } from "vitest";
import { conditionSchema } from "@loomail/core";
import { compile } from "../src/compile.js";
import { buildCompileMessages, type CompilePromptContext } from "../src/prompts/compile.js";
import type { LlmProvider } from "../src/providers/types.js";

const ctx: CompilePromptContext = {
  promptSource: "Email paid customers who have gone quiet.",
  triggerType: "lifecycle_transition",
  triggerConfig: { from: "engaged", to: "at_risk" },
};

const systemPrompt = buildCompileMessages(ctx).find((m) => m.role === "system")!.content;

/** One example of every shape the prompt teaches. Each must be accepted by the real schema. */
const examples: Array<[string, unknown, string[]]> = [
  ["lifecycle state", { lifecycle_state: "at_risk" }, ['"lifecycle_state"']],
  ["lifecycle state not", { lifecycle_state_not: "engaged" }, ['"lifecycle_state_not"']],
  ["event since step", { event_since_step: "feature_activated" }, ['"event_since_step"']],
  ["payment status", { field: "payment_status", op: "is", value: "paid" }, ['"payment_status"', "past_due"]],
  ["payment status in", { field: "payment_status", op: "in", value: ["trial", "paid"] }, ['"in"']],
  ["engagement", { field: "engagement_depth", op: "is_not", value: "minimal" }, ['"engagement_depth"', "power|regular|casual|minimal"]],
  ["plan", { field: "plan", op: "is", value: "Pro" }, ['"plan"']],
  ["has email", { field: "has_email", op: "is", value: true }, ['"has_email"']],
  ["trait text", { field: "trait", key: "country", op: "is", value: "Ghana" }, ['"trait"', "Never invent trait names"]],
  ["trait number", { field: "trait", key: "seats", op: "gt", value: 10 }, ['"gt"']],
  ["trait set", { field: "trait", key: "beta", op: "is_not_set" }, ['"is_not_set"']],
  ["event within days", { field: "event", name: "exported_report", op: "not_performed", within_days: 7 }, ['"within_days"', '"not_performed"']],
  ["event since flow", { field: "event", name: "logged_in", op: "performed", since: "flow", min_count: 3 }, ['"since": "flow"', '"min_count"']],
  ["all group", { all: [{ lifecycle_state: "at_risk" }, { field: "plan", op: "is", value: "Pro" }] }, ['"all"']],
  ["any group", { any: [{ lifecycle_state: "at_risk" }, { field: "plan", op: "is", value: "Pro" }] }, ['"any"']],
];

describe("the prompt and the schema agree", () => {
  it.each(examples)("%s: the engine accepts it and the prompt teaches it", (_name, example, mentions) => {
    expect(conditionSchema.safeParse(example).success).toBe(true);
    for (const token of mentions) expect(systemPrompt).toContain(token);
  });

  it("teaches the plan-level { condition } exit and the limits", () => {
    expect(systemPrompt).toContain('{ "condition": <any condition from the CONDITION VOCABULARY> }');
    expect(systemPrompt).toContain("up to 3 deep");
    expect(systemPrompt).toContain("at most 10 checks");
  });

  it("no longer claims there are only three shapes", () => {
    expect(systemPrompt).not.toContain("EXACTLY these three shapes");
    expect(systemPrompt).not.toContain("ONLY the three shapes");
  });
});

describe("compile() with the richer vocabulary", () => {
  const provider = (plan: unknown): LlmProvider => ({ async complete() { return { content: JSON.stringify(plan) }; } });
  const planWith = (stepExtra: Record<string, unknown>, exitConditions?: unknown[]) => ({
    trigger: { type: "lifecycle_transition", condition: { from: "engaged", to: "at_risk" } },
    steps: [{ order: 1, action_type: "nurture_reactivate", delay: "0m", window_policy: "respect_window", ...stepExtra }],
    ...(exitConditions ? { exit_conditions: exitConditions } : {}),
  });

  it("accepts a plan that uses contact fields, events and groups", async () => {
    const result = await compile(
      provider(
        planWith(
          { condition: { all: [{ field: "payment_status", op: "is", value: "paid" }, { field: "event", name: "logged_in", op: "not_performed", within_days: 14 }] } },
          [{ condition: { field: "payment_status", op: "is", value: "cancelled" } }],
        ),
      ),
      ctx,
    );
    expect(result.ok).toBe(true);
  });

  it("still refuses a shape the engine does not know, with the validation failure", async () => {
    const result = await compile(provider(planWith({ condition: { all: [{ favourite_colour: "red" }] } })), ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("validation failed");
  });

  it("refuses an event condition the model forgot a window on", async () => {
    const result = await compile(provider(planWith({ condition: { field: "event", name: "x", op: "performed" } })), ctx);
    expect(result.ok).toBe(false);
  });
});
