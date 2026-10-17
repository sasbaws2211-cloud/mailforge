/**
 * The flow tree: measuring it, turning it into a plan the server accepts, and turning any stored plan into an
 * outline. The server's own plan schema is the judge: every tree the editor can build must pass it.
 */
import { describe, it, expect } from "vitest";
import {
  MAX_FLOW_NODES,
  MAX_FORK_DEPTH,
  allEmails,
  buildPlanFromTree,
  canAddFork,
  countEmails,
  countNodes,
  emptySequence,
  forkDepth,
  hasFork,
  newFork,
  planOutline,
  type ForkData,
  type SequenceData,
} from "../src/flow-tree.js";
import { newConditionRow, emptyConditionState, type ConditionState } from "../src/conditions.js";
import { buildPlanBody, type StepData } from "../src/components/step-writer.js";
import { compiledPlanSchema } from "../../../packages/core/src/flow/compiled-plan.js";

let seq = 0;
const email = (over: Partial<StepData> = {}): StepData => ({
  order: ++seq,
  delay: "0m",
  action_type: "nurture_value",
  subject: `Subject ${seq}`,
  body_html: `<p>Body ${seq}</p>`,
  body_text: "",
  window_policy: "respect_window",
  ...over,
});

const paid = (): ConditionState => ({
  match: "all",
  rows: [{ ...newConditionRow("payment_status"), op: "is", value: "paid" }],
});

const fork = (yes: SequenceData = emptySequence(), no: SequenceData = emptySequence(), over: Partial<ForkData> = {}): ForkData => ({
  ...newFork(newConditionRow("payment_status")),
  condition: paid(),
  yes,
  no,
  ...over,
});

const sequence = (steps: StepData[], f: ForkData | null = null): SequenceData => ({ steps, fork: f });

/** A plan the server will judge: the body plus the parts the server adds. */
const asServerPlan = (body: ReturnType<typeof buildPlanFromTree>["body"]) => ({
  ...(body.version ? { version: body.version } : {}),
  trigger: { type: "event", condition: { event: "signed_up" } },
  steps: body.steps.map((s) => ({
    order: s.order,
    action_type: s.action_type,
    delay: s.delay,
    window_policy: s.window_policy,
    ...(s.condition ? { condition: s.condition } : {}),
    ...(s.exit_condition ? { exit_condition: s.exit_condition } : {}),
    ...(s.next !== undefined ? { next: s.next } : {}),
  })),
  ...(body.branches ? { branches: body.branches } : {}),
  ...(body.exit_conditions ? { exit_conditions: body.exit_conditions } : {}),
});

describe("measuring a tree", () => {
  it("counts emails and splits everywhere", () => {
    const tree = sequence([email(), email()], fork(sequence([email()], fork(sequence([email()]), emptySequence())), sequence([email(), email()])));
    expect(countEmails(tree)).toBe(6);
    expect(countNodes(tree)).toBe(8); // 6 emails + 2 splits
    expect(allEmails(tree)).toHaveLength(6);
    expect(forkDepth(tree)).toBe(2);
    expect(hasFork(tree)).toBe(true);
    expect(hasFork(sequence([email()]))).toBe(false);
    expect(forkDepth(sequence([email()]))).toBe(0);
  });

  it("allows a split only at the end of a path, within the depth and size limits", () => {
    const plain = sequence([email()]);
    expect(canAddFork(plain, 0, 1)).toBe(true);
    expect(canAddFork(sequence([email()], fork()), 0, 2)).toBe(false); // already ends in one
    expect(canAddFork(plain, MAX_FORK_DEPTH, 1)).toBe(false); // too deep
    expect(canAddFork(plain, 0, MAX_FLOW_NODES)).toBe(false); // flow is full
  });
});

describe("a tree with no split", () => {
  it("is exactly the straight-line plan the editor has always sent", () => {
    const steps = [email({ order: 1 }), email({ order: 2, delay: "2d" })]; // the editor keeps orders as 1, 2, 3...
    const built = buildPlanFromTree(sequence(steps));
    expect(built.branching).toBe(false);
    expect(built.errors).toEqual({});
    expect(built.body).toEqual(buildPlanBody(steps));
    expect(built.body.version).toBeUndefined();
    expect(built.body.branches).toBeUndefined();
    expect(built.body.steps.every((s) => s.next === undefined)).toBe(true);
  });
});

describe("numbering without a split", () => {
  it("is by position, whatever order values the steps happen to carry", () => {
    const { body } = buildPlanFromTree(sequence([email({ order: 40 }), email({ order: 7 }), email({ order: 99 })]));
    expect(body.steps.map((s) => s.order)).toEqual([1, 2, 3]);
  });
});

