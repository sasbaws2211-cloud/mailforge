/**
 * The shape of a flow as a graph, and the rules that keep a branching flow safe to run.
 *
 * A plan is a set of NODES that each carry an `order` (a unique id):
 *   - email steps (plan.steps): send one email, then go to `next`
 *   - branches (plan.branches): send nothing; after a delay, check a condition and go to `then` or `else`
 * A target is another node's order, or "end" (the contact finishes the flow). The contact starts at order 1.
 *
 * Plan version 1 (no `version`) is the original straight line: step N is followed by step N+1, and there are no
 * branches and no `next`. Version 2 allows branches and explicit `next`. An email step in a version 2 plan with
 * no `next` goes to the next-higher order among ALL nodes, or ends if there is none, so a plain list of steps
 * still means "in order".
 *
 * analyzePlanGraph() is what makes branching safe: it refuses a plan with a loop (a contact could be mailed
 * forever), a target that does not exist, a node nothing leads to, a duplicate id, or too many nodes or forks.
 *
 * Mirror side: PUBLIC (packages/core is mirrored).
 */
import { z } from "zod";

/** Most nodes (email steps plus branches) a plan may have. */
export const MAX_PLAN_NODES = 30;
/** Most branches that may be passed through on any one path. */
export const MAX_BRANCH_DEPTH = 3;

export type NodeTarget = number | "end";

export const nodeTargetSchema = z.union([z.number().int().min(1), z.literal("end")]);

export interface GraphStep {
  order: number;
  next?: NodeTarget | undefined;
}

export interface GraphBranch {
  order: number;
  then: NodeTarget;
  else: NodeTarget;
}

export interface PlanGraphInput {
  version?: number | undefined;
  steps: ReadonlyArray<GraphStep>;
  branches?: ReadonlyArray<GraphBranch> | undefined;
}

/** True for a plan that may use branches and explicit `next`. */
export function isBranchingPlan(plan: { version?: number | undefined }): boolean {
  return plan.version === 2;
}

/** Where an email step with no `next` goes: the next-higher order among all nodes, or the end. */
export function defaultNext(plan: PlanGraphInput, order: number): NodeTarget {
  let best: number | null = null;
  const consider = (o: number) => {
    if (o > order && (best === null || o < best)) best = o;
  };
  for (const s of plan.steps) consider(s.order);
  for (const b of plan.branches ?? []) consider(b.order);
  return best ?? "end";
}

/** Where an email step goes after it has been dealt with. */
export function stepTarget(plan: PlanGraphInput, step: GraphStep): NodeTarget {
  return step.next ?? defaultNext(plan, step.order);
}

/**
 * Problems with a plan's graph, as short sentences. Empty means it is safe to run.
 * A version 1 plan is only checked for not using version 2 features.
 */
export function analyzePlanGraph(plan: PlanGraphInput): string[] {
  const branches = plan.branches ?? [];

  if (!isBranchingPlan(plan)) {
    const problems: string[] = [];
    if (branches.length > 0) problems.push("branches need plan version 2");
    if (plan.steps.some((s) => s.next !== undefined)) problems.push("next needs plan version 2");
    return problems;
  }

  const problems: string[] = [];
  const total = plan.steps.length + branches.length;
  if (total > MAX_PLAN_NODES) problems.push(`a plan can have at most ${MAX_PLAN_NODES} steps and branches in total (this one has ${total})`);

  // Unique ids across email steps and branches.
  const kind = new Map<number, "step" | "branch">();
  const duplicates = new Set<number>();
  for (const s of plan.steps) {
    if (kind.has(s.order)) duplicates.add(s.order);
    kind.set(s.order, "step");
  }
  for (const b of branches) {
    if (kind.has(b.order)) duplicates.add(b.order);
    kind.set(b.order, "branch");
  }
  if (duplicates.size > 0) problems.push(`order ${[...duplicates].sort((a, b) => a - b).join(", ")} is used by more than one step or branch`);
  if (!kind.has(1)) problems.push("the flow starts at order 1, and there is no step or branch with order 1");

  // Edges, checking every target exists.
  const edges = new Map<number, NodeTarget[]>();
  for (const s of plan.steps) edges.set(s.order, [stepTarget(plan, s)]);
  for (const b of branches) edges.set(b.order, [b.then, b.else]);
  const missing = new Set<number>();
  for (const [from, targets] of edges) {
    for (const t of targets) {
      if (t !== "end" && !kind.has(t)) missing.add(t);
      if (t === from) problems.push(`order ${from} leads back to itself`);
    }
  }
  if (missing.size > 0) problems.push(`nothing has order ${[...missing].sort((a, b) => a - b).join(", ")}, but something leads there`);
  if (problems.length > 0 && (missing.size > 0 || duplicates.size > 0)) return problems;

  // No loops: depth-first search with colours.
  const colour = new Map<number, 1 | 2>(); // 1 = on the current path, 2 = done
  let loopAt: number | null = null;
  const visit = (n: number): void => {
    if (loopAt !== null) return;
    colour.set(n, 1);
    for (const t of edges.get(n) ?? []) {
      if (t === "end") continue;
      const c = colour.get(t);
      if (c === 1) {
        loopAt = t;
        return;
      }
      if (c === undefined) visit(t);
      if (loopAt !== null) return;
    }
    colour.set(n, 2);
  };
  if (kind.has(1)) visit(1);
  if (loopAt !== null) {
    problems.push(`the flow loops back to order ${loopAt}, so a contact could go round forever`);
    return problems;
  }

  // Everything is reachable from the start.
  const unreachable = [...kind.keys()].filter((o) => !colour.has(o)).sort((a, b) => a - b);
  if (kind.has(1) && unreachable.length > 0) {
    problems.push(`order ${unreachable.join(", ")} can never be reached from the start`);
  }

  // At most MAX_BRANCH_DEPTH branches on any one path (the graph has no loops now, so this terminates).
  const memo = new Map<number, number>();
  const depth = (n: number): number => {
    const known = memo.get(n);
    if (known !== undefined) return known;
    let deepest = 0;
    for (const t of edges.get(n) ?? []) if (t !== "end") deepest = Math.max(deepest, depth(t));
    const here = (kind.get(n) === "branch" ? 1 : 0) + deepest;
    memo.set(n, here);
    return here;
  };
  if (kind.has(1) && depth(1) > MAX_BRANCH_DEPTH) {
    problems.push(`a path can pass through at most ${MAX_BRANCH_DEPTH} branches`);
  }

  return problems;
}
