import { describe, it, expect } from "vitest";
import {
  PLANS,
  PLAN_IDS,
  PlanLimitError,
  aiAllowanceMessage,
  aiAllowanceSpent,
  assertWithinLimit,
  entitlementsFor,
  estimateTokens,
  isPlatformLlmSlot,
  limitFor,
  planLimitMessage,
} from "../src/index.js";

describe("AI allowance per plan", () => {
  it("every plan has a monthly AI token allowance and it grows with the plan", () => {
    let prev = -1;
    for (const id of PLAN_IDS) {
      const cap = PLANS[id].limits.aiTokensPerMonth;
      expect(cap).not.toBeNull();
      expect(cap!).toBeGreaterThan(prev);
      prev = cap!;
    }
  });

  it("each plan's feature list states its AI allowance", () => {
    for (const id of PLAN_IDS) {
      const cap = PLANS[id].limits.aiTokensPerMonth!;
      expect(PLANS[id].features.some((f) => f.includes(cap.toLocaleString("en-US")) && f.includes("AI"))).toBe(true);
    }
  });

  it("is enforced as the 'ai' limit kind, and unlimited when enforcement is off", () => {
    const on = entitlementsFor({ plan: "starter", trialEndsAt: null, enforced: true });
    expect(limitFor(on, "ai")).toBe(PLANS.starter.limits.aiTokensPerMonth);
    const off = entitlementsFor({ plan: "starter", trialEndsAt: null, enforced: false });
    expect(limitFor(off, "ai")).toBeNull();
  });

  it("assertWithinLimit refuses AI use past the cap with a message that names both ways out", () => {
    const ent = entitlementsFor({ plan: "free", trialEndsAt: null, enforced: true });
    const cap = PLANS.free.limits.aiTokensPerMonth!;
    expect(() => assertWithinLimit(ent, "ai", cap - 1, 1)).not.toThrow();
    expect(() => assertWithinLimit(ent, "ai", cap, 1)).toThrow(PlanLimitError);
    try {
      assertWithinLimit(ent, "ai", cap, 1);
    } catch (e) {
      const err = e as PlanLimitError;
      expect(err.kind).toBe("ai");
      expect(err.message).toMatch(/upgrade your plan/i);
      expect(err.message).toMatch(/own AI key/i);
    }
    expect(planLimitMessage("ai", 1, "Free")).toContain("1 Mailforge AI token this month");
  });
});

describe("aiAllowanceSpent", () => {
  it("is spent exactly at the cap, never when there is no cap", () => {
    expect(aiAllowanceSpent(100, 99)).toBe(false);
    expect(aiAllowanceSpent(100, 100)).toBe(true);
    expect(aiAllowanceSpent(100, 5000)).toBe(true);
    expect(aiAllowanceSpent(null, 1_000_000_000)).toBe(false);
    expect(aiAllowanceSpent(0, 0)).toBe(true);
  });

  it("explains itself in plain words", () => {
    const m = aiAllowanceMessage("Starter", 300_000);
    expect(m).toContain("Starter");
    expect(m).toContain("300,000");
    expect(m).toMatch(/own AI key/i);
  });
});

describe("estimateTokens", () => {
  it("is about one token per four characters, rounded up, and zero for nothing", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("a")).toBe(1);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
    expect(estimateTokens("x".repeat(4000))).toBe(1000);
  });
});

describe("isPlatformLlmSlot", () => {
  it("accepts primary and fallback only", () => {
    expect(isPlatformLlmSlot("primary")).toBe(true);
    expect(isPlatformLlmSlot("fallback")).toBe(true);
    expect(isPlatformLlmSlot("third")).toBe(false);
    expect(isPlatformLlmSlot(undefined)).toBe(false);
  });
});

import {
  AI_ALERT_COOLDOWN_MINUTES,
  MAX_PRICE_USD_PER_MTOK,
  aiHealth,
  costMicros,
  isValidPriceUsdPerMtok,
  microsToUsd,
  shouldSendAiAlert,
} from "../src/index.js";

describe("cost", () => {
  it("price per million tokens times tokens is already millionths of a dollar", () => {
    // $3 per million in, $15 per million out: 1,000 in + 500 out = $0.003 + $0.0075 = $0.0105
    expect(costMicros(1000, 500, 3, 15)).toBe(10_500);
    expect(microsToUsd(10_500)).toBeCloseTo(0.0105, 10);
    expect(microsToUsd(1_000_000)).toBe(1);
  });

  it("a missing price counts as free, and negative tokens as zero", () => {
    expect(costMicros(1000, 500, undefined, undefined)).toBe(0);
    expect(costMicros(1000, 500, 3, null)).toBe(3000);
    expect(costMicros(-5, 10, 3, 1)).toBe(10);
  });

  it("rounds to a whole micro-dollar", () => {
    expect(costMicros(1, 1, 0.4, 0.4)).toBe(1);
  });

  it("accepts prices from 0 to the typo guard, nothing else", () => {
    for (const v of [0, 0.15, 3, MAX_PRICE_USD_PER_MTOK]) expect(isValidPriceUsdPerMtok(v)).toBe(true);
    for (const v of [-1, MAX_PRICE_USD_PER_MTOK + 1, NaN, Infinity, "3", null, undefined]) expect(isValidPriceUsdPerMtok(v)).toBe(false);
  });
});

