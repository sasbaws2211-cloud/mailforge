/**
 * Tests for the plan banner rules: what the customer is told, in what order,
 * and what they can dismiss. Pure functions; no rendering needed.
 */
import { describe, it, expect } from "vitest";
import { barFraction, planNeedsAttention, planNotice } from "../src/plan.js";
import type { BillingSubscription, PlanCatalogEntry, PlanInfo, PlanMeter, PlanMeterState } from "../src/api.js";

function meter(used: number, limit: number | null, state: PlanMeterState): PlanMeter {
  return { used, limit, state };
}

/** Just enough of the plan catalogue for names to resolve. */
const CATALOG: PlanCatalogEntry[] = ["free", "starter", "growth", "scale"].map((id) => ({
  id,
  name: id[0]!.toUpperCase() + id.slice(1),
  tagline: "",
  price_monthly_usd: 0,
  price_annual_usd: 0,
  limits: { contacts: null, emails_per_month: null, seats: null },
  features: [],
  recommended: false,
  current: false,
}));

/** A healthy Free workspace by default; override what the test cares about. */
function plan(over: {
  enforced?: boolean;
  planName?: string;
  stored?: string;
  trial?: Partial<PlanInfo["trial"]>;
  payment?: Partial<PlanInfo["payment"]>;
  subscription?: BillingSubscription | null;
  billingEnabled?: boolean;
  contacts?: PlanMeter;
  emails?: PlanMeter;
  seats?: PlanMeter;
} = {}): PlanInfo {
  return {
    enforced: over.enforced ?? true,
    billing: { enabled: over.billingEnabled ?? true, currency: "USD", subscription: over.subscription ?? null },
    payment: { status: "none", paid_through: null, grace_ends_at: null, ...over.payment },
    plan: { id: "free", name: over.planName ?? "Free", tagline: "" },
    stored_plan: over.stored ?? "free",
    shows_powered_by: true,
    support_email: "support@example.com",
    trial: { active: false, expired: false, ends_at: null, days_left: 0, ...over.trial },
    meters: {
      contacts: over.contacts ?? meter(10, 500, "ok"),
      emails: { ...(over.emails ?? meter(10, 5000, "ok")), resets_at: "2026-11-01T00:00:00.000Z" },
      seats: { ...(over.seats ?? meter(1, 1, "at_limit")), members: 1, pending_invites: 0 },
    },
    plans: CATALOG,
  };
}

// A Free workspace has exactly one seat, which the owner fills. That is "at limit"
// but expected, so most tests give it room to keep the noise out.
const roomySeats = meter(1, 10, "ok");

describe("planNotice: nothing to say", () => {
  it("is null when plans are not enforced, whatever the numbers say", () => {
    expect(planNotice(plan({ enforced: false, contacts: meter(999, 500, "over") }))).toBeNull();
  });

  it("is null while data is loading", () => {
    expect(planNotice(undefined)).toBeNull();
  });

  it("is null for a healthy Free workspace, whose single seat is always full", () => {
    // The default fixture is exactly that: 1 of 1 seats at limit. That is normal, not a problem.
    expect(planNotice(plan())).toBeNull();
  });

  it("a full seat meter alone says nothing on any plan", () => {
    expect(planNotice(plan({ planName: "Starter", seats: meter(3, 3, "at_limit") }))).toBeNull();
  });
});

describe("planNotice: limits reached", () => {
  it("a full contacts meter is a danger notice that cannot be dismissed", () => {
    const n = planNotice(plan({ contacts: meter(500, 500, "at_limit"), seats: roomySeats }))!;
    expect(n.tone).toBe("danger");
    expect(n.dismissible).toBe(false);
    expect(n.id).toBe("limit-contacts");
    expect(n.message).toContain("Free plan limit of 500 contacts");
    expect(n.message).toContain("People you already have keep working");
  });

  it("over the limit reads the same as at it", () => {
    const n = planNotice(plan({ contacts: meter(620, 500, "over"), seats: roomySeats }))!;
    expect(n.tone).toBe("danger");
    expect(n.id).toBe("limit-contacts");
  });

  it("emails say sending waits and nothing is lost", () => {
    const n = planNotice(plan({ emails: meter(5000, 5000, "at_limit"), seats: roomySeats }))!;
    expect(n.id).toBe("limit-emails");
    expect(n.message).toContain("5,000 emails a month");
    expect(n.message).toContain("Queued emails will go out");
  });

  it("seats only speak up when exceeded, and then say you cannot invite more", () => {
    const n = planNotice(plan({ seats: meter(4, 3, "over"), planName: "Starter" }))!;
    expect(n.id).toBe("limit-seats");
    expect(n.message).toContain("Starter plan limit of 3 team members");
    expect(n.message).toContain("cannot invite more people");
  });

  it("says team member, not team members, when the limit is one", () => {
    const n = planNotice(plan({ seats: meter(2, 1, "over") }))!;
    expect(n.message).toContain("Free plan limit of 1 team member.");
    expect(n.message).not.toContain("1 team members");
  });

  it("when several are reached, the worst (over) wins over merely at the limit", () => {
    const n = planNotice(plan({ contacts: meter(500, 500, "at_limit"), emails: meter(6000, 5000, "over"), seats: roomySeats }))!;
    expect(n.id).toBe("limit-emails");
  });

  it("a limit outranks an ended trial and a trial about to end", () => {
    const n = planNotice(
      plan({ trial: { expired: true }, contacts: meter(500, 500, "at_limit"), seats: roomySeats }),
    )!;
    expect(n.id).toBe("limit-contacts");
  });
});

