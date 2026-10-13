/**
 * Tests for the plan banner rules: what the customer is told, in what order,
 * what they can dismiss, and what the banner's button does. Pure functions;
 * no rendering needed.
 */
import { describe, it, expect } from "vitest";
import { barFraction, planNeedsAttention, planNotice } from "../src/plan.js";
import type { AddonCatalogEntry, BillingSubscription, PlanCatalogEntry, PlanInfo, PlanMeter, PlanMeterState } from "../src/api.js";

function meter(used: number, limit: number | null, state: PlanMeterState): PlanMeter {
  return { used, limit, state };
}

const CATALOG: PlanCatalogEntry[] = [
  {
    id: "essential",
    name: "Essential",
    tagline: "",
    price_monthly_usd: 100,
    price_annual_usd: 1000,
    charge_monthly: null,
    charge_annual: null,
    limits: { contacts: 6000, emails_per_month: 1_000_000, seats: null, ai_tokens_per_month: 8_000_000 },
    features: [],
    recommended: true,
    current: true,
  },
];

const ADDONS: AddonCatalogEntry[] = [
  { kind: "profiles", label: "Extra customer profiles", rate: "$0.009 per profile", pack_units: 1000, pack_price_usd: 9, pack_charge: null },
  { kind: "emails", label: "Additional emails", rate: "$0.12 per 1,000 emails", pack_units: 100000, pack_price_usd: 12, pack_charge: null },
  { kind: "ai", label: "Extra AI credits", rate: "$10 per 100,000 credits", pack_units: 100000, pack_price_usd: 10, pack_charge: null },
];

/** A healthy Essential workspace by default; override what the test cares about. */
function plan(over: {
  enforced?: boolean;
  noPlan?: boolean;
  stored?: string;
  trial?: Partial<PlanInfo["trial"]>;
  payment?: Partial<PlanInfo["payment"]>;
  subscription?: BillingSubscription | null;
  billingEnabled?: boolean;
  contacts?: PlanMeter;
  emails?: PlanMeter;
  seats?: PlanMeter;
  ai?: PlanMeter;
  aiSource?: "platform" | "byok";
} = {}): PlanInfo {
  return {
    enforced: over.enforced ?? true,
    billing: { enabled: over.billingEnabled ?? true, currency: "USD", usd_rate: 1, subscription: over.subscription ?? null },
    payment: { status: "none", paid_through: null, grace_ends_at: null, ...over.payment },
    plan: over.noPlan ? { id: "free", name: "No plan", tagline: "" } : { id: "essential", name: "Essential", tagline: "" },
    stored_plan: over.stored ?? "essential",
    shows_powered_by: false,
    support_email: "support@example.com",
    trial: { active: false, expired: false, ends_at: null, days_left: 0, ...over.trial },
    meters: {
      contacts: over.contacts ?? meter(10, 6000, "ok"),
      emails: { ...(over.emails ?? meter(10, 1_000_000, "ok")), resets_at: "2026-11-01T00:00:00.000Z" },
      seats: { ...(over.seats ?? meter(1, null, "unlimited")), members: 1, pending_invites: 0 },
      ai: { ...(over.ai ?? meter(10, 8_000_000, "ok")), source: over.aiSource ?? "platform", resets_at: "2026-11-01T00:00:00.000Z" },
    },
    addons: ADDONS,
    plans: CATALOG,
  } as PlanInfo;
}

describe("planNotice: nothing to say", () => {
  it("is null when plans are not enforced, whatever the numbers say", () => {
    expect(planNotice(plan({ enforced: false, contacts: meter(9999, 6000, "over") }))).toBeNull();
  });

  it("is null while data is loading", () => {
    expect(planNotice(undefined)).toBeNull();
  });

  it("is null for a healthy workspace", () => {
    expect(planNotice(plan())).toBeNull();
  });
});

