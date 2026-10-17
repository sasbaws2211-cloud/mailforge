/**
 * Conditions inside a flow, as the editor sees them: "send this email only if...", "stop the flow if...".
 *
 * The engine's vocabulary is in packages/core/src/flow/condition.ts (which also validates what the API
 * receives). The editor works with flat rows of strings joined by "all of these" / "any of these", which is
 * what people can build with a few dropdowns, and converts to and from the API shape here. A condition the
 * editor cannot show faithfully (nested groups, which the AI may write) is reported as unreadable, never
 * flattened. Nothing in this file talks to the network.
 *
 * Mirror side: PUBLIC (apps/dashboard is mirrored).
 */
import {
  audienceToRows,
  rowToCondition,
  optionsFor,
  describeAudience,
  OP_LABELS,
  type AudienceField,
  type AudienceRow,
  type ApiCondition,
} from "./audience.js";

export const MAX_CONDITION_ROWS = 10;

export type ConditionField = AudienceField | "lifecycle_state" | "event";
export type EventWindow = "within_days" | "step" | "flow";

export const LIFECYCLE_STATES = ["signed_up", "activated", "engaged", "at_risk", "dormant", "churned", "resurrected"] as const;

export interface ConditionRow {
  id: string;
  field: ConditionField;
  /** Trait name, for field = "trait". */
  key: string;
  op: string;
  value: string;
  values: string[];
  /** Event rows: the event, its window, and "at least N times". */
  name: string;
  window: EventWindow;
  days: string;
  minCount: string;
}

export interface ConditionState {
  match: "all" | "any";
  rows: ConditionRow[];
}

export const emptyConditionState = (): ConditionState => ({ match: "all", rows: [] });

/** What the API stores: a leaf or an all/any group (see core's flow/condition.ts). */
export type ApiFlowCondition = ApiCondition | { lifecycle_state: string } | { lifecycle_state_not: string } | { event_since_step: string } | ApiEventCondition | { all: ApiFlowCondition[] } | { any: ApiFlowCondition[] };

export interface ApiEventCondition {
  field: "event";
  name: string;
  op: "performed" | "not_performed";
  within_days?: number;
  since?: "step" | "flow";
  min_count?: number;
}

export const FIELD_LABELS: Record<ConditionField, string> = {
  payment_status: "Payment status",
  engagement_depth: "Engagement",
  plan: "Plan",
  has_email: "Email address",
  trait: "Custom trait",
  lifecycle_state: "Lifecycle stage",
  event: "Did something",
};

export const FIELD_ORDER: ConditionField[] = ["event", "payment_status", "plan", "engagement_depth", "lifecycle_state", "has_email", "trait"];

export const EVENT_OP_LABELS: Record<string, string> = { performed: "did", not_performed: "did not" };

let counter = 0;
const nextId = () => `cond-${++counter}`;

const blank = (field: ConditionField): ConditionRow => ({
  id: nextId(),
  field,
  key: "",
  op: "is",
  value: "",
  values: [],
  name: "",
  window: "within_days",
  days: "7",
  minCount: "",
});

