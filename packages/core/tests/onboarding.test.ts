/**
 * Tests for the onboarding rules: which steps exist, when each is done,
 * which comes next, and when the panel steps aside.
 */
import { describe, it, expect } from "vitest";
import {
  ONBOARDING_STEP_IDS,
  computeOnboarding,
  nudgeDue,
  waitingReason,
  ONBOARDING_GOALS,
  GOAL_INFO,
  parseGoal,
  BUSINESS_MODEL_IDS,
  MAX_NUDGES,
  parseOnboardingPatch,
  showOnboardingPanel,
  type OnboardingFacts,
} from "../src/index.js";

const NOTHING: OnboardingFacts = {
  hasPostalAddress: false,
  hasSender: false,
  hasActiveFlow: false,
  hasEvents: false,
  hasSentEmail: false,
};
const EVERYTHING: OnboardingFacts = {
  hasPostalAddress: true,
  hasSender: true,
  hasActiveFlow: true,
  hasEvents: true,
  hasSentEmail: true,
};

function doneIds(f: OnboardingFacts): string[] {
  return computeOnboarding(f)
    .steps.filter((s) => s.done)
    .map((s) => s.id);
}

describe("computeOnboarding", () => {
  it("lists every step once, in order", () => {
    expect(computeOnboarding(NOTHING).steps.map((s) => s.id)).toEqual([...ONBOARDING_STEP_IDS]);
  });

  it("starts a brand-new workspace with only the workspace step done", () => {
    const p = computeOnboarding(NOTHING);
    expect(doneIds(NOTHING)).toEqual(["workspace"]);
    expect(p.done).toBe(1);
    expect(p.total).toBe(6);
    expect(p.percent).toBe(17);
    expect(p.complete).toBe(false);
    expect(p.next).toBe("address");
  });

  it("maps each fact to exactly its own step", () => {
    expect(doneIds({ ...NOTHING, hasPostalAddress: true })).toEqual(["workspace", "address"]);
    expect(doneIds({ ...NOTHING, hasSender: true })).toEqual(["workspace", "sender"]);
    expect(doneIds({ ...NOTHING, hasActiveFlow: true })).toEqual(["workspace", "flow"]);
    expect(doneIds({ ...NOTHING, hasEvents: true })).toEqual(["workspace", "events"]);
    expect(doneIds({ ...NOTHING, hasSentEmail: true })).toEqual(["workspace", "email"]);
  });

  it("points next at the first step still open, even when a later one is done", () => {
    const p = computeOnboarding({ ...NOTHING, hasPostalAddress: true, hasEvents: true });
    expect(p.next).toBe("sender");
    expect(p.done).toBe(3);
  });

  it("is complete with no next step when everything is done", () => {
    const p = computeOnboarding(EVERYTHING);
    expect(p.complete).toBe(true);
    expect(p.next).toBeNull();
    expect(p.percent).toBe(100);
    expect(p.minutesLeft).toBe(0);
  });

  it("counts minutes left only over steps not done", () => {
    const all = computeOnboarding(NOTHING).minutesLeft;
    const withAddress = computeOnboarding({ ...NOTHING, hasPostalAddress: true }).minutesLeft;
    expect(all).toBeGreaterThan(0);
    expect(withAddress).toBe(all - 1);
  });

  it("gives every step a title, a reason and a place to go", () => {
    for (const s of computeOnboarding(NOTHING).steps) {
      expect(s.title.length).toBeGreaterThan(0);
      expect(s.description.length).toBeGreaterThan(10);
      expect(s.href.startsWith("/")).toBe(true);
      expect(s.cta.length).toBeGreaterThan(0);
    }
  });

  it("sends the sender step to the page where sending is set up", () => {
    const sender = computeOnboarding(NOTHING).steps.find((s) => s.id === "sender")!;
    expect(sender.href).toBe("/settings/transport");
  });
});

describe("showOnboardingPanel", () => {
  it("shows while unfinished and not dismissed", () => {
    expect(showOnboardingPanel(computeOnboarding(NOTHING), {})).toBe(true);
  });
  it("steps aside once dismissed", () => {
    expect(showOnboardingPanel(computeOnboarding(NOTHING), { dismissed_at: "2026-10-05T00:00:00Z" })).toBe(false);
  });
  it("steps aside once complete, dismissed or not", () => {
    expect(showOnboardingPanel(computeOnboarding(EVERYTHING), {})).toBe(false);
  });
});

describe("parseOnboardingPatch", () => {
  it("accepts a boolean dismissed", () => {
    expect(parseOnboardingPatch({ dismissed: true })).toEqual({ dismissed: true });
    expect(parseOnboardingPatch({ dismissed: false })).toEqual({ dismissed: false });
  });
  it("refuses anything else", () => {
    for (const bad of [null, undefined, [], "x", 1, {}, { dismissed: "yes" }, { dismissed: 1 }]) {
      expect(parseOnboardingPatch(bad)).toBeNull();
    }
  });
  it("ignores unknown fields", () => {
    expect(parseOnboardingPatch({ dismissed: true, completed_at: "x" })).toEqual({ dismissed: true });
  });
});