describe("planNotice: no plan (trial ended or subscription lapsed)", () => {
  it("says what happened, that data is safe, and offers to subscribe; it cannot be dismissed", () => {
    const n = planNotice(plan({ noPlan: true, stored: "trial", trial: { expired: true } }))!;
    expect(n.id).toBe("no-plan");
    expect(n.tone).toBe("danger");
    expect(n.dismissible).toBe(false);
    expect(n.message).toContain("free trial has ended");
    expect(n.message).toContain("Your data is safe");
    expect(n.action).toEqual({ kind: "subscribe" });
  });

  it("never reads as a limit of zero", () => {
    const n = planNotice(plan({ noPlan: true, contacts: meter(60, 0, "over") }))!;
    expect(n.id).toBe("no-plan");
    expect(n.message).not.toMatch(/limit of 0|No plan plan/);
  });
});

describe("planNotice: limits reached", () => {
  it("a full profiles meter is a danger notice with a one-click pack of extra profiles", () => {
    const n = planNotice(plan({ contacts: meter(6000, 6000, "at_limit") }))!;
    expect(n.tone).toBe("danger");
    expect(n.dismissible).toBe(false);
    expect(n.id).toBe("limit-contacts");
    expect(n.message).toContain("all 6,000 customer profiles");
    expect(n.message).toContain("People you already have keep working");
    expect(n.message).not.toMatch(/upgrade/i);
    expect(n.action).toEqual({ kind: "addon", addon: "profiles", label: "Add 1,000 for $9" });
  });

  it("over the limit reads the same as at it", () => {
    const n = planNotice(plan({ contacts: meter(6200, 6000, "over") }))!;
    expect(n.id).toBe("limit-contacts");
    expect(n.tone).toBe("danger");
  });

  it("emails say sending waits, and offer a pack of emails", () => {
    const n = planNotice(plan({ emails: meter(1_000_000, 1_000_000, "at_limit") }))!;
    expect(n.id).toBe("limit-emails");
    expect(n.message).toContain("1,000,000 emails a month");
    expect(n.message).toContain("Queued emails go out");
    expect(n.action).toEqual({ kind: "addon", addon: "emails", label: "Add 100,000 for $12" });
  });

  it("AI credits are a limit too, and offer a pack of credits", () => {
    const n = planNotice(plan({ ai: meter(8_000_000, 8_000_000, "at_limit") }))!;
    expect(n.id).toBe("limit-ai");
    expect(n.action).toEqual({ kind: "addon", addon: "ai", label: "Add 100,000 for $10" });
  });

  it("a workspace on its own AI key is never nagged about AI credits", () => {
    expect(planNotice(plan({ ai: meter(8_000_000, 8_000_000, "at_limit"), aiSource: "byok" }))).toBeNull();
  });

  it("without online billing the button falls back to the plan page", () => {
    const n = planNotice(plan({ billingEnabled: false, contacts: meter(6000, 6000, "at_limit") }))!;
    expect(n.action).toEqual({ kind: "plans" });
  });

  it("when several are reached, the worst (over) wins over merely at the limit", () => {
    const n = planNotice(plan({ contacts: meter(6000, 6000, "at_limit"), emails: meter(1_100_000, 1_000_000, "over") }))!;
    expect(n.id).toBe("limit-emails");
  });
});

describe("planNotice: nearing a limit", () => {
  it("is a dismissible note with the real numbers, what is left, and a one-click pack", () => {
    const n = planNotice(plan({ contacts: meter(5000, 6000, "near") }))!;
    expect(n.id).toBe("near-contacts");
    expect(n.tone).toBe("info");
    expect(n.dismissible).toBe(true);
    expect(n.message).toBe("You have used 5,000 of 6,000 customer profiles (1,000 left).");
    expect(n.action).toEqual({ kind: "addon", addon: "profiles", label: "Add 1,000 for $9" });
  });

  it("formats big numbers with separators", () => {
    const n = planNotice(plan({ emails: meter(850_000, 1_000_000, "near") }))!;
    expect(n.message).toContain("850,000 of 1,000,000 monthly emails (150,000 left)");
  });

  it("is outranked by a limit that is reached", () => {
    const n = planNotice(plan({ contacts: meter(5000, 6000, "near"), emails: meter(1_000_000, 1_000_000, "at_limit") }))!;
    expect(n.id).toBe("limit-emails");
  });
});

