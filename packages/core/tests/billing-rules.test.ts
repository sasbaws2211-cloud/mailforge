/**
 * Tests for the pure billing rules: paid plans and prices, the billing period
 * calendar math, the grace period, and how a paid-through date changes what a
 * workspace is entitled to. No database and no clock (time is always injected).
 */
import { describe, it, expect } from "vitest";
import {
  BILLING_GRACE_DAYS,
  PLANS,
  PlanLimitError,
  addBillingPeriod,
  assertWithinLimit,
  effectivePlan,
  entitlementsFor,
  isBillingInterval,
  isPaidPlanId,
  paymentStatus,
  planPriceUsd,
} from "../src/index.js";

const DAY = 86_400_000;
const NOW = new Date("2026-10-04T12:00:00Z");
const iso = (d: Date) => d.toISOString();

describe("paid plans and prices", () => {
  it("only the plans that cost money are paid plans", () => {
    for (const p of ["starter", "growth", "scale"]) expect(isPaidPlanId(p), p).toBe(true);
    for (const v of ["free", "trial", "enterprise", "", null, undefined, 3]) expect(isPaidPlanId(v), String(v)).toBe(false);
  });

  it("recognizes only monthly and yearly as billing intervals", () => {
    expect(isBillingInterval("monthly")).toBe(true);
    expect(isBillingInterval("yearly")).toBe(true);
    for (const v of ["annual", "weekly", "Monthly", "", null, undefined]) expect(isBillingInterval(v), String(v)).toBe(false);
  });

  it("the billed amount is the exact monthly price or the exact yearly total", () => {
    expect(planPriceUsd("starter", "monthly")).toBe(19);
    expect(planPriceUsd("growth", "monthly")).toBe(49);
    expect(planPriceUsd("scale", "monthly")).toBe(129);
    expect(planPriceUsd("starter", "yearly")).toBe(190);
    expect(planPriceUsd("growth", "yearly")).toBe(490);
    expect(planPriceUsd("scale", "yearly")).toBe(1290);
  });
});

describe("addBillingPeriod", () => {
  it("adds one calendar month, keeping the day and time", () => {
    expect(iso(addBillingPeriod(new Date("2026-10-04T12:30:15.250Z"), "monthly"))).toBe("2026-11-04T12:30:15.250Z");
  });

  it("clamps to the last day of a shorter month instead of spilling over", () => {
    expect(iso(addBillingPeriod(new Date("2026-01-31T09:00:00Z"), "monthly"))).toBe("2026-02-28T09:00:00.000Z");
    expect(iso(addBillingPeriod(new Date("2028-01-31T09:00:00Z"), "monthly"))).toBe("2028-02-29T09:00:00.000Z"); // leap year
    expect(iso(addBillingPeriod(new Date("2026-03-31T00:00:00Z"), "monthly"))).toBe("2026-04-30T00:00:00.000Z");
    expect(iso(addBillingPeriod(new Date("2026-05-31T00:00:00Z"), "monthly"))).toBe("2026-06-30T00:00:00.000Z");
  });

  it("rolls December into January of the next year", () => {
    expect(iso(addBillingPeriod(new Date("2026-12-15T00:00:00Z"), "monthly"))).toBe("2027-01-15T00:00:00.000Z");
    expect(iso(addBillingPeriod(new Date("2026-12-31T00:00:00Z"), "monthly"))).toBe("2027-01-31T00:00:00.000Z");
  });

  it("adds one calendar year, and clamps 29 February to 28 February", () => {
    expect(iso(addBillingPeriod(new Date("2026-10-04T12:00:00Z"), "yearly"))).toBe("2027-10-04T12:00:00.000Z");
    expect(iso(addBillingPeriod(new Date("2028-02-29T12:00:00Z"), "yearly"))).toBe("2029-02-28T12:00:00.000Z");
    expect(iso(addBillingPeriod(new Date("2027-02-28T12:00:00Z"), "yearly"))).toBe("2028-02-28T12:00:00.000Z");
  });

  it("never mutates its input", () => {
    const d = new Date("2026-01-31T09:00:00Z");
    addBillingPeriod(d, "monthly");
    expect(iso(d)).toBe("2026-01-31T09:00:00.000Z");
  });

  it("twelve monthly periods in a row land on the same day a year later", () => {
    let d = new Date("2026-10-04T12:00:00Z");
    for (let i = 0; i < 12; i++) d = addBillingPeriod(d, "monthly");
    expect(iso(d)).toBe("2027-10-04T12:00:00.000Z");
  });
});

