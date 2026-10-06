/**
 * Tests for the onboarding wording and step states. Pure functions; no rendering needed.
 */
import { describe, it, expect } from "vitest";
import {
  COMPLETION_CARD_DAYS,
  goalCard,
  sampleMessage,
  hashTarget,
  justCompleted,
  onboardingHeadline,
  onboardingSubline,
  stepStates,
  timeLeftLabel,
  waitingNotice,
  type OnboardingInfo,
  type OnboardingStep,
} from "../src/onboarding.js";

const ids = ["workspace", "address", "sender", "flow", "events", "email"];

function info(doneIds: string[], over: Partial<OnboardingInfo> = {}): OnboardingInfo {
  const steps: OnboardingStep[] = ids.map((id) => ({
    id,
    title: id,
    description: `about ${id}`,
    done: doneIds.includes(id),
    href: `/${id}`,
    cta: "Go",
    minutes: 2,
  }));
  const done = steps.filter((s) => s.done).length;
  return {
    hosted: true,
    steps,
    done,
    total: steps.length,
    percent: Math.round((done / steps.length) * 100),
    complete: done === steps.length,
    next: steps.find((s) => !s.done)?.id ?? null,
    minutes_left: steps.filter((s) => !s.done).length * 2,
    has_ingest_key: false,
    waiting_emails: 0,
    waiting_reason: null,
    goal: null,
    goal_suggestion: null,
    dismissed: false,
    completed_at: null,
    ...over,
  };
}

describe("stepStates", () => {
  it("marks done steps, exactly one next, and the rest as todo", () => {
    const rows = stepStates(info(["workspace", "address"]));
    expect(rows.map((r) => r.state)).toEqual(["done", "done", "next", "todo", "todo", "todo"]);
  });

  it("keeps a later finished step done while an earlier one is still next", () => {
    const rows = stepStates(info(["workspace", "events"]));
    expect(rows.find((r) => r.step.id === "events")!.state).toBe("done");
    expect(rows.find((r) => r.step.id === "address")!.state).toBe("next");
    expect(rows.filter((r) => r.state === "next")).toHaveLength(1);
  });

  it("has no next step when everything is done", () => {
    expect(stepStates(info(ids)).every((r) => r.state === "done")).toBe(true);
  });
});

describe("timeLeftLabel", () => {
  it("pluralises", () => {
    expect(timeLeftLabel(1)).toBe("About 1 minute left");
    expect(timeLeftLabel(17)).toBe("About 17 minutes left");
  });
  it("is null when nothing is left", () => {
    expect(timeLeftLabel(0)).toBeNull();
    expect(timeLeftLabel(-3)).toBeNull();
  });
});

describe("onboardingHeadline", () => {
  it("welcomes a new workspace by name, or without one", () => {
    expect(onboardingHeadline(info(["workspace"]), "Brightpath")).toBe("Welcome, Brightpath");
    expect(onboardingHeadline(info(["workspace"]), null)).toBe("Welcome");
  });
  it("encourages partway, and calls out the last step", () => {
    expect(onboardingHeadline(info(["workspace", "address", "sender"]), "X")).toBe("You are getting there");
    expect(onboardingHeadline(info(ids.slice(0, 5)), "X")).toBe("One step left");
  });
  it("celebrates when complete", () => {
    expect(onboardingHeadline(info(ids), "X")).toBe("You are live");
  });
});

describe("onboardingSubline", () => {
  it("shows progress and time left", () => {
    expect(onboardingSubline(info(["workspace"]))).toBe("1 of 6 done. About 10 minutes left to your first delivered email.");
  });
  it("confirms when complete", () => {
    expect(onboardingSubline(info(ids))).toMatch(/first email has been delivered/);
  });
});

describe("hashTarget", () => {
  it("returns the id for a link that only scrolls this page", () => {
    expect(hashTarget("/home#welcome-flow")).toBe("welcome-flow");
  });
  it("returns null for ordinary links and for hashes on other pages", () => {
    expect(hashTarget("/settings/postal")).toBeNull();
    expect(hashTarget("/flows#top")).toBeNull();
  });
});

describe("justCompleted", () => {
  const now = new Date("2026-10-10T12:00:00Z");
  const ago = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();

  it("is true shortly after finishing", () => {
    expect(justCompleted(info(ids, { completed_at: ago(0.1) }), now)).toBe(true);
    expect(justCompleted(info(ids, { completed_at: ago(COMPLETION_CARD_DAYS - 0.01) }), now)).toBe(true);
  });
  it("is false once the window has passed", () => {
    expect(justCompleted(info(ids, { completed_at: ago(COMPLETION_CARD_DAYS) }), now)).toBe(false);
    expect(justCompleted(info(ids, { completed_at: ago(30) }), now)).toBe(false);
  });
  it("is false when not complete, or with no or bad date, or a date in the future", () => {
    expect(justCompleted(info(ids.slice(0, 4), { completed_at: ago(0.1) }), now)).toBe(false);
    expect(justCompleted(info(ids, { completed_at: null }), now)).toBe(false);
    expect(justCompleted(info(ids, { completed_at: "not a date" }), now)).toBe(false);
    expect(justCompleted(info(ids, { completed_at: ago(-1) }), now)).toBe(false);
  });
});

