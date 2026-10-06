/**
 * Tests for the entitlement rules: what a tenant may do, and limit checks.
 * Pure functions: no database, no clock (time is always injected).
 */
import { describe, it, expect } from "vitest";
import {
  PLANS,
  PlanLimitError,
  assertWithinLimit,
  entitlementsFor,
  limitFor,
  plansEnforced,
  planLimitMessage,
  poweredByFor,
  startOfMonthUtc,
  startOfNextMonthUtc,
  usageFraction,
  wouldExceed,
} from "../src/index.js";

const NOW = new Date("2026-10-04T12:00:00Z");
const DAY = 86_400_000;
const ent = (plan: string | null, trialEndsAt: Date | null = null, enforced = true) =>
  entitlementsFor({ plan, trialEndsAt, now: NOW, enforced });

describe("plansEnforced", () => {
  it("is on only for the exact string true", () => {
    expect(plansEnforced({ MAILFORGE_ENFORCE_PLANS: "true" })).toBe(true);
    for (const v of [undefined, "", "false", "1", "yes", "TRUE", " true"]) {
      expect(plansEnforced({ MAILFORGE_ENFORCE_PLANS: v }), String(v)).toBe(false);
    }
    expect(plansEnforced({})).toBe(false);
  });
});

describe("entitlementsFor: enforcement off (self-hosted default)", () => {
  it("everything is unlimited and nothing is branded, whatever the plan", () => {
    for (const plan of ["free", "trial", "starter", "scale", null, "nonsense"]) {
      const e = ent(plan, null, false);
      expect(e.enforced).toBe(false);
      expect(e.limits).toEqual({ contacts: null, emailsPerMonth: null, seats: null, aiTokensPerMonth: null });
      expect(e.showsPoweredBy).toBe(false);
      for (const kind of ["contacts", "emails", "seats"] as const) expect(limitFor(e, kind)).toBeNull();
    }
  });

  it("an enforcement-off tenant can never trip a limit", () => {
    expect(() => assertWithinLimit(ent("free", null, false), "contacts", 10_000_000)).not.toThrow();
  });
});

describe("entitlementsFor: enforcement on", () => {
  it("a paid plan gets that plan's limits", () => {
    expect(ent("starter").limits).toEqual(PLANS.starter.limits);
    expect(ent("scale").limits).toEqual(PLANS.scale.limits);
    expect(ent("scale").plan).toBe("scale");
  });

  it("free gets the free limits and the powered-by link; paid plans do not show it", () => {
    expect(ent("free").limits).toEqual(PLANS.free.limits);
    expect(ent("free").showsPoweredBy).toBe(true);
    for (const p of ["starter", "growth", "scale"]) expect(ent(p).showsPoweredBy, p).toBe(false);
  });

  it("an unknown or missing plan is treated as free (fail to the smallest plan)", () => {
    expect(ent(null).plan).toBe("free");
    expect(ent("enterprise").plan).toBe("free");
    expect(ent("enterprise").limits).toEqual(PLANS.free.limits);
  });

  it("a running trial gets the trial plan's limits and reports the days left", () => {
    const e = ent("trial", new Date(NOW.getTime() + 9 * DAY));
    expect(e.plan).toBe("growth");
    expect(e.onTrial).toBe(true);
    expect(e.trialExpired).toBe(false);
    expect(e.trialDaysLeft).toBe(9);
    expect(e.limits).toEqual(PLANS.growth.limits);
    expect(e.showsPoweredBy).toBe(false);
    expect(e.storedPlan).toBe("trial");
  });

  it("a trial drops to free the instant it ends, and says it expired", () => {
    const justEnded = ent("trial", new Date(NOW.getTime()));
    expect(justEnded.plan).toBe("free");
    expect(justEnded.onTrial).toBe(false);
    expect(justEnded.trialExpired).toBe(true);
    expect(justEnded.trialDaysLeft).toBe(0);
    expect(justEnded.limits).toEqual(PLANS.free.limits);
    expect(justEnded.showsPoweredBy).toBe(true);

    const oneMsLeft = ent("trial", new Date(NOW.getTime() + 1));
    expect(oneMsLeft.onTrial).toBe(true);
    expect(oneMsLeft.trialDaysLeft).toBe(1);
  });

  it("a trial with no end date is treated as expired", () => {
    const e = ent("trial", null);
    expect(e.plan).toBe("free");
    expect(e.trialExpired).toBe(true);
  });

  it("a paid plan is never reported as a trial, even with an old trial date", () => {
    const e = ent("growth", new Date(NOW.getTime() - 30 * DAY));
    expect(e.onTrial).toBe(false);
    expect(e.trialExpired).toBe(false);
    expect(e.plan).toBe("growth");
  });
});

