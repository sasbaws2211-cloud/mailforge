/**
 * Reopening a saved flow: build a plan from a tree, store it the way POST /v1/flows/:id/plan does (template_ref per
 * step, copy in the templates), load it back, build again, and get the same plan. Plans the editor cannot draw must
 * refuse to load, so saving can never replace them.
 */
import { describe, it, expect } from "vitest";
import {
  buildPlanFromTree,
  emptySequence,
  newFork,
  treeFromPlan,
  type ForkData,
  type SequenceData,
  type TemplateCopy,
} from "../src/flow-tree.js";
import { newConditionRow, type ConditionState } from "../src/conditions.js";
import type { StepData } from "../src/components/step-writer.js";
import { compiledPlanSchema } from "../../../packages/core/src/flow/compiled-plan.js";

let seq = 0;
const email = (over: Partial<StepData> = {}): StepData => ({
  order: ++seq,
  delay: "1d",
  action_type: "nurture_value",
  subject: `Subject ${seq}`,
  body_html: `<p>Body ${seq}</p>`,
  body_text: seq % 2 ? "plain" : "",
  window_policy: "respect_window",
  ...over,
});
const paid = (): ConditionState => ({ match: "all", rows: [{ ...newConditionRow("payment_status"), op: "is", value: "paid" }] });
const fork = (yes: SequenceData, no: SequenceData, over: Partial<ForkData> = {}): ForkData => ({
  ...newFork(newConditionRow("payment_status")),
  condition: paid(),
  yes,
  no,
  ...over,
});
const tree = (steps: StepData[], f: ForkData | null = null): SequenceData => ({ steps, fork: f });

/** What the API stores for a body, plus the templates it writes. */
function store(body: ReturnType<typeof buildPlanFromTree>["body"], flowId = "f1") {
  const templates = new Map<string, TemplateCopy>();
  const steps = body.steps.map((s) => {
    const slug = `flow-${flowId}-step-${s.order}`;
    templates.set(slug, { subject: s.subject, body_html: s.body_html, body_text: s.body_text ?? null });
    return {
      order: s.order,
      action_type: s.action_type,
      delay: s.delay,
      window_policy: s.window_policy,
      template_ref: slug,
      ...(s.condition ? { condition: s.condition } : {}),
      ...(s.exit_condition ? { exit_condition: s.exit_condition } : {}),
      ...(s.next !== undefined ? { next: s.next } : {}),
    };
  });
  const plan = {
    ...(body.version ? { version: body.version } : {}),
    trigger: { type: "event", condition: { event: "signed_up" } },
    steps,
    ...(body.branches?.length ? { branches: body.branches } : {}),
    ...(body.exit_conditions?.length ? { exit_conditions: body.exit_conditions } : {}),
  };
  expect(compiledPlanSchema.safeParse(plan).success).toBe(true);
  return { plan, templates };
}

function roundTrip(original: SequenceData, planExit?: ConditionState) {
  const first = buildPlanFromTree(original, planExit);
  expect(first.errors).toEqual({});
  const { plan, templates } = store(first.body);
  const loaded = treeFromPlan(plan, templates);
  expect(loaded.ok).toBe(true);
  if (!loaded.ok) throw new Error(loaded.reason);
  const second = buildPlanFromTree(loaded.tree, loaded.planExit);
  expect(second.errors).toEqual({});
  expect(second.body).toEqual(first.body);
  return loaded;
}

