/**
 * Flow conditions in the editor: rows <-> API shape, plain-English summaries, the plan body, the component.
 *
 * The contract tests run everything the editor can produce through the SERVER's schema
 * (packages/core/src/flow/condition.ts), so the two cannot drift apart unnoticed.
 */
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  MAX_CONDITION_ROWS,
  changeConditionField,
  changeConditionOp,
  conditionToState,
  describeCondition,
  emptyConditionState,
  newConditionRow,
  opsFor,
  stateToCondition,
  type ConditionRow,
  type ConditionState,
} from "../src/conditions.js";
import { ConditionEditor } from "../src/components/condition-editor.js";
import { buildPlanWithConditions, buildPlanBody, type StepData } from "../src/components/step-writer.js";
import { conditionSchema, MAX_CONDITION_LEAVES } from "../../../packages/core/src/flow/condition.js";
import { compiledPlanSchema } from "../../../packages/core/src/flow/compiled-plan.js";

const row = (over: Partial<ConditionRow>): ConditionRow => ({ ...newConditionRow(), ...over });
const state = (rows: ConditionRow[], match: "all" | "any" = "all"): ConditionState => ({ match, rows });

describe("stateToCondition", () => {
  it("no rows means no condition", () => {
    expect(stateToCondition(emptyConditionState())).toEqual({ condition: null, errors: {} });
  });

  it("one row is a bare leaf, several are an all/any group", () => {
    const paid = row({ field: "payment_status", op: "is", value: "paid" });
    const plan = row({ field: "plan", op: "is", value: "Pro" });
    expect(stateToCondition(state([paid])).condition).toEqual({ field: "payment_status", op: "is", value: "paid" });
    expect(stateToCondition(state([paid, plan])).condition).toEqual({
      all: [{ field: "payment_status", op: "is", value: "paid" }, { field: "plan", op: "is", value: "Pro" }],
    });
    expect(stateToCondition(state([paid, plan], "any")).condition).toEqual({
      any: [{ field: "payment_status", op: "is", value: "paid" }, { field: "plan", op: "is", value: "Pro" }],
    });
  });

  it("builds event rows with each kind of window", () => {
    const within = row({ field: "event", op: "not_performed", name: " exported ", window: "within_days", days: "7" });
    const step = row({ field: "event", op: "performed", name: "login", window: "step" });
    const flow = row({ field: "event", op: "performed", name: "login", window: "flow", minCount: "3" });
    const once = row({ field: "event", op: "performed", name: "login", window: "flow", minCount: "1" });
    expect(stateToCondition(state([within])).condition).toEqual({ field: "event", name: "exported", op: "not_performed", within_days: 7 });
    expect(stateToCondition(state([step])).condition).toEqual({ field: "event", name: "login", op: "performed", since: "step" });
    expect(stateToCondition(state([flow])).condition).toEqual({ field: "event", name: "login", op: "performed", since: "flow", min_count: 3 });
    expect(stateToCondition(state([once])).condition).toEqual({ field: "event", name: "login", op: "performed", since: "flow" }); // "1 time" is just "did"
  });

  it("builds lifecycle rows in the original shapes", () => {
    expect(stateToCondition(state([row({ field: "lifecycle_state", op: "is", value: "at_risk" })])).condition).toEqual({ lifecycle_state: "at_risk" });
    expect(stateToCondition(state([row({ field: "lifecycle_state", op: "is_not", value: "engaged" })])).condition).toEqual({ lifecycle_state_not: "engaged" });
  });

  it("reports each bad row and sends nothing while any remain", () => {
    const rows = [
      row({ field: "event", op: "performed", name: "", window: "flow" }),
      row({ field: "event", op: "performed", name: "x", window: "within_days", days: "0" }),
      row({ field: "event", op: "performed", name: "x", window: "within_days", days: "400" }),
      row({ field: "event", op: "performed", name: "x", window: "flow", minCount: "many" }),
      row({ field: "lifecycle_state", op: "is", value: "" }),
      row({ field: "plan", op: "is", value: "" }),
      row({ field: "trait", key: "", op: "is", value: "x" }),
      row({ field: "payment_status", op: "is", value: "paid" }),
    ];
    const result = stateToCondition(state(rows));
    expect(result.condition).toBeNull();
    expect(Object.keys(result.errors)).toEqual(rows.slice(0, 7).map((r) => r.id));
  });
});

