import { describe, it, expect, vi } from "vitest";
import { decide, DECISION_TEMPERATURE } from "../src/decide.js";
import type { LlmProvider, CompletionOptions, CompletionResult } from "../src/providers/types.js";
import type { DecidePromptContext } from "../src/prompts/decide.js";

// ---------------------------------------------------------------------------
// Mock provider factory
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

const baseCtx: DecidePromptContext = {
  actionType: "nurture_value",
  contact: {
    name: "Alice Smith",
    email: "alice@example.com",
    company: "Acme Corp",
    plan: "pro",
    signupDate: "2025-01-15",
    lastSeen: "2025-06-20",
  },
  lifecycle: {
    state: "engaged",
    tenureDays: 150,
    engagementDepth: "regular",
    paymentStatus: "paid",
  },
  cadence: {
    current7d: 3,
    previous7d: 5,
    trend: "declining",
  },
  behavior: {
    lastAction: "viewed_dashboard",
    mostUsedFeatures: ["reports", "api"],
    recentEvents: ["login", "viewed_dashboard", "exported_report"],
  },
  priorContact: {
    lastMessageDate: "2025-06-01",
    lastMessageType: "nurture_tip",
    totalMessagesSent: 4,
    messagesOpened: 3,
    messagesClicked: 1,
  },
  firstContact: false,
  brainInstruction: "Highlight features user hasn't tried, personalize based on usage data",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("decide()", () => {
  it("returns a validated 'contact' decision on valid LLM output", async () => {
    const output = { action: "contact", reasoning: "User engagement declining, good time to reach out." };
    const { provider } = mockProvider(JSON.stringify(output));
    const result = await decide(provider, baseCtx);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.decision.action).toBe("contact");
      expect(result.decision.reasoning).toBe("User engagement declining, good time to reach out.");
    }
  });

  it("returns a validated 'skip' decision", async () => {
    const output = { action: "skip", reasoning: "Contact was reached recently." };
    const { provider } = mockProvider(JSON.stringify(output));
    const result = await decide(provider, baseCtx);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.decision.action).toBe("skip");
      expect(result.decision.reasoning).toBe("Contact was reached recently.");
    }
  });

  it("returns a validated 'wait' decision", async () => {
    const output = { action: "wait", reasoning: "Not the right moment, but may be appropriate next week." };
    const { provider } = mockProvider(JSON.stringify(output));
    const result = await decide(provider, baseCtx);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.decision.action).toBe("wait");
      expect(result.decision.reasoning).toBe("Not the right moment, but may be appropriate next week.");
    }
  });

  it("rejects an unknown decision value via schema validation", async () => {
    const output = { action: "noop", reasoning: "No reason." };
    const { provider } = mockProvider(JSON.stringify(output));
    const result = await decide(provider, baseCtx);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("validation failed");
    }
  });

  it("rejects unparseable (non-JSON) output", async () => {
    const { provider } = mockProvider("This is not JSON at all");
    const result = await decide(provider, baseCtx);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("invalid JSON");
    }
  });

  it("carries reasoning through to the result", async () => {
    const reasoning = "The contact has been highly active this week and already received a tip email 2 days ago.";
    const output = { action: "skip", reasoning };
    const { provider } = mockProvider(JSON.stringify(output));
    const result = await decide(provider, baseCtx);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.decision.reasoning).toBe(reasoning);
    }
  });

  it("passes DECISION_TEMPERATURE (0.3) to the provider", async () => {
    const output = { action: "contact", reasoning: "Looks good." };
    const { provider, completeSpy } = mockProvider(JSON.stringify(output));
    await decide(provider, baseCtx);

    expect(completeSpy).toHaveBeenCalledTimes(1);
    const opts = completeSpy.mock.calls[0]![0] as CompletionOptions;
    expect(opts.temperature).toBe(0.3);
    expect(opts.temperature).toBe(DECISION_TEMPERATURE);
  });

  it("does not read or branch on a confidence value", async () => {
    // The schema allows confidence as optional, but the decide function
    // must not use it in any branch. It passes through if present.
    const output = { action: "contact", confidence: 0.95, reasoning: "High confidence." };
    const { provider } = mockProvider(JSON.stringify(output));
    const result = await decide(provider, baseCtx);

    expect(result.ok).toBe(true);
    if (result.ok) {
      // confidence is carried through by the schema, but decide() itself
      // has no branch that reads it - it just validates and returns.
      expect(result.decision.action).toBe("contact");
      expect(result.decision.confidence).toBe(0.95);
    }
  });

  it("returns usage info when provider supplies it", async () => {
    const usage = { prompt_tokens: 200, completion_tokens: 30, total_tokens: 230 };
    const output = { action: "skip", reasoning: "Not needed." };
    const { provider } = mockProvider(JSON.stringify(output), usage);
    const result = await decide(provider, baseCtx);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.usage).toEqual(usage);
    }
  });

  it("fails gracefully when LLM call throws", async () => {
    const provider = failingProvider(new Error("Rate limited"));
    const result = await decide(provider, baseCtx);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("LLM call failed");
      expect(result.error).toContain("Rate limited");
    }
  });

  it("fails when LLM returns JSON that does not match schema (missing action)", async () => {
    const output = { reasoning: "Some reason but no action field." };
    const { provider } = mockProvider(JSON.stringify(output));
    const result = await decide(provider, baseCtx);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("validation failed");
    }
  });

  it("requests json_object response format", async () => {
    const output = { action: "contact", reasoning: "Go for it." };
    const { provider, completeSpy } = mockProvider(JSON.stringify(output));
    await decide(provider, baseCtx);

    const opts = completeSpy.mock.calls[0]![0] as CompletionOptions;
    expect(opts.response_format).toEqual({ type: "json_object" });
  });

  it("accepts a decision with only the required action field (no reasoning)", async () => {
    const output = { action: "contact" };
    const { provider } = mockProvider(JSON.stringify(output));
    const result = await decide(provider, baseCtx);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.decision.action).toBe("contact");
      expect(result.decision.reasoning).toBeUndefined();
    }
  });
});
