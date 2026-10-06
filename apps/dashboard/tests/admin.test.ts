/**
 * Tests for how the admin console describes a workspace and an audit entry:
 * which badge wins, plain-language audit sentences, money and relative dates.
 * Pure functions.
 */
import { describe, it, expect } from "vitest";
import { adminLoginNotice } from "../src/admin-auth.js";
import { adminTabFor, ago, auditReason, auditSummary, auditWorkspaceName, dropSentence, formatHours, goalsSentence, formatUsd, planLabel, workspaceBadge } from "../src/admin.js";
import type { AdminAuditEntry, AdminWorkspace } from "../src/admin-api.js";

const DAY = 86_400_000;
const NOW = new Date("2026-10-04T12:00:00Z");

function ws(over: Partial<AdminWorkspace> = {}): AdminWorkspace {
  return {
    id: "w1",
    name: "Acme",
    slug: "acme",
    owner_email: "o@acme.test",
    created_at: "2026-09-01T00:00:00Z",
    stored_plan: "growth",
    effective_plan: { id: "growth", name: "Growth" },
    on_trial: false,
    trial_ends_at: null,
    payment_status: "current",
    paid_through: null,
    suspended: false,
    suspended_at: null,
    suspended_reason: null,
    deletion_scheduled_at: null,
    deletion_requested_by: null,
    ai_allowance_override: null,
    contacts: 0,
    emails_this_month: 0,
    members: 1,
    subscription: null,
    ...over,
  };
}

describe("workspaceBadge: the single most important thing about a workspace", () => {
  it("a healthy paid workspace shows its plan in green", () => {
    expect(workspaceBadge(ws(), NOW)).toEqual({ label: "Growth", variant: "success" });
  });

  it("free is neutral", () => {
    expect(workspaceBadge(ws({ stored_plan: "free", effective_plan: { id: "free", name: "Free" }, payment_status: "none" }), NOW)).toEqual({ label: "Free", variant: "neutral" });
  });

  it("a running trial counts days, singular and plural, never zero", () => {
    const t = (ms: number) => workspaceBadge(ws({ stored_plan: "trial", on_trial: true, trial_ends_at: new Date(NOW.getTime() + ms).toISOString(), payment_status: "none" }), NOW);
    expect(t(5 * DAY).label).toBe("Trial, 5 days left");
    expect(t(DAY).label).toBe("Trial, 1 day left");
    expect(t(3 * 3_600_000).label).toBe("Trial, 1 day left");
    expect(t(DAY).variant).toBe("accent");
  });

  it("an ended trial is muted", () => {
    expect(workspaceBadge(ws({ stored_plan: "trial", on_trial: false, effective_plan: { id: "free", name: "Free" }, payment_status: "none" }), NOW)).toEqual({ label: "Trial ended", variant: "muted" });
  });

  it("overdue is a warning and lapsed is danger, both naming the plan on record", () => {
    expect(workspaceBadge(ws({ payment_status: "overdue" }), NOW)).toEqual({ label: "Growth overdue", variant: "warning" });
    expect(workspaceBadge(ws({ payment_status: "lapsed", effective_plan: { id: "free", name: "Free" } }), NOW)).toEqual({ label: "Growth lapsed", variant: "danger" });
  });

  it("suspended outranks everything", () => {
    expect(workspaceBadge(ws({ suspended: true, payment_status: "lapsed" }), NOW)).toEqual({ label: "Suspended", variant: "danger" });
  });
});

