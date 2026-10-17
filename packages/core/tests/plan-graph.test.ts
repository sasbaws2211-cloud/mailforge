/**
 * Plan graphs: what makes a branching flow safe to run, and that old straight-line plans are untouched.
 */
import { describe, it, expect } from "vitest";
import {
  analyzePlanGraph,
  compiledPlanSchema,
  defaultNext,
  stepTarget,
  MAX_PLAN_NODES,
  MAX_BRANCH_DEPTH,
  type PlanGraphInput,
} from "../src/index.js";

const email = (order: number, next?: number | "end") => ({ order, ...(next !== undefined ? { next } : {}) });
const fork = (order: number, then: number | "end", otherwise: number | "end") => ({ order, then, else: otherwise });
const v2 = (steps: PlanGraphInput["steps"], branches: NonNullable<PlanGraphInput["branches"]> = []): PlanGraphInput => ({ version: 2, steps, branches });

describe("a plain list of steps", () => {
  it("is fine without a version, and may not use version 2 features", () => {
    expect(analyzePlanGraph({ steps: [email(1), email(2), email(3)] })).toEqual([]);
    expect(analyzePlanGraph({ steps: [email(1)], branches: [fork(2, "end", "end")] })).toEqual(["branches need plan version 2"]);
    expect(analyzePlanGraph({ steps: [email(1, 2), email(2)] })).toEqual(["next needs plan version 2"]);
  });

  it("is fine as version 2 too: each step goes to the next-higher order", () => {
    expect(analyzePlanGraph(v2([email(1), email(2), email(3)]))).toEqual([]);
  });
});

describe("where a step goes next", () => {
  it("defaults to the next-higher order among all nodes, or the end", () => {
    const plan = v2([email(1), email(5), email(7)], [fork(3, 5, 7)]);
    expect(defaultNext(plan, 1)).toBe(3); // a branch counts
    expect(defaultNext(plan, 3)).toBe(5);
    expect(defaultNext(plan, 7)).toBe("end");
  });

  it("an explicit next wins", () => {
    const plan = v2([email(1, 7), email(2), email(7)]);
    expect(stepTarget(plan, plan.steps[0]!)).toBe(7);
    expect(stepTarget(plan, plan.steps[1]!)).toBe(7);
    expect(stepTarget(plan, email(1, "end"))).toBe("end");
  });
});

describe("valid branching plans", () => {
  it("a fork with two paths that each end", () => {
    // 1 email -> 2 fork -> 3 (yes) or 4 (no); 3 and 4 end
    expect(analyzePlanGraph(v2([email(1), email(3, "end"), email(4, "end")], [fork(2, 3, 4)]))).toEqual([]);
  });

  it("paths that rejoin", () => {
    expect(analyzePlanGraph(v2([email(1), email(3, 5), email(4, 5), email(5)], [fork(2, 3, 4)]))).toEqual([]);
  });

  it("a fork may start the flow, and a branch may lead straight to the end", () => {
    expect(analyzePlanGraph(v2([email(2, "end")], [fork(1, 2, "end")]))).toEqual([]);
  });

  it("forks chained back to back", () => {
    expect(analyzePlanGraph(v2([email(4, "end"), email(5, "end")], [fork(1, 2, 5), fork(2, 3, 5), fork(3, 4, 5)]))).toEqual([]);
  });
});

