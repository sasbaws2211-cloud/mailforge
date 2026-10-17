/**
 * A/B tests and holdouts in the dashboard: building the plan, the outline, the editor, the wording and the results.
 */
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SequenceEditor, type TreeContext } from "../src/components/flow-tree-editor.js";
import { SplitResultsView } from "../src/components/split-results.js";
import { buildPlanFromTree, emptySequence, newFork, planOutline, switchForkKind, type ForkData, type SequenceData } from "../src/flow-tree.js";
import { describeSplitVerdict, goalRate, sentRate, versionName } from "../src/split.js";
import { newConditionRow } from "../src/conditions.js";
import type { StepData } from "../src/components/step-writer.js";
import type { SplitTestResult, SplitVersionResult } from "../src/api.js";

let n = 0;
const email = (): StepData => ({
  order: ++n,
  delay: "0m",
  action_type: "nurture_value",
  subject: `Subject ${n}`,
  body_html: "<p>Hi</p>",
  body_text: "",
  window_policy: "respect_window",
});
const split = (yes: SequenceData = emptySequence(), no: SequenceData = emptySequence(), over: Partial<ForkData> = {}): ForkData => ({
  ...newFork(newConditionRow("payment_status")),
  kind: "split",
  percent_a: 50,
  yes,
  no,
  ...over,
});
const seq = (steps: StepData[], fork: ForkData | null = null): SequenceData => ({ steps, fork });

describe("building a plan with a random split", () => {
  it("writes a split with its percentage and no condition", () => {
    const { body, errors } = buildPlanFromTree(seq([email()], split(seq([email()]), seq([email()]), { percent_a: 70 })));
    expect(errors).toEqual({});
    const branch = body.branches![0]!;
    expect(branch).toMatchObject({ order: 2, delay: "3d", split: { percent_a: 70 }, then: 3, else: 4 });
    expect("condition" in branch).toBe(false);
    expect("early" in branch).toBe(false);
  });

  it("a condition split is unchanged, and has no split key", () => {
    const f = { ...split(), kind: "condition" as const, condition: { match: "all" as const, rows: [{ ...newConditionRow("payment_status"), op: "is", value: "paid" }] } };
    const { body } = buildPlanFromTree(seq([email()], f));
    expect("split" in body.branches![0]!).toBe(false);
    expect(body.branches![0]!.condition).toEqual({ field: "payment_status", op: "is", value: "paid" });
  });

  it("a holdout is a split with an empty path, which becomes end", () => {
    const { body, errors } = buildPlanFromTree(seq([], split(seq([email()]), emptySequence(), { percent_a: 90 })));
    expect(errors).toEqual({});
    expect(body.branches![0]).toMatchObject({ order: 1, split: { percent_a: 90 }, then: 2, else: "end" });
  });

  it("needs no condition rows (a condition split without any is refused, a random split is not)", () => {
    const empty = { match: "all" as const, rows: [] };
    expect(buildPlanFromTree(seq([email()], split(emptySequence(), emptySequence(), { condition: empty }))).errors).toEqual({});
    const asCondition = split(emptySequence(), emptySequence(), { kind: "condition", condition: empty });
    expect(Object.keys(buildPlanFromTree(seq([email()], asCondition)).errors).length).toBeGreaterThan(0);
  });

  it("refuses a share outside 1 to 99, naming the split", () => {
    for (const bad of [0, 100, -3, 50.5, Number.NaN]) {
      const f = split(emptySequence(), emptySequence(), { percent_a: bad });
      const { errors } = buildPlanFromTree(seq([email()], f));
      expect(errors[`${f.id}-percent`], String(bad)).toMatch(/1 to 99/);
    }
    for (const ok of [1, 99, 50]) {
      const f = split(emptySequence(), emptySequence(), { percent_a: ok });
      expect(buildPlanFromTree(seq([email()], f)).errors, String(ok)).toEqual({});
    }
  });
});

