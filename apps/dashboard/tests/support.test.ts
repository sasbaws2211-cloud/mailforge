/** Support requests, the dashboard's rules: validating a request, labelling, and the small helpers the screens use. */
import { describe, it, expect } from "vitest";
import { MAX_MESSAGE, MAX_SUBJECT, STATUS_LABEL, newTicketProblems, pageToAttach, replyProblem, timeAgo } from "../src/support.js";
import { waitingFor } from "../src/admin-support.js";
import { adminTabFor, auditSummary } from "../src/admin.js";

describe("newTicketProblems", () => {
  it("is empty for a sensible request, ignoring surrounding spaces", () => {
    expect(newTicketProblems({ subject: "  Cannot connect  ", message: "  The tunnel fails.  " })).toEqual([]);
  });
  it("says what is missing or too long", () => {
    expect(newTicketProblems({ subject: "hi", message: "long enough" })).toEqual(["Give your request a short subject (at least 3 characters)."]);
    expect(newTicketProblems({ subject: "Fine subject", message: "abc" })).toEqual(["Tell us what is happening (at least 5 characters)."]);
    expect(newTicketProblems({ subject: "x".repeat(MAX_SUBJECT + 1), message: "long enough" })[0]).toMatch(/subject is too long/);
    expect(newTicketProblems({ subject: "Fine subject", message: "x".repeat(MAX_MESSAGE + 1) })[0]).toMatch(/message is too long/);
    expect(newTicketProblems({ subject: "", message: "" })).toHaveLength(2);
  });
});

describe("replyProblem", () => {
  it("needs a message that is not blank or over the limit", () => {
    expect(replyProblem("Thanks, that worked.")).toBeNull();
    expect(replyProblem("   ")).toMatch(/Write a message/);
    expect(replyProblem("x".repeat(MAX_MESSAGE + 1))).toMatch(/too long/);
  });
});

describe("pageToAttach", () => {
  it("keeps a path inside the app, and drops anything else and the support pages themselves", () => {
    expect(pageToAttach("/flows/123?tab=a")).toBe("/flows/123?tab=a");
    for (const bad of [null, undefined, "", "flows", "//evil.example", "https://evil.example/x", "javascript:alert(1)", "/has space", "/support", "/support/abc"]) expect(pageToAttach(bad as string | null | undefined), String(bad)).toBeUndefined();
  });
});

describe("timeAgo and waitingFor", () => {
  const now = new Date("2026-10-20T12:00:00Z");
  const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
  it("says it in plain words", () => {
    expect(timeAgo(ago(10_000), now)).toBe("just now");
    expect(timeAgo(ago(60_000), now)).toBe("1 minute ago");
    expect(timeAgo(ago(5 * 60_000), now)).toBe("5 minutes ago");
    expect(timeAgo(ago(3 * 3_600_000), now)).toBe("3 hours ago");
    expect(timeAgo(ago(30 * 3_600_000), now)).toBe("yesterday");
    expect(timeAgo(ago(4 * 86_400_000), now)).toBe("4 days ago");
    expect(timeAgo(ago(90 * 86_400_000), now)).toMatch(/2026|Jul/);
    expect(timeAgo(new Date(now.getTime() + 5_000).toISOString(), now)).toBe("just now"); // a clock a little ahead is not "in the future"
  });
  it("shows how long a request has waited", () => {
    expect(waitingFor(ago(10_000), now)).toBe("1 min");
    expect(waitingFor(ago(45 * 60_000), now)).toBe("45 min");
    expect(waitingFor(ago(3 * 3_600_000), now)).toBe("3 hours");
    expect(waitingFor(ago(60 * 3_600_000), now)).toBe("2 days");
  });
});

describe("labels", () => {
  it("tells the customer whose turn it is", () => {
    expect(STATUS_LABEL).toEqual({ open: "Waiting for support", answered: "Support replied", closed: "Closed" });
  });
});

describe("the admin console", () => {
  it("puts the support pages under their own tab", () => {
    expect(adminTabFor("/admin/support")).toBe("support");
    expect(adminTabFor("/admin/support/abc")).toBe("support");
    expect(adminTabFor("/admin/ai")).toBe("ai");
    expect(adminTabFor("/admin")).toBe("overview");
  });
  it("describes support actions in the audit log in words", () => {
    const entry = (action: string, detail: Record<string, unknown>) => ({ action, detail, tenant_id: null, actor: "a@x.test", at: "2026-10-20T00:00:00Z" }) as never;
    expect(auditSummary(entry("support_reply", { closed: false }))).toBe("Answered a support request");
    expect(auditSummary(entry("support_reply", { closed: true }))).toBe("Answered a support request and closed it");
    expect(auditSummary(entry("support_close", {}))).toBe("Closed a support request");
    expect(auditSummary(entry("support_reopen", {}))).toBe("Reopened a support request");
  });
});
