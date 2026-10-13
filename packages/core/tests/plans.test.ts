/**
 * Tests for the plans config and the trial rules built on it.
 */
import { describe, it, expect } from "vitest";
import {
  rebasedTrialEnd,
  TRIAL_MAX_DAYS,
  ADDONS,
  addonCheckoutPlan,
  addonPriceUsd,
  addonUnits,
  isAddonKind,
  isValidPackCount,
  parseAddonCheckoutPlan,
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
    }
  });

  it("sells exactly one plan: Essential, at $100 a month", () => {
    expect([...PLAN_IDS]).toEqual(["free", "essential"]);
    expect(PLANS.essential.priceMonthlyUsd).toBe(100);
    expect(PLANS.essential.features.length).toBeGreaterThan(0);
    expect(PLANS.essential.showsPoweredBy).toBeFalsy();
  });

  it("the internal free state costs nothing and allows nothing", () => {
    expect(PLANS.free.priceMonthlyUsd).toBe(0);
    expect(PLANS.free.limits.contacts).toBe(0);
    expect(PLANS.free.limits.emailsPerMonth).toBe(0);
    expect(PLANS.free.limits.aiTokensPerMonth).toBe(0);
  });

  it("annual total is exactly 10 months, never a rounded figure", () => {
    expect(PLANS.essential.priceAnnualUsd).toBe(1000);
    expect(PLANS.essential.priceAnnualMonthlyUsd).toBe(83.33);
  });

  it("the only recommended plan is the trial plan", () => {
    const rec = PLAN_IDS.filter((id) => PLANS[id].recommended);
    expect(rec).toEqual([TRIAL_PLAN]);
    expect(TRIAL_PLAN).toBe("essential");
  });

  it("Essential lists its contact and email limits in the feature bullets", () => {
    const p = PLANS.essential;
    expect(p.features[0]).toContain(p.limits.contacts!.toLocaleString("en-US"));
    expect(p.features[1]).toContain(p.limits.emailsPerMonth!.toLocaleString("en-US"));
  });
});

describe("isPlanId", () => {
  it("accepts known ids only", () => {
    expect(isPlanId("essential")).toBe(true);
    expect(isPlanId("trial")).toBe(false);
    expect(isPlanId("growth")).toBe(false);
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
    expect(effectivePlan("essential", null, now)).toBe("essential");
    expect(effectivePlan("essential", new Date(now.getTime() - DAY), now)).toBe("essential");
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
    expect(TRIAL_DAYS).toBe(7);
    expect(trialEndDate(now).getTime() - now.getTime()).toBe(7 * DAY);
  });

  it("trialDaysLeft rounds up and bottoms out at 0", () => {
    expect(trialDaysLeft(trialEndDate(now), now)).toBe(7);
    expect(trialDaysLeft(new Date(now.getTime() + DAY / 2), now)).toBe(1);
    expect(trialDaysLeft(new Date(now.getTime() + 3 * DAY), now)).toBe(3);
    expect(trialDaysLeft(new Date(now.getTime() - DAY), now)).toBe(0);
    expect(trialDaysLeft(null, now)).toBe(0);
  });
});

describe("extra usage top-ups", () => {
  it("prices packs from the published per-unit rates", () => {
    // $0.009 per profile, $0.12 per 1,000 emails, $10 per 100,000 AI credits.
    expect(ADDONS.profiles.packPriceCents / ADDONS.profiles.packUnits).toBeCloseTo(0.9, 10);
    expect(addonPriceUsd("profiles", 1)).toBe(9);
    expect(addonPriceUsd("emails", 1)).toBe(12);
    expect(ADDONS.emails.packPriceCents / (ADDONS.emails.packUnits / 1000)).toBe(12);
    expect(addonPriceUsd("ai", 1)).toBe(10);
    expect(addonPriceUsd("profiles", 5)).toBe(45);
    expect(addonUnits("emails", 3)).toBe(300_000);
  });

  it("validates kinds and pack counts", () => {
    expect(isAddonKind("profiles")).toBe(true);
    expect(isAddonKind("seats")).toBe(false);
    for (const n of [1, 50, 100]) expect(isValidPackCount(n), String(n)).toBe(true);
    for (const n of [0, -1, 101, 1.5, "2", null, NaN]) expect(isValidPackCount(n), String(n)).toBe(false);
  });

  it("round-trips the checkout plan marker", () => {
    expect(parseAddonCheckoutPlan(addonCheckoutPlan("ai"))).toBe("ai");
    expect(parseAddonCheckoutPlan("essential")).toBeNull();
    expect(parseAddonCheckoutPlan("addon:seats")).toBeNull();
    expect(parseAddonCheckoutPlan(null)).toBeNull();
  });

  it("top-ups raise the limits, and never cap an uncapped kind", async () => {
    const { entitlementsFor } = await import("../src/index.js");
    const base = entitlementsFor({ plan: "essential", trialEndsAt: null, enforced: true });
    const more = entitlementsFor({
      plan: "essential",
      trialEndsAt: null,
      enforced: true,
      addons: { contacts: 1_000, emailsPerMonth: 200_000, aiTokensPerMonth: 100_000 },
    });
    expect(more.limits.contacts).toBe(base.limits.contacts! + 1_000);
    expect(more.limits.emailsPerMonth).toBe(base.limits.emailsPerMonth! + 200_000);
    expect(more.limits.aiTokensPerMonth).toBe(base.limits.aiTokensPerMonth! + 100_000);
    expect(more.limits.seats).toBeNull();
    const off = entitlementsFor({ plan: "essential", trialEndsAt: null, enforced: false, addons: { contacts: 5 } });
    expect(off.limits.contacts).toBeNull();
  });
});

describe("rebasedTrialEnd", () => {
  const created = new Date("2026-10-01T00:00:00Z");
  it("restarts a full trial from the first event", () => {
    const end = new Date("2026-10-08T00:00:00Z");
    const now = new Date("2026-10-06T00:00:00Z");
    expect(rebasedTrialEnd(created, end, now).toISOString()).toBe("2026-10-13T00:00:00.000Z");
  });
  it("never ends earlier than it already did", () => {
    const end = new Date("2026-10-14T12:00:00Z");
    const now = new Date("2026-10-02T00:00:00Z");
    expect(rebasedTrialEnd(created, end, now).getTime()).toBe(end.getTime() > created.getTime() + TRIAL_MAX_DAYS * DAY ? created.getTime() + TRIAL_MAX_DAYS * DAY : end.getTime());
  });
  it("never runs past the cap from signup", () => {
    const now = new Date("2026-10-10T00:00:00Z");
    const out = rebasedTrialEnd(created, new Date("2026-10-08T00:00:00Z"), now);
    expect(out.getTime()).toBe(created.getTime() + TRIAL_MAX_DAYS * DAY);
  });
});