describe("changing a row", () => {
  it("changing the field restarts the row but keeps its place", () => {
    const before = row({ field: "event", name: "x" });
    const after = changeConditionField(before, "payment_status");
    expect(after).toMatchObject({ id: before.id, field: "payment_status", op: "is", name: "" });
  });

  it("offers sensible operators per field", () => {
    expect(opsFor("event")).toEqual(["performed", "not_performed"]);
    expect(opsFor("lifecycle_state")).toEqual(["is", "is_not"]);
    expect(opsFor("has_email")).toEqual(["is"]);
  });

  it("'is one of' keeps the value, and back keeps the first", () => {
    const r = changeConditionOp(row({ field: "payment_status", op: "is", value: "paid" }), "in");
    expect(r.values).toEqual(["paid"]);
    expect(changeConditionOp({ ...r, values: ["trial", "paid"] }, "is").value).toBe("trial");
  });
});

describe("conditionToState", () => {
  it("nothing stored is simply no rows", () => {
    expect(conditionToState(undefined)).toEqual({ state: emptyConditionState(), unreadable: false });
  });

  it("round-trips what the editor builds", () => {
    const original = state(
      [
        row({ field: "payment_status", op: "in", values: ["trial", "paid"] }),
        row({ field: "event", op: "not_performed", name: "exported", window: "within_days", days: "14" }),
        row({ field: "lifecycle_state", op: "is_not", value: "dormant" }),
        row({ field: "trait", key: "seats", op: "gt", value: "5" }),
      ],
      "any",
    );
    const { condition } = stateToCondition(original);
    const back = conditionToState(condition);
    expect(back.unreadable).toBe(false);
    expect(back.state.match).toBe("any");
    expect(stateToCondition(back.state).condition).toEqual(condition);
  });

  it("shows the original event_since_step shape as the equivalent event row", () => {
    const { state: s, unreadable } = conditionToState({ event_since_step: "feature_used" });
    expect(unreadable).toBe(false);
    expect(s.rows[0]).toMatchObject({ field: "event", op: "performed", name: "feature_used", window: "step" });
  });

  it("will not flatten nested groups: it says it cannot show them", () => {
    const nested = { all: [{ field: "plan", op: "is", value: "Pro" }, { any: [{ lifecycle_state: "a" }, { lifecycle_state: "b" }] }] };
    expect(conditionToState(nested).unreadable).toBe(true);
  });

  it("never guesses at a shape it does not know", () => {
    for (const bad of [{ nope: 1 }, "paid", { all: [] }, { all: [{ field: "event", name: "x", op: "performed" }] }, { all: [{ lifecycle_state: "x" }], extra: 1 }]) {
      expect(conditionToState(bad).unreadable).toBe(true);
    }
  });
});

describe("describeCondition", () => {
  it("reads like a sentence", () => {
    expect(describeCondition({ lifecycle_state: "at_risk" })).toBe("lifecycle stage is at_risk");
    expect(describeCondition({ field: "payment_status", op: "is", value: "paid" })).toBe("payment status is paid");
    expect(describeCondition({ field: "event", name: "exported", op: "not_performed", within_days: 7 })).toBe("did not do exported in the last 7 days");
    expect(describeCondition({ field: "event", name: "login", op: "performed", since: "flow", min_count: 3 })).toBe("did login at least 3 times since entering the flow");
    expect(describeCondition({ field: "event", name: "login", op: "performed", within_days: 1 })).toBe("did login in the last 1 day");
  });

  it("groups read with and / or, in brackets", () => {
    expect(describeCondition({ all: [{ field: "plan", op: "is", value: "Pro" }, { field: "has_email", op: "is", value: true }] })).toBe(
      "(plan is Pro and has an email address)",
    );
    expect(describeCondition({ any: [{ lifecycle_state: "a" }, { all: [{ lifecycle_state: "b" }, { lifecycle_state_not: "c" }] }] })).toBe(
      "(lifecycle stage is a or (lifecycle stage is b and lifecycle stage is not c))",
    );
  });

  it("never throws on a shape it does not know", () => {
    expect(() => describeCondition(null)).not.toThrow();
    expect(() => describeCondition({ whatever: 1 })).not.toThrow();
    expect(() => describeCondition("x")).not.toThrow();
  });
});

