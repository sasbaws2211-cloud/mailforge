/**
 * Tests for what the dashboard says about money: overdue and lapsed payments,
 * cancelled subscriptions, the notice shown when the customer comes back from
 * the payment page, and the date helpers behind them. Pure functions.
 */
import { describe, it, expect } from "vitest";
import { billingReturnNotice, daysUntil, formatDay, formatMoney, planNeedsAttention, planNotice, storedPlanName } from "../src/plan.js";
import type { BillingSubscription, PlanCatalogEntry, PlanInfo, PlanMeter } from "../src/api.js";

const DAY = 86_400_000;
const ok = (used: number, limit: number): PlanMeter => ({ used, limit, state: "ok" });

const CATALOG: PlanCatalogEntry[] = [
  ["free", "Free"],
  ["starter", "Starter"],
  ["growth", "Growth"],
  ["scale", "Scale"],
].map(([id, name]) => ({
  id: id!,
  name: name!,
  tagline: "",
  price_monthly_usd: 0,
  price_annual_usd: 0,
  limits: { contacts: null, emails_per_month: null, seats: null },
  features: [],
  recommended: false,
  current: false,
}));

function sub(over: Partial<BillingSubscription> = {}): BillingSubscription {
  return {
    plan: "growth",
    interval: "monthly",
    amount_usd: 49,
    status: "active",
    current_period_end: new Date(Date.now() + 20 * DAY).toISOString(),
    cancel_at_period_end: false,
    ...over,
  };
}

/** A paying Growth workspace by default. */
function paying(over: {
  payment?: Partial<PlanInfo["payment"]>;
  subscription?: BillingSubscription | null;
  effective?: { id: string; name: string };
  stored?: string;
  trial?: Partial<PlanInfo["trial"]>;
  enforced?: boolean;
} = {}): PlanInfo {
  const effective = over.effective ?? { id: "growth", name: "Growth" };
  return {
    enforced: over.enforced ?? true,
    billing: { enabled: true, currency: "USD", subscription: over.subscription === undefined ? sub() : over.subscription },
    payment: { status: "current", paid_through: null, grace_ends_at: null, ...over.payment },
    plan: { ...effective, tagline: "" },
    stored_plan: over.stored ?? "growth",
    shows_powered_by: false,
    support_email: null,
    trial: { active: false, expired: false, ends_at: null, days_left: 0, ...over.trial },
    meters: {
      contacts: ok(100, 10000),
      emails: { ...ok(10, 100000), resets_at: "2026-11-01T00:00:00.000Z" },
      seats: { ...ok(1, 10), members: 1, pending_invites: 0 },
    },
    plans: CATALOG,
  };
}

describe("a healthy paying workspace", () => {
  it("has nothing to say and no attention dot", () => {
    expect(planNotice(paying())).toBeNull();
    expect(planNeedsAttention(paying())).toBe(false);
  });
});

describe("payment overdue (inside the grace period)", () => {
  const overdue = (daysLeft: number) =>
    paying({ payment: { status: "overdue", paid_through: new Date(Date.now() - DAY).toISOString(), grace_ends_at: new Date(Date.now() + daysLeft * DAY).toISOString() } });

  it("warns, names the plan, says how long it keeps working, and cannot be dismissed", () => {
    const n = planNotice(overdue(2))!;
    expect(n.id).toBe("payment-overdue");
    expect(n.tone).toBe("warning");
    expect(n.dismissible).toBe(false);
    expect(n.message).toContain("Growth payment is overdue");
    expect(n.message).toContain("keeps working for 2 more days");
  });

  it("with under a day left it says so instead of 0 days", () => {
    const n = planNotice(overdue(0.4))!;
    expect(n.message).toContain("less than a day");
    expect(n.message).not.toContain("0 more days");
  });

  it("turns the attention dot on", () => {
    expect(planNeedsAttention(overdue(2))).toBe(true);
  });

  it("a reached limit still outranks it", () => {
    const p = overdue(2);
    p.meters.contacts = { used: 10000, limit: 10000, state: "at_limit" };
    expect(planNotice(p)!.id).toBe("limit-contacts");
  });
});

describe("subscription lapsed (now on Free)", () => {
  const lapsed = () =>
    paying({
      effective: { id: "free", name: "Free" },
      stored: "growth",
      payment: { status: "lapsed", paid_through: new Date(Date.now() - 10 * DAY).toISOString(), grace_ends_at: new Date(Date.now() - 7 * DAY).toISOString() },
      subscription: sub({ status: "ended", current_period_end: new Date(Date.now() - 10 * DAY).toISOString() }),
    });

  it("explains the downgrade, names the old plan, reassures about data, and cannot be dismissed", () => {
    const n = planNotice(lapsed())!;
    expect(n.id).toBe("subscription-lapsed");
    expect(n.tone).toBe("warning");
    expect(n.dismissible).toBe(false);
    expect(n.message).toContain("Growth subscription has ended");
    expect(n.message).toContain("now on the Free plan");
    expect(n.message).toContain("Your data is safe");
  });

  it("turns the attention dot on", () => {
    expect(planNeedsAttention(lapsed())).toBe(true);
  });

  it("outranks an ended trial", () => {
    const p = lapsed();
    p.trial.expired = true;
    expect(planNotice(p)!.id).toBe("subscription-lapsed");
  });
});