describe("paymentStatus and the grace period", () => {
  const grace = BILLING_GRACE_DAYS * DAY;

  it("the grace period is three days", () => {
    expect(BILLING_GRACE_DAYS).toBe(3);
  });

  it("has no status for free, trial, unknown or hand-granted plans", () => {
    expect(paymentStatus("free", new Date(NOW.getTime() - 99 * DAY), NOW)).toBe("none");
    expect(paymentStatus("trial", new Date(NOW.getTime() - 99 * DAY), NOW)).toBe("none");
    expect(paymentStatus("growth", null, NOW)).toBe("none"); // granted by hand: no paid-through date
    expect(paymentStatus(null, null, NOW)).toBe("none");
  });

  it("is current while paid through a future date", () => {
    expect(paymentStatus("growth", new Date(NOW.getTime() + 1), NOW)).toBe("current");
    expect(paymentStatus("growth", new Date(NOW.getTime() + 30 * DAY), NOW)).toBe("current");
  });

  it("is overdue the instant the date passes, and for the whole grace period", () => {
    expect(paymentStatus("growth", new Date(NOW.getTime()), NOW)).toBe("overdue"); // exactly now
    expect(paymentStatus("growth", new Date(NOW.getTime() - 1), NOW)).toBe("overdue");
    expect(paymentStatus("growth", new Date(NOW.getTime() - grace + 1), NOW)).toBe("overdue"); // 1 ms inside
  });

  it("is lapsed exactly when the grace period ends", () => {
    expect(paymentStatus("growth", new Date(NOW.getTime() - grace), NOW)).toBe("lapsed"); // boundary
    expect(paymentStatus("growth", new Date(NOW.getTime() - grace - 1), NOW)).toBe("lapsed");
    expect(paymentStatus("growth", new Date(NOW.getTime() - 60 * DAY), NOW)).toBe("lapsed");
  });
});

describe("effectivePlan with a paid-through date", () => {
  const grace = BILLING_GRACE_DAYS * DAY;

  it("keeps a paid plan while current and during grace", () => {
    expect(effectivePlan("growth", null, NOW, new Date(NOW.getTime() + DAY))).toBe("growth");
    expect(effectivePlan("growth", null, NOW, new Date(NOW.getTime() - DAY))).toBe("growth");
    expect(effectivePlan("growth", null, NOW, new Date(NOW.getTime() - grace + 1))).toBe("growth");
  });

  it("drops to free the moment the grace period ends", () => {
    expect(effectivePlan("growth", null, NOW, new Date(NOW.getTime() - grace))).toBe("free");
    expect(effectivePlan("scale", null, NOW, new Date(NOW.getTime() - 90 * DAY))).toBe("free");
  });

  it("a paid plan with no paid-through date is never dropped (granted by hand)", () => {
    expect(effectivePlan("scale", null, NOW, null)).toBe("scale");
    expect(effectivePlan("scale", null, NOW)).toBe("scale");
  });

  it("does not affect free, trials or unknown plans", () => {
    expect(effectivePlan("free", null, NOW, new Date(NOW.getTime() - 90 * DAY))).toBe("free");
    expect(effectivePlan("trial", new Date(NOW.getTime() + DAY), NOW, new Date(NOW.getTime() - 90 * DAY))).toBe("growth");
    expect(effectivePlan("enterprise", null, NOW, new Date(NOW.getTime() + DAY))).toBe("free");
  });
});

describe("entitlements with a paid-through date", () => {
  const through = (plan: string, offsetMs: number) =>
    entitlementsFor({ plan, trialEndsAt: null, paidThrough: new Date(NOW.getTime() + offsetMs), now: NOW, enforced: true });

  it("a current subscription has the limits of its plan and is not overdue", () => {
    const e = through("growth", 10 * DAY);
    expect(e.plan).toBe("growth");
    expect(e.paymentStatus).toBe("current");
    expect(e.limits).toEqual(PLANS.growth.limits);
    expect(e.showsPoweredBy).toBe(false);
    expect(e.paidThrough?.getTime()).toBe(NOW.getTime() + 10 * DAY);
  });

  it("during the grace period the paid plan still works but is flagged overdue", () => {
    const e = through("growth", -DAY);
    expect(e.plan).toBe("growth");
    expect(e.paymentStatus).toBe("overdue");
    expect(e.limits).toEqual(PLANS.growth.limits);
  });

  it("once lapsed it is Free: Free limits, the credit line, and status lapsed", () => {
    const e = through("growth", -4 * DAY);
    expect(e.plan).toBe("free");
    expect(e.storedPlan).toBe("growth");
    expect(e.paymentStatus).toBe("lapsed");
    expect(e.limits).toEqual(PLANS.free.limits);
    expect(e.showsPoweredBy).toBe(true);
    expect(() => assertWithinLimit(e, "contacts", 500)).toThrow(PlanLimitError);
  });

  it("a hand-granted plan with no date is never lapsed", () => {
    const e = entitlementsFor({ plan: "scale", trialEndsAt: null, now: NOW, enforced: true });
    expect(e.paymentStatus).toBe("none");
    expect(e.plan).toBe("scale");
    expect(e.paidThrough).toBeNull();
  });

  it("lapsing changes nothing when enforcement is off", () => {
    const e = entitlementsFor({ plan: "growth", trialEndsAt: null, paidThrough: new Date(NOW.getTime() - 99 * DAY), now: NOW, enforced: false });
    expect(e.limits).toEqual({ contacts: null, emailsPerMonth: null, seats: null, aiTokensPerMonth: null });
    expect(e.showsPoweredBy).toBe(false);
  });
});