describe("nudgeDue", () => {
  const H = 3_600_000;
  const welcome = new Date("2026-10-01T00:00:00Z");
  const at = (h: number) => new Date(welcome.getTime() + h * H);
  const w = welcome.toISOString();

  it("is not due before 24 hours, and is due at 24", () => {
    expect(nudgeDue({ welcome_sent_at: w }, at(23.9))).toBe(false);
    expect(nudgeDue({ welcome_sent_at: w }, at(24))).toBe(true);
  });
  it("is never due without a welcome date, or with a bad one", () => {
    expect(nudgeDue({}, at(500))).toBe(false);
    expect(nudgeDue({ welcome_sent_at: "nope" }, at(500))).toBe(false);
  });
  it("waits until 72 hours after the welcome for the second nudge", () => {
    const first = { welcome_sent_at: w, nudge_count: 1, last_nudge_at: at(25).toISOString() };
    expect(nudgeDue(first, at(71.9))).toBe(false);
    expect(nudgeDue(first, at(72))).toBe(true);
  });
  it("keeps 24 hours between nudges even when the 72-hour mark has passed", () => {
    const late = { welcome_sent_at: w, nudge_count: 1, last_nudge_at: at(80).toISOString() };
    expect(nudgeDue(late, at(90))).toBe(false);
    expect(nudgeDue(late, at(104))).toBe(true);
  });
  it("never sends more than the maximum", () => {
    expect(nudgeDue({ welcome_sent_at: w, nudge_count: MAX_NUDGES, last_nudge_at: at(80).toISOString() }, at(9999))).toBe(false);
  });
});

describe("waitingReason", () => {
  const ok = { hasOwnTransport: false, managedEnabled: true, managedUsable: true, managedPaused: false, hasPostalAddress: true };

  it("is null when mail can go out", () => {
    expect(waitingReason(ok)).toBeNull();
    expect(waitingReason({ ...ok, managedEnabled: false, hasOwnTransport: true })).toBeNull();
  });
  it("says there is no sender when nothing is set up", () => {
    expect(waitingReason({ ...ok, managedEnabled: false, managedUsable: false })).toBe("no_sender");
  });
  it("says a domain is needed when managed sending has nowhere to send from", () => {
    expect(waitingReason({ ...ok, managedUsable: false })).toBe("needs_domain");
  });
  it("says paused when managed sending is paused", () => {
    expect(waitingReason({ ...ok, managedPaused: true })).toBe("paused");
  });
  it("says the address is missing when the sender is fine but there is no address", () => {
    expect(waitingReason({ ...ok, hasPostalAddress: false })).toBe("no_address");
    expect(waitingReason({ ...ok, hasOwnTransport: true, managedEnabled: false, hasPostalAddress: false })).toBe("no_address");
  });
  it("reports the sender problem before the address problem", () => {
    expect(waitingReason({ ...ok, managedEnabled: false, hasPostalAddress: false })).toBe("no_sender");
    expect(waitingReason({ ...ok, managedPaused: true, hasPostalAddress: false })).toBe("paused");
  });
  it("ignores managed sending state when the workspace has its own transport", () => {
    expect(waitingReason({ ...ok, hasOwnTransport: true, managedPaused: true, managedUsable: false })).toBeNull();
  });
});

describe("signup goals", () => {
  it("has info for every goal, with distinct labels", () => {
    expect(new Set(ONBOARDING_GOALS.map((g) => GOAL_INFO[g].label)).size).toBe(ONBOARDING_GOALS.length);
    for (const g of ONBOARDING_GOALS) {
      expect(GOAL_INFO[g].label.length).toBeGreaterThan(5);
      expect(GOAL_INFO[g].hint.length).toBeGreaterThan(5);
    }
  });
  it("points only at business-model templates that exist", () => {
    for (const g of ONBOARDING_GOALS) {
      const t = GOAL_INFO[g].template;
      if (t !== null) expect((BUSINESS_MODEL_IDS as readonly string[]).includes(t)).toBe(true);
    }
  });
  it("maps the trial goal to the trial template and the free-plan goal to freemium", () => {
    expect(GOAL_INFO.convert_trials.template).toBe("time_limited_trial");
    expect(GOAL_INFO.upgrade_free.template).toBe("freemium");
    expect(GOAL_INFO.welcome.template).toBeNull();
    expect(GOAL_INFO.explore.template).toBeNull();
  });
  it("parses only known goals", () => {
    for (const g of ONBOARDING_GOALS) expect(parseGoal(g)).toBe(g);
    for (const bad of [undefined, null, "", "WELCOME", "welcome ", "drop table", 1, {}, []]) expect(parseGoal(bad)).toBeNull();
  });
});
