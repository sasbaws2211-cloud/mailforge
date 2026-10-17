/**
 * Editor for a flow condition: "send this email only if..." / "stop the flow if...".
 *
 * Rows of [what] [how] [value], joined by "all of these" or "any of these". A row can be about the contact
 * (payment status, plan, engagement, email, a trait), their lifecycle stage, or something they did (an event,
 * in a stated window). The rows are plain strings (see ../conditions.ts); this component only renders them and
 * reports changes. Turning them into the API shape, and saving, belong to the caller.
 *
 * Mirror side: PUBLIC (apps/dashboard is mirrored).
 */
import { Plus, X } from "lucide-react";

import { Button } from "./ui/button.js";
import { Input } from "./ui/input.js";
import { Select } from "./ui/select.js";
import { ValueControl } from "./audience-editor.js";
import { OP_LABELS, type AudienceRow } from "../audience.js";
import {
  EVENT_OP_LABELS,
  FIELD_LABELS,
  FIELD_ORDER,
  LIFECYCLE_STATES,
  MAX_CONDITION_ROWS,
  changeConditionField,
  changeConditionOp,
  newConditionRow,
  opsFor,
  type ConditionField,
  type ConditionRow,
  type ConditionState,
  type EventWindow,
} from "../conditions.js";

const toAudienceRow = (row: ConditionRow): AudienceRow => ({
  id: row.id,
  field: row.field as AudienceRow["field"],
  key: row.key,
  op: row.op,
  value: row.value,
  values: row.values,
});