describe("a tree with a split", () => {
  // emails 1, 2 then a split: yes -> email, no -> email, email
  const tree = () => sequence([email(), email({ delay: "1d" })], fork(sequence([email()]), sequence([email(), email()])));

  it("numbers every node once, in reading order, and links them with next", () => {
    const { body, errors, branching } = buildPlanFromTree(tree());
    expect(branching).toBe(true);
    expect(errors).toEqual({});
    expect(body.version).toBe(2);
    // 1, 2 emails; 3 the split; 4 the yes email; 5, 6 the no emails
    expect(body.steps.map((s) => [s.order, s.next])).toEqual([[1, 2], [2, 3], [4, "end"], [5, 6], [6, "end"]]);
    expect(body.branches).toHaveLength(1);
    expect(body.branches![0]).toMatchObject({ order: 3, delay: "3d", then: 4, else: 5 });
    expect(body.branches![0]!.condition).toEqual({ field: "payment_status", op: "is", value: "paid" });
  });

  it("a split can start the flow, and either path can be empty (the flow ends there)", () => {
    const first = buildPlanFromTree(sequence([], fork(sequence([email()]), emptySequence())));
    expect(first.errors).toEqual({});
    expect(first.body.branches![0]).toMatchObject({ order: 1, then: 2, else: "end" });
    const both = buildPlanFromTree(sequence([email()], fork()));
    expect(both.body.branches![0]).toMatchObject({ order: 2, then: "end", else: "end" });
  });

  it("carries each email's own conditions and the flow-wide exit", () => {
    const withConditions = email({ condition: paid(), exit_condition: { match: "all", rows: [{ ...newConditionRow("plan"), op: "is", value: "Pro" }] } });
    const planExit: ConditionState = { match: "all", rows: [{ ...newConditionRow("event"), op: "performed", name: "upgraded", window: "flow" }] };
    const { body, errors } = buildPlanFromTree(sequence([withConditions], fork()), planExit);
    expect(errors).toEqual({});
    expect(body.steps[0]!.condition).toEqual({ field: "payment_status", op: "is", value: "paid" });
    expect(body.steps[0]!.exit_condition).toEqual({ field: "plan", op: "is", value: "Pro" });
    expect(body.exit_conditions).toEqual([{ condition: { field: "event", name: "upgraded", op: "performed", since: "flow" } }]);
  });

  it("reports a split with no condition, and bad condition rows, keyed so the editor can show them", () => {
    const noCondition = fork(emptySequence(), emptySequence(), { condition: emptyConditionState() });
    const a = buildPlanFromTree(sequence([email()], noCondition));
    expect(a.errors[noCondition.id]).toMatch(/at least one condition/);

    const badRow = { ...newConditionRow("plan"), op: "is", value: "" };
    const b = buildPlanFromTree(sequence([email()], fork(emptySequence(), emptySequence(), { condition: { match: "all", rows: [badRow] } })));
    expect(b.errors[badRow.id]).toBeTruthy();
  });

  it("the server's schema accepts what the editor builds", () => {
    const { body } = buildPlanFromTree(tree());
    expect(compiledPlanSchema.safeParse(asServerPlan(body)).success).toBe(true);
  });
});

describe("any tree the editor can build is a plan the server accepts", () => {
  // A small deterministic generator, so a failure can be reproduced.
  const rng = (seed: number) => () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };

  const randomTree = (rand: () => number, depth: number, budget: { left: number }): SequenceData => {
    const steps: StepData[] = [];
    const count = Math.floor(rand() * 3);
    for (let i = 0; i < count && budget.left > 1; i++) {
      steps.push(email());
      budget.left--;
    }
    let f: ForkData | null = null;
    if (depth < MAX_FORK_DEPTH && budget.left > 2 && rand() < 0.6) {
      budget.left--;
      f = fork(randomTree(rand, depth + 1, budget), randomTree(rand, depth + 1, budget));
    }
    return sequence(steps, f);
  };

  it("holds for 300 random trees up to the limits", () => {
    const rand = rng(12345);
    let withForks = 0;
    for (let i = 0; i < 300; i++) {
      const tree = randomTree(rand, 0, { left: MAX_FLOW_NODES });
      if (countEmails(tree) === 0) continue; // a plan needs at least one email
      const built = buildPlanFromTree(tree);
      expect(built.errors).toEqual({});
      expect(countNodes(tree)).toBeLessThanOrEqual(MAX_FLOW_NODES);
      const result = compiledPlanSchema.safeParse(asServerPlan(built.body));
      if (!result.success) throw new Error(`tree ${i} was refused: ${JSON.stringify(result.error.issues)}`);
      if (built.branching) withForks++;
      // every email appears exactly once, and the plan starts at order 1
      expect(built.body.steps).toHaveLength(countEmails(tree));
      const orders = [...built.body.steps.map((s) => s.order), ...(built.body.branches ?? []).map((b) => b.order)];
      expect(new Set(orders).size).toBe(orders.length);
      expect(orders).toContain(1);
    }
    expect(withForks).toBeGreaterThan(50); // the generator really did make branching plans
  });

  it("the outline of the built plan shows every email exactly once, in a tree", () => {
    const rand = rng(777);
    for (let i = 0; i < 100; i++) {
      const tree = randomTree(rand, 0, { left: MAX_FLOW_NODES });
      if (countEmails(tree) === 0) continue;
      const { body } = buildPlanFromTree(tree);
      const lines = planOutline(asServerPlan(body));
      expect(lines.filter((l) => l.kind === "email")).toHaveLength(countEmails(tree));
      expect(lines.filter((l) => l.kind === "fork")).toHaveLength(body.branches?.length ?? 0);
      expect(lines.some((l) => l.kind === "rejoin")).toBe(false); // trees never rejoin
    }
  });
});

