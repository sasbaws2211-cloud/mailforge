/**
 * A flow as the editor draws it: a sequence of emails that may end in a split into two paths, where each path
 * is again a sequence that may end in a split.
 *
 *   email, email, email, split ->  yes: email, email, split -> ...
 *                                  no:  email
 *
 * A split is always the LAST thing in its sequence, and when a path runs out, the flow ends for that contact.
 * That is a tree, which is what people can follow on a page. The engine accepts more (paths that rejoin, jumps),
 * and the preview below shows those faithfully, but this editor only builds trees.
 *
 * buildPlanFromTree() turns the tree into the body the API saves. A tree with no split is a plain
 * straight-line plan, byte for byte what the editor has always sent; only a tree with a split becomes a
 * version 2 plan. planOutline() goes the other way for display: any stored plan to indented lines.
 *
 * Nothing in this file talks to the network.
 *
 * Mirror side: PUBLIC (apps/dashboard is mirrored).
 */
import {
  buildPlanWithConditions,
  conditionConverter,
  planStepFor,
  type PlanBody,
  type PlanBuild,
  type StepData,
} from "./components/step-writer.js";
import { stateToCondition, type ApiFlowCondition, type ConditionState } from "./conditions.js";

/** The most emails and splits a flow may have in total, and the most splits one path may pass through. */
export const MAX_FLOW_NODES = 30;
export const MAX_FORK_DEPTH = 3;

/** The longest a wait-until split may wait; mirrors the API's limit. */
export const WAIT_LIMIT_PRESETS = [
  { value: "1h", label: "1 hour" },
  { value: "1d", label: "1 day" },
  { value: "2d", label: "2 days" },
  { value: "3d", label: "3 days" },
  { value: "5d", label: "5 days" },
  { value: "7d", label: "7 days" },
  { value: "14d", label: "14 days" },
  { value: "30d", label: "30 days" },
  { value: "60d", label: "60 days" },
  { value: "90d", label: "90 days" },
] as const;

export interface ForkData {
  /** Keys the split in the editor and in error reports (not sent anywhere). */
  id: string;
  /** How long to wait, from reaching the split, before checking (or, with `early`, the longest to wait). */
  delay: string;
  /** Wait-until mode: go down the "yes" path the moment the condition holds, or "no" when the delay runs out. */
  early: boolean;
  /** What decides the path: the "yes" path if it holds. */
  condition: ConditionState;
  yes: SequenceData;
  no: SequenceData;
}

export interface SequenceData {
  steps: StepData[];
  fork: ForkData | null;
}

export const emptySequence = (): SequenceData => ({ steps: [], fork: null });

let counter = 0;

/** A new split, waiting 3 days, with one blank condition row to fill in and two empty paths. */
export function newFork(firstRow: ConditionState["rows"][number]): ForkData {
  return {
    id: `fork-${++counter}`,
    delay: "3d",
    early: false,
    condition: { match: "all", rows: [firstRow] },
    yes: emptySequence(),
    no: emptySequence(),
  };
}

// ---------------------------------------------------------------------------
// Measuring a tree
// ---------------------------------------------------------------------------

/** Emails plus splits, everywhere in the tree. */
export function countNodes(seq: SequenceData): number {
  return seq.steps.length + (seq.fork ? 1 + countNodes(seq.fork.yes) + countNodes(seq.fork.no) : 0);
}

/** Emails only. */
export function countEmails(seq: SequenceData): number {
  return seq.steps.length + (seq.fork ? countEmails(seq.fork.yes) + countEmails(seq.fork.no) : 0);
}

/** The most splits any one path passes through (0 for a tree with no split). */
export function forkDepth(seq: SequenceData): number {
  return seq.fork ? 1 + Math.max(forkDepth(seq.fork.yes), forkDepth(seq.fork.no)) : 0;
}

export const hasFork = (seq: SequenceData): boolean => seq.fork !== null;

/** Every email in the tree, in reading order. */
export function allEmails(seq: SequenceData): StepData[] {
  return [...seq.steps, ...(seq.fork ? [...allEmails(seq.fork.yes), ...allEmails(seq.fork.no)] : [])];
}

/** May a split be added at the end of a sequence that sits `depth` splits down (0 at the top)? */
export function canAddFork(seq: SequenceData, depth: number, rootNodes: number): boolean {
  return seq.fork === null && depth < MAX_FORK_DEPTH && rootNodes < MAX_FLOW_NODES;
}

// ---------------------------------------------------------------------------
// Tree -> plan body
// ---------------------------------------------------------------------------

export interface TreeBuild extends PlanBuild {
  /** True when the body is a branching (version 2) plan. */
  branching: boolean;
}

/**
 * The body for POST /v1/flows/:id/plan. Problems with condition rows, and splits with no condition, are
 * reported in `errors` keyed by row id or split id; check it before sending.
 */
