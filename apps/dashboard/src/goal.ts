/**
 * Flow goals in the dashboard: turning the goal form into what the API takes and back, and the plain-English
 * numbers shown next to it.
 *
 * Mirror side: PUBLIC (apps/dashboard is mirrored).
 */
import { conditionToState, describeCondition, emptyConditionState, stateToCondition, type ApiFlowCondition, type ConditionState } from "./conditions.js";

export const GOAL_WINDOW_CHOICES = [
  { value: 7, label: "7 days" },
  { value: 14, label: "14 days" },
  { value: 30, label: "30 days" },
  { value: 60, label: "60 days" },
  { value: 90, label: "90 days" },
] as const;

export interface ApiGoal {
  name: string;
  condition: ApiFlowCondition;
  window_days: number;
  exit_on_conversion: boolean;
}

export interface GoalForm {
  name: string;
  condition: ConditionState;
  window_days: number;
  exit_on_conversion: boolean;
}

export const emptyGoalForm = (): GoalForm => ({ name: "", condition: emptyConditionState(), window_days: 30, exit_on_conversion: true });

/** A stored goal as form fields. `unreadable` is true when its condition cannot be shown without changing it. */
export function goalToForm(goal: ApiGoal | null | undefined): { form: GoalForm; unreadable: boolean } {
  if (!goal) return { form: emptyGoalForm(), unreadable: false };
  const parsed = conditionToState(goal.condition);
  return {
    form: { name: goal.name, condition: parsed.state, window_days: goal.window_days, exit_on_conversion: goal.exit_on_conversion },
    unreadable: parsed.unreadable,
  };
}

/** The goal to send, or the problems to show (`name` and per-row errors keyed by row id, `condition` for none). */
export function formToGoal(form: GoalForm): { goal: ApiGoal | null; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const name = form.name.trim();
  if (name === "") errors.name = "Give the goal a name, for example “Created a project”.";
  else if (name.length > 80) errors.name = "Keep the name to 80 characters or fewer.";
  const result = stateToCondition(form.condition);
  Object.assign(errors, result.errors);
  if (form.condition.rows.length === 0) errors.condition = "Say what counts as reaching the goal.";
  if (Object.keys(errors).length > 0 || result.condition === null) return { goal: null, errors };
  return { goal: { name, condition: result.condition, window_days: form.window_days, exit_on_conversion: form.exit_on_conversion }, errors };
}

/** One sentence: what the goal is, in plain words. */
export function describeGoal(goal: ApiGoal): string {
  const days = `${goal.window_days} day${goal.window_days === 1 ? "" : "s"}`;
  const exit = goal.exit_on_conversion ? " They leave the flow when they get there." : " They stay in the flow.";
  return `${goal.name}: ${describeCondition(goal.condition)}, within ${days} of entering.${exit}`;
}

/** 0.4 -> "40%". One decimal under 10%, so 0.037 reads "3.7%" and not "4%". null -> "-". */
export function formatRate(rate: number | null | undefined): string {
  if (rate === null || rate === undefined || !Number.isFinite(rate)) return "-";
  const pct = rate * 100;
  return pct > 0 && pct < 10 ? `${Math.round(pct * 10) / 10}%` : `${Math.round(pct)}%`;
}

/** 2 -> "2 hours", 0.5 -> "30 minutes", 50 -> "2.1 days", null -> "-". */
export function formatDuration(hours: number | null | undefined): string {
  if (hours === null || hours === undefined || !Number.isFinite(hours)) return "-";
  if (hours < 1) {
    const minutes = Math.max(1, Math.round(hours * 60));
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  if (hours < 48) {
    const h = Math.round(hours * 10) / 10;
    return `${h} hour${h === 1 ? "" : "s"}`;
  }
  const d = Math.round((hours / 24) * 10) / 10;
  return `${d} days`;
}