describe("wait-until splits", () => {
  it("a normal split never writes early", () => {
    const { body } = buildPlanFromTree(sequence([email()], fork()));
    expect("early" in body.branches![0]!).toBe(false);
  });

  it("a wait-until split writes early and keeps its deadline", () => {
    const { body, errors } = buildPlanFromTree(sequence([email()], fork(emptySequence(), emptySequence(), { early: true, delay: "7d" })));
    expect(errors).toEqual({});
    expect(body.branches![0]).toMatchObject({ order: 2, delay: "7d", early: true });
  });

  it("refuses a wait-until split with no deadline, naming the split", () => {
    const f = fork(emptySequence(), emptySequence(), { early: true, delay: "0m" });
    const { errors } = buildPlanFromTree(sequence([email()], f));
    expect(errors[`${f.id}-delay`]).toMatch(/longest to wait/);
  });

  it("an ordinary split may still check immediately", () => {
    const f = fork(emptySequence(), emptySequence(), { delay: "0m" });
    expect(buildPlanFromTree(sequence([email()], f)).errors).toEqual({});
  });

  it("the outline marks a wait-until split and leaves normal ones alone", () => {
    const e = (order: number, extra: Record<string, unknown> = {}) => ({ order, action_type: "x", delay: "0m", ...extra });
    const plan = (early: boolean) => ({
      version: 2,
      steps: [e(1, { next: 2 }), e(3, { next: "end" }), e(4, { next: "end" })],
      branches: [{ order: 2, delay: "3d", condition: { lifecycle_state: "a" }, then: 3, else: 4, ...(early ? { early: true } : {}) }],
    });
    const forkLine = (early: boolean) => planOutline(plan(early)).find((l) => l.kind === "fork") as { early: boolean };
    expect(forkLine(true).early).toBe(true);
    expect(forkLine(false).early).toBe(false);
  });
});

describe("planOutline", () => {
  const emailStep = (order: number, extra: Record<string, unknown> = {}) => ({ order, action_type: "x", delay: "0m", ...extra });
  const branch = (order: number, then: unknown, otherwise: unknown) => ({ order, delay: "3d", condition: { lifecycle_state: "a" }, then, else: otherwise });

  it("a straight-line plan is its steps in order", () => {
    const lines = planOutline({ steps: [emailStep(1), emailStep(2), emailStep(3)] });
    expect(lines.map((l) => (l.kind === "email" ? l.order : l.kind))).toEqual([1, 2, 3]);
    expect(lines.every((l) => l.depth === 0)).toBe(true);
  });

  it("a branching plan reads: emails, the split, then each path indented", () => {
    const plan = { version: 2, steps: [emailStep(1, { next: 2 }), emailStep(3, { next: "end" }), emailStep(4, { next: "end" })], branches: [branch(2, 3, 4)] };
    expect(planOutline(plan).map((l) => `${l.depth}:${l.kind === "email" || l.kind === "fork" || l.kind === "rejoin" ? `${l.kind}${l.order}` : l.kind === "path" ? l.label : l.kind}`)).toEqual([
      "0:email1",
      "0:fork2",
      "1:If yes",
      "2:email3",
      "2:end",
      "1:Otherwise",
      "2:email4",
      "2:end",
    ]);
  });

  it("an email with no next goes to the next-higher order, like the engine", () => {
    const plan = { version: 2, steps: [emailStep(1), emailStep(5)] };
    expect(planOutline(plan).filter((l) => l.kind === "email").map((l) => (l as { order: number }).order)).toEqual([1, 5]);
  });

  it("paths that rejoin say so instead of repeating the step", () => {
    const plan = { version: 2, steps: [emailStep(2, { next: 4 }), emailStep(3, { next: 4 }), emailStep(4, { next: "end" })], branches: [branch(1, 2, 3)] };
    const lines = planOutline(plan);
    expect(lines.filter((l) => l.kind === "email" && l.order === 4)).toHaveLength(1);
    expect(lines.filter((l) => l.kind === "rejoin")).toHaveLength(1);
  });

  it("cannot loop forever on a plan the engine would refuse", () => {
    const loop = { version: 2, steps: [emailStep(1, { next: 2 }), emailStep(2, { next: 1 })] };
    expect(planOutline(loop).length).toBeLessThan(10);
    const selfFork = { version: 2, steps: [emailStep(2)], branches: [branch(1, 1, 1)] };
    expect(planOutline(selfFork).length).toBeLessThan(10);
  });

  it("shows a missing target as an ending, and copes with nonsense", () => {
    expect(planOutline({ version: 2, steps: [emailStep(1, { next: 9 })] }).map((l) => l.kind)).toEqual(["email", "end"]);
    expect(planOutline(null)).toEqual([]);
    expect(planOutline("x")).toEqual([]);
    expect(planOutline({})).toEqual([]);
  });
});