describe("treeFromPlan round trips", () => {
  it("a straight line", () => {
    const loaded = roundTrip(tree([email(), email({ delay: "2h", window_policy: "immediate" }), email()]));
    expect(loaded.tree.steps).toHaveLength(3);
    expect(loaded.tree.fork).toBeNull();
  });

  it("per-email conditions and a plan-level stop condition", () => {
    roundTrip(tree([email({ condition: paid() }), email({ exit_condition: paid() })]), paid());
  });

  it("a condition split with emails on both paths", () => {
    const loaded = roundTrip(tree([email()], fork(tree([email(), email()]), tree([email()]), { delay: "3d" })));
    expect(loaded.tree.fork?.kind).toBe("condition");
    expect(loaded.tree.fork?.yes.steps).toHaveLength(2);
  });

  it("a wait-until split", () => {
    const loaded = roundTrip(tree([email()], fork(tree([email()]), tree([email()]), { early: true, delay: "7d" })));
    expect(loaded.tree.fork?.early).toBe(true);
    expect(loaded.tree.fork?.delay).toBe("7d");
  });

  it("an A/B split keeps its percentage", () => {
    const loaded = roundTrip(tree([email()], fork(tree([email()]), tree([email(), email()]), { kind: "split", percent_a: 30, delay: "0m" })));
    expect(loaded.tree.fork?.kind).toBe("split");
    expect(loaded.tree.fork?.percent_a).toBe(30);
  });

  it("a holdout (one path is empty and ends the flow), on either side", () => {
    const yesHeld = roundTrip(tree([], fork(emptySequence(), tree([email()]), { kind: "split", percent_a: 10, delay: "0m" })));
    expect(yesHeld.tree.fork?.yes.steps).toHaveLength(0);
    const noHeld = roundTrip(tree([email()], fork(tree([email()]), emptySequence(), { kind: "split", percent_a: 90, delay: "0m" })));
    expect(noHeld.tree.fork?.no.steps).toHaveLength(0);
  });

  it("nested splits of every kind", () => {
    const inner = fork(tree([email()]), emptySequence(), { early: true, delay: "5d" });
    const ab = fork(tree([email()], inner), tree([email()]), { kind: "split", percent_a: 50, delay: "0m" });
    roundTrip(tree([email()], fork(tree([email()], ab), tree([email()]))), paid());
  });

  it("restores subject and body from the templates, not the plan", () => {
    const original = tree([email({ subject: "Hello {{contact.first_name|there}}", body_html: "<p>Hi</p>", body_text: "Hi" })]);
    const loaded = roundTrip(original);
    expect(loaded.tree.steps[0]).toMatchObject({ subject: "Hello {{contact.first_name|there}}", body_html: "<p>Hi</p>", body_text: "Hi" });
  });

  it("a differently listed tree still loads", () => {
    const { plan, templates } = store(buildPlanFromTree(tree([email()], fork(tree([email()]), tree([email()])))).body);
    expect(treeFromPlan({ ...plan, steps: [...plan.steps].reverse() }, templates).ok).toBe(true);
  });
});

describe("treeFromPlan refuses what the editor cannot draw", () => {
  const base = () => store(buildPlanFromTree(tree([email()], fork(tree([email()]), tree([email()])))).body);

  it("paths that rejoin", () => {
    const { plan, templates } = base();
    // Orders: 1 email, 2 split, 3 yes email, 4 no email. Make the yes email continue into the no email.
    const rejoined = { ...plan, steps: plan.steps.map((s) => (s.order === 3 ? { ...s, next: 4 } : s)) };
    expect(treeFromPlan(rejoined, templates).ok).toBe(false);
  });

  it("a step jumping over another with next", () => {
    const { plan, templates } = store(buildPlanFromTree(tree([email(), email(), email()])).body);
    const jumpy = { ...plan, version: 2 as const, steps: plan.steps.map((s) => (s.order === 1 ? { ...s, next: 3 } : s)) };
    expect(treeFromPlan(jumpy, templates).ok).toBe(false); // step 2 is never reached
  });

  it("a loop", () => {
    const { plan, templates } = store(buildPlanFromTree(tree([email(), email()])).body);
    const looping = { ...plan, version: 2 as const, steps: plan.steps.map((s) => (s.order === 2 ? { ...s, next: 1 } : s)) };
    expect(treeFromPlan(looping, templates).ok).toBe(false);
  });

  it("a missing template", () => {
    const { plan } = base();
    expect(treeFromPlan(plan, new Map()).ok).toBe(false);
  });

  it("more than one stop condition", () => {
    const { plan, templates } = store(buildPlanFromTree(tree([email()])).body);
    const two = { ...plan, exit_conditions: [{ condition: { lifecycle_state: "churned" } }, { condition: { lifecycle_state: "dormant" } }] };
    expect(treeFromPlan(two, templates).ok).toBe(false);
  });

  it("nothing to load", () => {
    expect(treeFromPlan(null, new Map()).ok).toBe(false);
    expect(treeFromPlan({ steps: [] }, new Map()).ok).toBe(false);
  });
});
