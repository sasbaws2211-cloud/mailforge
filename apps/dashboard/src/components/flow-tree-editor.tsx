/**
 * Editor for a flow that can split: a list of emails that may end in "split into two paths", where each path is
 * again a list of emails that may end in a split (see ../flow-tree.ts for the model and its rules).
 *
 * SequenceEditor is the list. It reuses StepWriter for the emails, then offers the split. ForkEditor is the
 * split: how long to wait, the condition that decides, and the two paths, each drawn by SequenceEditor again.
 * The tree is plain data; this file only draws it and reports changes. Saving belongs to the caller.
 *
 * Mirror side: PUBLIC (apps/dashboard is mirrored).
 */
import type { ReactNode } from "react";
import { GitFork, X } from "lucide-react";

import { Button } from "./ui/button.js";
import { Select } from "./ui/select.js";
import { ConditionEditor } from "./condition-editor.js";
import { StepWriter, DELAY_PRESETS } from "./step-writer.js";
import { newConditionRow } from "../conditions.js";
import {
  MAX_FLOW_NODES,
  MAX_FORK_DEPTH,
  canAddFork,
  newFork,
  type ForkData,
  type SequenceData,
} from "../flow-tree.js";

/** What every sequence in the tree needs to know about the flow around it. */
export interface TreeContext {
  flowId: string | undefined;
  hasLlm: boolean;
  disabled?: boolean;
  triggerType?: string;
  triggerConfig?: Record<string, unknown>;
  flowName?: string;
  /** Problems with condition rows and splits, keyed by row id or split id. */
  conditionErrors: Record<string, string>;
  /** Names of events the app already sends. */
  eventSuggestions: string[];
  /** Emails plus splits in the whole flow, to stop at the limit. */
  totalNodes: number;
}

export function ForkEditor({
  fork,
  onChange,
  onRemove,
  renderPath,
  ctx,
  depth,
}: {
  fork: ForkData;
  onChange: (fork: ForkData) => void;
  onRemove: () => void;
  /** Draws one of the two paths; the sequence editor passes itself in here. */
  renderPath: (which: "yes" | "no") => ReactNode;
  ctx: TreeContext;
  /** Splits above this one (0 for the first). */
  depth: number;
}) {
  const error = ctx.conditionErrors[fork.id];
  return (
    <section
      aria-label={`Split ${depth + 1}`}
      className="rounded-lg border border-accent/40 bg-accent/5 p-4"
    >
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <GitFork size={18} strokeWidth={1.5} aria-hidden="true" className="text-accent-text" />
          <h3 className="text-[15px] font-semibold text-foreground">Split into two paths</h3>
        </div>
        <Button type="button" variant="secondary" size="sm" disabled={ctx.disabled} onClick={onRemove} aria-label="Remove this split">
          <X size={16} strokeWidth={1.5} /> Remove split
        </Button>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2 text-[14px] text-foreground">
        <span>After the emails above, wait</span>
        <div className="w-40">
          <Select
            aria-label="How long to wait before checking"
            value={fork.delay}
            disabled={ctx.disabled}
            onChange={(e) => onChange({ ...fork, delay: e.target.value })}
          >
            {DELAY_PRESETS.map((d) => (
              <option key={d.value} value={d.value}>
                {d.label}
              </option>
            ))}
          </Select>
        </div>
        <span>then check:</span>
      </div>

      <ConditionEditor
        state={fork.condition}
        onChange={(condition) => onChange({ ...fork, condition })}
        errors={ctx.conditionErrors}
        disabled={ctx.disabled}
        firstLabel="If"
        addLabel="Add a condition"
        emptyText="Add a condition to decide which path a contact takes."
        eventSuggestions={ctx.eventSuggestions}
        idPrefix={`${fork.id}-cond`}
      />
      {error && (
        <p className="mt-2 text-[13px] text-danger" role="alert">
          {error}
        </p>
      )}

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="rounded-md border border-border bg-background p-3" role="group" aria-label="If it holds">
          <p className="mb-3 text-[13px] font-semibold uppercase tracking-[0.06em] text-success">If it holds</p>
          {renderPath("yes")}
        </div>
        <div className="rounded-md border border-border bg-background p-3" role="group" aria-label="Otherwise">
          <p className="mb-3 text-[13px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">Otherwise</p>
          {renderPath("no")}
        </div>
      </div>
    </section>
  );
}

export function SequenceEditor({
  value,
  onChange,
  ctx,
  depth = 0,
  emptyText,
  addLabel,
}: {
  value: SequenceData;
  onChange: (value: SequenceData) => void;
  ctx: TreeContext;
  /** Splits above this sequence (0 for the main sequence). */
  depth?: number;
  emptyText?: string;
  addLabel?: string;
}) {
  const room = ctx.totalNodes < MAX_FLOW_NODES;
  const splitAllowed = canAddFork(value, depth, ctx.totalNodes);

  return (
    <div className="space-y-5">
      <StepWriter
        flowId={ctx.flowId}
        steps={value.steps}
        onStepsChange={(steps) => onChange({ ...value, steps })}
        disabled={ctx.disabled}
        hasLlm={ctx.hasLlm}
        triggerType={ctx.triggerType}
        triggerConfig={ctx.triggerConfig}
        flowName={ctx.flowName}
        conditionErrors={ctx.conditionErrors}
        eventSuggestions={ctx.eventSuggestions}
        emptyText={emptyText}
        addLabel={addLabel}
        canAdd={room}
      />

      {value.fork ? (
        <ForkEditor
          fork={value.fork}
          depth={depth}
          ctx={ctx}
          onChange={(fork) => onChange({ ...value, fork })}
          onRemove={() => onChange({ ...value, fork: null })}
          renderPath={(which) => (
            <SequenceEditor
              value={value.fork![which]}
              onChange={(seq) => onChange({ ...value, fork: { ...value.fork!, [which]: seq } })}
              ctx={ctx}
              depth={depth + 1}
              emptyText="Nothing is sent on this path: the flow ends here for these contacts."
              addLabel="Add an email to this path"
            />
          )}
        />
      ) : (
        <div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={ctx.disabled || !splitAllowed}
            onClick={() => onChange({ ...value, fork: newFork(newConditionRow("event")) })}
          >
            <GitFork size={16} strokeWidth={1.5} aria-hidden="true" />
            Split into two paths
          </Button>
          {depth >= MAX_FORK_DEPTH && (
            <p className="mt-1.5 text-[13px] text-muted-foreground">
              A path can pass through at most {MAX_FORK_DEPTH} splits.
            </p>
          )}
          {depth < MAX_FORK_DEPTH && !room && (
            <p className="mt-1.5 text-[13px] text-muted-foreground">
              A flow can have at most {MAX_FLOW_NODES} emails and splits in total.
            </p>
          )}
          {value.steps.length > 0 && splitAllowed && (
            <p className="mt-1.5 text-[13px] text-muted-foreground">
              Contacts who get the emails above are then sent down one path or the other by a condition.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