describe("auditSummary and auditReason", () => {
  const entry = (action: string, detail: Record<string, unknown> | null): AdminAuditEntry => ({ actor: "a@x.test", action, detail, at: NOW.toISOString() });

  it("describes each kind of change in plain words", () => {
    expect(auditSummary(entry("set_plan", { before: { plan: "trial" }, after: { plan: "scale" } }))).toBe("Set plan to Scale (was Trial)");
    expect(auditSummary(entry("set_plan", { before: { plan: null }, after: { plan: "starter" } }))).toBe("Set plan to Starter (was Free)");
    expect(auditSummary(entry("extend_trial", {}))).toBe("Started a trial");
    expect(auditSummary(entry("suspend", {}))).toBe("Suspended the workspace");
    expect(auditSummary(entry("unsuspend", {}))).toBe("Reinstated the workspace");
    expect(auditSummary(entry("cancel_subscription", { plan: "growth" }))).toBe("Cancelled the Growth subscription");
  });

  it("copes with missing detail and unknown actions", () => {
    expect(auditSummary(entry("set_plan", null))).toBe("Set plan to Free (was Free)");
    expect(auditSummary(entry("brand_new_thing", null))).toBe("brand new thing");
  });

  it("reads the reason only when it is a string", () => {
    expect(auditReason(entry("suspend", { reason: "Spam" }))).toBe("Spam");
    expect(auditReason(entry("suspend", { reason: 5 }))).toBe("");
    expect(auditReason(entry("suspend", null))).toBe("");
  });
});

describe("formatting", () => {
  it("formatUsd shows whole dollars when exact and cents otherwise", () => {
    expect(formatUsd(0)).toBe("$0");
    expect(formatUsd(1234)).toBe("$1,234");
    expect(formatUsd(15.83)).toBe("$15.83");
  });

  it("ago says today, yesterday, days, then a date; null is a dash", () => {
    expect(ago(null, NOW)).toBe("—");
    expect(ago(new Date(NOW.getTime() - 3_600_000).toISOString(), NOW)).toBe("today");
    expect(ago(new Date(NOW.getTime() - DAY).toISOString(), NOW)).toBe("yesterday");
    expect(ago(new Date(NOW.getTime() - 9 * DAY).toISOString(), NOW)).toBe("9 days ago");
    expect(ago("2026-01-15T00:00:00Z", NOW)).toBe("Jan 15, 2026");
  });

  it("planLabel capitalises and defaults to Free", () => {
    expect(planLabel("growth")).toBe("Growth");
    expect(planLabel(null)).toBe("Free");
    expect(planLabel(undefined)).toBe("Free");
  });
});

describe("deletion in the console", () => {
  const scheduled = (ms: number, over: Partial<AdminWorkspace> = {}) =>
    ws({ deletion_scheduled_at: new Date(NOW.getTime() + ms).toISOString(), ...over });

  it("a workspace waiting to be erased says how long is left, in danger colour", () => {
    expect(workspaceBadge(scheduled(5 * DAY), NOW)).toEqual({ label: "Deleting in 5 days", variant: "danger" });
    expect(workspaceBadge(scheduled(DAY), NOW).label).toBe("Deleting in 1 day");
    expect(workspaceBadge(scheduled(3_600_000), NOW).label).toBe("Deleting in 1 day");
    expect(workspaceBadge(scheduled(-1000), NOW).label).toBe("Erasing today");
  });

  it("suspended still outranks it, and it outranks payment trouble", () => {
    expect(workspaceBadge(scheduled(DAY, { suspended: true }), NOW).label).toBe("Suspended");
    expect(workspaceBadge(scheduled(DAY, { payment_status: "lapsed" }), NOW).label).toBe("Deleting in 1 day");
  });

  it("audit sentences for the new actions", () => {
    const e = (action: string, detail: Record<string, unknown> | null = null): AdminAuditEntry => ({ actor: "a@x.test", action, detail, at: NOW.toISOString() });
    expect(auditSummary(e("schedule_deletion"))).toBe("Scheduled the workspace for deletion");
    expect(auditSummary(e("cancel_deletion"))).toBe("Cancelled the scheduled deletion");
    expect(auditSummary(e("delete_workspace"))).toBe("Permanently deleted the workspace");
    expect(auditSummary(e("export_data"))).toBe("Downloaded a data export");
  });

  it("a deleted workspace is still named from inside the audit entry", () => {
    const base = { actor: "a", action: "delete_workspace", at: null };
    expect(auditWorkspaceName({ ...base, tenant_name: "Live Co", detail: null })).toBe("Live Co");
    expect(auditWorkspaceName({ ...base, tenant_id: null, tenant_name: null, detail: { workspace_name: "Gone Co" } })).toBe("Gone Co");
    expect(auditWorkspaceName({ ...base, tenant_name: null, detail: { workspace_name: 5 } })).toBeNull();
    expect(auditWorkspaceName({ ...base, tenant_name: null, detail: null })).toBeNull();
  });
});

