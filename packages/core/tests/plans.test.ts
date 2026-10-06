/**
 * Tests for the plans config and the trial rules built on it.
 */
import { describe, it, expect } from "vitest";
import {
  PLANS,
  PLAN_IDS,
  TRIAL_DAYS,
  TRIAL_PLAN,
  effectivePlan,
  isPlanId,
  trialDaysLeft,
  trialEndDate,
} from "../src/index.js";

const DAY = 86_400_000;

describe("PLANS", () => {
  it("defines every plan id, keyed by its own id", () => {
    for (const id of PLAN_IDS) {
      expect(PLANS[id].id).toBe(id);
      expect(PLANS[id].name.length).toBeGreaterThan(0);
      expect(PLANS[id].features.length).toBeGreaterThan(0);
    }
  });

  it("prices and limits rise from plan to plan (no plan is worse than the one below)", () => {
    const ordered = PLAN_IDS.map((id) => PLANS[id]);
    for (let i = 1; i < ordered.length; i++) {
      const prev = ordered[i - 1]!;
      const cur = ordered[i]!;
      expect(cur.priceMonthlyUsd).toBeGreaterThan(prev.priceMonthlyUsd);
      expect(cur.limits.contacts ?? Infinity).toBeGreaterThan(prev.limits.contacts ?? Infinity);
      expect(cur.limits.emailsPerMonth ?? Infinity).toBeGreaterThan(prev.limits.emailsPerMonth ?? Infinity);
      expect(cur.limits.seats ?? Infinity).toBeGreaterThan(prev.limits.seats ?? Infinity);
    }
  });

  it("free costs nothing and carries the powered-by link; paid plans do not", () => {
    expect(PLANS.free.priceMonthlyUsd).toBe(0);
    expect(PLANS.free.priceAnnualMonthlyUsd).toBe(0);
    expect(PLANS.free.showsPoweredBy).toBe(true);
    for (const id of ["starter", "growth", "scale"] as const) {
      expect(PLANS[id].showsPoweredBy).toBeFalsy();
    }
  });

  it("annual billing charges exactly 10 months (2 months free), never a rounded figure", () => {
    expect(PLANS.free.priceAnnualUsd).toBe(0);
    expect(PLANS.starter.priceAnnualUsd).toBe(190);
    expect(PLANS.growth.priceAnnualUsd).toBe(490);
    expect(PLANS.scale.priceAnnualUsd).toBe(1290);
    for (const id of ["starter", "growth", "scale"] as const) {
      expect(PLANS[id].priceAnnualUsd).toBe(PLANS[id].priceMonthlyUsd * 10);
      // Paying yearly saves exactly two months versus paying monthly.
      expect(PLANS[id].priceMonthlyUsd * 12 - PLANS[id].priceAnnualUsd).toBe(PLANS[id].priceMonthlyUsd * 2);
    }
  });

  it("the per-month display price is the rounded annual total over 12, and is only for display", () => {
    expect(PLANS.starter.priceAnnualMonthlyUsd).toBe(16); // 190 / 12 = 15.83
    expect(PLANS.growth.priceAnnualMonthlyUsd).toBe(41); // 490 / 12 = 40.83
    expect(PLANS.scale.priceAnnualMonthlyUsd).toBe(108); // 1290 / 12 = 107.5
    for (const id of ["starter", "growth", "scale"] as const) {
      expect(PLANS[id].priceAnnualMonthlyUsd).toBe(Math.round(PLANS[id].priceAnnualUsd / 12));
      expect(PLANS[id].priceAnnualMonthlyUsd).toBeLessThan(PLANS[id].priceMonthlyUsd);
    }
  });

  it("exactly one plan is recommended, and it is the trial plan", () => {
    const rec = PLAN_IDS.filter((id) => PLANS[id].recommended);
    expect(rec).toEqual([TRIAL_PLAN]);
  });

  it("every plan lists its contact and email limits in the feature bullets", () => {
    for (const id of PLAN_IDS) {
      const p = PLANS[id];
      expect(p.features[0]).toContain(p.limits.contacts!.toLocaleString("en-US"));
      expect(p.features[1]).toContain(p.limits.emailsPerMonth!.toLocaleString("en-US"));
    }
  });
});

describe("isPlanId", () => {
  it("accepts known ids only", () => {
    expect(isPlanId("growth")).toBe(true);
    expect(isPlanId("trial")).toBe(false);
    expect(isPlanId("enterprise")).toBe(false);
    expect(isPlanId(undefined)).toBe(false);
    expect(isPlanId(7)).toBe(false);
  });
});

describe("effectivePlan", () => {
  const now = new Date("2026-10-04T12:00:00Z");

  it("a running trial behaves like the trial plan", () => {
    expect(effectivePlan("trial", new Date(now.getTime() + DAY), now)).toBe(TRIAL_PLAN);
  });

  it("an ended trial drops to free", () => {
    expect(effectivePlan("trial", new Date(now.getTime() - 1), now)).toBe("free");
    expect(effectivePlan("trial", new Date(now.getTime()), now)).toBe("free");
  });

  it("a trial with no end date is treated as ended (fail closed)", () => {
    expect(effectivePlan("trial", null, now)).toBe("free");
    expect(effectivePlan("trial", undefined, now)).toBe("free");
  });

  it("a paid plan stays as is, regardless of trial date", () => {
    expect(effectivePlan("starter", null, now)).toBe("starter");
    expect(effectivePlan("scale", new Date(now.getTime() - DAY), now)).toBe("scale");
  });

  it("null, empty and unknown plans resolve to free", () => {
    expect(effectivePlan(null, null, now)).toBe("free");
    expect(effectivePlan("", null, now)).toBe("free");
    expect(effectivePlan("enterprise", null, now)).toBe("free");
  });
});

describe("trial dates", () => {
  const now = new Date("2026-10-04T12:00:00Z");

  it("a trial lasts TRIAL_DAYS", () => {
    expect(TRIAL_DAYS).toBe(14);
    expect(trialEndDate(now).getTime() - now.getTime()).toBe(14 * DAY);
  });

  it("trialDaysLeft rounds up and bottoms out at 0", () => {
    expect(trialDaysLeft(trialEndDate(now), now)).toBe(14);
    expect(trialDaysLeft(new Date(now.getTime() + DAY / 2), now)).toBe(1);
    expect(trialDaysLeft(new Date(now.getTime() + 3 * DAY), now)).toBe(3);
    expect(trialDaysLeft(new Date(now.getTime() - DAY), now)).toBe(0);
    expect(trialDaysLeft(null, now)).toBe(0);
  });
});
