/**
 * Unit tests for context-budget.ts (slice 18.4).
 *
 * Tests token estimation, truncation order, section recording, protection
 * of protected sections, and the still-over-budget case.
 *
 * All tests are pure unit tests; no database required.
 *
 * Coverage:
 *   estimation:
 *     - estimateTokens overstates rather than understates on a known input
 *     - estimateTokensFromMessages applies Math.ceil(charCount / 4) correctly
 *
 *   no truncation:
 *     - context comfortably under budget is returned untouched with empty droppedSections
 *
 *   truncation order:
 *     - over-budget context drops kb_context first (and stops if it now fits)
 *     - drops behavior.recent_events second (after kb_context removed)
 *     - drops behavior.most_used_features third
 *     - drops cadence fourth
 *     - sections drop in the documented order across successive thresholds
 *
 *   protected sections:
 *     - user, lifecycle, tenure, prior_contact survive even when everything
 *       else has been dropped
 *
 *   recording:
 *     - droppedSections matches what was actually removed from the context
 *
 *   still-over-budget:
 *     - when all droppable sections are gone and still over budget, returns
 *       fully-truncated context, all droppable sections in droppedSections,
 *       and emits console.warn
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  estimateTokens,
  estimateTokensFromMessages,
  estimateDecideTokens,
  estimateAssessTokens,
  checkAssessBudget,
  applyBudgetTruncation,
  applyBudgetForBothPaths,
  draftContextToDecideContext,
  MAX_CONTEXT_TOKENS,
  type DroppableSection,
} from "../src/context-budget.js";
import { buildDraftMessages, buildDecideMessages, buildAssessMessages, type DraftPromptContext } from "@claros/brain-oss";
import type { AssessPromptContext } from "@claros/brain-oss";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a DraftPromptContext whose assembled char count can be predicted.
 * Fills optional sections with data whose presence/absence is testable.
 */
function makeCtx(overrides: Partial<DraftPromptContext> = {}): DraftPromptContext {
  return {
    brain_instruction: "Write a welcome email.",
    contact: { name: "Alice", email: "alice@example.com" },
    lifecycle: { state: "engaged", tenure_days: 30 },
    tenure: { category: "growing", days: 30 },
    prior_contact: {
      total_messages_sent: 2,
      messages_opened: 1,
      messages_clicked: 0,
    },
    ...overrides,
  };
}

/**
 * Build a string of exactly n ASCII characters.
 */
function chars(n: number): string {
  return "x".repeat(n);
}

// ---------------------------------------------------------------------------
// Restore console.warn after tests that spy on it
// ---------------------------------------------------------------------------

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Estimation
// ---------------------------------------------------------------------------

describe("estimateTokensFromMessages", () => {
  it("applies Math.ceil(charCount / 4) exactly", () => {
    // 4 chars -> exactly 1 token (no remainder, ceil makes no difference)
    expect(estimateTokensFromMessages([{ role: "user", content: "abcd" }])).toBe(1);

    // 5 chars -> ceil(5/4) = 2 tokens (rounds up)
    expect(estimateTokensFromMessages([{ role: "user", content: "abcde" }])).toBe(2);

    // 8 chars -> ceil(8/4) = 2 tokens (no remainder)
    expect(estimateTokensFromMessages([{ role: "user", content: "abcdefgh" }])).toBe(2);

    // 9 chars across two messages -> ceil(9/4) = 3 tokens
    expect(
      estimateTokensFromMessages([
        { role: "system", content: "abcde" },
        { role: "user", content: "abcd" },
      ]),
    ).toBe(3);
  });

  it("returns 0 for empty messages", () => {
    expect(estimateTokensFromMessages([])).toBe(0);
    expect(estimateTokensFromMessages([{ role: "system", content: "" }])).toBe(0);
  });
});

describe("estimateTokens", () => {
  it("overstates rather than understates on a known input", () => {
    // The estimate must be >= the true token count. Since ceil rounds up,
    // for any input whose char count is not a multiple of 4, the estimate
    // will be strictly larger than charCount / 4.
    //
    // Concrete check: build a context with a known kb_context string whose
    // char count is not a multiple of 4, then assert that
    //   estimate > Math.floor(totalChars / 4)
    // which proves overstating.
    const ctx = makeCtx({ kb_context: chars(9) }); // 9 chars = 2.25 tokens
    const estimate = estimateTokens(ctx);

    // The estimate must be a whole number >= ceil of the true fractional tokens
    expect(estimate).toBeGreaterThan(0);

    // Verify against direct character measurement
    const messages = buildDraftMessages(ctx);
    const totalChars = messages.reduce((s, m) => s + m.content.length, 0);
    const exactCeil = Math.ceil(totalChars / 4);
    expect(estimate).toBe(exactCeil);

    // For a non-multiple-of-4 char count, ceil > floor, so we overstate.
    if (totalChars % 4 !== 0) {
      expect(estimate).toBeGreaterThan(Math.floor(totalChars / 4));
    }
  });
});

