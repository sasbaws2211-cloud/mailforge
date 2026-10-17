/**
 * The segment screens: the rule editor, the Segments list, the flow trigger control, and the small
 * formatting helpers. Pages are rendered with the app's data cache pre-filled, so they show real rows.
 */
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SegmentRuleEditor } from "../src/components/segment-rule-editor.js";
import SegmentsPage from "../src/pages/SegmentsPage.js";
import { SegmentTriggerConfig } from "../src/pages/FlowEditorPage.js";
import {
  SEGMENT_MAX_GROUP_LEAVES,
  SEGMENT_MAX_LEAVES,
  changeRowField,
  emptySegmentState,
  formatMemberCount,
  newGroup,
  newSegmentRow,
  timeAgo,
  type SegmentRow,
  type SegmentState,
} from "../src/segment-rules.js";
import type { Segment } from "../src/segments.js";

const row = (over: Partial<SegmentRow> = {}): SegmentRow => ({ ...newSegmentRow(), ...over });
const state = (rows: SegmentRow[], match: "all" | "any" = "all"): SegmentState => ({
  match,
  items: rows.map((r) => ({ kind: "row" as const, row: r })),
});

const renderEditor = (s: SegmentState, errors: Record<string, string> = {}, extra: Record<string, unknown> = {}) =>
  renderToStaticMarkup(createElement(SegmentRuleEditor, { state: s, onChange: () => {}, errors, ...extra }));

describe("SegmentRuleEditor", () => {
  it("with no rules says so, and offers a rule or a group", () => {
    const html = renderEditor(emptySegmentState());
    expect(html).toContain("No rules yet");
    expect(html).toContain("Add a rule");
    expect(html).toContain("Add a group");
  });

  it("each row has a field, and the right controls for it", () => {
    const html = renderEditor(
      state([
        row({ field: "payment_status", op: "is", value: "paid" }),
        row({ field: "last_seen", op: "before_days", days: "14" }),
        row({ field: "event", op: "not_performed", name: "exported", days: "7" }),
        row({ field: "lifecycle_state", op: "in", values: ["at_risk"] }),
        row({ field: "trait", key: "seats", op: "gt", value: "10" }),
      ]),
    );
    expect(html).toContain('aria-label="Rule 1 field"');
    expect(html).toContain("Where");
    expect(html).toContain(">and<");
    // an age row: "more than [14] days ago"
    expect(html).toContain("more than");
    expect(html).toContain('aria-label="Rule 2 number of days"');
    expect(html).toContain("days ago");
    // an event row: did/did not, a name, and a window in days
    expect(html).toContain('aria-label="Rule 3 event name"');
    expect(html).toContain("did not");
    expect(html).toContain("in the last");
    // a lifecycle "is one of" row lists the stages as checkboxes
    expect(html).toContain('aria-label="Rule 4 stages"');
    expect(html).toContain(">dormant<");
    // a trait row
    expect(html).toContain('aria-label="Rule 5 trait name"');
  });

  it("offers a 'did it this many times' box only for 'did'", () => {
    expect(renderEditor(state([row({ field: "event", op: "performed", name: "x", days: "7" })]))).toContain("at least this many times");
    expect(renderEditor(state([row({ field: "event", op: "not_performed", name: "x", days: "7" })]))).not.toContain("at least this many times");
  });

  it("joins rules by the match: 'and' for all, 'or' for any, and shows the chooser only for two or more", () => {
    const two = state([row(), row()]);
    expect(renderEditor(two)).toContain("Match all or any of the rules");
    expect(renderEditor(two)).toContain(">and<");
    expect(renderEditor({ ...two, match: "any" })).toContain(">or<");
    expect(renderEditor(state([row()]))).not.toContain("Match all or any of the rules");
  });

  it("draws a group as a box with its own match, its own rules and its own add button", () => {
    const g = newGroup();
    g.match = "any";
    g.rows = [row({ field: "plan", op: "is", value: "Pro" }), row({ field: "plan", op: "is", value: "Growth" })];
    const html = renderEditor({ match: "all", items: [{ kind: "row", row: row() }, { kind: "group", group: g }] });
    expect(html).toContain('aria-label="Group 2"');
    expect(html).toContain('aria-label="Group 2 match"');
    expect(html).toContain('aria-label="Group 2 rule 1 field"');
    expect(html).toContain('aria-label="Group 2 rule 2 field"');
    expect(html).toContain("Add a rule to this group");
    expect(html).toContain("Remove group");
    expect(html).toContain(">or<"); // between the group's own rules
  });

  it("shows a problem next to its row, and on an empty group", () => {
    const r = row({ field: "plan", op: "is", value: "" });
    expect(renderEditor(state([r]), { [r.id]: "Enter the plan name." })).toContain("Enter the plan name.");
    const g = newGroup();
    g.rows = [];
    expect(renderEditor({ match: "all", items: [{ kind: "group", group: g }] }, { [g.id]: "Add at least one rule to this group, or remove it." })).toContain(
      "Add at least one rule to this group",
    );
  });

  it("stops offering more at the limits", () => {
    const full = state(Array.from({ length: SEGMENT_MAX_LEAVES }, () => row()));
    const html = renderEditor(full);
    expect(html).toContain(`Up to ${SEGMENT_MAX_LEAVES} rules in total.`);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>(?:(?!<\/button>)[\s\S])*Add another rule/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>(?:(?!<\/button>)[\s\S])*Add a group/);

    const g = newGroup();
    g.rows = Array.from({ length: SEGMENT_MAX_GROUP_LEAVES }, () => row());
    const groupHtml = renderEditor({ match: "all", items: [{ kind: "group", group: g }] });
    expect(groupHtml).toMatch(/<button[^>]*disabled=""[^>]*>(?:(?!<\/button>)[\s\S])*Add a rule to this group/);
  });

  it("is read-only when disabled", () => {
    const html = renderEditor(state([row()]), {}, { disabled: true });
    expect(html).toMatch(/<select[^>]*disabled=""/);
  });
});

