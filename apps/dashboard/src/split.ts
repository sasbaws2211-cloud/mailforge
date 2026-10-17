/**
 * A/B tests and holdouts in the dashboard: the plain-English reading of a split's results.
 *
 * Mirror side: PUBLIC (apps/dashboard is mirrored).
 */
import type { SplitTestResult, SplitVersionResult } from "./api.js";
import { formatRate } from "./goal.js";

export const SPLIT_PRESETS = [
  { percent: 50, label: "50/50" },
  { percent: 80, label: "80/20" },
  { percent: 90, label: "90/10 holdout" },
] as const;

/** The name shown for a version: "Version A", "Version B", or "Holdout" for a path nobody is emailed on. */
export function versionName(which: "a" | "b", v: SplitVersionResult): string {
  return v.holdout ? "Holdout" : which === "a" ? "Version A" : "Version B";
}

/** A count over a total as a rate, "-" when there is no total. */
function rateOf(count: number, total: number): string {
  return total > 0 ? formatRate(count / total) : "-";
}

export function sentRate(v: SplitVersionResult, count: number): string {
  return rateOf(count, v.sent);
}

export function goalRate(v: SplitVersionResult): string {
  return rateOf(v.converted, v.assigned);
}

/** What the comparison means, in words. Honest about small numbers and about having no goal. */
export function describeSplitVerdict(t: SplitTestResult): string {
  const c = t.comparison;
  if (!c) return "Set a goal on this flow to compare how many people from each version get there. Opens and clicks are shown below.";
  if (c.verdict === "too_early") {
    return "Too early to tell. Each version needs at least 30 people, and there need to be at least 10 who reached the goal in total.";
  }
  if (c.verdict === "no_difference") return "No clear difference yet. The two are close enough that chance could explain it.";
  const winner = c.verdict === "a_better" ? t.a : t.b;
  const loser = c.verdict === "a_better" ? t.b : t.a;
  const winnerName = versionName(c.verdict === "a_better" ? "a" : "b", winner);
  const loserName = versionName(c.verdict === "a_better" ? "b" : "a", loser);
  const numbers = `${goalRate(winner)} against ${goalRate(loser)}`;
  const p = c.p_value !== null ? ` (p = ${c.p_value < 0.001 ? "under 0.001" : c.p_value.toFixed(3)})` : "";
  if (loser.holdout) return `The emails helped: ${numbers} reached the goal, people who got them against the holdout${p}.`;
  if (winner.holdout) return `The holdout did better: ${numbers}. The emails may not be helping${p}.`;
  return `${winnerName} is probably better: ${numbers}${p}.`;
}