// ---------------------------------------------------------------------------
// No truncation
// ---------------------------------------------------------------------------

describe("applyBudgetTruncation - no truncation needed", () => {
  it("returns the context untouched with empty droppedSections when under budget", () => {
    // A minimal context with no optional sections is well under 4000 tokens
    const ctx = makeCtx();
    const result = applyBudgetTruncation(ctx);

    expect(result.droppedSections).toEqual([]);
    // The returned context must be the same object reference (or deep-equal - 
    // if no truncation, we return the original)
    expect(result.ctx).toBe(ctx);
  });

  it("does not drop any section when exactly at budget", () => {
    // Use a custom budget of 1 that will definitely be exceeded later,
    // but test a context that fits within a generous budget first.
    const ctx = makeCtx();
    const estimate = estimateTokens(ctx);
    // Budget == estimate -> fits (<=), no truncation
    const result = applyBudgetTruncation(ctx, estimate);
    expect(result.droppedSections).toEqual([]);
    expect(result.ctx).toBe(ctx);
  });
});

// ---------------------------------------------------------------------------
// Truncation order
// ---------------------------------------------------------------------------

describe("applyBudgetTruncation - drops kb_context first", () => {
  it("drops only kb_context when removing it makes the context fit", () => {
    // Build a context that is over budget only because of a large kb_context.
    // We pick a budget slightly above the estimate without kb_context.
    const baseCtx = makeCtx();
    const baseEstimate = estimateTokens(baseCtx);

    // Add kb_context large enough to push over budget by a small margin
    // Budget = baseEstimate + 1 (so base fits, base+kb does not)
    const budget = baseEstimate + 1;

    // How many chars in kb_context do we need to push over budget by 1 token?
    // One token = 4 chars (minimum). We need to add > 4 chars.
    const kbContent = chars(5); // 5 chars -> 2 tokens -> pushes over by at least 1
    const ctx = makeCtx({ kb_context: kbContent });

    // Verify it is over budget with kb_context
    expect(estimateTokens(ctx)).toBeGreaterThan(budget);

    const result = applyBudgetTruncation(ctx, budget);

    // Only kb_context should be dropped
    expect(result.droppedSections).toEqual(["kb_context"]);
    expect(result.ctx.kb_context).toBeUndefined();

    // Verify we're now within budget
    expect(estimateTokens(result.ctx)).toBeLessThanOrEqual(budget);

    // Protected sections still present
    expect(result.ctx.contact).toBeDefined();
    expect(result.ctx.lifecycle).toBeDefined();
    expect(result.ctx.tenure).toBeDefined();
    expect(result.ctx.prior_contact).toBeDefined();
  });
});