describe("aiHealth", () => {
  it("is unhealthy only with enough calls AND a high failure rate", () => {
    expect(aiHealth(10, 5).unhealthy).toBe(true);
    expect(aiHealth(10, 4).unhealthy).toBe(false);
    expect(aiHealth(9, 9).unhealthy).toBe(false); // too few calls to mean anything
    expect(aiHealth(100, 100).unhealthy).toBe(true);
    expect(aiHealth(0, 0)).toMatchObject({ rate: 0, unhealthy: false });
  });

  it("thresholds can be tuned", () => {
    expect(aiHealth(4, 4, { minCalls: 3 }).unhealthy).toBe(true);
    expect(aiHealth(10, 3, { failRate: 0.25 }).unhealthy).toBe(true);
  });
});

describe("shouldSendAiAlert", () => {
  const now = new Date("2026-10-04T12:00:00Z");
  const bad = { unhealthy: true };
  const mins = (m: number) => new Date(now.getTime() - m * 60_000);

  it("never while healthy", () => {
    expect(shouldSendAiAlert({ unhealthy: false }, null, now)).toBe(false);
    expect(shouldSendAiAlert({ unhealthy: false }, { active: true, lastSentAt: mins(500) }, now)).toBe(false);
  });

  it("straight away for a new incident", () => {
    expect(shouldSendAiAlert(bad, null, now)).toBe(true);
    expect(shouldSendAiAlert(bad, { active: false, lastSentAt: mins(1) }, now)).toBe(true); // recovered since, so a new one
    expect(shouldSendAiAlert(bad, { active: true, lastSentAt: null }, now)).toBe(true);
  });

  it("one reminder per cooldown while it lasts", () => {
    expect(shouldSendAiAlert(bad, { active: true, lastSentAt: mins(AI_ALERT_COOLDOWN_MINUTES - 1) }, now)).toBe(false);
    expect(shouldSendAiAlert(bad, { active: true, lastSentAt: mins(AI_ALERT_COOLDOWN_MINUTES) }, now)).toBe(true);
    expect(shouldSendAiAlert(bad, { active: true, lastSentAt: mins(5) }, now, 5)).toBe(true);
  });
});

describe("per-workspace AI allowance override", () => {
  const ent = (aiTokensOverride: number | null | undefined, enforced = true) =>
    entitlementsFor({ plan: "free", trialEndsAt: null, aiTokensOverride, enforced });

  it("uses the plan's allowance unless an admin set one", () => {
    expect(limitFor(ent(undefined), "ai")).toBe(20_000);
    expect(limitFor(ent(null), "ai")).toBe(20_000);
  });

  it("a number replaces the plan's (more or less, and zero means none)", () => {
    expect(limitFor(ent(1_000_000), "ai")).toBe(1_000_000);
    expect(limitFor(ent(5), "ai")).toBe(5);
    expect(limitFor(ent(0), "ai")).toBe(0);
  });

  it("a negative number means no cap", () => {
    expect(limitFor(ent(-1), "ai")).toBeNull();
  });

  it("changes only the AI limit, and does nothing when plans are not enforced", () => {
    const e = ent(42);
    expect(e.limits).toMatchObject({ contacts: 500, emailsPerMonth: 5_000, seats: 1, aiTokensPerMonth: 42 });
    expect(limitFor(ent(42, false), "ai")).toBeNull();
  });
});

import { AI_UNAVAILABLE_MESSAGE, MAX_AI_BUDGET_USD, aiBudgetState, isValidAiBudgetUsd } from "../src/index.js";

describe("monthly dollar budget", () => {
  it("no budget means no limit at all", () => {
    expect(aiBudgetState(null, 0)).toBe("none");
    expect(aiBudgetState(null, 1_000_000)).toBe("none");
  });

  it("ok below 80 percent, near from 80 percent, reached exactly at the budget and beyond", () => {
    expect(aiBudgetState(100, 0)).toBe("ok");
    expect(aiBudgetState(100, 79.99)).toBe("ok");
    expect(aiBudgetState(100, 80)).toBe("near");
    expect(aiBudgetState(100, 99.99)).toBe("near");
    expect(aiBudgetState(100, 100)).toBe("reached");
    expect(aiBudgetState(100, 250)).toBe("reached");
  });

  it("accepts a positive number up to the typo guard, nothing else", () => {
    for (const v of [0.01, 1, 50, MAX_AI_BUDGET_USD]) expect(isValidAiBudgetUsd(v)).toBe(true);
    for (const v of [0, -5, MAX_AI_BUDGET_USD + 1, NaN, Infinity, "50", null, undefined]) expect(isValidAiBudgetUsd(v)).toBe(false);
  });

  it("what customers are told says nothing about money and points at their own key", () => {
    expect(AI_UNAVAILABLE_MESSAGE).toMatch(/own AI key/i);
    expect(AI_UNAVAILABLE_MESSAGE).not.toMatch(/budget|\$|dollar|cost|spend/i);
  });
});