describe("planNotice: trials", () => {
  it("an ended trial warns, reassures about data, and cannot be dismissed", () => {
    const n = planNotice(plan({ trial: { expired: true }, seats: roomySeats }))!;
    expect(n.id).toBe("trial-expired");
    expect(n.tone).toBe("warning");
    expect(n.dismissible).toBe(false);
    expect(n.message).toContain("trial has ended");
    expect(n.message).toContain("Your data is safe");
  });

  it("3 days or fewer left warns and cannot be dismissed", () => {
    for (const d of [3, 2, 1]) {
      const n = planNotice(plan({ planName: "Growth", trial: { active: true, days_left: d }, seats: roomySeats }))!;
      expect(n.id, String(d)).toBe("trial-ending");
      expect(n.tone).toBe("warning");
      expect(n.dismissible).toBe(false);
    }
  });

  it("uses singular and plural correctly", () => {
    const one = planNotice(plan({ planName: "Growth", trial: { active: true, days_left: 1 }, seats: roomySeats }))!;
    const two = planNotice(plan({ planName: "Growth", trial: { active: true, days_left: 2 }, seats: roomySeats }))!;
    expect(one.message).toContain("ends in 1 day.");
    expect(two.message).toContain("ends in 2 days.");
  });

  it("4 or more days left is a quiet, dismissible note", () => {
    const n = planNotice(plan({ planName: "Growth", trial: { active: true, days_left: 9 }, seats: roomySeats }))!;
    expect(n.id).toBe("trial-active");
    expect(n.tone).toBe("info");
    expect(n.dismissible).toBe(true);
    expect(n.message).toContain("free Growth trial, 9 days left");
  });

  it("the boundary between ending-soon and quiet is between 3 and 4 days", () => {
    const at = (d: number) => planNotice(plan({ planName: "Growth", trial: { active: true, days_left: d }, seats: roomySeats }))!.id;
    expect(at(3)).toBe("trial-ending");
    expect(at(4)).toBe("trial-active");
  });
});

describe("planNotice: nearing a limit", () => {
  it("a near-limit meter is a dismissible info note with the real numbers", () => {
    const n = planNotice(plan({ contacts: meter(420, 500, "near"), seats: roomySeats }))!;
    expect(n.id).toBe("near-contacts");
    expect(n.tone).toBe("info");
    expect(n.dismissible).toBe(true);
    expect(n.message).toBe("You have used 420 of 500 contacts on the Free plan.");
  });

  it("outranks the quiet trial note, but not an ending trial", () => {
    const quiet = planNotice(plan({ planName: "Growth", trial: { active: true, days_left: 9 }, contacts: meter(8500, 10000, "near"), seats: roomySeats }))!;
    expect(quiet.id).toBe("near-contacts");
    const ending = planNotice(plan({ planName: "Growth", trial: { active: true, days_left: 2 }, contacts: meter(8500, 10000, "near"), seats: roomySeats }))!;
    expect(ending.id).toBe("trial-ending");
  });

  it("formats big numbers with separators", () => {
    const n = planNotice(plan({ planName: "Growth", emails: meter(85000, 100000, "near"), seats: roomySeats }))!;
    expect(n.message).toContain("85,000 of 100,000 monthly emails");
  });
});

describe("barFraction", () => {
  it("is used over limit, capped to 1 for drawing", () => {
    expect(barFraction(0, 500)).toBe(0);
    expect(barFraction(250, 500)).toBe(0.5);
    expect(barFraction(500, 500)).toBe(1);
    expect(barFraction(900, 500)).toBe(1);
  });

  it("draws nothing for unlimited, zero limits and negative usage", () => {
    expect(barFraction(123, null)).toBe(0);
    expect(barFraction(5, 0)).toBe(0);
    expect(barFraction(-3, 500)).toBe(0);
  });
});

describe("planNeedsAttention (the settings nav dot)", () => {
  it("is off for a healthy Free workspace, even though its one seat is full", () => {
    expect(planNeedsAttention(plan())).toBe(false);
  });

  it("is off when plans are not enforced or still loading", () => {
    expect(planNeedsAttention(plan({ enforced: false, contacts: meter(999, 500, "over") }))).toBe(false);
    expect(planNeedsAttention(undefined)).toBe(false);
  });

  it("is on for a reached contact or email limit, an exceeded seat limit, or an ended trial", () => {
    expect(planNeedsAttention(plan({ contacts: meter(500, 500, "at_limit") }))).toBe(true);
    expect(planNeedsAttention(plan({ emails: meter(5001, 5000, "over") }))).toBe(true);
    expect(planNeedsAttention(plan({ seats: meter(4, 3, "over") }))).toBe(true);
    expect(planNeedsAttention(plan({ trial: { expired: true } }))).toBe(true);
  });

  it("is off when merely near a limit, or in a trial that is not over", () => {
    expect(planNeedsAttention(plan({ contacts: meter(450, 500, "near") }))).toBe(false);
    expect(planNeedsAttention(plan({ trial: { active: true, days_left: 2 } }))).toBe(false);
  });

  it("agrees with the banner: whenever a limit banner shows, the dot is on", () => {
    for (const p of [
      plan({ contacts: meter(500, 500, "at_limit") }),
      plan({ emails: meter(6000, 5000, "over") }),
      plan({ seats: meter(4, 3, "over") }),
    ]) {
      expect(planNotice(p)?.id.startsWith("limit-")).toBe(true);
      expect(planNeedsAttention(p)).toBe(true);
    }
  });
});
