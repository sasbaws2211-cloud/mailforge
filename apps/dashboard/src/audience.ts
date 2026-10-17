/**
 * The "only contacts where..." filter on a flow trigger, as the editor sees it.
 *
 * The API stores it in trigger_config.audience (see packages/core/src/audience.ts, which also validates it
 * on the server). The editor works with flat rows of strings, which are easy to bind to form controls, and
 * converts to and from the API shape here. Nothing in this file talks to the network.
 *
 * Mirror side: PUBLIC (apps/dashboard is mirrored).
 */

export const MAX_AUDIENCE_CONDITIONS = 5;

export type AudienceField = "payment_status" | "engagement_depth" | "plan" | "has_email" | "trait";

export interface AudienceRow {
  /** Stable key for the list (not sent anywhere). */
  id: string;
  field: AudienceField;
  /** Trait name, for field = "trait". */
  key: string;
  op: string;
  /** Single value: a status, a plan name, "yes"/"no", or text/number for traits. */
  value: string;
  /** Chosen values, for op = "in". */
  values: string[];
}

/** What the API accepts and returns (a subset of the server's schema, which is the authority). */
export type ApiCondition =
  | { field: "payment_status" | "engagement_depth"; op: "is" | "is_not"; value: string }
  | { field: "payment_status" | "engagement_depth"; op: "in"; value: string[] }
  | { field: "plan"; op: "is" | "is_not"; value: string }
  | { field: "has_email"; op: "is"; value: boolean }
  | { field: "trait"; key: string; op: "is" | "is_not" | "contains"; value: string }
  | { field: "trait"; key: string; op: "gt" | "lt"; value: number }
  | { field: "trait"; key: string; op: "is_set" | "is_not_set" };

export interface ApiAudience {
  conditions: ApiCondition[];
}

export const PAYMENT_STATUSES = ["free", "trial", "paid", "past_due", "cancelled"] as const;
export const ENGAGEMENT_DEPTHS = ["power", "regular", "casual", "minimal"] as const;

export const FIELD_LABELS: Record<AudienceField, string> = {
  payment_status: "Payment status",
  engagement_depth: "Engagement",
  plan: "Plan",
  has_email: "Email address",
  trait: "Custom trait",
};

export const OP_LABELS: Record<string, string> = {
  is: "is",
  is_not: "is not",
  in: "is one of",
  contains: "contains",
  gt: "is greater than",
  lt: "is less than",
  is_set: "is set",
  is_not_set: "is not set",
};

export function opsFor(field: AudienceField): string[] {
  switch (field) {
    case "payment_status":
    case "engagement_depth":
      return ["is", "is_not", "in"];
    case "plan":
      return ["is", "is_not"];
    case "has_email":
      return ["is"];
    case "trait":
      return ["is", "is_not", "contains", "gt", "lt", "is_set", "is_not_set"];
  }
}

export function optionsFor(field: AudienceField): readonly string[] {
  return field === "payment_status" ? PAYMENT_STATUSES : field === "engagement_depth" ? ENGAGEMENT_DEPTHS : [];
}

let counter = 0;
const nextId = () => `aud-${++counter}`;

export function newRow(field: AudienceField = "payment_status"): AudienceRow {
  const options = optionsFor(field);
  return {
    id: nextId(),
    field,
    key: "",
    op: opsFor(field)[0]!,
    value: field === "has_email" ? "yes" : (options[0] ?? ""),
    values: [],
  };
}

/** A row after the person changed its field: the operator and value restart so nothing stale is kept. */
export function changeField(row: AudienceRow, field: AudienceField): AudienceRow {
  return { ...newRow(field), id: row.id };
}

/** A row after the person changed its operator: keep what still makes sense. */
export function changeOp(row: AudienceRow, op: string): AudienceRow {
  const next: AudienceRow = { ...row, op };
  if (op === "in") next.values = row.values.length > 0 ? row.values : row.value ? [row.value] : [];
  if (op !== "in" && row.op === "in") next.value = row.values[0] ?? optionsFor(row.field)[0] ?? "";
  return next;
}

const TRAIT_KEY = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;

export interface RowsResult {
  /** The audience to send, or null when there are no rows (meaning: everyone). */
  audience: ApiAudience | null;
  /** Problems keyed by row id. Empty when the rows are good to send. */
  errors: Record<string, string>;
}

export function rowsToAudience(rows: AudienceRow[]): RowsResult {
  const errors: Record<string, string> = {};
  const conditions: ApiCondition[] = [];
  for (const row of rows) {
    const c = rowToCondition(row);
    if (typeof c === "string") errors[row.id] = c;
    else conditions.push(c);
  }
  if (rows.length === 0) return { audience: null, errors };
  return { audience: Object.keys(errors).length === 0 ? { conditions } : null, errors };
}

