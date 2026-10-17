/**
 * The compile prompt teaches the AI to write branching plans, and what it writes is validated by the real
 * schema. These tests keep the two honest: the worked example inside the prompt is parsed back out of the
 * prompt text and must itself be a valid plan, and unsafe plans are refused however the AI got there.
 */
import { describe, it, expect } from "vitest";
import { compiledPlanSchema } from "@loomail/core";
import { compile } from "../src/compile.js";
import { buildCompileMessages, type CompilePromptContext } from "../src/prompts/compile.js";
import type { LlmProvider } from "../src/providers/types.js";

const ctx: CompilePromptContext = {
  promptSource: "Welcome email, then three days later a different email depending on whether they created a project.",
  triggerType: "event",
  triggerConfig: { event: "signed_up" },
};

const systemPrompt = buildCompileMessages(ctx).find((m) => m.role === "system")!.content;

/** The JSON object printed after "Example:" in the BRANCHING section of the prompt. */
function exampleInPrompt(): unknown {
  const at = systemPrompt.indexOf("Example: \"Send a welcome email.");
  expect(at).toBeGreaterThan(-1);
  const rest = systemPrompt.slice(at);
  const open = rest.indexOf("\n{\n");
  const close = rest.indexOf("\n}\n", open);
  return JSON.parse(rest.slice(open + 1, close + 2));
}

describe("the branching section of the prompt", () => {
  it("states the format and the safety rules", () => {
    for (const phrase of [
      'Put "version": 2 at the top level',
      '"branches" is an array of forks',
      'Give EVERY email step a "next"',
      "no loops",
      "at most 30 nodes",
      "at most 3 forks on any one path",
      "ONE numbering",
    ]) {
      expect(systemPrompt).toContain(phrase);
    }
  });

  it("tells the AI that a plain sequence, or a step condition, is not branching", () => {
    expect(systemPrompt).toContain("is NOT branching");
    expect(systemPrompt).toContain('A step\'s own "condition" still means "skip just this email');
  });

  it("the worked example in the prompt is a valid plan", () => {
    const example = exampleInPrompt() as { version: number; steps: unknown[]; branches: unknown[] };
    expect(example.version).toBe(2);
    expect(example.branches).toHaveLength(1);
    const result = compiledPlanSchema.safeParse(example);
    expect(result.success).toBe(true);
  });
});

describe("compile() with branching plans", () => {
  const provider = (plan: unknown): LlmProvider => ({
    async complete() {
      return { content: JSON.stringify(plan) };
    },
  });
  const email = (order: number, next: number | "end") => ({ order, action_type: "nurture_value", delay: "0m", window_policy: "respect_window", next });
  const base = {
    version: 2,
    trigger: { type: "event", condition: { event: "signed_up" } },
    steps: [email(1, 2), email(3, "end"), email(4, "end")],
    branches: [{ order: 2, delay: "3d", condition: { field: "event", name: "project_created", op: "performed", since: "flow" }, then: 3, else: 4 }],
  };

  it("accepts a good branching plan", async () => {
    const result = await compile(provider(base), ctx);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.version).toBe(2);
      expect(result.plan.branches).toHaveLength(1);
    }
  });

  it("the plan the prompt shows is accepted end to end", async () => {
    const result = await compile(provider(exampleInPrompt()), ctx);
    expect(result.ok).toBe(true);
  });

  it("refuses a plan that loops, however the AI wrote it", async () => {
    const result = await compile(provider({ ...base, steps: [email(1, 2), email(3, 1), email(4, "end")] }), ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("validation failed");
  });

  it("refuses forks without the version marker, a path to nowhere, and a step nothing reaches", async () => {
    const noVersion = { ...base } as Record<string, unknown>;
    delete noVersion.version;
    expect((await compile(provider(noVersion), ctx)).ok).toBe(false);
    expect((await compile(provider({ ...base, branches: [{ ...base.branches[0], else: 9 }] }), ctx)).ok).toBe(false);
    expect((await compile(provider({ ...base, steps: [...base.steps, email(7, "end")] }), ctx)).ok).toBe(false);
  });

  it("a plain straight-line plan is still just a straight-line plan", async () => {
    const plain = {
      trigger: base.trigger,
      steps: [{ order: 1, action_type: "x", delay: "0m" }, { order: 2, action_type: "y", delay: "1d" }],
    };
    const result = await compile(provider(plain), ctx);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.plan.version).toBeUndefined();
  });
});
