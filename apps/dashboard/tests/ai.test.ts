/**
 * Tests for how the dashboard describes a workspace's AI: where it comes from,
 * how much of the Mailforge AI allowance is used, and what the admin console
 * says about changes to the operator's providers. Pure functions.
 */
import { describe, it, expect } from "vitest";
import { AI_SOURCE_LABEL, aiMeterState, aiPercent, describeAi, resetDay, tokens } from "../src/ai.js";
import { adminTabFor, auditSummary } from "../src/admin.js";
import type { AdminAuditEntry, LlmAiInfo } from "../src/api.js";

const RESET = "2026-11-01T00:00:00.000Z";

function ai(over: Partial<LlmAiInfo> & { allowance?: Partial<LlmAiInfo["allowance"]> } = {}): LlmAiInfo {
  const { allowance, ...rest } = over;
  return {
    source: "platform",
    name: "Mailforge AI",
    unavailable: false,
    allowance: { plan: "Starter", limit: 300_000, used: 1_000, spent: false, resets_at: RESET, ...allowance },
    ...rest,
  };
}

describe("aiMeterState", () => {
  it("is unlimited without a cap, near at 80 percent, at_limit exactly at the cap, over beyond it", () => {
    expect(aiMeterState(null, 9_999_999)).toBe("unlimited");
    expect(aiMeterState(100, 0)).toBe("ok");
    expect(aiMeterState(100, 79)).toBe("ok");
    expect(aiMeterState(100, 80)).toBe("near");
    expect(aiMeterState(100, 99)).toBe("near");
    expect(aiMeterState(100, 100)).toBe("at_limit");
    expect(aiMeterState(100, 101)).toBe("over");
    expect(aiMeterState(0, 0)).toBe("at_limit");
  });
});

describe("aiPercent", () => {
  it("rounds, caps at 100, and is 0 when there is no cap", () => {
    expect(aiPercent(null, 50)).toBe(0);
    expect(aiPercent(0, 50)).toBe(0);
    expect(aiPercent(200, 50)).toBe(25);
    expect(aiPercent(3, 1)).toBe(33);
    expect(aiPercent(100, 250)).toBe(100);
    expect(aiPercent(100, -5)).toBe(0);
  });
});

describe("number and date formatting", () => {
  it("groups thousands and names the reset day in UTC", () => {
    expect(tokens(1_500_000)).toBe("1,500,000");
    expect(resetDay(RESET)).toBe("Nov 1");
  });
});

describe("describeAi", () => {
  it("on Mailforge AI with room left: calm, with a meter, nothing to set up", () => {
    const s = describeAi(ai());
    expect(s).toMatchObject({ heading: "Mailforge AI is on", tone: "success", showMeter: true });
    expect(s.body).toContain("Starter");
    expect(s.body).toMatch(/nothing to set up/i);
  });

  it("warns when close to the allowance and points at their own key", () => {
    const s = describeAi(ai({ allowance: { used: 250_000 } }));
    expect(s.tone).toBe("warning");
    expect(s.body).toMatch(/own key/i);
  });

  it("when the allowance is used up: says what stopped, until when, and both ways out, and that nothing is lost", () => {
    const s = describeAi(ai({ allowance: { used: 300_000, spent: true } }));
    expect(s).toMatchObject({ tone: "warning", showMeter: true });
    expect(s.heading).toMatch(/used up/);
    expect(s.body).toContain("300,000");
    expect(s.body).toContain("Nov 1");
    expect(s.body).toMatch(/upgrade your plan or add your own key/i);
    expect(s.body).toMatch(/nothing you have is deleted/i);
  });

  it("with no cap there is no meter", () => {
    expect(describeAi(ai({ allowance: { limit: null } })).showMeter).toBe(false);
  });

  it("on the customer's own key: no allowance is used and no meter is shown", () => {
    const s = describeAi(ai({ source: "byok" }));
    expect(s).toMatchObject({ tone: "success", showMeter: false });
    expect(s.body).toMatch(/billed by them/);
  });

  it("with nothing set up: asks for a key", () => {
    const s = describeAi(ai({ source: "none" }));
    expect(s.tone).toBe("warning");
    expect(s.body).toMatch(/add your own key/i);
  });

  it("never names a vendor or model behind Mailforge AI", () => {
    for (const a of [ai(), ai({ allowance: { spent: true, used: 300_000 } }), ai({ allowance: { used: 290_000 } })]) {
      expect(JSON.stringify(describeAi(a))).not.toMatch(/openai|anthropic|claude|gpt/i);
    }
  });

  it("labels each source", () => {
    expect(AI_SOURCE_LABEL).toEqual({ byok: "Own key", platform: "Mailforge AI", none: "None" });
  });
});