describe("the plan outline for a random split", () => {
  const plan = (then: number | "end", otherwise: number | "end", percent = 50) => ({
    version: 2,
    steps: [{ order: 2, action_type: "x", delay: "0m", next: "end" }, { order: 3, action_type: "x", delay: "0m", next: "end" }],
    branches: [{ order: 1, delay: "0m", split: { percent_a: percent }, then, else: otherwise }],
  });
  const labels = (p: unknown) => planOutline(p).filter((l) => l.kind === "path").map((l) => (l as { label: string }).label);

  it("names the paths by version and carries the percentage", () => {
    const lines = planOutline(plan(2, 3, 70));
    expect(lines.find((l) => l.kind === "fork")).toMatchObject({ split: 70, early: false });
    expect(labels(plan(2, 3))).toEqual(["Version A", "Version B"]);
  });

  it("calls a path that ends straight away a holdout", () => {
    expect(labels({ ...plan(2, "end"), steps: [{ order: 2, action_type: "x", delay: "0m", next: "end" }] })).toEqual(["Version A", "Holdout"]);
  });

  it("a condition fork keeps its yes/otherwise labels and no split value", () => {
    const p = { version: 2, steps: [{ order: 2, action_type: "x", delay: "0m", next: "end" }, { order: 3, action_type: "x", delay: "0m", next: "end" }], branches: [{ order: 1, delay: "0m", condition: { lifecycle_state: "a" }, then: 2, else: 3 }] };
    expect(labels(p)).toEqual(["If yes", "Otherwise"]);
    expect(planOutline(p).find((l) => l.kind === "fork")).toMatchObject({ split: null });
  });
});

const ctx = (over: Partial<TreeContext> = {}): TreeContext => ({ flowId: "flow-1", hasLlm: false, conditionErrors: {}, eventSuggestions: [], totalNodes: 0, ...over });
const render = (value: SequenceData, c: TreeContext = ctx()) =>
  renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(SequenceEditor, { value, onChange: () => {}, ctx: c })));

describe("the editor for a random split", () => {
  const html = () => render(seq([email()], split(emptySequence(), emptySequence(), { percent_a: 80 })));

  it("shows the share controls, the presets and the explanation instead of the condition editor", () => {
    const h = html();
    expect(h).toContain("Random split (A/B test)");
    expect(h).toContain("Version A gets");
    expect(h).toContain("version B gets 20%");
    expect(h).toContain("90/10 holdout");
    expect(h).toContain("Each person is assigned once");
    expect(h).not.toContain("When to check"); // the condition-mode controls
    expect(h).not.toContain("Wait for it to happen");
    expect(h).not.toContain("Condition 1 field"); // no condition rows
  });

  it("titles the two paths by version and share, and explains an empty path as a holdout", () => {
    const h = html();
    expect(h).toContain("Version A (80%)");
    expect(h).toContain("Version B (20%)");
    expect(h).toContain("a holdout: held back and sent nothing");
  });

  it("offers the choice of how to split, defaulting a new split to a condition", () => {
    const h = render(seq([email()], { ...split(), kind: "condition", early: false }));
    expect(h).toContain("A condition about the contact");
    expect(h).toContain("A random split (A/B test or holdout)");
    expect(h).toContain("Split into two paths");
    expect(h).not.toContain("Version A gets");
    expect(h).toContain("If it holds");
  });

  it("shows the share problem next to the split", () => {
    const f = split(emptySequence(), emptySequence(), { percent_a: 0 });
    const h = render(seq([email()], f), ctx({ conditionErrors: { [`${f.id}-percent`]: "Choose a share from 1 to 99." } }));
    expect(h).toContain("Choose a share from 1 to 99.");
  });
});

const version = (over: Partial<SplitVersionResult> = {}): SplitVersionResult => ({ assigned: 100, converted: 20, sent: 100, opened: 40, clicked: 10, holdout: false, ...over });
const test = (over: Partial<SplitTestResult> = {}): SplitTestResult => ({
  node_order: 2,
  percent_a: 50,
  in_plan: true,
  a: version({ converted: 20 }),
  b: version({ converted: 35 }),
  comparison: { rate_a: 0.2, rate_b: 0.35, difference: 0.15, p_value: 0.012, verdict: "b_better" },
  ...over,
});

