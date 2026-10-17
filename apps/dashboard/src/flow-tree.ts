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
import {
  conditionToState,
  emptyConditionState,
  newConditionRow,
  stateToCondition,
  type ApiFlowCondition,
  type ConditionState,
} from "./conditions.js";

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
  /** "condition": decided by what is true of the contact. "split": decided at random (an A/B test or a holdout). */
  kind: "condition" | "split";
  /** For a random split: the share (1 to 99) sent down the "yes" path, which is version A. */
  percent_a: number;
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
    kind: "condition",
    percent_a: 50,
    condition: { match: "all", rows: [firstRow] },
    yes: emptySequence(),
    no: emptySequence(),
  };
}

/**
 * Change how a split decides. A random split has no condition to wait for, so it cannot be a wait-until, and it
 * normally splits straight away: the condition fork's 3-day default becomes "Immediately" (and back again). A delay
 * the person chose themselves is kept.
 */
export function switchForkKind(fork: ForkData, kind: ForkData["kind"]): ForkData {
  if (fork.kind === kind) return fork;
  const delay = kind === "split" && fork.delay === "3d" ? "0m" : kind === "condition" && fork.delay === "0m" ? "3d" : fork.delay;
  return { ...fork, kind, early: kind === "split" ? false : fork.early, delay };
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

    if (seq.fork && forkId !== null && seq.fork.kind === "split") {
      const yesEntry = emit(seq.fork.yes);
      const noEntry = emit(seq.fork.no);
      const pct = seq.fork.percent_a;
      if (!Number.isInteger(pct) || pct < 1 || pct > 99) errors[`${seq.fork.id}-percent`] = "Choose a share from 1 to 99.";
      branches.push({ order: forkId, delay: seq.fork.delay, split: { percent_a: pct }, then: yesEntry, else: noEntry });
    } else if (seq.fork && forkId !== null) {
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
  | { kind: "fork"; depth: number; order: number; delay: string; condition: unknown; early: boolean; split: number | null }
  /** The heading of one path out of a split. */
  | { kind: "path"; depth: number; label: "If yes" | "Otherwise" | "Version A" | "Version B" | "Holdout" }
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
      const split = branch.split as { percent_a?: unknown } | undefined;
      const percent = split && typeof split.percent_a === "number" ? split.percent_a : null;
      lines.push({ kind: "fork", depth, order: target, delay: String(branch.delay ?? ""), condition: branch.condition, early: branch.early === true, split: percent });
      // A random split names its paths by version; a path that is simply "end" is a holdout.
      lines.push({ kind: "path", depth: depth + 1, label: percent === null ? "If yes" : branch.then === "end" ? "Holdout" : "Version A" });
      walk(branch.then, depth + 2);
      lines.push({ kind: "path", depth: depth + 1, label: percent === null ? "Otherwise" : branch.else === "end" ? "Holdout" : "Version B" });
      walk(branch.else, depth + 2);
      return;
    }
    // A target the plan does not have: show it as an ending rather than guess.
    lines.push({ kind: "end", depth });
  };

  walk(1, 0);
  return lines;
}

// ---------------------------------------------------------------------------
// Stored plan -> tree (to reopen a saved flow in the editor)
// ---------------------------------------------------------------------------

/** The copy of one email, as kept in its template: what the plan itself does not hold. */
export interface TemplateCopy {
  subject: string;
  body_html: string;
  body_text: string | null;
}

export type TreeFromPlan =
  | { ok: true; tree: SequenceData; planExit: ConditionState }
  | { ok: false; reason: string };

let loadedForks = 0;

/**
 * The inverse of buildPlanFromTree(): a stored plan back into the tree the editor edits, with each email's
 * subject and body taken from its template (`templates`, by slug = the step's template_ref).
 *
 * Only plans in a shape the editor can draw load: a straight line, or a tree of splits where every path is its
 * own run of emails ending in a split or the end. Anything else (paths that rejoin, a node nothing leads to,
 * a template that is gone, a condition the editor cannot show, more than one plan-level stop condition, a
 * tree beyond the editor's limits) returns `ok: false` with the reason, because saving what the editor drew
 * would silently change or destroy the stored plan. A plan with the same shape but different numbering loads
 * fine; it is renumbered when saved again.
 */