describe("applyBudgetTruncation - drops behavior.recent_events second", () => {
  it("drops kb_context then behavior.recent_events when kb_context alone is not enough", () => {
    // Start with a context that has both kb_context and recent_events.
    // Budget is set so that after dropping kb_context we are still over,
    // but after dropping recent_events we fit.
    const baseCtx = makeCtx();
    const baseEstimate = estimateTokens(baseCtx);

    // Add recent_events to the behavior section (3 events, each adding chars)
    const recentEvents = ["feature_used", "page_viewed", "project_created"];
    const ctxWithBehavior = makeCtx({
      behavior: { recent_events: recentEvents },
    });
    const behaviorEstimate = estimateTokens(ctxWithBehavior);

    // Budget = behaviorEstimate - 1 (just below what we'd have after kb_context drop,
    // but above baseEstimate so after dropping kb+events it fits).
    // Simpler: set budget just below behaviorEstimate so it requires dropping events,
    // and budget >= baseEstimate so after dropping events it fits.
    expect(behaviorEstimate).toBeGreaterThan(baseEstimate);
    const budget = baseEstimate + Math.floor((behaviorEstimate - baseEstimate) / 2);

    // Make context over budget by adding kb_context too - but budget is set so that
    // even after removing kb_context we are still over (because recent_events alone
    // pushes us past budget). Add enough kb_context to go over.
    const kbContent = chars(4); // 1 token
    const ctx = makeCtx({
      kb_context: kbContent,
      behavior: { recent_events: recentEvents },
    });

    // Sanity: over budget
    expect(estimateTokens(ctx)).toBeGreaterThan(budget);

    // After removing kb_context, still over
    const withoutKb = makeCtx({ behavior: { recent_events: recentEvents } });
    expect(estimateTokens(withoutKb)).toBeGreaterThan(budget);

    // After removing both, fits
    expect(estimateTokens(makeCtx())).toBeLessThanOrEqual(budget);

    const result = applyBudgetTruncation(ctx, budget);

    expect(result.droppedSections).toContain("kb_context");
    expect(result.droppedSections).toContain("behavior.recent_events");
    expect(result.ctx.kb_context).toBeUndefined();
    expect(result.ctx.behavior?.recent_events).toBeUndefined();

    // Protected sections untouched
    expect(result.ctx.contact).toBeDefined();
    expect(result.ctx.lifecycle).toBeDefined();
  });
});

