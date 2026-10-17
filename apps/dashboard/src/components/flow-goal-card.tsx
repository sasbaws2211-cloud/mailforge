/**
 * A flow's goal: what success looks like, and how the flow is doing against it.
 *
 * Like the audience, a goal can be changed at any time (the engine reads it as people move through the flow),
 * so it has its own save, separate from the main form. Below it, once the flow has a goal, the results: how
 * many people entered, how many reached it, how long it took, and the same per email.
 *
 * Mirror side: PUBLIC (apps/dashboard is mirrored).
 */
import { useState } from "react";
import type { Flow } from "../api.js";
import { useFlowResults } from "../flows.js";
import { Button } from "./ui/button.js";
import { Input } from "./ui/input.js";
import { Select } from "./ui/select.js";
import { Skeleton } from "./ui/skeleton.js";
import { ConditionEditor } from "./condition-editor.js";
import { newConditionRow } from "../conditions.js";
import {
  GOAL_WINDOW_CHOICES,
  describeGoal,
  emptyGoalForm,
  formToGoal,
  formatDuration,
  formatRate,
  goalToForm,
  type ApiGoal,
  type GoalForm,
} from "../goal.js";

export function FlowGoalCard({
  flow,
  saving,
  onSave,
  eventSuggestions = [],
}: {
  flow: Flow;
  saving: boolean;
  /** Resolves to an error message, or null once saved. */
  onSave: (goal: ApiGoal | null) => Promise<string | null>;
  eventSuggestions?: string[];
}) {
  const stored = flow.goal;
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<GoalForm>(emptyGoalForm());
  const [unreadable, setUnreadable] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  function startEditing() {
    const start = goalToForm(stored);
    // A new goal starts with one blank "did this event" row to fill in.
    setForm(stored ? start.form : { ...start.form, condition: { match: "all", rows: [newConditionRow("event")] } });
    setUnreadable(start.unreadable);
    setErrors({});
    setMessage(null);
    setSaved(false);
    setEditing(true);
  }

  async function save() {
    const { goal, errors: found } = formToGoal(form);
    if (!goal) {
      setErrors(found);
      setMessage("Fix the highlighted problems first.");
      return;
    }
    const failure = await onSave(goal);
    if (failure) {
      setMessage(failure);
      return;
    }
    setEditing(false);
    setSaved(true);
  }

  async function remove() {
    const failure = await onSave(null);
    if (failure) {
      setMessage(failure);
      return;
    }
    setEditing(false);
    setSaved(true);
  }

  return (
    <div className="mt-4 rounded-lg border border-border bg-card px-5 py-4" aria-label="Goal">
      <div className="flex items-start justify-between gap-4">
        <p className="text-[12px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">Goal</p>
        {!editing && (
          <Button type="button" variant="secondary" size="sm" onClick={startEditing}>
            {stored ? "Edit" : "Set a goal"}
          </Button>
        )}
      </div>

      {editing ? (
        <div className="mt-3 space-y-4">
          {unreadable && <p className="text-[13px] text-muted-foreground">The current goal cannot be shown here. Saving replaces it.</p>}
          <div>
            <label htmlFor="goal-name" className="mb-1 block text-[13px] font-medium text-foreground">
              Name
            </label>
            <Input
              id="goal-name"
              value={form.name}
              maxLength={80}
              disabled={saving}
              placeholder="Created a project"
              onChange={(e) => {
                setForm({ ...form, name: e.target.value });
                setErrors({ ...errors, name: "" });
              }}
            />
            {errors.name && (
              <p className="mt-1 text-[13px] text-danger" role="alert">
                {errors.name}
              </p>
            )}
          </div>

          <div>
            <p className="mb-2 text-[13px] font-medium text-foreground">Reached when</p>
            <ConditionEditor
              state={form.condition}
              onChange={(condition) => {
                setForm({ ...form, condition });
                setErrors({});
              }}
              errors={errors}
              disabled={saving}
              firstLabel="When"
              addLabel="Add a condition"
              emptyText="Add a condition that means success."
              eventSuggestions={eventSuggestions}
              allowStepWindow={false}
              idPrefix="goal-cond"
            />
            {errors.condition && (
              <p className="mt-2 text-[13px] text-danger" role="alert">
                {errors.condition}
              </p>
            )}
            <p className="mt-2 text-[13px] text-muted-foreground">
              For an event, choose “since entering the flow” so only what happens after they join counts. A fact such as “payment status is
              paid” also counts people who were already paid when they joined.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 text-[14px] text-foreground">
            <span>Counts if it happens within</span>
            <div className="w-32">
              <Select
                aria-label="How long after entering the goal still counts"
                value={String(form.window_days)}
                disabled={saving}
                onChange={(e) => setForm({ ...form, window_days: Number(e.target.value) })}
              >
                {GOAL_WINDOW_CHOICES.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </Select>
            </div>
            <span>of entering the flow</span>
          </div>

          <label className="flex items-start gap-2 text-[14px] text-foreground">
            <input
              type="checkbox"
              className="mt-1"
              checked={form.exit_on_conversion}
              disabled={saving}
              onChange={(e) => setForm({ ...form, exit_on_conversion: e.target.checked })}
            />
            <span>
              Leave the flow when the goal is reached
              <span className="block text-[13px] text-muted-foreground">So someone who already succeeded is not sent the rest of the emails.</span>
            </span>
          </label>

          {message && (
            <p className="text-[13px] text-danger" role="alert">
              {message}
            </p>
          )}
          <div className="flex items-center gap-3">
            <Button type="button" size="sm" disabled={saving} onClick={() => void save()}>
              {saving ? "Saving..." : "Save goal"}
            </Button>
            <Button type="button" variant="secondary" size="sm" disabled={saving} onClick={() => setEditing(false)}>
              Cancel
            </Button>
            {stored && (
              <Button type="button" variant="ghost" size="sm" disabled={saving} onClick={() => void remove()}>
                Remove goal
              </Button>
            )}
          </div>
        </div>
      ) : (
        <>
          <p className="mt-1.5 text-[15px] text-foreground">
            {stored ? describeGoal(stored) : "No goal yet. Set one to see how many people this flow gets to it."}
          </p>
          {saved && <p className="mt-1 text-[13px] text-foreground">Saved.</p>}
          {stored && <GoalResults flowId={flow.id} />}
        </>
      )}
    </div>
  );
}

/** The numbers for a flow that has a goal. Counts people who reached it after entering; it does not prove the flow caused it. */
export function GoalResults({ flowId }: { flowId: string }) {
  const results = useFlowResults(flowId, 30);

  if (results.isLoading) return <Skeleton className="mt-4 h-16 w-full" aria-busy="true" aria-label="Loading results" />;
  if (results.isError || !results.data) {
    return (
      <p className="mt-3 text-[13px] text-muted-foreground" role="status">
        The results could not be loaded.{" "}
        <button type="button" className="text-accent-text underline underline-offset-4" onClick={() => void results.refetch()}>
          Try again
        </button>
      </p>
    );
  }
  return <GoalResultsView results={results.data} />;
}

/** The results themselves, separate from loading them so they can be shown and tested on their own. */
export function GoalResultsView({ results: r }: { results: import("../api.js").FlowResults }) {
  if (r.entered === 0) {
    return <p className="mt-3 text-[13px] text-muted-foreground">Nobody has entered this flow in the last {r.range_days} days yet.</p>;
  }
  return (
    <div className="mt-4 border-t border-border pt-4" aria-label="Goal results">
      <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat label="Entered" value={r.entered.toLocaleString("en-US")} />
        <Stat label="Reached the goal" value={r.converted.toLocaleString("en-US")} />
        <Stat label="Conversion" value={formatRate(r.conversion_rate)} />
        <Stat label="Typical time" value={formatDuration(r.median_hours_to_convert)} />
      </dl>
      <p className="mt-2 text-[12px] text-muted-foreground">
        People who entered in the last {r.range_days} days. This shows who got there after joining, not that the emails caused it.
      </p>
      {r.by_step.length > 0 && (
        <table className="mt-3 w-full text-[13px]">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th className="py-1 font-medium">Email</th>
              <th className="py-1 text-right font-medium">Sent to</th>
              <th className="py-1 text-right font-medium">Of those, reached the goal</th>
            </tr>
          </thead>
          <tbody>
            {r.by_step.map((s) => (
              <tr key={s.step} className="border-t border-border">
                <td className="py-1.5 text-foreground">Step {s.step}</td>
                <td className="py-1.5 text-right tabular-nums text-foreground">{s.sent.toLocaleString("en-US")}</td>
                <td className="py-1.5 text-right tabular-nums text-foreground">
                  {s.converted.toLocaleString("en-US")}{" "}
                  <span className="text-muted-foreground">({formatRate(s.sent > 0 ? s.converted / s.sent : null)})</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[12px] text-muted-foreground">{label}</dt>
      <dd className="text-[20px] font-semibold tabular-nums text-foreground">{value}</dd>
    </div>
  );
}
