/**
 * Tests for brain.assess() - the value gate (task 20, slice 20.1).
 *
 * Provider is mocked. No network calls.
 *
 * Tests:
 * - A "pass" verdict parses and returns typed.
 * - A "fail" verdict parses and returns typed with reasoning carried through.
 * - An unknown verdict value is rejected by the schema.
 * - Unparseable output (non-JSON) is rejected.
 * - The chosen temperature (ASSESS_TEMPERATURE = 0.1) reaches the provider.
 * - The draft body is present in the messages sent to the provider.
 * - JSON mode (response_format) is requested.
 * - A provider error (LLM call throws) returns ok=false with descriptive error.
 * - Missing reasoning field is rejected by the schema (reasoning is required).
 * - Usage info is carried through when the provider supplies it.
 */
import { describe, it, expect, vi } from "vitest";
import { assess, ASSESS_TEMPERATURE } from "../src/assess.js";
import type { LlmProvider, CompletionOptions, CompletionResult } from "../src/providers/types.js";
import type { AssessPromptContext } from "../src/prompts/assess.js";

// ---------------------------------------------------------------------------
// Mock provider factory (same pattern as decide.test.ts)
// ---------------------------------------------------------------------------

function mockProvider(
  response: string,
  usage?: CompletionResult["usage"],
): { provider: LlmProvider; completeSpy: ReturnType<typeof vi.fn> } {
  const completeSpy = vi.fn(async (_opts: CompletionOptions): Promise<CompletionResult> => {
    return { content: response, usage };
  });
  return { provider: { complete: completeSpy }, completeSpy };
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

const baseCtx: AssessPromptContext = {
  draftCtx: {
    action_type: "nurture_value",
    brain_instruction: "Highlight features user hasn't tried, personalize based on usage data",
    contact: {
      name: "Alice Smith",
      email: "alice@example.com",
      company: "Acme Corp",
      plan: "pro",
      signup_date: "2025-01-15",
    },
    lifecycle: {
      state: "at_risk",
      tenure_days: 150,
      engagement_depth: "regular",
      payment_status: "paid",
    },
    behavior: {
      most_used_features: ["reports", "api"],
      last_action: "viewed_dashboard",
    },
  },
  subject: "Quick tip: unlock the API's full potential",
  body_markdown: `Hi Alice,

I noticed you've been using the API feature heavily - here's a quick tip to get even more out of it.

[Show tip content here]

Let me know if you have questions!`,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("assess()", () => {
  it("returns a validated 'pass' verdict on valid LLM output", async () => {
    const output = { verdict: "pass", reasoning: "The email is personalized to Alice's API usage and addresses a specific feature gap." };
    const { provider } = mockProvider(JSON.stringify(output));
    const result = await assess(provider, baseCtx);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.assessment.verdict).toBe("pass");
      expect(result.assessment.reasoning).toBe(output.reasoning);
    }
  });

  it("returns a validated 'fail' verdict with reasoning carried through", async () => {
    const output = { verdict: "fail", reasoning: "The email is generic; it does not reference Alice's specific API usage patterns or the features she already uses." };
    const { provider } = mockProvider(JSON.stringify(output));
    const result = await assess(provider, baseCtx);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.assessment.verdict).toBe("fail");
      expect(result.assessment.reasoning).toBe(output.reasoning);
    }
  });

  it("rejects an unknown verdict value ('maybe') via schema validation", async () => {
    const output = { verdict: "maybe", reasoning: "Not sure." };
    const { provider } = mockProvider(JSON.stringify(output));
    const result = await assess(provider, baseCtx);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("validation failed");
    }
  });

  it("rejects unparseable (non-JSON) output", async () => {
    const { provider } = mockProvider("This email looks fine to me, I'd send it.");
    const result = await assess(provider, baseCtx);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("invalid JSON");
    }
  });

  it("passes ASSESS_TEMPERATURE (0.1) to the provider", async () => {
    const output = { verdict: "pass", reasoning: "Good email." };
    const { provider, completeSpy } = mockProvider(JSON.stringify(output));
    await assess(provider, baseCtx);

    expect(completeSpy).toHaveBeenCalledTimes(1);
    const opts = completeSpy.mock.calls[0]![0] as CompletionOptions;
    expect(opts.temperature).toBe(0.1);
    expect(opts.temperature).toBe(ASSESS_TEMPERATURE);
  });

  it("includes the draft body in the messages sent to the provider", async () => {
    const output = { verdict: "pass", reasoning: "Fine." };
    const { provider, completeSpy } = mockProvider(JSON.stringify(output));
    await assess(provider, baseCtx);

    const opts = completeSpy.mock.calls[0]![0] as CompletionOptions;
    const userMessage = opts.messages.find((m) => m.role === "user");
    expect(userMessage).toBeDefined();
    // The draft body must appear verbatim in the user message
    expect(userMessage!.content).toContain(baseCtx.body_markdown);
    // The subject must also appear
    expect(userMessage!.content).toContain(baseCtx.subject);
  });

  it("requests json_object response format", async () => {
    const output = { verdict: "pass", reasoning: "Good." };
    const { provider, completeSpy } = mockProvider(JSON.stringify(output));
    await assess(provider, baseCtx);

    const opts = completeSpy.mock.calls[0]![0] as CompletionOptions;
    expect(opts.response_format).toEqual({ type: "json_object" });
  });

  it("fails gracefully when the LLM call throws (transient - not a gate rejection)", async () => {
    const provider = failingProvider(new Error("Rate limited"));
    const result = await assess(provider, baseCtx);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("LLM call failed");
      expect(result.error).toContain("Rate limited");
    }
  });

  it("rejects output missing the required 'reasoning' field", async () => {
    const output = { verdict: "pass" }; // reasoning is required
    const { provider } = mockProvider(JSON.stringify(output));
    const result = await assess(provider, baseCtx);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("validation failed");
    }
  });

  it("rejects output with an empty reasoning string", async () => {
    const output = { verdict: "pass", reasoning: "" }; // min(1) required
    const { provider } = mockProvider(JSON.stringify(output));
    const result = await assess(provider, baseCtx);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("validation failed");
    }
  });

  it("carries usage info through when the provider supplies it", async () => {
    const usage = { prompt_tokens: 350, completion_tokens: 40, total_tokens: 390 };
    const output = { verdict: "fail", reasoning: "Too generic." };
    const { provider } = mockProvider(JSON.stringify(output), usage);
    const result = await assess(provider, baseCtx);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.usage).toEqual(usage);
    }
  });

  it("rejects output that is JSON but not an object (e.g. an array)", async () => {
    const { provider } = mockProvider(JSON.stringify(["pass", "good email"]));
    const result = await assess(provider, baseCtx);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("validation failed");
    }
  });
});
