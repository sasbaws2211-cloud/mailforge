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

describe("the wait-until part of the prompt", () => {
  it("explains when to use early and its limits", () => {
    for (const phrase of ['"early": true', "at most 90 days", 'Use "since": "step"', "Do NOT add \"early\" for a plain"]) {
      expect(systemPrompt).toContain(phrase);
    }
  });

  it("the fork shown in the prompt is valid inside a plan", () => {
    const line = systemPrompt.split("\n").find((l) => l.trim().startsWith('{ "order": 2, "delay": "3d", "early": true'));
    expect(line).toBeDefined();
    const fork = JSON.parse(line!.trim());
    const email = (order: number) => ({ order, action_type: "nurture_value", delay: "0m", window_policy: "respect_window", next: "end" });
    const plan = { version: 2, trigger: { type: "event", condition: { event: "signed_up" } }, steps: [{ ...email(1), next: 2 }, email(3), email(4)], branches: [fork] };
    expect(compiledPlanSchema.safeParse(plan).success).toBe(true);
  });
});

describe("the random split part of the prompt", () => {
  it("explains when to use a split, its limits and the holdout", () => {
    for (const phrase of ['"split": { "percent_a": N }', "a whole number from 1 to 99", 'never use "early" with a split', "A holdout is a split where the held-back path is", "Use a condition fork, not a split"]) {
      expect(systemPrompt.toLowerCase()).toContain(phrase.toLowerCase());
    }
  });

  const email = (order: number, next: number | "end") => ({ order, action_type: "nurture_value", delay: "0m", window_policy: "respect_window", next });
  const forkLine = (startsWith: string) => {
    const line = systemPrompt.split("\n").find((l) => l.trim().startsWith(startsWith));
    expect(line, startsWith).toBeDefined();
    return JSON.parse(line!.trim().replace(/^Holdout:\s*/, ""));
  };

  it("the A/B fork shown in the prompt is valid inside a plan", () => {
    const fork = forkLine('{ "order": 2, "delay": "0m", "split"');
    const plan = { version: 2, trigger: { type: "event", condition: { event: "signed_up" } }, steps: [{ ...email(1, 2) }, email(3, "end"), email(4, "end")], branches: [fork] };
    expect(compiledPlanSchema.safeParse(plan).success).toBe(true);
  });

  it("the holdout fork shown in the prompt is valid inside a plan", () => {
    const fork = forkLine("Holdout:");
    const plan = { version: 2, trigger: { type: "event", condition: { event: "signed_up" } }, steps: [email(1, 2), email(3, "end")], branches: [fork] };
    expect(compiledPlanSchema.safeParse(plan).success).toBe(true);
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

  it("accepts a wait-until fork and keeps early", async () => {
    const waiting = { ...base, branches: [{ ...base.branches[0], early: true, condition: { ...base.branches[0].condition, since: "step" } }] };
    const result = await compile(provider(waiting), ctx);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.plan.branches?.[0]?.early).toBe(true);
  });

  it("refuses a wait-until fork with no deadline", async () => {
    const waiting = { ...base, branches: [{ ...base.branches[0], early: true, delay: "0m" }] };
    expect((await compile(provider(waiting), ctx)).ok).toBe(false);
  });

  it("accepts a split plan and a holdout plan, and keeps the split", async () => {
    const splitPlan = { ...base, branches: [{ order: 2, delay: "0m", split: { percent_a: 60 }, then: 3, else: 4 }] };
    const result = await compile(provider(splitPlan), ctx);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.plan.branches?.[0]?.split).toEqual({ percent_a: 60 });
    const holdout = { ...base, steps: [email(1, 2), email(3, "end")], branches: [{ order: 2, delay: "0m", split: { percent_a: 90 }, then: 3, else: "end" }] };
    expect((await compile(provider(holdout), ctx)).ok).toBe(true);
  });

  it("refuses a fork with both a condition and a split, or a split of 0 or 100", async () => {
    const both = { ...base, branches: [{ ...base.branches[0], split: { percent_a: 50 } }] };
    expect((await compile(provider(both), ctx)).ok).toBe(false);
    for (const percent_a of [0, 100]) {
      const bad = { ...base, branches: [{ order: 2, delay: "0m", split: { percent_a }, then: 3, else: 4 }] };
      expect((await compile(provider(bad), ctx)).ok, String(percent_a)).toBe(false);
    }
  });
});