describe("the plan body", () => {
  const step = (over: Partial<StepData> = {}): StepData => ({
    order: 1,
    delay: "0m",
    action_type: "nurture_value",
    subject: "Hi",
    body_html: "<p>Hi</p>",
    body_text: "",
    window_policy: "respect_window",
    ...over,
  });

  it("a step with no conditions produces exactly the original body", () => {
    const { body, errors } = buildPlanWithConditions([step()]);
    expect(errors).toEqual({});
    expect(body).toEqual(buildPlanBody([step()]));
    expect(body.exit_conditions).toBeUndefined();
  });

  it("carries step conditions, step exits and a plan exit", () => {
    const cond = state([row({ field: "payment_status", op: "is", value: "paid" })]);
    const exit = state([row({ field: "plan", op: "is", value: "Pro" })]);
    const planExit = state([row({ field: "event", op: "performed", name: "upgraded", window: "flow" })]);
    const { body, errors } = buildPlanWithConditions([step({ condition: cond, exit_condition: exit })], planExit);
    expect(errors).toEqual({});
    expect(body.steps[0]!.condition).toEqual({ field: "payment_status", op: "is", value: "paid" });
    expect(body.steps[0]!.exit_condition).toEqual({ field: "plan", op: "is", value: "Pro" });
    expect(body.exit_conditions).toEqual([{ condition: { field: "event", name: "upgraded", op: "performed", since: "flow" } }]);
  });

  it("collects errors from steps and the plan exit together, keyed by row", () => {
    const bad1 = row({ field: "plan", op: "is", value: "" });
    const bad2 = row({ field: "event", op: "performed", name: "", window: "flow" });
    const { errors } = buildPlanWithConditions([step({ condition: state([bad1]) })], state([bad2]));
    expect(Object.keys(errors).sort()).toEqual([bad1.id, bad2.id].sort());
  });

  it("the whole body is accepted as a compiled plan by the server's schema", () => {
    const { body } = buildPlanWithConditions(
      [
        step({ condition: state([row({ field: "payment_status", op: "is", value: "paid" }), row({ field: "event", op: "not_performed", name: "x", window: "within_days", days: "7" })], "all") }),
        step({ order: 2, delay: "2d", exit_condition: state([row({ field: "lifecycle_state", op: "is", value: "churned" })]) }),
      ],
      state([row({ field: "payment_status", op: "is", value: "cancelled" }), row({ field: "event", op: "performed", name: "upgraded", window: "flow" })], "any"),
    );
    const plan = {
      trigger: { type: "event", condition: {} },
      steps: body.steps.map((s) => ({ order: s.order, action_type: s.action_type, delay: s.delay, condition: s.condition, exit_condition: s.exit_condition })),
      exit_conditions: body.exit_conditions,
    };
    expect(compiledPlanSchema.safeParse(plan).success).toBe(true);
  });
});