export function treeFromPlan(plan: unknown, templates: ReadonlyMap<string, TemplateCopy>): TreeFromPlan {
  const fail = (reason: string): TreeFromPlan => ({ ok: false, reason });
  if (!plan || typeof plan !== "object") return fail("The flow has no plan.");
  const p = plan as Record<string, unknown>;
  const rawSteps = Array.isArray(p.steps) ? (p.steps as Array<Record<string, unknown>>) : [];
  const rawBranches = Array.isArray(p.branches) ? (p.branches as Array<Record<string, unknown>>) : [];
  if (rawSteps.length === 0) return fail("The plan has no steps.");
  if (p.version !== 2 && (rawBranches.length > 0 || rawSteps.some((s) => s.next !== undefined))) {
    return fail("The plan has branches but is not marked as a branching plan.");
  }

  const stepAt = new Map<number, Record<string, unknown>>();
  const branchAt = new Map<number, Record<string, unknown>>();
  for (const s of rawSteps) {
    if (typeof s.order !== "number" || stepAt.has(s.order)) return fail("The plan numbers its steps in a way the editor cannot read.");
    stepAt.set(s.order, s);
  }
  for (const b of rawBranches) {
    if (typeof b.order !== "number" || stepAt.has(b.order) || branchAt.has(b.order)) {
      return fail("The plan numbers its steps in a way the editor cannot read.");
    }
    branchAt.set(b.order, b);
  }
  const orders = [...stepAt.keys(), ...branchAt.keys()].sort((a, b) => a - b);
  const nextAfter = (order: number): number | "end" => orders.find((o) => o > order) ?? "end";

  const seen = new Set<number>();
  let problem: string | null = null;
  const stop = (reason: string): SequenceData => {
    problem ??= reason;
    return emptySequence();
  };

  const parseSeq = (entry: unknown, depth: number): SequenceData => {
    const seq: SequenceData = emptySequence();
    let cur = entry;
    while (problem === null) {
      if (cur === "end") return seq;
      if (typeof cur !== "number") return stop("A step points somewhere that is not in the plan.");
      if (seen.has(cur)) return stop(`Two paths lead to step ${cur}, so the paths rejoin.`);
      seen.add(cur);

      const step = stepAt.get(cur);
      if (step) {
        const copy = typeof step.template_ref === "string" ? templates.get(step.template_ref) : undefined;
        if (!copy) return stop(`The email for step ${cur} could not be found.`);
        const condition = conditionToState(step.condition);
        const exit = conditionToState(step.exit_condition);
        if (condition.unreadable || exit.unreadable) return stop(`Step ${cur} has a condition the editor cannot show.`);
        if (typeof step.delay !== "string" || typeof step.action_type !== "string") return stop(`Step ${cur} is incomplete.`);
        seq.steps.push({
          order: seq.steps.length + 1,
          delay: step.delay,
          action_type: step.action_type,
          window_policy: step.window_policy === "immediate" ? "immediate" : "respect_window",
          subject: copy.subject,
          body_html: copy.body_html,
          body_text: copy.body_text ?? "",
          ...(step.condition !== undefined ? { condition: condition.state } : {}),
          ...(step.exit_condition !== undefined ? { exit_condition: exit.state } : {}),
        });
        cur = step.next ?? nextAfter(cur);
        continue;
      }

      const branch = branchAt.get(cur);
      if (!branch) return stop(`A step points to step ${cur}, which is not in the plan.`);
      if (depth >= MAX_FORK_DEPTH) return stop("The plan splits more deeply than the editor allows.");
      if (typeof branch.delay !== "string") return stop(`Split ${cur} is incomplete.`);
      const split = branch.split as { percent_a?: unknown } | undefined;
      let fork: ForkData;
      if (split !== undefined) {
        const pct = split.percent_a;
        if (branch.condition !== undefined || branch.early === true || typeof pct !== "number" || !Number.isInteger(pct) || pct < 1 || pct > 99) {
          return stop(`Split ${cur} is not an A/B split the editor can show.`);
        }
        fork = { ...newFork(emptyRow()), kind: "split", percent_a: pct, early: false, delay: branch.delay, condition: emptyConditionState() };
      } else {
        const cond = conditionToState(branch.condition);
        if (branch.condition === undefined || cond.unreadable || cond.state.rows.length === 0) {
          return stop(`Split ${cur} has a condition the editor cannot show.`);
        }
        fork = { ...newFork(emptyRow()), kind: "condition", early: branch.early === true, delay: branch.delay, condition: cond.state };
      }
      fork.id = `loaded-fork-${++loadedForks}`;
      fork.yes = parseSeq(branch.then, depth + 1);
      fork.no = parseSeq(branch.else, depth + 1);
      seq.fork = fork;
      return seq;
    }
    return seq;
  };

  const tree = parseSeq(1, 0);
  if (problem !== null) return fail(problem);
  if (seen.size !== orders.length) return fail("Some steps in the plan are not reachable from the start.");
  if (countNodes(tree) > MAX_FLOW_NODES) return fail("The plan has more steps than the editor allows.");

  const exits = Array.isArray(p.exit_conditions) ? (p.exit_conditions as Array<Record<string, unknown>>) : [];
  let planExit = emptyConditionState();
  if (exits.length > 1) return fail("The plan has more than one stop condition.");
  if (exits.length === 1) {
    const only = exits[0]!;
    const parsed = Object.keys(only).length === 1 && "condition" in only ? conditionToState(only.condition) : null;
    if (!parsed || parsed.unreadable) return fail("The plan's stop condition is one the editor cannot show.");
    planExit = parsed.state;
  }
  return { ok: true, tree, planExit };
}

/** A throwaway row for newFork(), which is overwritten straight away. */
const emptyRow = () => newConditionRow();