describe("adminTabFor: which header tab is lit", () => {
  it("the audit log lights Audit log", () => {
    expect(adminTabFor("/admin/audit")).toBe("audit");
    expect(adminTabFor("/admin/audit/")).toBe("audit");
  });

  it("the overview and every workspace page light Overview", () => {
    expect(adminTabFor("/admin")).toBe("overview");
    expect(adminTabFor("/admin/")).toBe("overview");
    expect(adminTabFor("/admin/tenants/abc-123")).toBe("overview");
  });

  it("a path that merely starts with the word audit does not light Audit log", () => {
    expect(adminTabFor("/admin/auditors")).toBe("overview");
  });
});

describe("adminLoginNotice: the message above the sign-in form", () => {
  it("explains a bad link, once, in plain words", () => {
    expect(adminLoginNotice("invalid_link")).toContain("invalid, already used, or has expired");
  });

  it("says nothing for anything we did not put there, so a crafted URL cannot write text onto the page", () => {
    expect(adminLoginNotice(null)).toBeNull();
    expect(adminLoginNotice("")).toBeNull();
    expect(adminLoginNotice("<script>alert(1)</script>")).toBeNull();
    expect(adminLoginNotice("INVALID_LINK")).toBeNull();
  });
});

describe("formatHours", () => {
  it("uses minutes under an hour, hours under two days, then days", () => {
    expect(formatHours(0.5)).toBe("30 minutes");
    expect(formatHours(0.01)).toBe("1 minute");
    expect(formatHours(1)).toBe("1 hour");
    expect(formatHours(3.46)).toBe("3.5 hours");
    expect(formatHours(47.9)).toBe("47.9 hours");
    expect(formatHours(72)).toBe("3 days");
  });
  it("shows an em dash when unknown", () => {
    expect(formatHours(null)).toBe("—");
    expect(formatHours(undefined)).toBe("—");
    expect(formatHours(Number.NaN)).toBe("—");
  });
});

describe("dropSentence", () => {
  it("names the stages and the share of signups lost", () => {
    const s = dropSentence({ cohort: 40, biggest_drop: { from: "signed_in", to: "address", lost: 10 } })!;
    expect(s).toContain("between first sign-in and adding an address");
    expect(s).toContain("10 workspaces (25% of signups)");
  });
  it("says workspace for one", () => {
    expect(dropSentence({ cohort: 4, biggest_drop: { from: "flow", to: "event", lost: 1 } })).toContain("1 workspace (25%");
  });
  it("is null with no drop or an empty cohort", () => {
    expect(dropSentence({ cohort: 5, biggest_drop: null })).toBeNull();
    expect(dropSentence({ cohort: 0, biggest_drop: { from: "signed_up", to: "signed_in", lost: 1 } })).toBeNull();
  });
});

describe("goalsSentence", () => {
  it("lists goals from most to least common, leaving out zeros", () => {
    expect(goalsSentence({ welcome: 2, convert_trials: 3, upgrade_free: 0, explore: 0, none: 1 })).toBe("convert trials 3, welcome new signups 2, skipped 1");
  });
  it("is null when nobody is in the cohort", () => {
    expect(goalsSentence({ welcome: 0, convert_trials: 0, upgrade_free: 0, explore: 0, none: 0 })).toBeNull();
  });
});