describe("reading the results in plain words", () => {
  it("says which version is probably better, with the numbers and the p-value", () => {
    const text = describeSplitVerdict(test());
    expect(text).toContain("Version B is probably better");
    expect(text).toContain("35% against 20%");
    expect(text).toContain("p = 0.012");
  });

  it("names version A when A is the winner", () => {
    const t = test({ comparison: { rate_a: 0.35, rate_b: 0.2, difference: -0.15, p_value: 0.0004, verdict: "a_better" }, a: version({ converted: 35 }), b: version({ converted: 20 }) });
    const text = describeSplitVerdict(t);
    expect(text).toContain("Version A is probably better");
    expect(text).toContain("p = under 0.001");
  });

  it("says too early, and what 'enough' means", () => {
    const text = describeSplitVerdict(test({ comparison: { rate_a: 0.5, rate_b: 0.1, difference: -0.4, p_value: null, verdict: "too_early" } }));
    expect(text).toContain("Too early to tell");
    expect(text).toContain("at least 30 people");
    expect(text).toContain("at least 10");
  });

  it("says no clear difference when close", () => {
    expect(describeSplitVerdict(test({ comparison: { rate_a: 0.2, rate_b: 0.21, difference: 0.01, p_value: 0.8, verdict: "no_difference" } }))).toContain("No clear difference");
  });

  it("asks for a goal when there is none, instead of showing a verdict", () => {
    expect(describeSplitVerdict(test({ comparison: null }))).toContain("Set a goal");
  });

  it("for a holdout, says whether the emails helped", () => {
    const holdout = version({ assigned: 30, converted: 3, sent: 0, opened: 0, clicked: 0, holdout: true });
    const helped = describeSplitVerdict(test({ a: version({ assigned: 270, converted: 81 }), b: holdout, comparison: { rate_a: 0.3, rate_b: 0.1, difference: -0.2, p_value: 0.01, verdict: "a_better" } }));
    expect(helped).toContain("The emails helped");
    expect(helped).toContain("30% against 10%");
    const hurt = describeSplitVerdict(test({ a: version({ assigned: 270, converted: 27 }), b: version({ assigned: 30, converted: 9, sent: 0, holdout: true }), comparison: { rate_a: 0.1, rate_b: 0.3, difference: 0.2, p_value: 0.01, verdict: "b_better" } }));
    expect(hurt).toContain("The holdout did better");
  });

  it("names versions, and rates divide safely", () => {
    expect(versionName("a", version())).toBe("Version A");
    expect(versionName("b", version())).toBe("Version B");
    expect(versionName("b", version({ holdout: true }))).toBe("Holdout");
    expect(goalRate(version({ assigned: 0, converted: 0 }))).toBe("-");
    expect(sentRate(version({ sent: 0 }), 0)).toBe("-");
    expect(goalRate(version({ assigned: 200, converted: 50 }))).toBe("25%");
  });
});

describe("the results panel", () => {
  const view = (tests: SplitTestResult[]) => renderToStaticMarkup(createElement(SplitResultsView, { results: { split_tests: tests, range_days: 30 } }));

  it("shows nothing for a flow with no random split", () => {
    expect(view([])).toBe("");
  });

  it("shows each version's people, goal count and rate, emails and opens", () => {
    const h = view([test()]);
    expect(h).toContain("A/B tests");
    expect(h).toContain("50% / 50%");
    expect(h).toContain("Version A");
    expect(h).toContain("Version B");
    expect(h).toContain("20");
    expect(h).toContain("(35%)");
    expect(h).toContain("40%"); // opened 40 of 100 sent
    expect(h).toContain("Opens are approximate");
  });

  it("marks a holdout, with no emails or opens", () => {
    const h = view([test({ a: version(), b: version({ holdout: true, sent: 0, opened: 0, clicked: 0, assigned: 30, converted: 3 }) })]);
    expect(h).toContain("Holdout");
    expect(h).toContain("none");
  });

  it("without a goal, shows no goal numbers but still shows emails", () => {
    const h = view([test({ comparison: null })]);
    expect(h).toContain("Set a goal on this flow");
    expect(h).not.toContain("(35%)");
    expect(h).toContain("40%");
  });

  it("flags a split that is no longer in the flow, and numbers several splits", () => {
    expect(view([test({ in_plan: false, percent_a: null })])).toContain("no longer in the flow");
    const h = view([test(), test({ node_order: 5 })]);
    expect(h).toContain("Split 1");
    expect(h).toContain("Split 2");
  });
});

describe("switching how a split decides", () => {
  it("a new random split starts immediate, not at the condition fork's 3-day default", () => {
    const f = switchForkKind({ ...newFork(newConditionRow("payment_status")) }, "split");
    expect(f.kind).toBe("split");
    expect(f.delay).toBe("0m");
  });

  it("keeps a delay the person chose, and switches early off for a random split", () => {
    const chosen = switchForkKind({ ...newFork(newConditionRow("payment_status")), delay: "7d", early: true }, "split");
    expect(chosen.delay).toBe("7d");
    expect(chosen.early).toBe(false);
  });

  it("switching back to a condition restores a sensible wait, and keeps the share for later", () => {
    const back = switchForkKind(switchForkKind({ ...newFork(newConditionRow("payment_status")), percent_a: 80 }, "split"), "condition");
    expect(back.kind).toBe("condition");
    expect(back.delay).toBe("3d");
    expect(back.percent_a).toBe(80);
  });

  it("does nothing when the kind is unchanged", () => {
    const f = newFork(newConditionRow("payment_status"));
    expect(switchForkKind(f, "condition")).toBe(f);
  });
});