describe("cancelled subscription still running out its time", () => {
  const cancelling = () => paying({ subscription: sub({ status: "cancelling", cancel_at_period_end: true, current_period_end: "2026-11-04T12:00:00.000Z" }) });

  it("is a quiet, dismissible note with the end date", () => {
    const n = planNotice(cancelling())!;
    expect(n.id).toBe("subscription-cancelling");
    expect(n.tone).toBe("info");
    expect(n.dismissible).toBe(true);
    expect(n.message).toContain("ends on Nov 4, 2026");
    expect(n.message).toContain("keep everything until then");
  });

  it("does not light the attention dot: nothing is wrong, it is a choice the customer made", () => {
    expect(planNeedsAttention(cancelling())).toBe(false);
  });

  it("a payment problem or a limit outranks it", () => {
    const p = cancelling();
    p.payment = { status: "overdue", paid_through: null, grace_ends_at: new Date(Date.now() + DAY).toISOString() };
    expect(planNotice(p)!.id).toBe("payment-overdue");
  });

  it("an ended subscription (past its date) is not described as cancelling", () => {
    const p = paying({ subscription: sub({ status: "ended" }) });
    expect(planNotice(p)).toBeNull();
  });
});

describe("storedPlanName", () => {
  it("names the plan on the workspace even when it is not the one currently in force", () => {
    expect(storedPlanName(paying({ effective: { id: "free", name: "Free" }, stored: "scale" }))).toBe("Scale");
    expect(storedPlanName(paying())).toBe("Growth");
  });

  it("falls back to the current plan's name for something it does not know", () => {
    expect(storedPlanName(paying({ stored: "mystery" }))).toBe("Growth");
  });
});

describe("billingReturnNotice", () => {
  it("has wording for each state Paystack can send the customer back with", () => {
    expect(billingReturnNotice("success")).toMatchObject({ tone: "success", message: "Payment confirmed. Your plan is active." });
    expect(billingReturnNotice("pending")!.message).toContain("confirming your payment");
    expect(billingReturnNotice("failed")!.message).toContain("you have not been charged");
    expect(billingReturnNotice("cancelled")!.message).toContain("Nothing was charged");
    expect(billingReturnNotice("unknown")!.tone).toBe("warning");
  });

  it("tones: good news is success, trouble is a warning, neutral is info", () => {
    expect(billingReturnNotice("success")!.tone).toBe("success");
    expect(billingReturnNotice("failed")!.tone).toBe("warning");
    expect(billingReturnNotice("unknown")!.tone).toBe("warning");
    expect(billingReturnNotice("pending")!.tone).toBe("info");
    expect(billingReturnNotice("cancelled")!.tone).toBe("info");
  });

  it("says nothing when there is no billing parameter or it is not one of ours", () => {
    expect(billingReturnNotice(null)).toBeNull();
    expect(billingReturnNotice("")).toBeNull();
    expect(billingReturnNotice("<script>")).toBeNull();
    expect(billingReturnNotice("SUCCESS")).toBeNull();
  });

  it("never echoes the parameter back (so it cannot be used to put words on the page)", () => {
    expect(JSON.stringify(billingReturnNotice("pending"))).not.toContain("<");
    expect(billingReturnNotice("hello world")).toBeNull();
  });
});

describe("date helpers", () => {
  it("formatDay is the UTC calendar date, so it does not shift with the viewer's time zone", () => {
    expect(formatDay("2026-11-04T23:59:59.000Z")).toBe("Nov 4, 2026");
    expect(formatDay("2026-11-05T00:00:00.000Z")).toBe("Nov 5, 2026");
  });

  it("daysUntil rounds up and never goes negative", () => {
    const now = new Date("2026-10-04T12:00:00Z");
    expect(daysUntil("2026-10-07T12:00:00Z", now)).toBe(3);
    expect(daysUntil("2026-10-04T12:00:01Z", now)).toBe(1);
    expect(daysUntil("2026-10-04T12:00:00Z", now)).toBe(0);
    expect(daysUntil("2026-09-01T00:00:00Z", now)).toBe(0);
  });
});

describe("formatMoney", () => {
  it("shows whole units with the local symbol", () => {
    expect(formatMoney(49, "USD")).toBe("$49");
    expect(formatMoney(760, "GHS")).toBe("GH₵760");
    expect(formatMoney(7595, "GHS")).toBe("GH₵7,595");
  });

  it("falls back to the code, and never throws, for a currency the browser does not know", () => {
    expect(() => formatMoney(760, "NOT-A-CURRENCY")).not.toThrow();
    expect(formatMoney(760, "NOT-A-CURRENCY")).toBe("760 NOT-A-CURRENCY");
    expect(formatMoney(760, "")).toBe("760 ");
  });
});