export function buildPlanFromTree(root: SequenceData, planExit?: ConditionState): TreeBuild {
  if (!hasFork(root)) {
    // Numbered by position, as the editor already keeps them, so the plan never depends on stray order values.
    const numbered = root.steps.map((s, i) => ({ ...s, order: i + 1 }));
    return { ...buildPlanWithConditions(numbered, planExit), branching: false };
  }

  const errors: Record<string, string> = {};
  const convert = conditionConverter(errors);
  const steps: PlanBody["steps"] = [];
  const branches: NonNullable<PlanBody["branches"]> = [];
  let n = 0;

  /** Emit a sequence; returns the order of its first node, or "end" if it is empty. */
  const emit = (seq: SequenceData): number | "end" => {
    const ids = seq.steps.map(() => ++n);
    const forkId = seq.fork ? ++n : null;
    const entry = ids[0] ?? forkId ?? "end";

    seq.steps.forEach((s, i) => {
      const next = i + 1 < ids.length ? ids[i + 1]! : (forkId ?? "end");
      steps.push(planStepFor(s, ids[i]!, convert, next));
    });

    if (seq.fork && forkId !== null) {
      const yesEntry = emit(seq.fork.yes);
      const noEntry = emit(seq.fork.no);
      const result = stateToCondition(seq.fork.condition);
      Object.assign(errors, result.errors);
      if (seq.fork.condition.rows.length === 0) errors[seq.fork.id] = "Add at least one condition to decide the path.";
      if (seq.fork.early && seq.fork.delay === "0m") errors[`${seq.fork.id}-delay`] = "Choose the longest to wait. Waiting 0 minutes is the same as checking straight away.";
      branches.push({
        order: forkId,
        delay: seq.fork.delay,
        ...(seq.fork.early ? { early: true } : {}),
        condition: (result.condition ?? { lifecycle_state: "signed_up" }) as ApiFlowCondition,
        then: yesEntry,
        else: noEntry,
      });
    }
    return entry;
  };

  emit(root);

  const body: PlanBody = { version: 2, steps, branches };
  const planExitCondition = convert(planExit);
  if (planExitCondition) body.exit_conditions = [{ condition: planExitCondition }];
  return { body, errors, branching: true };
}

// ---------------------------------------------------------------------------
// Stored plan -> outline (for the preview)
// ---------------------------------------------------------------------------

export type OutlineLine =
  /** An email step. */
  | { kind: "email"; depth: number; order: number; step: Record<string, unknown> }
  /** A split: wait, then check. */
  | { kind: "fork"; depth: number; order: number; delay: string; condition: unknown; early: boolean }
  /** The heading of one path out of a split. */
  | { kind: "path"; depth: number; label: "If yes" | "Otherwise" }
  /** A path that finishes the flow. */
  | { kind: "end"; depth: number }
  /** A path that joins a step already shown above. */
  | { kind: "rejoin"; depth: number; order: number };

/**
 * A stored plan as indented lines. A straight-line plan is just its steps in order. A branching plan is walked
 * from order 1: an email, then whatever it leads to; a split, then its "If yes" and "Otherwise" paths
 * indented beneath it. A path that reaches a step already shown says it rejoins rather than repeating it, and
 * a plan the engine would refuse (a loop, a missing node) cannot make this run forever.
 */
export function planOutline(plan: unknown): OutlineLine[] {
  if (!plan || typeof plan !== "object") return [];
  const p = plan as Record<string, unknown>;
  const steps = Array.isArray(p.steps) ? (p.steps as Array<Record<string, unknown>>) : [];
  const branches = Array.isArray(p.branches) ? (p.branches as Array<Record<string, unknown>>) : [];

  if (p.version !== 2) {
    return steps.map((step, i) => ({
      kind: "email" as const,
      depth: 0,
      order: typeof step.order === "number" ? step.order : i + 1,
      step,
    }));
  }

  const stepAt = new Map<number, Record<string, unknown>>();
  const branchAt = new Map<number, Record<string, unknown>>();
  for (const s of steps) if (typeof s.order === "number") stepAt.set(s.order, s);
  for (const b of branches) if (typeof b.order === "number") branchAt.set(b.order, b);

  const orders = [...stepAt.keys(), ...branchAt.keys()];
  const nextAfter = (order: number): number | "end" => {
    const higher = orders.filter((o) => o > order);
    return higher.length > 0 ? Math.min(...higher) : "end";
  };

  const lines: OutlineLine[] = [];
  const seen = new Set<number>();

  const walk = (target: unknown, depth: number): void => {
    if (target === "end" || typeof target !== "number") {
      lines.push({ kind: "end", depth });
      return;
    }
    if (seen.has(target)) {
      lines.push({ kind: "rejoin", depth, order: target });
      return;
    }
    seen.add(target);
    const step = stepAt.get(target);
    if (step) {
      lines.push({ kind: "email", depth, order: target, step });
      walk(step.next ?? nextAfter(target), depth);
      return;
    }
    const branch = branchAt.get(target);
    if (branch) {
      lines.push({ kind: "fork", depth, order: target, delay: String(branch.delay ?? ""), condition: branch.condition, early: branch.early === true });
      lines.push({ kind: "path", depth: depth + 1, label: "If yes" });
      walk(branch.then, depth + 2);
      lines.push({ kind: "path", depth: depth + 1, label: "Otherwise" });
      walk(branch.else, depth + 2);
      return;
    }
    // A target the plan does not have: show it as an ending rather than guess.
    lines.push({ kind: "end", depth });
  };

  walk(1, 0);
  return lines;
}
