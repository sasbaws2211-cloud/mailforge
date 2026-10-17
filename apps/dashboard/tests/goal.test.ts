/**
 * Flow goals in the dashboard: the form <-> API conversion, the plain-English wording, the number formatting,
 * and the card and results rendered for real.
 */
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describeGoal, emptyGoalForm, formToGoal, formatDuration, formatRate, goalToForm, GOAL_WINDOW_CHOICES, type ApiGoal } from "../src/goal.js";
import { newConditionRow } from "../src/conditions.js";
import { FlowGoalCard, GoalResultsView } from "../src/components/flow-goal-card.js";
import type { Flow, FlowResults } from "../src/api.js";

const eventRow = (name = "project_created") => ({ ...newConditionRow("event"), name, op: "performed", window: "flow" as const });

const apiGoal = (over: Partial<ApiGoal> = {}): ApiGoal => ({
  name: "Created a project",
  condition: { field: "event", name: "project_created", op: "performed", since: "flow" } as never,
  window_days: 30,
  exit_on_conversion: true,
  ...over,
});

describe("formToGoal", () => {
  it("turns a filled-in form into the API shape", () => {
    const { goal, errors } = formToGoal({ ...emptyGoalForm(), name: "  Created a project ", condition: { match: "all", rows: [eventRow()] } });
    expect(errors).toEqual({});
    expect(goal).toEqual(apiGoal());
  });

  it("keeps the window and the exit choice", () => {
    const { goal } = formToGoal({ name: "x", condition: { match: "all", rows: [eventRow()] }, window_days: 7, exit_on_conversion: false });
    expect(goal).toMatchObject({ window_days: 7, exit_on_conversion: false });
  });

  it("refuses a missing name and a missing condition, saying which", () => {
    const r = formToGoal(emptyGoalForm());
    expect(r.goal).toBeNull();
    expect(r.errors.name).toMatch(/name/);
    expect(r.errors.condition).toMatch(/what counts/i);
  });

  it("refuses a name that is only spaces or over 80 characters", () => {
    const c = { match: "all" as const, rows: [eventRow()] };
    expect(formToGoal({ ...emptyGoalForm(), name: "   ", condition: c }).errors.name).toBeDefined();
    expect(formToGoal({ ...emptyGoalForm(), name: "x".repeat(81), condition: c }).errors.name).toMatch(/80/);
    expect(formToGoal({ ...emptyGoalForm(), name: "x".repeat(80), condition: c }).goal).not.toBeNull();
  });

  it("reports a bad condition row against that row", () => {
    const bad = { ...eventRow(), name: "" };
    const r = formToGoal({ ...emptyGoalForm(), name: "x", condition: { match: "all", rows: [bad] } });
    expect(r.goal).toBeNull();
    expect(r.errors[bad.id]).toBeDefined();
  });

  it("several rows become all-of or any-of", () => {
    const rows = [eventRow("a"), eventRow("b")];
    expect(formToGoal({ ...emptyGoalForm(), name: "x", condition: { match: "all", rows } }).goal?.condition).toHaveProperty("all");
    expect(formToGoal({ ...emptyGoalForm(), name: "x", condition: { match: "any", rows } }).goal?.condition).toHaveProperty("any");
  });
});

describe("goalToForm", () => {
  it("a goal with no value gives a blank form", () => {
    expect(goalToForm(null)).toEqual({ form: emptyGoalForm(), unreadable: false });
    expect(goalToForm(undefined).form.name).toBe("");
  });

  it("round-trips a stored goal", () => {
    const { form, unreadable } = goalToForm(apiGoal({ window_days: 14, exit_on_conversion: false }));
    expect(unreadable).toBe(false);
    expect(form).toMatchObject({ name: "Created a project", window_days: 14, exit_on_conversion: false });
    const back = formToGoal(form).goal;
    expect(back).toMatchObject({ name: "Created a project", window_days: 14, exit_on_conversion: false });
    expect(back?.condition).toEqual(apiGoal().condition);
  });

  it("says so when the stored condition cannot be shown", () => {
    expect(goalToForm(apiGoal({ condition: { favourite_colour: "red" } as never })).unreadable).toBe(true);
  });

  it("every window the form offers is one the API accepts (1 to 90)", () => {
    for (const c of GOAL_WINDOW_CHOICES) {
      expect(c.value).toBeGreaterThanOrEqual(1);
      expect(c.value).toBeLessThanOrEqual(90);
    }
  });
});