export function opsFor(field: ConditionField): string[] {
  switch (field) {
    case "event":
      return ["performed", "not_performed"];
    case "lifecycle_state":
      return ["is", "is_not"];
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

export function newConditionRow(field: ConditionField = "event"): ConditionRow {
  const row = blank(field);
  row.op = opsFor(field)[0]!;
  if (field === "lifecycle_state") row.value = LIFECYCLE_STATES[0];
  else if (field === "has_email") row.value = "yes";
  else row.value = (optionsFor(field as AudienceField)[0] as string | undefined) ?? "";
  return row;
}

/** Start a row over for a new field, keeping its place in the list. */
export function changeConditionField(row: ConditionRow, field: ConditionField): ConditionRow {
  return { ...newConditionRow(field), id: row.id };
}

/** Switching to "is one of" keeps the chosen value, and back keeps the first. */
export function changeConditionOp(row: ConditionRow, op: string): ConditionRow {
  const next: ConditionRow = { ...row, op };
  if (op === "in") next.values = row.values.length > 0 ? row.values : row.value ? [row.value] : [];
  if (op !== "in" && row.op === "in") next.value = row.values[0] ?? (optionsFor(row.field as AudienceField)[0] as string | undefined) ?? "";
  return next;
}

const asAudienceRow = (row: ConditionRow): AudienceRow => ({
  id: row.id,
  field: row.field as AudienceField,
  key: row.key,
  op: row.op,
  value: row.value,
  values: row.values,
});

// ---------------------------------------------------------------------------
// Rows -> API
// ---------------------------------------------------------------------------

function rowToApi(row: ConditionRow): ApiFlowCondition | string {
  if (row.field === "lifecycle_state") {
    if (!(LIFECYCLE_STATES as readonly string[]).includes(row.value)) return "Pick a lifecycle stage.";
    return row.op === "is_not" ? { lifecycle_state_not: row.value } : { lifecycle_state: row.value };
  }
  if (row.field === "event") {
    const name = row.name.trim();
    if (!name) return "Enter the event name.";
    if (name.length > 100) return "That event name is too long.";
    if (row.op !== "performed" && row.op !== "not_performed") return "Choose did or did not.";
    const c: ApiEventCondition = { field: "event", name, op: row.op };
    if (row.window === "within_days") {
      const days = Number(row.days);
      if (!Number.isInteger(days) || days < 1 || days > 365) return "Days must be a whole number from 1 to 365.";
      c.within_days = days;
    } else {
      c.since = row.window;
    }
    if (row.op === "performed" && row.minCount.trim() !== "") {
      const n = Number(row.minCount);
      if (!Number.isInteger(n) || n < 1 || n > 100) return "Times must be a whole number from 1 to 100.";
      if (n >= 2) c.min_count = n;
    }
    return c;
  }
  return rowToCondition(asAudienceRow(row));
}

export interface ConditionResult {
  /** The condition to send, or null when there are no rows (meaning: no condition). */
  condition: ApiFlowCondition | null;
  /** Problems keyed by row id. Empty when the rows are good to send. */
  errors: Record<string, string>;
}

export function stateToCondition(state: ConditionState): ConditionResult {
  const errors: Record<string, string> = {};
  const leaves: ApiFlowCondition[] = [];
  for (const row of state.rows) {
    const c = rowToApi(row);
    if (typeof c === "string") errors[row.id] = c;
    else leaves.push(c);
  }
  if (state.rows.length === 0) return { condition: null, errors };
  if (Object.keys(errors).length > 0) return { condition: null, errors };
  if (leaves.length === 1) return { condition: leaves[0]!, errors };
  return { condition: state.match === "any" ? { any: leaves } : { all: leaves }, errors };
}

// ---------------------------------------------------------------------------
// API -> rows
// ---------------------------------------------------------------------------

export interface ParsedCondition {
  state: ConditionState;
  /** True when a condition is stored that the editor cannot show without changing it. */
  unreadable: boolean;
}

export function conditionToState(condition: unknown): ParsedCondition {
  if (condition === undefined || condition === null) return { state: emptyConditionState(), unreadable: false };
  const unreadable: ParsedCondition = { state: emptyConditionState(), unreadable: true };
  if (typeof condition !== "object") return unreadable;
  const c = condition as Record<string, unknown>;

  let match: "all" | "any" = "all";
  let leaves: unknown[];
  if ("all" in c || "any" in c) {
    if (Object.keys(c).length !== 1) return unreadable;
    match = "all" in c ? "all" : "any";
    const list = c[match];
    if (!Array.isArray(list) || list.length === 0 || list.length > MAX_CONDITION_ROWS) return unreadable;
    leaves = list;
  } else {
    leaves = [condition];
  }

  const rows: ConditionRow[] = [];
  for (const leaf of leaves) {
    const row = leafToRow(leaf);
    if (!row) return unreadable; // includes nested groups
    rows.push(row);
  }
  return { state: { match, rows }, unreadable: false };
}

function leafToRow(leaf: unknown): ConditionRow | null {
  if (!leaf || typeof leaf !== "object") return null;
  const c = leaf as Record<string, unknown>;
  if (typeof c.lifecycle_state === "string" && Object.keys(c).length === 1) {
    return { ...newConditionRow("lifecycle_state"), op: "is", value: c.lifecycle_state };
  }
  if (typeof c.lifecycle_state_not === "string" && Object.keys(c).length === 1) {
    return { ...newConditionRow("lifecycle_state"), op: "is_not", value: c.lifecycle_state_not };
  }
  if (typeof c.event_since_step === "string" && Object.keys(c).length === 1) {
    // The original "did this since the step" shape, shown as the equivalent event row.
    return { ...newConditionRow("event"), op: "performed", name: c.event_since_step, window: "step" };
  }
  if (c.field === "event") {
    if (typeof c.name !== "string" || (c.op !== "performed" && c.op !== "not_performed")) return null;
    const row: ConditionRow = { ...newConditionRow("event"), op: c.op, name: c.name };
    if (typeof c.within_days === "number") {
      row.window = "within_days";
      row.days = String(c.within_days);
    } else if (c.since === "step" || c.since === "flow") {
      row.window = c.since;
    } else {
      return null;
    }
    if (typeof c.min_count === "number") row.minCount = String(c.min_count);
    return row;
  }
  // Everything a trigger audience can say: parsed by the audience module so the two stay in step.
  const parsed = audienceLeafToRow(leaf);
  return parsed;
}

function audienceLeafToRow(leaf: unknown): ConditionRow | null {
  // Reuse the audience reader on a one-condition audience.
  const { rows, unreadable } = audienceRowsFor(leaf);
  if (unreadable || rows.length !== 1) return null;
  const r = rows[0]!;
  return { ...newConditionRow(r.field), id: nextId(), key: r.key, op: r.op, value: r.value, values: r.values };
}

function audienceRowsFor(leaf: unknown) {
  return audienceToRows({ conditions: [leaf] });
}

// ---------------------------------------------------------------------------
// Plain English
// ---------------------------------------------------------------------------

/** A condition as one readable phrase, for the plan preview. Never throws on a shape it does not know. */
export function describeCondition(condition: unknown): string {
  if (!condition || typeof condition !== "object") return JSON.stringify(condition);
  const c = condition as Record<string, unknown>;
  if (Array.isArray(c.all) || Array.isArray(c.any)) {
    const isAll = Array.isArray(c.all);
    const parts = (isAll ? (c.all as unknown[]) : (c.any as unknown[])).map(describeCondition);
    const joined = parts.join(isAll ? " and " : " or ");
    return parts.length > 1 ? `(${joined})` : joined;
  }
  if (typeof c.lifecycle_state === "string") return `lifecycle stage is ${c.lifecycle_state}`;
  if (typeof c.lifecycle_state_not === "string") return `lifecycle stage is not ${c.lifecycle_state_not}`;
  if (typeof c.event_since_step === "string") return `${c.event_since_step} happened since this step`;
  if (c.field === "event" && typeof c.name === "string") {
    const verb = c.op === "not_performed" ? "did not do" : "did";
    const window =
      typeof c.within_days === "number"
        ? `in the last ${c.within_days} day${c.within_days === 1 ? "" : "s"}`
        : c.since === "flow"
          ? "since entering the flow"
          : "since this step";
    const times = typeof c.min_count === "number" ? ` at least ${c.min_count} times` : "";
    return `${verb} ${c.name}${times} ${window}`;
  }
  const phrases = describeAudience({ conditions: [condition] });
  return phrases[0] ?? JSON.stringify(condition);
}

/** Phrase for an operator, shared with the editor's dropdowns. */
export function opLabel(field: ConditionField, op: string): string {
  return field === "event" ? (EVENT_OP_LABELS[op] ?? op) : (OP_LABELS[op] ?? op);
}
