/**
 * Editor for a flow trigger's audience: "only contacts where...".
 *
 * Rows of [what] [how] [value], all of which must hold. Rows are plain strings (see ../audience.ts); this
 * component only renders them and reports changes. Saving, and turning rows into the API shape, belong to
 * the caller.
 *
 * Mirror side: PUBLIC (apps/dashboard is mirrored).
 */
import { Plus, X } from "lucide-react";

import { Button } from "./ui/button.js";
import { Input } from "./ui/input.js";
import { Select } from "./ui/select.js";
import {
  FIELD_LABELS,
  MAX_AUDIENCE_CONDITIONS,
  OP_LABELS,
  changeField,
  changeOp,
  newRow,
  opsFor,
  optionsFor,
  type AudienceField,
  type AudienceRow,
} from "../audience.js";

const FIELDS = Object.keys(FIELD_LABELS) as AudienceField[];

function ValueControl({
  row,
  onChange,
  disabled,
  label,
}: {
  row: AudienceRow;
  onChange: (row: AudienceRow) => void;
  disabled?: boolean;
  label: string;
}) {
  if (row.field === "trait" && (row.op === "is_set" || row.op === "is_not_set")) return null;

  if (row.field === "has_email") {
    return (
      <Select aria-label={`${label} value`} value={row.value} disabled={disabled} onChange={(e) => onChange({ ...row, value: e.target.value })}>
        <option value="yes">Has an email address</option>
        <option value="no">Has no email address</option>
      </Select>
    );
  }

  if (row.field === "payment_status" || row.field === "engagement_depth") {
    const options = optionsFor(row.field);
    if (row.op === "in") {
      return (
        <div className="flex flex-wrap gap-x-4 gap-y-1.5" role="group" aria-label={`${label} values`}>
          {options.map((opt) => (
            <label key={opt} className="flex items-center gap-1.5 text-[14px] text-foreground">
              <input
                type="checkbox"
                checked={row.values.includes(opt)}
                disabled={disabled}
                onChange={(e) =>
                  onChange({ ...row, values: e.target.checked ? [...row.values, opt] : row.values.filter((v) => v !== opt) })
                }
              />
              {opt}
            </label>
          ))}
        </div>
      );
    }
    return (
      <Select aria-label={`${label} value`} value={row.value} disabled={disabled} onChange={(e) => onChange({ ...row, value: e.target.value })}>
        {options.map((opt) => (
          <option key={opt} value={opt}>
            {opt}
          </option>
        ))}
      </Select>
    );
  }

  const numeric = row.field === "trait" && (row.op === "gt" || row.op === "lt");
  return (
    <Input
      aria-label={`${label} value`}
      type={numeric ? "number" : "text"}
      value={row.value}
      disabled={disabled}
      placeholder={row.field === "plan" ? "e.g. Pro" : numeric ? "e.g. 10" : "value"}
      autoComplete="off"
      onChange={(e) => onChange({ ...row, value: e.target.value })}
    />
  );
}

export function AudienceEditor({
  rows,
  onChange,
  errors = {},
  disabled,
}: {
  rows: AudienceRow[];
  onChange: (rows: AudienceRow[]) => void;
  /** Problems keyed by row id. */
  errors?: Record<string, string | undefined>;
  disabled?: boolean;
}) {
  const update = (id: string, next: AudienceRow) => onChange(rows.map((r) => (r.id === id ? next : r)));

  return (
    <div>
      {rows.length === 0 ? (
        <p className="text-[14px] text-muted-foreground">Everyone who matches the trigger enters the flow.</p>
      ) : (
        <ul className="space-y-3">
          {rows.map((row, index) => {
            const label = `Condition ${index + 1}`;
            const error = errors[row.id];
            return (
              <li key={row.id}>
                <div className="flex flex-wrap items-start gap-2">
                  <span className="mt-2 w-10 shrink-0 text-[13px] text-muted-foreground">{index === 0 ? "Only if" : "and"}</span>
                  <div className="w-44">
                    <Select
                      aria-label={`${label} field`}
                      value={row.field}
                      disabled={disabled}
                      onChange={(e) => update(row.id, changeField(row, e.target.value as AudienceField))}
                    >
                      {FIELDS.map((f) => (
                        <option key={f} value={f}>
                          {FIELD_LABELS[f]}
                        </option>
                      ))}
                    </Select>
                  </div>
                  {row.field === "trait" && (
                    <div className="w-40">
                      <Input
                        aria-label={`${label} trait name`}
                        type="text"
                        value={row.key}
                        disabled={disabled}
                        placeholder="trait name"
                        autoComplete="off"
                        onChange={(e) => update(row.id, { ...row, key: e.target.value })}
                      />
                    </div>
                  )}
                  {row.field !== "has_email" && (
                    <div className="w-40">
                      <Select
                        aria-label={`${label} comparison`}
                        value={row.op}
                        disabled={disabled}
                        onChange={(e) => update(row.id, changeOp(row, e.target.value))}
                      >
                        {opsFor(row.field).map((op) => (
                          <option key={op} value={op}>
                            {OP_LABELS[op]}
                          </option>
                        ))}
                      </Select>
                    </div>
                  )}
                  <div className="min-w-[10rem] flex-1">
                    <ValueControl row={row} onChange={(next) => update(row.id, next)} disabled={disabled} label={label} />
                  </div>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={disabled}
                    aria-label={`Remove ${label.toLowerCase()}`}
                    onClick={() => onChange(rows.filter((r) => r.id !== row.id))}
                  >
                    <X size={16} strokeWidth={1.5} />
                  </Button>
                </div>
                {error && (
                  <p className="mt-1 pl-12 text-[13px] text-danger" role="alert">
                    {error}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <div className="mt-3">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={disabled || rows.length >= MAX_AUDIENCE_CONDITIONS}
          onClick={() => onChange([...rows, newRow()])}
        >
          <Plus size={16} strokeWidth={1.5} />
          {rows.length === 0 ? "Add a condition" : "Add another"}
        </Button>
        {rows.length >= MAX_AUDIENCE_CONDITIONS && (
          <span className="ml-3 text-[13px] text-muted-foreground">Up to {MAX_AUDIENCE_CONDITIONS} conditions.</span>
        )}
      </div>
    </div>
  );
}