describe("wording and numbers", () => {
  it("describes a goal in one sentence, with the exit choice", () => {
    const text = describeGoal(apiGoal());
    expect(text).toContain("Created a project");
    expect(text).toContain("project_created");
    expect(text).toContain("within 30 days");
    expect(text).toContain("leave the flow");
    expect(describeGoal(apiGoal({ exit_on_conversion: false, window_days: 1 }))).toMatch(/within 1 day of entering\. They stay in the flow/);
  });

  it("formats rates", () => {
    expect(formatRate(0.4)).toBe("40%");
    expect(formatRate(1)).toBe("100%");
    expect(formatRate(0)).toBe("0%");
    expect(formatRate(0.037)).toBe("3.7%");
    expect(formatRate(0.004)).toBe("0.4%");
    expect(formatRate(null)).toBe("-");
    expect(formatRate(undefined)).toBe("-");
    expect(formatRate(Number.NaN)).toBe("-");
  });

  it("formats durations", () => {
    expect(formatDuration(null)).toBe("-");
    expect(formatDuration(0.5)).toBe("30 minutes");
    expect(formatDuration(0.01)).toBe("1 minute");
    expect(formatDuration(1)).toBe("1 hour");
    expect(formatDuration(2)).toBe("2 hours");
    expect(formatDuration(36.5)).toBe("36.5 hours");
    expect(formatDuration(72)).toBe("3 days");
    expect(formatDuration(50)).toBe("2.1 days");
  });
});

const render = (node: Parameters<typeof createElement>[0], props: Record<string, unknown>) =>
  renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(node as never, props)));

const flowWith = (goal: ApiGoal | null): Flow => ({ id: "f1", name: "Welcome", status: "active", goal } as unknown as Flow);

describe("the goal card", () => {
  it("without a goal, invites you to set one and shows no results", () => {
    const html = render(FlowGoalCard, { flow: flowWith(null), saving: false, onSave: async () => null });
    expect(html).toContain("Set a goal");
    expect(html).toContain("No goal yet");
    expect(html).not.toContain("Goal results");
  });

  it("with a goal, shows it in words and an Edit button", () => {
    const html = render(FlowGoalCard, { flow: flowWith(apiGoal()), saving: false, onSave: async () => null });
    expect(html).toContain("Created a project");
    expect(html).toContain("within 30 days");
    expect(html).toContain("Edit");
    expect(html).not.toContain("Set a goal");
  });
});

describe("the results", () => {
  const results = (over: Partial<FlowResults> = {}): FlowResults => ({
    goal: apiGoal(),
    range_days: 30,
    entered: 200,
    converted: 50,
    conversion_rate: 0.25,
    median_hours_to_convert: 26,
    by_step: [
      { step: 1, sent: 200, converted: 50 },
      { step: 2, sent: 120, converted: 20 },
    ],
    ...over,
  });
  const view = (r: FlowResults) => renderToStaticMarkup(createElement(GoalResultsView, { results: r }));

  it("shows entered, reached, the rate and the typical time", () => {
    const html = view(results());
    expect(html).toContain("Entered");
    expect(html).toContain(">200<");
    expect(html).toContain(">50<");
    expect(html).toContain("25%");
    expect(html).toContain("26 hours");
  });

  it("shows each email with how many of those sent it got there", () => {
    const html = view(results());
    expect(html).toContain("Step 1");
    expect(html).toContain("Step 2");
    expect(html).toContain("(17%)"); // 20 of 120
  });

  it("is honest that it does not prove the emails caused it", () => {
    expect(view(results())).toContain("not that the emails caused it");
  });

  it("says nobody has entered yet instead of showing zeros", () => {
    const html = view(results({ entered: 0, converted: 0, conversion_rate: null, median_hours_to_convert: null, by_step: [] }));
    expect(html).toContain("Nobody has entered this flow in the last 30 days");
    expect(html).not.toContain("Reached the goal");
  });

  it("shows a dash when there are no conversions to time", () => {
    const html = view(results({ converted: 0, conversion_rate: 0, median_hours_to_convert: null }));
    expect(html).toContain("0%");
    expect(html).toContain(">-<");
  });

  it("leaves out the per-email table when no email has been sent", () => {
    expect(view(results({ by_step: [] }))).not.toContain("Of those");
  });
});
