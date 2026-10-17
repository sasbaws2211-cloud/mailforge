/**
 * Editor for a segment's rules: "people who match all/any of these", with rows and, if needed, groups.
 *
 * A row is [what] [how] [value]: a fact about the contact (payment status, plan, lifecycle stage, a trait...), when
 * they were first or last seen, or something they did in the last N days. A group is a small box of rows with its
 * own all/any, for "this and (that or that)". One level only, like the server. The rows are plain strings (see
 * ../segment-rules.ts); this component renders them and reports changes. Saving belongs to the caller.
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
  AGE_OP_LABELS,
  EVENT_OP_LABELS,
  FIELD_LABELS,
  FIELD_ORDER,
  SEGMENT_LIFECYCLE_STATES,
  SEGMENT_MAX_GROUP_LEAVES,
  SEGMENT_MAX_LEAVES,
  changeRowField,
  changeRowOp,
  countRows,
  newGroup,
  newSegmentRow,
  opsFor,
  type SegmentField,
  type SegmentGroupState,
  type SegmentRow,
  type SegmentState,
} from "../segment-rules.js";

const toAudienceRow = (row: SegmentRow): AudienceRow => ({
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
  listId,
}: {
  row: SegmentRow;
  label: string;
  onChange: (row: SegmentRow) => void;
  disabled?: boolean;
  eventSuggestions: string[];
  listId: string;
}) {
  if (row.field === "event") {
    return (
      <>
        <div className="w-28">
          <Select aria-label={`${label} comparison`} value={row.op} disabled={disabled} onChange={(e) => onChange(changeRowOp(row, e.target.value))}>
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
        <span className="mt-2 text-[14px] text-muted-foreground">in the last</span>
        <div className="w-20">
          <Input aria-label={`${label} number of days`} type="number" min={1} max={365} value={row.days} disabled={disabled} onChange={(e) => onChange({ ...row, days: e.target.value })} />
        </div>
        <span className="mt-2 text-[14px] text-muted-foreground">days</span>
      </>
    );
  }

  if (row.field === "first_seen" || row.field === "last_seen") {
    return (
      <>
        <div className="w-36">
          <Select aria-label={`${label} comparison`} value={row.op} disabled={disabled} onChange={(e) => onChange(changeRowOp(row, e.target.value))}>
            {opsFor(row.field).map((op) => (
              <option key={op} value={op}>
                {AGE_OP_LABELS[op]}
              </option>
            ))}
          </Select>
        </div>
        <div className="w-24">
          <Input aria-label={`${label} number of days`} type="number" min={0} max={3650} value={row.days} disabled={disabled} onChange={(e) => onChange({ ...row, days: e.target.value })} />
        </div>
        <span className="mt-2 text-[14px] text-muted-foreground">{row.op === "before_days" ? "days ago" : "days"}</span>
      </>
    );
  }

  const opSelect = row.field !== "has_email" && (
    <div className="w-40">
      <Select aria-label={`${label} comparison`} value={row.op} disabled={disabled} onChange={(e) => onChange(changeRowOp(row, e.target.value))}>
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
          {row.op === "in" ? (
            <div className="flex flex-wrap gap-x-4 gap-y-1.5" role="group" aria-label={`${label} stages`}>
              {SEGMENT_LIFECYCLE_STATES.map((s) => (
                <label key={s} className="flex items-center gap-1.5 text-[14px] text-foreground">
                  <input
                    type="checkbox"
                    checked={row.values.includes(s)}
                    disabled={disabled}
                    onChange={(e) => onChange({ ...row, values: e.target.checked ? [...row.values, s] : row.values.filter((v) => v !== s) })}
                  />
                  {s}
                </label>
              ))}
            </div>
          ) : (
            <Select aria-label={`${label} value`} value={row.value} disabled={disabled} onChange={(e) => onChange({ ...row, value: e.target.value })}>
              {SEGMENT_LIFECYCLE_STATES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          )}
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

function RuleRow({
  row,
  label,
  lead,
  onChange,
  onRemove,
  error,
  disabled,
  eventSuggestions,
  idPrefix,
}: {
  row: SegmentRow;
  label: string;
  /** The word at the start of the row: "Where", "and" or "or". */
  lead: string;
  onChange: (row: SegmentRow) => void;
  onRemove: () => void;
  error: string | undefined;
  disabled?: boolean;
  eventSuggestions: string[];
  idPrefix: string;
}) {
  return (
    <li>
      <div className="flex flex-wrap items-start gap-2">
        <span className="mt-2 w-14 shrink-0 text-[13px] text-muted-foreground">{lead}</span>
        <div className="w-40">
          <Select aria-label={`${label} field`} value={row.field} disabled={disabled} onChange={(e) => onChange(changeRowField(row, e.target.value as SegmentField))}>
            {FIELD_ORDER.map((f) => (
              <option key={f} value={f}>
                {FIELD_LABELS[f]}
              </option>
            ))}
          </Select>
        </div>
        <RowControls row={row} label={label} disabled={disabled} eventSuggestions={eventSuggestions} listId={`${idPrefix}-events-${row.id}`} onChange={onChange} />
        <Button type="button" variant="secondary" size="sm" disabled={disabled} aria-label={`Remove ${label.toLowerCase()}`} onClick={onRemove}>
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
}

function MatchSelect({ value, onChange, disabled, label }: { value: "all" | "any"; onChange: (v: "all" | "any") => void; disabled?: boolean; label: string }) {
  return (
    <div className="w-36">
      <Select aria-label={label} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value === "any" ? "any" : "all")}>
        <option value="all">all of these</option>
        <option value="any">any of these</option>
      </Select>
    </div>
  );
}