describe("waitingNotice", () => {
  it("says nothing when nothing is waiting, or nothing is wrong", () => {
    expect(waitingNotice({ waiting_emails: 0, waiting_reason: "no_sender" })).toBeNull();
    expect(waitingNotice({ waiting_emails: 5, waiting_reason: null })).toBeNull();
  });
  it("sends each reason to the page that fixes it", () => {
    expect(waitingNotice({ waiting_emails: 2, waiting_reason: "no_sender" })!.to).toBe("/settings/transport");
    expect(waitingNotice({ waiting_emails: 2, waiting_reason: "needs_domain" })!.to).toBe("/settings/transport");
    expect(waitingNotice({ waiting_emails: 2, waiting_reason: "paused" })!.to).toBe("/settings/transport");
    expect(waitingNotice({ waiting_emails: 2, waiting_reason: "no_address" })!.to).toBe("/settings/postal");
  });
  it("words the count for one, several and many", () => {
    expect(waitingNotice({ waiting_emails: 1, waiting_reason: "no_sender" })!.title).toBe("1 email is waiting to be sent");
    expect(waitingNotice({ waiting_emails: 7, waiting_reason: "no_sender" })!.title).toBe("7 emails are waiting to be sent");
    expect(waitingNotice({ waiting_emails: 100, waiting_reason: "no_sender" })!.title).toBe("100+ emails are waiting to be sent");
  });
  it("explains each reason differently", () => {
    const bodies = (["no_sender", "needs_domain", "paused", "no_address"] as const).map((r) => waitingNotice({ waiting_emails: 3, waiting_reason: r })!.body);
    expect(new Set(bodies).size).toBe(4);
  });
});

describe("goalCard", () => {
  const suggestion = { template_id: "time_limited_trial", name: "Time-Limited Trial", flow_count: 5, applied: false };
  const done = (flow: boolean) => info(flow ? ["workspace", "flow"] : ["workspace"]);

  it("offers the matching flows once the welcome flow is on", () => {
    const c = goalCard({ ...done(true), goal: "convert_trials", goal_suggestion: suggestion })!;
    expect(c.title).toBe("You said you want to turn trial users into paying customers");
    expect(c.body).toContain("Time-Limited Trial");
    expect(c.body).toContain("5 ready-made drafts");
    expect(c.body).toContain("Nothing sends");
    expect(c.button).toBe("Add 5 draft flows");
    expect(c.templateId).toBe("time_limited_trial");
  });
  it("words the free-plan goal differently", () => {
    const c = goalCard({ ...done(true), goal: "upgrade_free", goal_suggestion: { ...suggestion, template_id: "freemium", name: "Freemium" } })!;
    expect(c.title).toBe("You said you want to move free users to a paid plan");
  });
  it("waits until the welcome flow is on", () => {
    expect(goalCard({ ...done(false), goal: "convert_trials", goal_suggestion: suggestion })).toBeNull();
  });
  it("disappears once a template has been applied", () => {
    expect(goalCard({ ...done(true), goal: "convert_trials", goal_suggestion: { ...suggestion, applied: true } })).toBeNull();
  });
  it("is null with no goal, no suggestion, or a goal without a card", () => {
    expect(goalCard({ ...done(true), goal: null, goal_suggestion: suggestion })).toBeNull();
    expect(goalCard({ ...done(true), goal: "convert_trials", goal_suggestion: null })).toBeNull();
    expect(goalCard({ ...done(true), goal: "welcome", goal_suggestion: suggestion })).toBeNull();
  });
});

describe("sampleMessage", () => {
  const base = { sent_to: "ama@acme.test", flow_active: true, sender_ready: true, repeat: false };
  it("tells them to check their inbox when everything is in place", () => {
    const m = sampleMessage(base);
    expect(m.tone).toBe("ok");
    expect(m.text).toContain("ama@acme.test");
    expect(m.text).toContain("first email");
  });
  it("says a repeat may not send again", () => {
    const m = sampleMessage({ ...base, repeat: true });
    expect(m.tone).toBe("ok");
    expect(m.text).toContain("only run once");
  });
  it("warns that no email goes out until a flow is on", () => {
    const m = sampleMessage({ ...base, flow_active: false });
    expect(m.tone).toBe("warn");
    expect(m.text).toContain("no flow is turned on");
  });
  it("warns that the email will wait when nothing can send it", () => {
    const m = sampleMessage({ ...base, sender_ready: false });
    expect(m.tone).toBe("warn");
    expect(m.text).toContain("wait");
  });
  it("puts the missing flow before the missing sender", () => {
    expect(sampleMessage({ ...base, flow_active: false, sender_ready: false }).text).toContain("no flow");
  });
});