describe("wouldExceed: the boundary", () => {
  it("allows up to and including the limit, refuses one past it", () => {
    expect(wouldExceed(500, 498)).toBe(false);
    expect(wouldExceed(500, 499)).toBe(false); // this one makes exactly 500
    expect(wouldExceed(500, 500)).toBe(true); // this one would make 501
    expect(wouldExceed(500, 501)).toBe(true);
  });

  it("handles adding several at once", () => {
    expect(wouldExceed(500, 490, 10)).toBe(false);
    expect(wouldExceed(500, 490, 11)).toBe(true);
    expect(wouldExceed(500, 500, 0)).toBe(false);
  });

  it("null (unlimited) never exceeds", () => {
    expect(wouldExceed(null, Number.MAX_SAFE_INTEGER, 1_000_000)).toBe(false);
  });

  it("a zero limit refuses everything", () => {
    expect(wouldExceed(0, 0, 1)).toBe(true);
  });
});

describe("assertWithinLimit and PlanLimitError", () => {
  it("passes under the limit and at exactly the limit after adding", () => {
    expect(() => assertWithinLimit(ent("free"), "contacts", 0)).not.toThrow();
    expect(() => assertWithinLimit(ent("free"), "contacts", 499)).not.toThrow();
  });

  it("throws a PlanLimitError past the limit, with everything a client needs", () => {
    let caught: unknown;
    try {
      assertWithinLimit(ent("free"), "contacts", 500);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(PlanLimitError);
    const err = caught as PlanLimitError;
    expect(err.code).toBe("plan_limit");
    expect(err.kind).toBe("contacts");
    expect(err.limit).toBe(500);
    expect(err.used).toBe(500);
    expect(err.plan).toBe("free");
    expect(err.message).toBe("Your Free plan allows up to 500 contacts. Upgrade your plan to add more.");
    expect(err.toJSON()).toEqual({
      error: err.message,
      code: "plan_limit",
      limit_kind: "contacts",
      limit: 500,
      used: 500,
      plan: "free",
    });
    // Serializes cleanly for an HTTP body.
    expect(JSON.parse(JSON.stringify(err)).limit_kind).toBe("contacts");
  });

  it("checks each kind against its own limit", () => {
    const e = ent("starter");
    expect(() => assertWithinLimit(e, "seats", 3)).toThrow(PlanLimitError);
    expect(() => assertWithinLimit(e, "seats", 2)).not.toThrow();
    expect(() => assertWithinLimit(e, "emails", 25_000)).toThrow(PlanLimitError);
    expect(() => assertWithinLimit(e, "emails", 24_999)).not.toThrow();
    expect(() => assertWithinLimit(e, "contacts", 2_500)).toThrow(PlanLimitError);
  });

  it("a plan with no limit for a kind never throws (Scale has unlimited seats)", () => {
    expect(() => assertWithinLimit(ent("scale"), "seats", 1_000_000)).not.toThrow();
  });

  it("a trial tenant is checked against the trial plan, not free", () => {
    const e = ent("trial", new Date(NOW.getTime() + DAY));
    expect(() => assertWithinLimit(e, "contacts", 5_000)).not.toThrow(); // would fail on Free (500)
    expect(() => assertWithinLimit(e, "contacts", 10_000)).toThrow(PlanLimitError);
  });

  it("words each kind sensibly", () => {
    expect(planLimitMessage("emails", 5000, "Free")).toBe("Your Free plan allows up to 5,000 emails this month. Upgrade your plan to add more.");
    expect(planLimitMessage("seats", 1, "Free")).toBe("Your Free plan allows up to 1 team member. Upgrade your plan to add more.");
    expect(planLimitMessage("seats", 3, "Starter")).toBe("Your Starter plan allows up to 3 team members. Upgrade your plan to add more.");
    expect(planLimitMessage("contacts", 1, "Free")).toBe("Your Free plan allows up to 1 contact. Upgrade your plan to add more.");
    expect(planLimitMessage("emails", 1, "Free")).toBe("Your Free plan allows up to 1 email this month. Upgrade your plan to add more.");
  });
});

describe("usageFraction", () => {
  it("is used over limit, can pass 1, and is null when unlimited", () => {
    expect(usageFraction(500, 0)).toBe(0);
    expect(usageFraction(500, 250)).toBe(0.5);
    expect(usageFraction(500, 500)).toBe(1);
    expect(usageFraction(500, 600)).toBe(1.2);
    expect(usageFraction(null, 123)).toBeNull();
  });

  it("copes with a zero limit", () => {
    expect(usageFraction(0, 0)).toBe(0);
    expect(usageFraction(0, 1)).toBe(Infinity);
  });
});

describe("month boundaries (UTC)", () => {
  it("start of month is the first instant of the month", () => {
    expect(startOfMonthUtc(new Date("2026-10-04T12:00:00Z")).toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(startOfMonthUtc(new Date("2026-10-01T00:00:00Z")).toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(startOfMonthUtc(new Date("2026-10-31T23:59:59.999Z")).toISOString()).toBe("2026-10-01T00:00:00.000Z");
  });

  it("the next month starts exactly when this one ends, including across a year", () => {
    expect(startOfNextMonthUtc(new Date("2026-10-04T12:00:00Z")).toISOString()).toBe("2026-11-01T00:00:00.000Z");
    expect(startOfNextMonthUtc(new Date("2026-12-31T23:59:59Z")).toISOString()).toBe("2027-01-01T00:00:00.000Z");
    expect(startOfNextMonthUtc(new Date("2026-01-31T23:59:59Z")).toISOString()).toBe("2026-02-01T00:00:00.000Z");
  });

  it("is independent of the machine's time zone (uses UTC fields)", () => {
    // 00:30 UTC on 1 Nov is still 31 Oct in the Americas; UTC month must be November.
    expect(startOfMonthUtc(new Date("2026-11-01T00:30:00Z")).toISOString()).toBe("2026-11-01T00:00:00.000Z");
  });
});

describe("poweredByFor", () => {
  const env = { MAILFORGE_SITE_URL: "https://mailforge.example" };

  it("gives the credit only to plans that carry it", () => {
    expect(poweredByFor(ent("free"), env)).toEqual({ name: "Mailforge", url: "https://mailforge.example" });
    for (const p of ["starter", "growth", "scale"]) expect(poweredByFor(ent(p), env), p).toBeUndefined();
  });

  it("gives nothing when enforcement is off, even on Free", () => {
    expect(poweredByFor(ent("free", null, false), env)).toBeUndefined();
  });

  it("prefers MAILFORGE_SITE_URL, falls back to BASE_URL, and adds nothing without either", () => {
    expect(poweredByFor(ent("free"), { MAILFORGE_SITE_URL: "https://a.example", BASE_URL: "https://b.example" })?.url).toBe("https://a.example");
    expect(poweredByFor(ent("free"), { BASE_URL: "https://b.example" })?.url).toBe("https://b.example");
    expect(poweredByFor(ent("free"), {})).toBeUndefined();
    expect(poweredByFor(ent("free"), { BASE_URL: "   " })).toBeUndefined();
  });

  it("refuses a URL that is not http(s)", () => {
    for (const url of ["javascript:alert(1)", "data:text/html,x", "mailforge.example", "ftp://x"]) {
      expect(poweredByFor(ent("free"), { MAILFORGE_SITE_URL: url }), url).toBeUndefined();
    }
  });
});