describe("admin console: AI audit entries and tab", () => {
  const entry = (action: string, slot: string): AdminAuditEntry => ({ actor: "boss@x.test", action, detail: { slot, reason: "r" }, at: "2026-10-04T00:00:00Z" });

  it("describes each AI provider change in plain words", () => {
    expect(auditSummary(entry("ai_provider_set", "primary"))).toBe("Added the primary AI provider");
    expect(auditSummary(entry("ai_provider_change", "fallback"))).toBe("Changed the fallback AI provider");
    expect(auditSummary(entry("ai_provider_enable", "primary"))).toBe("Switched the primary AI provider on");
    expect(auditSummary(entry("ai_provider_disable", "primary"))).toBe("Switched the primary AI provider off");
    expect(auditSummary(entry("ai_provider_remove", "fallback"))).toBe("Removed the fallback AI provider");
  });

  it("the AI page has its own tab", () => {
    expect(adminTabFor("/admin/ai")).toBe("ai");
    expect(adminTabFor("/admin/ai/")).toBe("ai");
    expect(adminTabFor("/admin")).toBe("overview");
    expect(adminTabFor("/admin/audit")).toBe("audit");
    expect(adminTabFor("/admin/tenants/abc")).toBe("overview");
  });
});

import { describeAllowance, formatCost } from "../src/admin.js";

describe("allowance and cost wording in the admin console", () => {
  it("says what a hand-set allowance means", () => {
    expect(describeAllowance(null)).toBe("the plan's allowance");
    expect(describeAllowance(undefined)).toBe("the plan's allowance");
    expect(describeAllowance(-1)).toBe("no cap");
    expect(describeAllowance(500000)).toBe("500,000 tokens a month");
    expect(describeAllowance(0)).toBe("0 tokens a month");
  });

  it("shows tiny costs with enough digits not to read as zero", () => {
    expect(formatCost(0)).toBe("$0");
    expect(formatCost(0.0042)).toBe("$0.0042");
    expect(formatCost(12.345)).toBe("$12.35");
    expect(formatCost(1234.5)).toBe("$1,234.50");
  });

  it("describes an allowance change in the audit log", () => {
    const e = (after: number | null) => ({ actor: "a", action: "set_ai_allowance", detail: { after: { ai_allowance_override: after } }, at: null });
    expect(auditSummary(e(750000))).toBe("Set the AI allowance to 750,000 tokens a month");
    expect(auditSummary(e(-1))).toBe("Set the AI allowance to no cap");
    expect(auditSummary(e(null))).toBe("Set the AI allowance to the plan's allowance");
  });
});

describe("when the operator has paused Mailforge AI (budget used up)", () => {
  it("tells the customer it is paused, to add their own key or wait, and that nothing is lost - with no mention of money", () => {
    const s = describeAi(ai({ unavailable: true }));
    expect(s).toMatchObject({ tone: "warning", showMeter: false });
    expect(s.heading).toMatch(/temporarily unavailable/);
    expect(s.body).toMatch(/add your own AI key/i);
    expect(s.body).toMatch(/nothing you have is deleted/i);
    expect(JSON.stringify(s)).not.toMatch(/budget|\$|dollar|cost|spend|openai|anthropic/i);
  });

  it("never applies to a workspace on its own key", () => {
    expect(describeAi(ai({ source: "byok", unavailable: true })).heading).toMatch(/own AI key/);
  });

  it("describes budget changes in the admin audit log", () => {
    const e = (action: string, after: number | null) => ({ actor: "a", action, detail: { after: { monthly_usd: after } }, at: null });
    expect(auditSummary(e("ai_budget_set", 250))).toBe("Set the monthly AI budget to $250.00");
    expect(auditSummary(e("ai_budget_clear", null))).toBe("Removed the monthly AI budget");
  });
});