export function SegmentRuleEditor({
  state,
  onChange,
  errors = {},
  disabled,
  eventSuggestions = [],
  idPrefix = "seg",
}: {
  state: SegmentState;
  onChange: (state: SegmentState) => void;
  /** Problems keyed by row id (or group id). */
  errors?: Record<string, string | undefined>;
  disabled?: boolean;
  /** Names of events the app already sends, offered as you type. */
  eventSuggestions?: string[];
  /** Keeps element ids of several editors on one page apart. */
  idPrefix?: string;
}) {
  const total = countRows(state);
  const full = total >= SEGMENT_MAX_LEAVES;
  const updateItem = (index: number, next: SegmentState["items"][number]) =>
    onChange({ ...state, items: state.items.map((it, i) => (i === index ? next : it)) });
  const removeItem = (index: number) => onChange({ ...state, items: state.items.filter((_, i) => i !== index) });

  return (
    <div>
      {state.items.length === 0 ? (
        <p className="text-[14px] text-muted-foreground">No rules yet: add one to say who belongs in this segment.</p>
      ) : (
        <>
          {state.items.length > 1 && (
            <div className="mb-3 flex items-center gap-2 text-[14px] text-foreground">
              <span>People who match</span>
              <MatchSelect label="Match all or any of the rules" value={state.match} disabled={disabled} onChange={(match) => onChange({ ...state, match })} />
              <span>the rules below</span>
            </div>
          )}
          <ul className="space-y-3">
            {state.items.map((item, index) => {
              const lead = index === 0 ? "Where" : state.match === "any" ? "or" : "and";
              if (item.kind === "row") {
                return (
                  <RuleRow
                    key={item.row.id}
                    row={item.row}
                    label={`Rule ${index + 1}`}
                    lead={lead}
                    disabled={disabled}
                    error={errors[item.row.id]}
                    eventSuggestions={eventSuggestions}
                    idPrefix={idPrefix}
                    onChange={(row) => updateItem(index, { kind: "row", row })}
                    onRemove={() => removeItem(index)}
                  />
                );
              }
              const group = item.group;
              const setGroup = (g: SegmentGroupState) => updateItem(index, { kind: "group", group: g });
              return (
                <li key={group.id}>
                  <div className="flex items-start gap-2">
                    <span className="mt-2 w-14 shrink-0 text-[13px] text-muted-foreground">{lead}</span>
                    <section aria-label={`Group ${index + 1}`} className="min-w-0 flex-1 rounded-lg border border-border bg-sunken p-3">
                      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-2 text-[14px] text-foreground">
                          <span>Matches</span>
                          <MatchSelect label={`Group ${index + 1} match`} value={group.match} disabled={disabled} onChange={(match) => setGroup({ ...group, match })} />
                          <span>of these</span>
                        </div>
                        <Button type="button" variant="secondary" size="sm" disabled={disabled} aria-label={`Remove group ${index + 1}`} onClick={() => removeItem(index)}>
                          <X size={16} strokeWidth={1.5} /> Remove group
                        </Button>
                      </div>
                      {group.rows.length === 0 && <p className="text-[13px] text-muted-foreground">This group has no rules yet.</p>}
                      <ul className="space-y-3">
                        {group.rows.map((row, r) => (
                          <RuleRow
                            key={row.id}
                            row={row}
                            label={`Group ${index + 1} rule ${r + 1}`}
                            lead={r === 0 ? "Where" : group.match === "any" ? "or" : "and"}
                            disabled={disabled}
                            error={errors[row.id]}
                            eventSuggestions={eventSuggestions}
                            idPrefix={idPrefix}
                            onChange={(next) => setGroup({ ...group, rows: group.rows.map((x) => (x.id === row.id ? next : x)) })}
                            onRemove={() => setGroup({ ...group, rows: group.rows.filter((x) => x.id !== row.id) })}
                          />
                        ))}
                      </ul>
                      {errors[group.id] && (
                        <p className="mt-2 text-[13px] text-danger" role="alert">
                          {errors[group.id]}
                        </p>
                      )}
                      <div className="mt-3">
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          disabled={disabled || full || group.rows.length >= SEGMENT_MAX_GROUP_LEAVES}
                          onClick={() => setGroup({ ...group, rows: [...group.rows, newSegmentRow()] })}
                        >
                          <Plus size={16} strokeWidth={1.5} /> Add a rule to this group
                        </Button>
                      </div>
                    </section>
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button type="button" variant="secondary" size="sm" disabled={disabled || full} onClick={() => onChange({ ...state, items: [...state.items, { kind: "row", row: newSegmentRow() }] })}>
          <Plus size={16} strokeWidth={1.5} />
          {state.items.length === 0 ? "Add a rule" : "Add another rule"}
        </Button>
        <Button type="button" variant="outline" size="sm" disabled={disabled || full} onClick={() => onChange({ ...state, items: [...state.items, { kind: "group", group: newGroup() }] })}>
          <Plus size={16} strokeWidth={1.5} /> Add a group
        </Button>
        {full && <span className="text-[13px] text-muted-foreground">Up to {SEGMENT_MAX_LEAVES} rules in total.</span>}
      </div>
    </div>
  );
}