describe("plans that are refused", () => {
  it("a loop", () => {
    const problems = analyzePlanGraph(v2([email(1), email(2, 1)]));
    expect(problems[0]).toMatch(/loops back to order 1/);
    expect(analyzePlanGraph(v2([email(2), email(3, "end")], [fork(1, 2, 3), fork(4, 1, 1)]))[0]).toMatch(/can never be reached/);
    expect(analyzePlanGraph(v2([email(1), email(3)], [fork(2, 3, 1)]))[0]).toMatch(/loops back to order 1/);
  });

  it("a step that goes to itself", () => {
    expect(analyzePlanGraph(v2([email(1, 1)]))[0]).toMatch(/leads back to itself/);
  });

  it("a target that does not exist", () => {
    expect(analyzePlanGraph(v2([email(1, 9)]))[0]).toMatch(/nothing has order 9/);
    expect(analyzePlanGraph(v2([email(1), email(3, "end")], [fork(2, 3, 8)]))[0]).toMatch(/nothing has order 8/);
  });

  it("two nodes with the same order, even if one is a branch", () => {
    expect(analyzePlanGraph(v2([email(1), email(2)], [fork(2, "end", "end")]))[0]).toMatch(/order 2 is used by more than one/);
    expect(analyzePlanGraph(v2([email(1), email(1)]))[0]).toMatch(/order 1 is used by more than one/);
  });

  it("no starting node", () => {
    expect(analyzePlanGraph(v2([email(2), email(3)]))[0]).toMatch(/no step or branch with order 1/);
  });

  it("something nothing leads to", () => {
    const problems = analyzePlanGraph(v2([email(1, "end"), email(2)]));
    expect(problems).toEqual(["order 2 can never be reached from the start"]);
  });

  it("too many nodes", () => {
    const steps = Array.from({ length: MAX_PLAN_NODES + 1 }, (_, i) => email(i + 1));
    expect(analyzePlanGraph(v2(steps))[0]).toMatch(/at most 30/);
    expect(analyzePlanGraph(v2(steps.slice(0, MAX_PLAN_NODES)))).toEqual([]);
  });

  it("too many forks on one path", () => {
    const chain = (n: number) => Array.from({ length: n }, (_, i) => fork(i + 1, i + 2, i + 2));
    // n forks followed by one email at order n+1
    const plan = (n: number) => v2([email(n + 1, "end")], chain(n));
    expect(analyzePlanGraph(plan(MAX_BRANCH_DEPTH))).toEqual([]);
    expect(analyzePlanGraph(plan(MAX_BRANCH_DEPTH + 1))[0]).toMatch(/at most 3 branches/);
  });

  it("forks side by side are not 'deep'", () => {
    // one fork leading to two emails; plenty of forks overall but never more than one on a path
    const plan = v2([email(2, "end"), email(3, "end")], [fork(1, 2, 3)]);
    expect(analyzePlanGraph(plan)).toEqual([]);
  });
});

describe("through the plan schema", () => {
  const base = {
    trigger: { type: "event", condition: {} },
    steps: [
      { order: 1, action_type: "nurture_value", delay: "0m" },
      { order: 3, action_type: "nurture_value", delay: "0m", next: "end" },
      { order: 4, action_type: "nurture_reactivate", delay: "0m" },
    ],
    branches: [{ order: 2, delay: "3d", condition: { field: "payment_status", op: "is", value: "paid" }, then: 3, else: 4 }],
  };

  it("accepts a version 2 plan with a branch", () => {
    expect(compiledPlanSchema.safeParse({ ...base, version: 2 }).success).toBe(true);
  });

  it("refuses the same plan without the version", () => {
    const r = compiledPlanSchema.safeParse(base);
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toMatch(/plan version 2/);
  });

  it("reports a loop as an issue on the plan", () => {
    const looped = { ...base, version: 2, steps: [{ ...base.steps[0], next: 2 }, ...base.steps.slice(1)], branches: [{ ...base.branches[0], else: 1 }] };
    const r = compiledPlanSchema.safeParse(looped);
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toMatch(/loops back/);
  });

  it("a branch needs a condition the engine knows, and both ways out", () => {
    const bad = (branch: unknown) => compiledPlanSchema.safeParse({ ...base, version: 2, branches: [branch] }).success;
    expect(bad({ ...base.branches[0], condition: { nope: 1 } })).toBe(false);
    expect(bad({ order: 2, delay: "3d", condition: { lifecycle_state: "x" }, then: 3 })).toBe(false);
    expect(bad({ ...base.branches[0], then: 0 })).toBe(false);
    expect(bad({ ...base.branches[0], then: "finish" })).toBe(false);
    expect(bad({ ...base.branches[0], delay: "soon" })).toBe(false);
    expect(bad({ ...base.branches[0], extra: 1 })).toBe(false);
  });

  it("only version 2 is a version", () => {
    expect(compiledPlanSchema.safeParse({ ...base, version: 3 }).success).toBe(false);
    expect(compiledPlanSchema.safeParse({ ...base, version: 1 }).success).toBe(false);
  });

  it("an ordinary plan is exactly as before", () => {
    const plain = { trigger: { type: "event", condition: {} }, steps: [{ order: 1, action_type: "x", delay: "0m" }, { order: 2, action_type: "y", delay: "1d" }] };
    expect(compiledPlanSchema.safeParse(plain).success).toBe(true);
    expect(compiledPlanSchema.safeParse({ ...plain, steps: [{ ...plain.steps[0], next: 2 }, plain.steps[1]] }).success).toBe(false);
  });
});