describe("applyBudgetTruncation - sections drop in documented order", () => {
  it("drops sections in the exact documented order: kb_context, recent_events, most_used_features, cadence", () => {
    // Build a context with all four droppable sections populated.
    // Force a very tight budget so all four must be dropped in order.
    const ctx = makeCtx({
      kb_context: chars(8),
      behavior: {
        recent_events: ["event_a", "event_b"],
        most_used_features: ["feature_x", "feature_y"],
      },
      cadence: { current_7d: 3, previous_7d: 5, trend: "declining" },
    });

    // Budget = 0 forces all drops (suppressing the expected warning)
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = applyBudgetTruncation(ctx, 0);
    warnSpy.mockRestore();

    // All droppable sections must be listed, in order
    expect(result.droppedSections).toEqual([
      "kb_context",
      "behavior.recent_events",
      "behavior.most_used_features",
      "cadence",
    ] satisfies DroppableSection[]);

    // All droppable sections absent from result
    expect(result.ctx.kb_context).toBeUndefined();
    expect(result.ctx.behavior?.recent_events).toBeUndefined();
    expect(result.ctx.behavior?.most_used_features).toBeUndefined();
    expect(result.ctx.cadence).toBeUndefined();
  });

  it("stops dropping as soon as the context fits (does not over-truncate)", () => {
    // A context that only needs kb_context removed to fit.
    // Verify that most_used_features and cadence are NOT dropped.
    const baseCtx = makeCtx({
      behavior: { most_used_features: ["feature_a"] },
      cadence: { current_7d: 1, previous_7d: 2, trend: "stable" },
    });
    const baseEstimate = estimateTokens(baseCtx);

    // Add kb_context that pushes exactly 2 tokens over budget
    const kbContent = chars(9); // ceil(9/4) = 3 tokens worth
    const ctx = makeCtx({
      kb_context: kbContent,
      behavior: { most_used_features: ["feature_a"] },
      cadence: { current_7d: 1, previous_7d: 2, trend: "stable" },
    });
    const budget = baseEstimate + 1; // fits without kb_context

    expect(estimateTokens(ctx)).toBeGreaterThan(budget);

    const result = applyBudgetTruncation(ctx, budget);

    // Only kb_context dropped
    expect(result.droppedSections).toEqual(["kb_context"]);

    // most_used_features and cadence still present
    expect(result.ctx.behavior?.most_used_features).toBeDefined();
    expect(result.ctx.cadence).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Protected sections
// ---------------------------------------------------------------------------

describe("applyBudgetTruncation - protected sections", () => {
  it("never truncates user, lifecycle, tenure, or prior_contact even when all droppable sections are gone", () => {
    const ctx = makeCtx({
      kb_context: chars(8),
      behavior: {
        recent_events: ["event_a"],
        most_used_features: ["feature_a"],
      },
      cadence: { current_7d: 1, previous_7d: 2, trend: "stable" },
    });

    // Budget of 0 forces all drops
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = applyBudgetTruncation(ctx, 0);
    warnSpy.mockRestore();

    // Protected sections must be intact
    expect(result.ctx.contact).toEqual(ctx.contact);
    expect(result.ctx.lifecycle).toEqual(ctx.lifecycle);
    expect(result.ctx.tenure).toEqual(ctx.tenure);
    expect(result.ctx.prior_contact).toEqual(ctx.prior_contact);

    // brain_instruction also preserved (not a truncatable section)
    expect(result.ctx.brain_instruction).toBe(ctx.brain_instruction);
  });

  it("never drops brain_context even when all droppable sections are gone", () => {
    const ctx = makeCtx({
      brain_context: "Acme is a kanban tool. No Gantt charts.",
      kb_context: chars(8),
      behavior: {
        recent_events: ["event_a"],
        most_used_features: ["feature_a"],
      },
      cadence: { current_7d: 1, previous_7d: 2, trend: "stable" },
    });

    // Budget of 0 forces all drops
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = applyBudgetTruncation(ctx, 0);
    warnSpy.mockRestore();

    // brain_context is protected: present in the result, absent from the drop list
    expect(result.ctx.brain_context).toBe(ctx.brain_context);
    expect(result.droppedSections).not.toContain("brain_context");
  });

  it("applyBudgetForBothPaths also preserves brain_context under full truncation", () => {
    const ctx = makeCtx({
      brain_context: "Acme is a kanban tool. No Gantt charts.",
      kb_context: chars(8),
      cadence: { current_7d: 1, previous_7d: 2, trend: "stable" },
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = applyBudgetForBothPaths(ctx, "nurture_value", undefined, 0);
    warnSpy.mockRestore();

    expect(result.ctx.brain_context).toBe(ctx.brain_context);
  });

  it("brain_context is counted in the estimate (can trigger truncation of droppables)", () => {
    // A large brain_context pushes the assembly over budget; the droppable
    // kb_context is sacrificed while brain_context stays.
    const ctx = makeCtx({
      brain_context: chars(8000),
      kb_context: chars(8000),
    });

    const result = applyBudgetTruncation(ctx);

    expect(result.droppedSections).toContain("kb_context");
    expect(result.ctx.kb_context).toBeUndefined();
    expect(result.ctx.brain_context).toBe(chars(8000));
  });
});

// ---------------------------------------------------------------------------
// Recording - droppedSections matches what was removed
// ---------------------------------------------------------------------------

describe("applyBudgetTruncation - recording", () => {
  it("records dropped sections that match what is actually absent from the returned context", () => {
    const ctx = makeCtx({
      kb_context: chars(8),
      behavior: {
        recent_events: ["event_a", "event_b"],
        most_used_features: ["feature_x"],
      },
      cadence: { current_7d: 2, previous_7d: 3, trend: "stable" },
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = applyBudgetTruncation(ctx, 0);
    warnSpy.mockRestore();

    // For each reported dropped section, verify absence in result
    for (const section of result.droppedSections) {
      switch (section) {
        case "kb_context":
          expect(result.ctx.kb_context).toBeUndefined();
          break;
        case "behavior.recent_events":
          expect(result.ctx.behavior?.recent_events).toBeUndefined();
          break;
        case "behavior.most_used_features":
          expect(result.ctx.behavior?.most_used_features).toBeUndefined();
          break;
        case "cadence":
          expect(result.ctx.cadence).toBeUndefined();
          break;
      }
    }

    // And sections NOT in droppedSections should still be present if they
    // were in the input (all four were: kb_context, both behavior fields,
    // cadence - all should be in droppedSections)
    expect(result.droppedSections).toHaveLength(4);
  });

  it("records no dropped sections when the context is under budget", () => {
    const ctx = makeCtx();
    const result = applyBudgetTruncation(ctx);
    expect(result.droppedSections).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Still-over-budget case
// ---------------------------------------------------------------------------

describe("applyBudgetTruncation - still over budget after all drops", () => {
  it("emits console.warn and returns the fully-truncated context", () => {
    const ctx = makeCtx({
      kb_context: chars(8),
      behavior: {
        recent_events: ["event_a"],
        most_used_features: ["feature_x"],
      },
      cadence: { current_7d: 1, previous_7d: 2, trend: "stable" },
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Budget of 0 is impossible to satisfy even after full truncation
    const result = applyBudgetTruncation(ctx, 0);

    // Warning must have been emitted
    expect(warnSpy).toHaveBeenCalledOnce();
    const [warnMsg] = warnSpy.mock.calls[0] as [string];
    expect(warnMsg).toContain("[context-budget]");
    expect(warnMsg).toContain("exceeds budget");

    // All four droppable sections are recorded as dropped
    expect(result.droppedSections).toEqual([
      "kb_context",
      "behavior.recent_events",
      "behavior.most_used_features",
      "cadence",
    ]);

    // All droppable sections are absent from the returned context
    expect(result.ctx.kb_context).toBeUndefined();
    expect(result.ctx.behavior?.recent_events).toBeUndefined();
    expect(result.ctx.behavior?.most_used_features).toBeUndefined();
    expect(result.ctx.cadence).toBeUndefined();

    // Protected sections still present
    expect(result.ctx.contact).toBeDefined();
    expect(result.ctx.lifecycle).toBeDefined();

    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Decide path estimation (step 0a fix)
// ---------------------------------------------------------------------------

describe("estimateDecideTokens", () => {
  it("estimates token count for a decide context using buildDecideMessages", () => {
    const decideCtx = {
      actionType: "nurture_value",
      contact: { name: "Alice", email: "alice@example.com" },
      lifecycle: { state: "engaged", tenureDays: 30 },
    };

    const estimate = estimateDecideTokens(decideCtx);
    expect(estimate).toBeGreaterThan(0);

    // Verify against direct character measurement
    const messages = buildDecideMessages(decideCtx);
    const totalChars = messages.reduce((s, m) => s + m.content.length, 0);
    expect(estimate).toBe(Math.ceil(totalChars / 4));
  });

  it("includes the decide system prompt in the estimate", () => {
    // The decide system prompt is ~1000 chars. Even with no user data,
    // the estimate must reflect it.
    const minCtx = {
      actionType: "nurture_value",
      contact: {},
      lifecycle: { state: "unknown" },
    };

    const estimate = estimateDecideTokens(minCtx);
    // System prompt alone is ~250 tokens (1000 chars / 4)
    expect(estimate).toBeGreaterThan(200);
  });
});

// ---------------------------------------------------------------------------
// draftContextToDecideContext mapping
// ---------------------------------------------------------------------------

describe("draftContextToDecideContext", () => {
  it("maps all shared fields from DraftPromptContext to DecidePromptContext", () => {
    const draftCtx: DraftPromptContext = {
      brain_instruction: "Write a welcome email.",
      action_type: "nurture_value",
      contact: { name: "Alice", email: "alice@example.com", company: "Acme", plan: "pro", signup_date: "2026-01-01" },
      lifecycle: { state: "engaged", tenure_days: 45, engagement_depth: "regular", payment_status: "paid" },
      tenure: { category: "growing", days: 45 },
      cadence: { current_7d: 5, previous_7d: 8, trend: "declining" },
      behavior: { last_action: "feature_used", most_used_features: ["dashboard", "reports"], recent_events: ["login", "export"] },
      prior_contact: { last_message_date: "2026-07-01", last_message_type: "nurture_value", total_messages_sent: 3, messages_opened: 2, messages_clicked: 1 },
      first_contact: false,
      kb_context: "Some knowledge base content",
      brain_context: "Acme is a kanban tool.",
      sender_name: "Alice from Acme",
      product_name: "Acme Pro",
    };

    const decideCtx = draftContextToDecideContext(draftCtx, "nurture_value");

    expect(decideCtx.actionType).toBe("nurture_value");
    expect(decideCtx.contact.name).toBe("Alice");
    expect(decideCtx.contact.email).toBe("alice@example.com");
    expect(decideCtx.contact.company).toBe("Acme");
    expect(decideCtx.contact.plan).toBe("pro");
    expect(decideCtx.contact.signupDate).toBe("2026-01-01");
    expect(decideCtx.lifecycle.state).toBe("engaged");
    expect(decideCtx.lifecycle.tenureDays).toBe(45);
    expect(decideCtx.lifecycle.engagementDepth).toBe("regular");
    expect(decideCtx.lifecycle.paymentStatus).toBe("paid");
    expect(decideCtx.cadence).toEqual({ current7d: 5, previous7d: 8, trend: "declining" });
    expect(decideCtx.behavior).toEqual({ lastAction: "feature_used", mostUsedFeatures: ["dashboard", "reports"], recentEvents: ["login", "export"] });
    expect(decideCtx.priorContact).toEqual({ lastMessageDate: "2026-07-01", lastMessageType: "nurture_value", totalMessagesSent: 3, messagesOpened: 2, messagesClicked: 1 });
    expect(decideCtx.firstContact).toBe(false);
    expect(decideCtx.brainInstruction).toBe("Write a welcome email.");
    expect(decideCtx.kbContext).toBe("Some knowledge base content");
    expect(decideCtx.brainContext).toBe("Acme is a kanban tool.");
  });

  it("handles minimal draft context with missing optional fields", () => {
    const draftCtx: DraftPromptContext = {
      action_type: "onboard_welcome",
      lifecycle: { state: "new" },
    };

    const decideCtx = draftContextToDecideContext(draftCtx, "onboard_welcome");

    expect(decideCtx.actionType).toBe("onboard_welcome");
    expect(decideCtx.contact).toEqual({});
    expect(decideCtx.lifecycle.state).toBe("new");
    expect(decideCtx.cadence).toBeUndefined();
    expect(decideCtx.behavior).toBeUndefined();
    expect(decideCtx.priorContact).toBeUndefined();
    expect(decideCtx.firstContact).toBeUndefined();
    expect(decideCtx.brainInstruction).toBeUndefined();
    expect(decideCtx.kbContext).toBeUndefined();
    expect(decideCtx.brainContext).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Dual-path budget (applyBudgetForBothPaths)
// ---------------------------------------------------------------------------

describe("applyBudgetForBothPaths", () => {
  it("returns decideEstimate when context fits without truncation", () => {
    const ctx = makeCtx();
    const result = applyBudgetForBothPaths(ctx, "nurture_value");

    expect(result.droppedSections).toEqual([]);
    expect(result.decideEstimate).toBeDefined();
    expect(result.decideEstimate).toBeGreaterThan(0);
    expect(result.decideEstimate!).toBeLessThanOrEqual(MAX_CONTEXT_TOKENS);
  });

  it("truncates using max of both paths (decide is larger) and verifies both fit", () => {
    // Build a context with kb_context that pushes the decide path over budget.
    // The decide system prompt is ~94 tokens larger than draft's, so decide
    // is the constraining path. We set a budget that draft alone would fit
    // but decide would not.
    const ctx = makeCtx({
      kb_context: chars(200),
      behavior: { recent_events: ["event_a", "event_b"], most_used_features: ["feat_x"] },
      cadence: { current_7d: 3, previous_7d: 5, trend: "declining" },
    });

    // Use a tight budget that requires truncation
    const draftEstimate = estimateTokens(ctx);
    const budget = draftEstimate - 10; // tighter than draft alone

    const result = applyBudgetForBothPaths(ctx, "nurture_value", undefined, budget);

    // Should have dropped something
    expect(result.droppedSections.length).toBeGreaterThan(0);
    expect(result.ctx.kb_context).toBeUndefined();
    expect(result.decideEstimate).toBeDefined();

    // After truncation, the max of both paths should fit (or all droppable exhausted)
    const finalDraftEst = estimateTokens(result.ctx);
    const finalMax = Math.max(finalDraftEst, result.decideEstimate!);
    // Either it fits, or all droppable sections were exhausted
    if (result.droppedSections.length < 4) {
      expect(finalMax).toBeLessThanOrEqual(budget);
    }
  });

  it("decide path is larger than draft path for the same data (system prompt difference)", () => {
    // With identical user data, decide estimate should be > draft estimate
    // because the decide system prompt is longer.
    const ctx = makeCtx({
      kb_context: chars(20),
      behavior: { recent_events: ["event_a"], most_used_features: ["feat_x"] },
      cadence: { current_7d: 3, previous_7d: 5, trend: "declining" },
    });

    const draftEstimate = estimateTokens(ctx);
    const decideCtx = draftContextToDecideContext(ctx, "nurture_value");
    const decideEstimate = estimateDecideTokens(decideCtx);

    // Decide should be larger because its system prompt is longer
    expect(decideEstimate).toBeGreaterThan(draftEstimate);
  });

  it("a context that fits draft but not decide triggers truncation (decide is the constraint)", () => {
    // This is the scenario that motivated step 0a: the decide path is larger.
    // A budget between the two estimates means decide needs truncation even
    // though draft would fit without it. The design truncates against max(both)
    // so both see the same truncated data.
    const ctx = makeCtx({
      kb_context: chars(100),
      behavior: { recent_events: ["event_a", "event_b"], most_used_features: ["feat_x"] },
    });

    const draftEstimate = estimateTokens(ctx);
    const decideCtx = draftContextToDecideContext(ctx, "nurture_value");
    const decideEstimate = estimateDecideTokens(decideCtx);

    // Pick a budget that draft fits but decide does not
    if (decideEstimate > draftEstimate) {
      const midBudget = draftEstimate + Math.floor((decideEstimate - draftEstimate) / 2);

      // Without dual-path budgeting, draft would pass but decide would overflow.
      // With dual-path budgeting, truncation is applied.
      const result = applyBudgetForBothPaths(ctx, "nurture_value", undefined, midBudget);

      // Truncation happened because decide exceeded the budget
      expect(result.droppedSections.length).toBeGreaterThan(0);
      // After truncation, both paths should fit
      const finalDraftEst = estimateTokens(result.ctx);
      const finalMax = Math.max(finalDraftEst, result.decideEstimate!);
      expect(finalMax).toBeLessThanOrEqual(midBudget);
    }
  });

  it("emits warning and returns result when both paths exceed budget after full truncation", () => {
    const ctx = makeCtx({ kb_context: chars(4) });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Budget of 1 token is impossible to satisfy
    const result = applyBudgetForBothPaths(ctx, "nurture_value", undefined, 1);

    // We expect the over-budget warning
    expect(warnSpy).toHaveBeenCalled();
    const warnings = warnSpy.mock.calls.map(c => c[0] as string);
    const hasOverBudgetWarning = warnings.some(w => w.includes("exceeds budget"));
    expect(hasOverBudgetWarning).toBe(true);

    // Despite warnings, result is still returned
    expect(result.ctx).toBeDefined();
    expect(result.droppedSections.length).toBeGreaterThan(0);
    expect(result.decideEstimate).toBeDefined();

    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Step 0a: decide messages reflect truncation
// ---------------------------------------------------------------------------

describe("decide messages reflect truncation (step 0a proof)", () => {
  it("dropped sections are absent from the decide messages sent to the provider", () => {
    // Build a context with all droppable sections populated.
    const ctx = makeCtx({
      kb_context: "Important knowledge base content about the product.",
      behavior: {
        last_action: "dashboard_viewed",
        recent_events: ["login", "export", "invite_sent"],
        most_used_features: ["analytics", "reports"],
      },
      cadence: { current_7d: 5, previous_7d: 8, trend: "declining" },
    });

    // Force a budget of 0 to drop all droppable sections.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = applyBudgetForBothPaths(ctx, "nurture_value", "2026-07-20T10:00:00Z", 0);
    warnSpy.mockRestore();

    // Reconstruct the decide context as content.ts would.
    const decideCtx = draftContextToDecideContext(
      result.ctx,
      "nurture_value",
      "2026-07-20T10:00:00Z",
    );

    // Build the messages that would be sent to the provider.
    const messages = buildDecideMessages(decideCtx);
    const fullText = messages.map((m) => m.content).join("\n");

    // Dropped sections must NOT appear in the messages.
    expect(fullText).not.toContain("knowledge base content");
    expect(fullText).not.toContain("KNOWLEDGE BASE");
    expect(fullText).not.toContain("login");
    expect(fullText).not.toContain("export");
    expect(fullText).not.toContain("invite_sent");
    expect(fullText).not.toContain("analytics");
    expect(fullText).not.toContain("reports");
    expect(fullText).not.toContain("CADENCE");
    expect(fullText).not.toContain("Visits last 7 days");

    // Protected sections MUST appear.
    expect(fullText).toContain("Alice");
    expect(fullText).toContain("engaged");

    // lastSeen (decide-only field) MUST appear since it was passed.
    expect(fullText).toContain("2026-07-20T10:00:00Z");
  });

  it("lastSeen (decide-only field) is included in the decide estimate", () => {
    const draftCtx = makeCtx();
    const lastSeen = "2026-07-25T14:30:00Z";

    // Estimate WITHOUT lastSeen
    const decideCtxWithout = draftContextToDecideContext(draftCtx, "nurture_value");
    const estimateWithout = estimateDecideTokens(decideCtxWithout);

    // Estimate WITH lastSeen
    const decideCtxWith = draftContextToDecideContext(draftCtx, "nurture_value", lastSeen);
    const estimateWith = estimateDecideTokens(decideCtxWith);

    // With lastSeen must be strictly larger (more chars in messages).
    expect(estimateWith).toBeGreaterThan(estimateWithout);

    // Verify the lastSeen value actually appears in the messages.
    const messages = buildDecideMessages(decideCtxWith);
    const fullText = messages.map((m) => m.content).join("\n");
    expect(fullText).toContain("Last seen: 2026-07-25T14:30:00Z");
  });

  it("budget estimation measures the same messages that decide() would send", () => {
    // This proves byte-for-byte equivalence: the messages used for estimation
    // are identical to those that buildDecideMessages produces for the same context.
    const draftCtx = makeCtx({
      kb_context: "Some KB content",
      behavior: { recent_events: ["event_a"], most_used_features: ["feat_x"] },
      cadence: { current_7d: 2, previous_7d: 4, trend: "stable" },
    });
    const lastSeen = "2026-07-20T10:00:00Z";

    // Apply budget (with generous budget so nothing is dropped)
    const result = applyBudgetForBothPaths(draftCtx, "nurture_value", lastSeen);

    // Reconstruct the decide context exactly as content.ts does after budget.
    const decideCtx = draftContextToDecideContext(result.ctx, "nurture_value", lastSeen);

    // The messages that decide() would send:
    const messagesForProvider = buildDecideMessages(decideCtx);

    // The estimate must equal ceil(totalChars/4) of those exact messages.
    const totalChars = messagesForProvider.reduce((s, m) => s + m.content.length, 0);
    const expectedEstimate = Math.ceil(totalChars / 4);
    expect(result.decideEstimate).toBe(expectedEstimate);
  });
});

// ---------------------------------------------------------------------------
// estimateAssessTokens and checkAssessBudget (task 20 budget coverage)
// ---------------------------------------------------------------------------

describe("estimateAssessTokens", () => {
  const baseDraftCtx: DraftPromptContext = {
    action_type: "nurture_value",
    brain_instruction: "Highlight unused features.",
    contact: { name: "Alice", plan: "pro" },
    lifecycle: { state: "at_risk", tenure_days: 90 },
  };

  it("returns a positive integer estimate", () => {
    const ctx: AssessPromptContext = {
      draftCtx: baseDraftCtx,
      subject: "Quick tip for you",
      body_markdown: "Hi Alice, here is a tip about feature X.",
    };
    const estimate = estimateAssessTokens(ctx);
    expect(estimate).toBeGreaterThan(0);
    expect(Number.isInteger(estimate)).toBe(true);
  });

  it("larger draft body produces larger estimate than shorter draft body", () => {
    const short: AssessPromptContext = {
      draftCtx: baseDraftCtx,
      subject: "Hi",
      body_markdown: "Short.",
    };
    const long: AssessPromptContext = {
      draftCtx: baseDraftCtx,
      subject: "Hi",
      body_markdown: "A".repeat(1000),
    };
    expect(estimateAssessTokens(long)).toBeGreaterThan(estimateAssessTokens(short));
  });

  it("estimate matches Math.ceil(totalChars/4) of the assembled messages", () => {
    const ctx: AssessPromptContext = {
      draftCtx: baseDraftCtx,
      subject: "Subject line",
      body_markdown: "Body content here.",
    };
    const messages = buildAssessMessages(ctx);
    const totalChars = messages.reduce((s: number, m: { content: string }) => s + m.content.length, 0);
    const expected = Math.ceil(totalChars / 4);
    expect(estimateAssessTokens(ctx)).toBe(expected);
  });
});

describe("checkAssessBudget", () => {
  const baseDraftCtx: DraftPromptContext = {
    action_type: "nurture_value",
    contact: { name: "Alice" },
    lifecycle: { state: "engaged" },
  };

  it("returns the estimated token count", () => {
    const estimate = checkAssessBudget(baseDraftCtx, "Subject", "Body.", 10_000);
    expect(estimate).toBeGreaterThan(0);
  });

  it("emits a console.warn when estimate exceeds budget", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Use a budget of 1 token to force the over-budget warning
    checkAssessBudget(baseDraftCtx, "Subject", "Body.", 1);
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0]![0]).toContain("assess call estimated at");
    warnSpy.mockRestore();
  });

  it("does not warn when estimate is within budget", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    checkAssessBudget(baseDraftCtx, "Subject", "Body.", 10_000);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("typical assess call fits within MAX_CONTEXT_TOKENS (4000)", () => {
    const estimate = checkAssessBudget(
      baseDraftCtx,
      "Quick tip for you",
      "Hi Alice, here is a personalized tip about using the reporting features you have been working with.",
    );
    expect(estimate).toBeLessThanOrEqual(MAX_CONTEXT_TOKENS);
  });
});