describe("planNotice: trials", () => {
  it("3 days or fewer left warns, cannot be dismissed and offers to subscribe", () => {
    for (const d of [3, 2, 1]) {
      const n = planNotice(plan({ trial: { active: true, days_left: d } }))!;
      expect(n.id, String(d)).toBe("trial-ending");
      expect(n.tone).toBe("warning");
      expect(n.dismissible).toBe(false);
      expect(n.action).toEqual({ kind: "subscribe" });
    }
  });

  it("uses singular and plural correctly", () => {
    const one = planNotice(plan({ trial: { active: true, days_left: 1 } }))!;
    const two = planNotice(plan({ trial: { active: true, days_left: 2 } }))!;
    expect(one.message).toContain("ends in 1 day.");
    expect(two.message).toContain("ends in 2 days.");
  });

  it("4 or more days left is a quiet, dismissible note", () => {
    const n = planNotice(plan({ trial: { active: true, days_left: 6 } }))!;
    expect(n.id).toBe("trial-active");
    expect(n.tone).toBe("info");
    expect(n.dismissible).toBe(true);
    expect(n.message).toContain("free Essential trial, 6 days left");
  });

  it("the boundary between ending-soon and quiet is between 3 and 4 days", () => {
    const at = (d: number) => planNotice(plan({ trial: { active: true, days_left: d } }))!.id;
    expect(at(3)).toBe("trial-ending");
    expect(at(4)).toBe("trial-active");
  });

  it("nearing a limit outranks the quiet trial note, but not an ending trial", () => {
    const quiet = planNotice(plan({ trial: { active: true, days_left: 6 }, contacts: meter(5000, 6000, "near") }))!;
    expect(quiet.id).toBe("near-contacts");
    const ending = planNotice(plan({ trial: { active: true, days_left: 2 }, contacts: meter(5000, 6000, "near") }))!;
    expect(ending.id).toBe("trial-ending");
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
  it("is off for a healthy workspace", () => {
    expect(planNeedsAttention(plan())).toBe(false);
  });

  it("is off when plans are not enforced or still loading", () => {
    expect(planNeedsAttention(plan({ enforced: false, contacts: meter(9999, 6000, "over") }))).toBe(false);
    expect(planNeedsAttention(undefined)).toBe(false);
  });

  it("is on for a reached limit or an ended trial", () => {
    expect(planNeedsAttention(plan({ contacts: meter(6000, 6000, "at_limit") }))).toBe(true);
    expect(planNeedsAttention(plan({ emails: meter(1_000_001, 1_000_000, "over") }))).toBe(true);
    expect(planNeedsAttention(plan({ noPlan: true, trial: { expired: true } }))).toBe(true);
  });

  it("is off when merely near a limit, or in a trial that is not over", () => {
    expect(planNeedsAttention(plan({ contacts: meter(5000, 6000, "near") }))).toBe(false);
    expect(planNeedsAttention(plan({ trial: { active: true, days_left: 2 } }))).toBe(false);
  });

  it("agrees with the banner: whenever a limit banner shows, the dot is on", () => {
    for (const p of [
      plan({ contacts: meter(6000, 6000, "at_limit") }),
      plan({ emails: meter(1_100_000, 1_000_000, "over") }),
      plan({ ai: meter(8_000_000, 8_000_000, "at_limit") }),
    ]) {
      expect(planNotice(p)?.id.startsWith("limit-")).toBe(true);
      expect(planNeedsAttention(p)).toBe(true);
    }
  });
});