function RowControls({
  row,
  label,
  onChange,
  disabled,
  eventSuggestions,
  allowStepWindow,
  listId,
}: {
  row: ConditionRow;
  label: string;
  onChange: (row: ConditionRow) => void;
  disabled?: boolean;
  eventSuggestions: string[];
  allowStepWindow: boolean;
  listId: string;
}) {
  if (row.field === "event") {
    return (
      <>
        <div className="w-28">
          <Select aria-label={`${label} comparison`} value={row.op} disabled={disabled} onChange={(e) => onChange(changeConditionOp(row, e.target.value))}>
            {opsFor("event").map((op) => (
              <option key={op} value={op}>
                {EVENT_OP_LABELS[op]}
              </option>
            ))}
          </Select>
        </div>
        <div className="min-w-[10rem] flex-1">
          <Input
            aria-label={`${label} event name`}
            type="text"
            list={listId}
            value={row.name}
            disabled={disabled}
            placeholder="event name, e.g. exported_report"
            autoComplete="off"
            onChange={(e) => onChange({ ...row, name: e.target.value })}
          />
          <datalist id={listId}>
            {eventSuggestions.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
        </div>
        {row.op === "performed" && (
          <div className="w-24">
            <Input
              aria-label={`${label} at least this many times`}
              type="number"
              min={1}
              value={row.minCount}
              disabled={disabled}
              placeholder="times"
              onChange={(e) => onChange({ ...row, minCount: e.target.value })}
            />
          </div>
        )}
        <div className="w-48">
          <Select
            aria-label={`${label} time window`}
            value={row.window}
            disabled={disabled}
            onChange={(e) => onChange({ ...row, window: e.target.value as EventWindow })}
          >
            <option value="within_days">in the last N days</option>
            {allowStepWindow && <option value="step">since this step</option>}
            <option value="flow">since entering the flow</option>
          </Select>
        </div>
        {row.window === "within_days" && (
          <div className="w-20">
            <Input
              aria-label={`${label} number of days`}
              type="number"
              min={1}
              max={365}
              value={row.days}
              disabled={disabled}
              onChange={(e) => onChange({ ...row, days: e.target.value })}
            />
          </div>
        )}
      </>
    );
  }

  const opSelect = row.field !== "has_email" && (
    <div className="w-40">
      <Select aria-label={`${label} comparison`} value={row.op} disabled={disabled} onChange={(e) => onChange(changeConditionOp(row, e.target.value))}>
        {opsFor(row.field).map((op) => (
          <option key={op} value={op}>
            {OP_LABELS[op]}
          </option>
        ))}
      </Select>
    </div>
  );

  if (row.field === "lifecycle_state") {
    return (
      <>
        {opSelect}
        <div className="min-w-[10rem] flex-1">
          <Select aria-label={`${label} value`} value={row.value} disabled={disabled} onChange={(e) => onChange({ ...row, value: e.target.value })}>
            {LIFECYCLE_STATES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
        </div>
      </>
    );
  }

  return (
    <>
      {row.field === "trait" && (
        <div className="w-40">
          <Input
            aria-label={`${label} trait name`}
            type="text"
            value={row.key}
            disabled={disabled}
            placeholder="trait name"
            autoComplete="off"
            onChange={(e) => onChange({ ...row, key: e.target.value })}
          />
        </div>
      )}
      {opSelect}
      <div className="min-w-[10rem] flex-1">
        <ValueControl
          row={toAudienceRow(row)}
          label={label}
          disabled={disabled}
          onChange={(next) => onChange({ ...row, key: next.key, op: next.op, value: next.value, values: next.values })}
        />
      </div>
    </>
  );
}

export function ConditionEditor({
  state,
  onChange,
  errors = {},
  disabled,
  firstLabel = "Only if",
  addLabel = "Add a condition",
  emptyText,
  eventSuggestions = [],
  allowStepWindow = true,
  idPrefix = "cond",
}: {
  state: ConditionState;
  onChange: (state: ConditionState) => void;
  /** Problems keyed by row id. */
  errors?: Record<string, string | undefined>;
  disabled?: boolean;
  /** The word at the start of the first row, e.g. "Only if" or "Stop if". */
  firstLabel?: string;
  addLabel?: string;
  /** Shown when there are no rows. */
  emptyText: string;
  /** Names of events the app already sends, offered as you type. */
  eventSuggestions?: string[];
  /** False for plan-level exits, where there is no step to measure from. */
  allowStepWindow?: boolean;
  /** Keeps the element ids of several editors on one page apart. */
  idPrefix?: string;
}) {
  const { rows, match } = state;
  const update = (id: string, next: ConditionRow) => onChange({ ...state, rows: rows.map((r) => (r.id === id ? next : r)) });

  return (
    <div>
      {rows.length === 0 ? (
        <p className="text-[14px] text-muted-foreground">{emptyText}</p>
      ) : (
        <>
          {rows.length > 1 && (
            <div className="mb-3 flex items-center gap-2 text-[14px] text-foreground">
              <span>Match</span>
              <div className="w-32">
                <Select
                  aria-label="Match all or any of the conditions"
                  value={match}
                  disabled={disabled}
                  onChange={(e) => onChange({ ...state, match: e.target.value === "any" ? "any" : "all" })}
                >
                  <option value="all">all of these</option>
                  <option value="any">any of these</option>
                </Select>
              </div>
            </div>
          )}
          <ul className="space-y-3">
            {rows.map((row, index) => {
              const label = `Condition ${index + 1}`;
              const error = errors[row.id];
              return (
                <li key={row.id}>
                  <div className="flex flex-wrap items-start gap-2">
                    <span className="mt-2 w-14 shrink-0 text-[13px] text-muted-foreground">
                      {index === 0 ? firstLabel : match === "any" ? "or" : "and"}
                    </span>
                    <div className="w-40">
                      <Select
                        aria-label={`${label} field`}
                        value={row.field}
                        disabled={disabled}
                        onChange={(e) => update(row.id, changeConditionField(row, e.target.value as ConditionField))}
                      >
                        {FIELD_ORDER.map((f) => (
                          <option key={f} value={f}>
                            {FIELD_LABELS[f]}
                          </option>
                        ))}
                      </Select>
                    </div>
                    <RowControls
                      row={row}
                      label={label}
                      disabled={disabled}
                      eventSuggestions={eventSuggestions}
                      allowStepWindow={allowStepWindow}
                      listId={`${idPrefix}-events-${row.id}`}
                      onChange={(next) => update(row.id, next)}
                    />
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      disabled={disabled}
                      aria-label={`Remove ${label.toLowerCase()}`}
                      onClick={() => onChange({ ...state, rows: rows.filter((r) => r.id !== row.id) })}
                    >
                      <X size={16} strokeWidth={1.5} />
                    </Button>
                  </div>
                  {error && (
                    <p className="mt-1 pl-16 text-[13px] text-danger" role="alert">
                      {error}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
      <div className="mt-3">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={disabled || rows.length >= MAX_CONDITION_ROWS}
          onClick={() => onChange({ ...state, rows: [...rows, newConditionRow()] })}
        >
          <Plus size={16} strokeWidth={1.5} />
          {rows.length === 0 ? addLabel : "Add another"}
        </Button>
        {rows.length >= MAX_CONDITION_ROWS && (
          <span className="ml-3 text-[13px] text-muted-foreground">Up to {MAX_CONDITION_ROWS} conditions.</span>
        )}
      </div>
    </div>
  );
}