// ---------------------------------------------------------------------------

const seg = (over: Partial<Segment> = {}): Segment => ({
  id: "11111111-1111-4111-8111-111111111111",
  name: "Paid and quiet",
  description: null,
  definition: { match: "all", rules: [{ field: "payment_status", op: "is", value: "paid" }, { field: "last_seen", op: "before_days", days: 14 }] },
  member_count: 1234,
  count_capped: false,
  counted_at: new Date(Date.now() - 5 * 60_000).toISOString(),
  archived: false,
  created_at: null,
  updated_at: null,
  flow_count: 2,
  ...over,
});

function withData(node: ReturnType<typeof createElement>, segments: Segment[] | null) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  if (segments) client.setQueryData(["segments"], segments);
  return renderToStaticMarkup(createElement(MemoryRouter, null, createElement(QueryClientProvider, { client }, node)));
}

describe("the Segments list", () => {
  it("shows each segment: name, its rules in words, people with when counted, flows", () => {
    const html = withData(createElement(SegmentsPage), [seg()]);
    expect(html).toContain("Paid and quiet");
    expect(html).toContain("payment status is paid and last seen more than 14 days ago");
    expect(html).toContain("1,234");
    expect(html).toContain("counted 5 minutes ago");
    expect(html).toContain('aria-label="Recount Paid and quiet"');
    expect(html).toContain(">2<"); // flows
    expect(html).toContain("New segment");
  });

  it("links the count to the people, and offers to start a flow or edit", () => {
    const html = withData(createElement(SegmentsPage), [seg()]);
    expect(html).toContain('href="/people?segment=11111111-1111-4111-8111-111111111111"');
    expect(html).toContain('href="/flows/new?segment_id=11111111-1111-4111-8111-111111111111"');
    expect(html).toContain('href="/segments/11111111-1111-4111-8111-111111111111"');
    expect(html).toContain('aria-label="Archive Paid and quiet"');
  });

  it("prefers the description to the rules when there is one", () => {
    const html = withData(createElement(SegmentsPage), [seg({ description: "People we should email" })]);
    expect(html).toContain("People we should email");
  });

  it("marks a capped count with a plus, and a never-counted one with a dash", () => {
    expect(withData(createElement(SegmentsPage), [seg({ member_count: 100000, count_capped: true })])).toContain("100,000+");
    expect(withData(createElement(SegmentsPage), [seg({ member_count: null, counted_at: null })])).toContain("counted never");
  });

  it("with none yet, explains what a segment is and offers the first one", () => {
    const html = withData(createElement(SegmentsPage), []);
    expect(html).toContain("No segments yet");
    expect(html).toContain("Create your first segment");
    expect(html).not.toContain("<table");
  });

  it("while loading shows a placeholder, not an empty state", () => {
    const html = withData(createElement(SegmentsPage), null);
    expect(html).toContain("Loading segments");
    expect(html).not.toContain("No segments yet");
  });
});