function rowToCondition(row: AudienceRow): ApiCondition | string {
  const value = row.value.trim();
  switch (row.field) {
    case "payment_status":
    case "engagement_depth": {
      const allowed = optionsFor(row.field);
      if (row.op === "in") {
        const picked = row.values.filter((v) => allowed.includes(v));
        return picked.length > 0 ? { field: row.field, op: "in", value: picked } : "Pick at least one.";
      }
      if (row.op !== "is" && row.op !== "is_not") return "Choose how to compare.";
      return allowed.includes(value) ? { field: row.field, op: row.op, value } : "Pick a value.";
    }
    case "plan":
      if (row.op !== "is" && row.op !== "is_not") return "Choose how to compare.";
      if (!value) return "Enter the plan name.";
      return value.length > 100 ? "Plan name is too long." : { field: "plan", op: row.op, value };
    case "has_email":
      return value === "yes" || value === "no" ? { field: "has_email", op: "is", value: value === "yes" } : "Pick yes or no.";
    case "trait": {
      const key = row.key.trim();
      if (!key) return "Enter the trait name.";
      if (!TRAIT_KEY.test(key)) return "Trait names use letters, numbers, _ . and - (up to 64).";
      if (row.op === "is_set" || row.op === "is_not_set") return { field: "trait", key, op: row.op };
      if (!value) return "Enter a value.";
      if (row.op === "gt" || row.op === "lt") {
        const n = Number(value);
        return Number.isFinite(n) ? { field: "trait", key, op: row.op, value: n } : "Enter a number.";
      }
      if (row.op === "is" || row.op === "is_not" || row.op === "contains") {
        return value.length > 200 ? "That value is too long." : { field: "trait", key, op: row.op, value };
      }
      return "Choose how to compare.";
    }
  }
}

export interface ParsedAudience {
  rows: AudienceRow[];
  /** True when an audience is stored but this editor cannot show it faithfully (a newer or hand-written shape). */
  unreadable: boolean;
}

/** Rows for an audience stored on a flow. Never guesses: anything unexpected makes the whole thing unreadable. */
export function audienceToRows(audience: unknown): ParsedAudience {
  if (audience === undefined || audience === null) return { rows: [], unreadable: false };
  const conditions = (audience as { conditions?: unknown }).conditions;
  if (!Array.isArray(conditions)) return { rows: [], unreadable: true };
  const rows: AudienceRow[] = [];
  for (const raw of conditions) {
    const row = conditionToRow(raw);
    if (!row) return { rows: [], unreadable: true };
    rows.push(row);
  }
  return { rows, unreadable: false };
}

function conditionToRow(raw: unknown): AudienceRow | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  const field = c.field;
  const op = c.op;
  if (typeof op !== "string") return null;
  const base = { id: nextId(), key: "", value: "", values: [] as string[] };
  switch (field) {
    case "payment_status":
    case "engagement_depth":
      if (op === "in" && Array.isArray(c.value) && c.value.every((v) => typeof v === "string")) {
        return { ...base, field, op, values: c.value as string[] };
      }
      return (op === "is" || op === "is_not") && typeof c.value === "string" ? { ...base, field, op, value: c.value } : null;
    case "plan":
      return (op === "is" || op === "is_not") && typeof c.value === "string" ? { ...base, field, op, value: c.value } : null;
    case "has_email":
      return op === "is" && typeof c.value === "boolean" ? { ...base, field, op, value: c.value ? "yes" : "no" } : null;
    case "trait": {
      if (typeof c.key !== "string") return null;
      if (op === "is_set" || op === "is_not_set") return { ...base, field, key: c.key, op };
      if ((op === "gt" || op === "lt") && typeof c.value === "number") return { ...base, field, key: c.key, op, value: String(c.value) };
      if ((op === "is" || op === "is_not") && ["string", "number", "boolean"].includes(typeof c.value)) {
        return { ...base, field, key: c.key, op, value: String(c.value) };
      }
      if (op === "contains" && typeof c.value === "string") return { ...base, field, key: c.key, op, value: c.value };
      return null;
    }
    default:
      return null;
  }
}

/** Plain-English phrases, one per condition, for read-only display. */
export function describeAudience(audience: unknown): string[] {
  const { rows, unreadable } = audienceToRows(audience);
  if (unreadable) return ["a filter this editor cannot show"];
  return rows.map(describeRow);
}

function describeRow(row: AudienceRow): string {
  const op = OP_LABELS[row.op] ?? row.op;
  switch (row.field) {
    case "payment_status":
    case "engagement_depth": {
      const subject = row.field === "payment_status" ? "payment status" : "engagement";
      return row.op === "in" ? `${subject} is one of ${row.values.join(", ")}` : `${subject} ${op} ${row.value}`;
    }
    case "plan":
      return `plan ${op} ${row.value}`;
    case "has_email":
      return row.value === "yes" ? "has an email address" : "has no email address";
    case "trait":
      return row.op === "is_set" || row.op === "is_not_set" ? `${row.key} ${op}` : `${row.key} ${op} ${row.value}`;
  }
}