describe("ConditionEditor", () => {
  const render = (s: ConditionState, errors: Record<string, string> = {}, extra: Record<string, unknown> = {}) =>
    renderToStaticMarkup(createElement(ConditionEditor, { state: s, onChange: () => {}, errors, emptyText: "Always sent.", ...extra }));

  it("with no rows shows the empty text and an add button", () => {
    const html = render(emptyConditionState());
    expect(html).toContain("Always sent.");
    expect(html).toContain("Add a condition");
  });

  it("shows the match chooser only when there are two or more rows", () => {
    expect(render(state([row({})]))).not.toContain("Match all or any");
    expect(render(state([row({}), row({})]))).toContain("Match all or any");
  });

  it("words the joiner by the match: and / or", () => {
    expect(render(state([row({}), row({})], "all"))).toContain(">and<");
    expect(render(state([row({}), row({})], "any"))).toContain(">or<");
  });

  it("an event row shows its event name, comparison, window and day count", () => {
    const html = render(state([row({ field: "event", op: "not_performed", name: "exported", window: "within_days", days: "7" })]));
    expect(html).toContain('aria-label="Condition 1 event name"');
    expect(html).toContain('value="exported"');
    expect(html).toContain("did not");
    expect(html).toContain('aria-label="Condition 1 number of days"');
  });

  it("leaves out the 'since this step' window for a plan-level exit", () => {
    const r = state([row({ field: "event", op: "performed", name: "x", window: "flow" })]);
    expect(render(r)).toContain("since this step");
    expect(render(r, {}, { allowStepWindow: false })).not.toContain("since this step");
  });

  it("offers a 'did this many times' box only for 'did'", () => {
    expect(render(state([row({ field: "event", op: "performed", name: "x", window: "flow" })]))).toContain("at least this many times");
    expect(render(state([row({ field: "event", op: "not_performed", name: "x", window: "flow" })]))).not.toContain("at least this many times");
  });

  it("a lifecycle row lists the stages; a contact row reuses the audience controls", () => {
    expect(render(state([row({ field: "lifecycle_state", op: "is", value: "at_risk" })]))).toContain(">dormant<");
    expect(render(state([row({ field: "trait", key: "seats", op: "gt", value: "5" })]))).toContain('aria-label="Condition 1 trait name"');
  });

  it("shows a row's problem next to it, and stops adding at the limit", () => {
    const r = row({ field: "plan", op: "is", value: "" });
    expect(render(state([r]), { [r.id]: "Enter the plan name." })).toContain("Enter the plan name.");
    const full = render(state(Array.from({ length: MAX_CONDITION_ROWS }, () => row({}))));
    expect(full).toContain(`Up to ${MAX_CONDITION_ROWS} conditions.`);
  });
});

describe("contract with the server", () => {
  it("every row kind the editor can build is accepted by the server schema", () => {
    const kinds: ConditionRow[] = [
      row({ field: "event", op: "performed", name: "a", window: "within_days", days: "365" }),
      row({ field: "event", op: "not_performed", name: "a", window: "step" }),
      row({ field: "event", op: "performed", name: "a", window: "flow", minCount: "100" }),
      row({ field: "lifecycle_state", op: "is", value: "resurrected" }),
      row({ field: "lifecycle_state", op: "is_not", value: "signed_up" }),
      row({ field: "payment_status", op: "in", values: ["free", "trial", "paid", "past_due", "cancelled"] }),
      row({ field: "engagement_depth", op: "is_not", value: "minimal" }),
      row({ field: "plan", op: "is", value: "Pro" }),
      row({ field: "has_email", op: "is", value: "no" }),
      row({ field: "trait", key: "a.b-c_d", op: "contains", value: "x" }),
      row({ field: "trait", key: "n", op: "lt", value: "-2.5" }),
      row({ field: "trait", key: "n", op: "is_set" }),
    ];
    for (const r of kinds) {
      const { condition, errors } = stateToCondition(state([r]));
      expect(errors).toEqual({});
      expect(conditionSchema.safeParse(condition).success).toBe(true);
    }
  });

  it("the biggest condition the editor allows is accepted, and the limits match the server's", () => {
    expect(MAX_CONDITION_ROWS).toBe(MAX_CONDITION_LEAVES);
    const rows = Array.from({ length: MAX_CONDITION_ROWS }, () => row({ field: "plan", op: "is", value: "Pro" }));
    for (const match of ["all", "any"] as const) {
      expect(conditionSchema.safeParse(stateToCondition(state(rows, match)).condition).success).toBe(true);
    }
  });
});