// ---------------------------------------------------------------------------

describe("the flow trigger control for a segment", () => {
  const props = {
    kind: "saved" as const,
    segmentId: "",
    onKindChange: () => {},
    onSegmentChange: () => {},
    tenure: "",
    recency: "",
    onTenureChange: () => {},
    onRecencyChange: () => {},
  };

  it("offers a saved segment or a retention cell", () => {
    const html = withData(createElement(SegmentTriggerConfig, props), [seg()]);
    expect(html).toContain("A saved segment");
    expect(html).toContain("One cell of the retention grid");
  });

  it("lists the saved segments with their sizes, and what happens when a flow starts from one", () => {
    const html = withData(createElement(SegmentTriggerConfig, props), [seg(), seg({ id: "22222222-2222-4222-8222-222222222222", name: "Trials", member_count: 7 })]);
    expect(html).toContain("Paid and quiet (1,234 people)");
    expect(html).toContain("Trials (7 people)");
    expect(html).toContain("up to 200 per scan");
  });

  it("with no segments, says so and links to create one", () => {
    const html = withData(createElement(SegmentTriggerConfig, props), []);
    expect(html).toContain("You have no segments yet");
    expect(html).toContain('href="/segments/new"');
  });

  it("shows the problem the server found with the chosen segment", () => {
    const html = withData(createElement(SegmentTriggerConfig, { ...props, segmentError: "that segment does not exist, or has been archived" }), [seg()]);
    expect(html).toContain("that segment does not exist, or has been archived");
  });

  it("the retention cell choice shows the original tenure and recency controls", () => {
    const html = withData(createElement(SegmentTriggerConfig, { ...props, kind: "cell" }), [seg()]);
    expect(html).toContain("Select tenure");
    expect(html).toContain("Select recency");
    expect(html).not.toContain("Select a segment");
  });
});

// ---------------------------------------------------------------------------

describe("formatting", () => {
  it("counts: thousands separated, a plus when capped, a dash when never counted", () => {
    expect(formatMemberCount(0, false)).toBe("0");
    expect(formatMemberCount(1234567, false)).toBe("1,234,567");
    expect(formatMemberCount(100000, true)).toBe("100,000+");
    expect(formatMemberCount(null, false)).toBe("-");
  });

  it("time ago, in the words a person would use", () => {
    const now = new Date("2026-07-20T12:00:00Z");
    const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
    expect(timeAgo(ago(10_000), now)).toBe("just now");
    expect(timeAgo(ago(60_000), now)).toBe("1 minute ago");
    expect(timeAgo(ago(5 * 60_000), now)).toBe("5 minutes ago");
    expect(timeAgo(ago(3_600_000), now)).toBe("1 hour ago");
    expect(timeAgo(ago(7 * 3_600_000), now)).toBe("7 hours ago");
    expect(timeAgo(ago(86_400_000), now)).toBe("1 day ago");
    expect(timeAgo(ago(10 * 86_400_000), now)).toBe("10 days ago");
    expect(timeAgo(ago(60 * 86_400_000), now)).toMatch(/2026|May|Jun/);
    expect(timeAgo(null, now)).toBe("never");
    expect(timeAgo("garbage", now)).toBe("never");
    expect(timeAgo(new Date(now.getTime() + 5000).toISOString(), now)).toBe("just now"); // a clock a little ahead
  });

  it("changing a row's field keeps its place", () => {
    const r = row({ field: "plan", value: "x" });
    expect(changeRowField(r, "event").id).toBe(r.id);
  });
});
