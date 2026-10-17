/**
 * Random splits (A/B tests and holdouts): who goes down which path, and whether one path did better.
 *
 * Assignment is a fixed hash, not a coin flip: the same membership at the same split always gets the same
 * answer, however many times the engine runs the step (retries, a crash, the scan and the targeted job both
 * reaching it), so nobody can be moved between versions. It is spread evenly over memberships.
 *
 * The comparison is a plain two-proportion test with an honest "too early" guard, because small tests mislead.
 *
 * Mirror side: PUBLIC (packages/core is mirrored).
 */

/** 32-bit FNV-1a over the text, then a murmur3 finaliser so nearby inputs spread evenly. Pure, no dependencies. */
function hash32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** A number in [0, 100) fixed by the membership and the split's order. */
export function splitBucket(membershipId: string, order: number): number {
  return (hash32(`${membershipId}:split:${order}`) / 0x1_0000_0000) * 100;
}

export type SplitVersion = "a" | "b";

/** Version A for `percentA` percent of memberships, version B for the rest. */
export function splitVersion(membershipId: string, order: number, percentA: number): SplitVersion {
  return splitBucket(membershipId, order) < percentA ? "a" : "b";
}

// ---------------------------------------------------------------------------
// Which emails belong to which path
// ---------------------------------------------------------------------------

export interface SplitPathsPlan {
  steps?: ReadonlyArray<{ order: number; next?: unknown }> | null;
  branches?: ReadonlyArray<{ order: number; then: unknown; else: unknown }> | null;
}

/**
 * The email steps a person can reach by going down each path of the split at `order`: `a` for the `then` path and
 * `b` for the `else` path. A path that is "end" has none, which is how a holdout shows up. Reads leniently and
 * stops at any node it has seen, so a bad plan cannot make it loop.
 */
export function splitPathSteps(plan: SplitPathsPlan | null | undefined, order: number): { a: number[]; b: number[] } | null {
  const steps = plan?.steps ?? [];
  const branches = plan?.branches ?? [];
  const split = branches.find((b) => b.order === order);
  if (!split) return null;
  const stepAt = new Map(steps.map((s) => [s.order, s]));
  const branchAt = new Map(branches.map((b) => [b.order, b]));
  const allOrders = [...stepAt.keys(), ...branchAt.keys()];
  const nextAfter = (o: number): number | "end" => {
    const higher = allOrders.filter((x) => x > o);
    return higher.length > 0 ? Math.min(...higher) : "end";
  };
  const reach = (start: unknown): number[] => {
    const found: number[] = [];
    const seen = new Set<number>();
    const walk = (target: unknown): void => {
      if (typeof target !== "number" || seen.has(target)) return;
      seen.add(target);
      const step = stepAt.get(target);
      if (step) {
        found.push(target);
        walk(step.next ?? nextAfter(target));
        return;
      }
      const branch = branchAt.get(target);
      if (branch) {
        walk(branch.then);
        walk(branch.else);
      }
    };
    walk(start);
    return found.sort((x, y) => x - y);
  };
  return { a: reach(split.then), b: reach(split.else) };
}

// ---------------------------------------------------------------------------
// Comparing two versions
// ---------------------------------------------------------------------------

/** Fewer people than this in either version, or fewer conversions than MIN_TOTAL_CONVERSIONS overall: too early. */
export const SPLIT_MIN_PER_VERSION = 30;
export const SPLIT_MIN_TOTAL_CONVERSIONS = 10;
export const SPLIT_SIGNIFICANCE = 0.05;

export interface VersionCounts {
  /** People assigned to the version. */
  n: number;
  /** Of those, how many reached the goal. */
  k: number;
}

export type SplitVerdict = "too_early" | "a_better" | "b_better" | "no_difference";

export interface SplitComparison {
  rateA: number | null;
  rateB: number | null;
  /** rateB - rateA as a fraction (0.05 = 5 percentage points). Null when a rate is unknown. */
  difference: number | null;
  /** Two-sided p-value, or null when the test could not be run. */
  pValue: number | null;
  verdict: SplitVerdict;
}

/** Standard normal cumulative distribution (Abramowitz and Stegun 7.1.26, error under 1.5e-7). */
function normalCdf(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erf = 1 - poly * Math.exp(-x * x);
  return z >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

/** Pooled two-proportion z-test of version A against version B. Never throws on odd input. */
export function compareVersions(a: VersionCounts, b: VersionCounts): SplitComparison {
  const valid = (v: VersionCounts) => Number.isFinite(v.n) && Number.isFinite(v.k) && v.n >= 0 && v.k >= 0 && v.k <= v.n;
  if (!valid(a) || !valid(b)) return { rateA: null, rateB: null, difference: null, pValue: null, verdict: "too_early" };
  const rateA = a.n > 0 ? a.k / a.n : null;
  const rateB = b.n > 0 ? b.k / b.n : null;
  const difference = rateA !== null && rateB !== null ? rateB - rateA : null;
  if (a.n < SPLIT_MIN_PER_VERSION || b.n < SPLIT_MIN_PER_VERSION || a.k + b.k < SPLIT_MIN_TOTAL_CONVERSIONS) {
    return { rateA, rateB, difference, pValue: null, verdict: "too_early" };
  }
  const pooled = (a.k + b.k) / (a.n + b.n);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / a.n + 1 / b.n));
  if (se === 0) return { rateA, rateB, difference, pValue: 1, verdict: "no_difference" }; // everyone converted, or no one
  const z = (rateB! - rateA!) / se;
  const pValue = 2 * (1 - normalCdf(Math.abs(z)));
  if (pValue >= SPLIT_SIGNIFICANCE) return { rateA, rateB, difference, pValue, verdict: "no_difference" };
  return { rateA, rateB, difference, pValue, verdict: rateB! > rateA! ? "b_better" : "a_better" };
}
