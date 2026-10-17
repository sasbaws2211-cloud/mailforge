/**
 * Segment rules as the editor sees them, and back.
 *
 * The API stores a segment as a definition (packages/core/src/segment.ts, which also validates what it
 * receives): a match ("all" or "any"), and rules, each either one check or one group of checks with its own
 * match. The editor works with rows of plain strings, which bind easily to form controls, and converts to and
 * from the definition here. A stored definition the editor cannot show without changing it (a shape from a newer
 * version, hand-written data) is reported as unreadable, never flattened or guessed at. Nothing here talks to
 * the network.
 *
 * Mirror side: PUBLIC (apps/dashboard is mirrored).
 */
import {
  audienceToRows,
  describeAudience,
  optionsFor,
  rowToCondition,
  type ApiCondition,
  type AudienceField,
  type AudienceRow,
} from "./audience.js";

/** Same limits as the server (core's segment.ts). */
export const SEGMENT_MAX_LEAVES = 20;
export const SEGMENT_MAX_GROUP_LEAVES = 10;
export const SEGMENT_MAX_EVENT_DAYS = 365;

export const SEGMENT_LIFECYCLE_STATES = ["signed_up", "activated", "engaged", "at_risk", "dormant", "churned", "resurrected"] as const;

export type SegmentField = AudienceField | "lifecycle_state" | "first_seen" | "last_seen" | "event";

export interface SegmentRow {
  id: string;
  field: SegmentField;
  /** Trait name, for field = "trait". */
  key: string;
  op: string;
  value: string;
  values: string[];
  /** Event rows: the event, how many days back, and "at least N times". */
  name: string;
  days: string;
  minCount: string;
}

export interface SegmentGroupState {
  id: string;
  match: "all" | "any";
  rows: SegmentRow[];
}

export type SegmentItem = { kind: "row"; row: SegmentRow } | { kind: "group"; group: SegmentGroupState };

export interface SegmentState {
  match: "all" | "any";
  items: SegmentItem[];
}

export const emptySegmentState = (): SegmentState => ({ match: "all", items: [] });

// ---------------------------------------------------------------------------
// The definition (what the API stores)
// ---------------------------------------------------------------------------

export type ApiSegmentLeaf =
  | ApiCondition
  | { field: "lifecycle_state"; op: "is" | "is_not"; value: string }
  | { field: "lifecycle_state"; op: "in"; value: string[] }
  | { field: "first_seen" | "last_seen"; op: "within_days" | "before_days"; days: number }
  | { field: "event"; name: string; op: "performed" | "not_performed"; within_days: number; min_count?: number };

export interface ApiSegmentGroup {
  match: "all" | "any";
  rules: ApiSegmentLeaf[];
}

export interface ApiSegmentDefinition {
  match: "all" | "any";
  rules: Array<ApiSegmentLeaf | ApiSegmentGroup>;
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export const FIELD_LABELS: Record<SegmentField, string> = {
  payment_status: "Payment status",
  plan: "Plan",
  engagement_depth: "Engagement",
  lifecycle_state: "Lifecycle stage",
  has_email: "Email address",
  trait: "Custom trait",
  first_seen: "First seen",
  last_seen: "Last seen",
  event: "Did something",
};

export const FIELD_ORDER: SegmentField[] = ["payment_status", "plan", "lifecycle_state", "last_seen", "first_seen", "event", "engagement_depth", "has_email", "trait"];

export const AGE_OP_LABELS: Record<string, string> = { within_days: "in the last", before_days: "more than" };
export const EVENT_OP_LABELS: Record<string, string> = { performed: "did", not_performed: "did not" };

export function opsFor(field: SegmentField): string[] {
  switch (field) {
    case "event":
      return ["performed", "not_performed"];
    case "first_seen":
    case "last_seen":
      return ["within_days", "before_days"];
    case "lifecycle_state":
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

let counter = 0;
const nextId = () => `seg-${++counter}`;

function optionList(field: SegmentField): readonly string[] {
  return field === "lifecycle_state" ? SEGMENT_LIFECYCLE_STATES : optionsFor(field as AudienceField);
}

export function newSegmentRow(field: SegmentField = "payment_status"): SegmentRow {
  const options = optionList(field);
  return {
    id: nextId(),
    field,
    key: "",
    op: opsFor(field)[0]!,
    value: field === "has_email" ? "yes" : (options[0] ?? ""),
    values: [],
    name: "",
    days: field === "event" ? "30" : field === "last_seen" ? "14" : "30",
    minCount: "",
  };
}

export function newGroup(): SegmentGroupState {
  return { id: nextId(), match: "any", rows: [newSegmentRow()] };
}

/** Start a row over for a new field, keeping its place in the list. */
export function changeRowField(row: SegmentRow, field: SegmentField): SegmentRow {
  return { ...newSegmentRow(field), id: row.id };
}

/** Switching to "is one of" keeps the chosen value, and back keeps the first. */
export function changeRowOp(row: SegmentRow, op: string): SegmentRow {
  const next: SegmentRow = { ...row, op };
  if (op === "in") next.values = row.values.length > 0 ? row.values : row.value ? [row.value] : [];
  if (op !== "in" && row.op === "in") next.value = row.values[0] ?? optionList(row.field)[0] ?? "";
  return next;
}

const asAudienceRow = (row: SegmentRow): AudienceRow => ({
  id: row.id,
  field: row.field as AudienceField,
  key: row.key,
  op: row.op,
  value: row.value,
  values: row.values,
});

export function countRows(state: SegmentState): number {
  return state.items.reduce((n, item) => n + (item.kind === "row" ? 1 : item.group.rows.length), 0);
}

// ---------------------------------------------------------------------------
// Rows -> definition
// ---------------------------------------------------------------------------

function rowToLeaf(row: SegmentRow): ApiSegmentLeaf | string {
  switch (row.field) {
    case "lifecycle_state": {
      if (row.op === "in") {
        const picked = row.values.filter((v) => (SEGMENT_LIFECYCLE_STATES as readonly string[]).includes(v));
        return picked.length > 0 ? { field: "lifecycle_state", op: "in", value: picked } : "Pick at least one stage.";
      }
      if (row.op !== "is" && row.op !== "is_not") return "Choose how to compare.";
      return (SEGMENT_LIFECYCLE_STATES as readonly string[]).includes(row.value)
        ? { field: "lifecycle_state", op: row.op, value: row.value }
        : "Pick a stage.";
    }
    case "first_seen":
    case "last_seen": {
      if (row.op !== "within_days" && row.op !== "before_days") return "Choose how to compare.";
      const days = Number(row.days);
      if (row.days.trim() === "" || !Number.isInteger(days) || days < 0 || days > 3650) return "Days must be a whole number from 0 to 3650.";
      return { field: row.field, op: row.op, days };
    }
    case "event": {
      const name = row.name.trim();
      if (!name) return "Enter the event name.";
      if (name.length > 100) return "That event name is too long.";
      if (row.op !== "performed" && row.op !== "not_performed") return "Choose did or did not.";
      const days = Number(row.days);
      if (row.days.trim() === "" || !Number.isInteger(days) || days < 1 || days > SEGMENT_MAX_EVENT_DAYS) {
        return `Days must be a whole number from 1 to ${SEGMENT_MAX_EVENT_DAYS}.`;
      }
      const leaf: ApiSegmentLeaf = { field: "event", name, op: row.op, within_days: days };
      if (row.op === "performed" && row.minCount.trim() !== "") {
        const n = Number(row.minCount);
        if (!Number.isInteger(n) || n < 1 || n > 100) return "Times must be a whole number from 1 to 100.";
        if (n >= 2) (leaf as { min_count?: number }).min_count = n;
      }
      return leaf;
    }
    default:
      return rowToCondition(asAudienceRow(row));
  }
}

export interface DefinitionResult {
  /** The definition to send, or null while there are no rules or any rule has a problem. */
  definition: ApiSegmentDefinition | null;
  /** Problems keyed by row id (or group id, for an empty group). */
  errors: Record<string, string>;
}

export function stateToDefinition(state: SegmentState): DefinitionResult {
  const errors: Record<string, string> = {};
  const rules: ApiSegmentDefinition["rules"] = [];
  for (const item of state.items) {
    if (item.kind === "row") {
      const leaf = rowToLeaf(item.row);
      if (typeof leaf === "string") errors[item.row.id] = leaf;
      else rules.push(leaf);
      continue;
    }
    const leaves: ApiSegmentLeaf[] = [];
    if (item.group.rows.length === 0) errors[item.group.id] = "Add at least one rule to this group, or remove it.";
    for (const row of item.group.rows) {
      const leaf = rowToLeaf(row);
      if (typeof leaf === "string") errors[row.id] = leaf;
      else leaves.push(leaf);
    }
    if (item.group.rows.length > 0) rules.push({ match: item.group.match, rules: leaves });
  }
  if (state.items.length === 0) return { definition: null, errors };
  if (Object.keys(errors).length > 0) return { definition: null, errors };
  return { definition: { match: state.match, rules }, errors };
}

// ---------------------------------------------------------------------------
// Definition -> rows
// ---------------------------------------------------------------------------

export interface ParsedSegment {
  state: SegmentState;
  /** True when the stored definition cannot be shown without changing it. */
  unreadable: boolean;
}

export function definitionToState(definition: unknown): ParsedSegment {
  const unreadable: ParsedSegment = { state: emptySegmentState(), unreadable: true };
  if (!definition || typeof definition !== "object") return unreadable;
  const d = definition as { match?: unknown; rules?: unknown };
  if ((d.match !== "all" && d.match !== "any") || !Array.isArray(d.rules) || d.rules.length === 0) return unreadable;

  const items: SegmentItem[] = [];
  for (const rule of d.rules) {
    if (rule && typeof rule === "object" && "rules" in rule) {
      const g = rule as { match?: unknown; rules?: unknown };
      if ((g.match !== "all" && g.match !== "any") || !Array.isArray(g.rules) || g.rules.length === 0) return unreadable;
      const rows: SegmentRow[] = [];
      for (const leaf of g.rules) {
        const row = leafToRow(leaf);
        if (!row) return unreadable; // includes a group inside a group
        rows.push(row);
      }
      items.push({ kind: "group", group: { id: nextId(), match: g.match, rows } });
    } else {
      const row = leafToRow(rule);
      if (!row) return unreadable;
      items.push({ kind: "row", row });
    }
  }
  return { state: { match: d.match, items }, unreadable: false };
}

function leafToRow(leaf: unknown): SegmentRow | null {
  if (!leaf || typeof leaf !== "object") return null;
  const c = leaf as Record<string, unknown>;
  const op = c.op;
  if (typeof op !== "string") return null;
  const base = newSegmentRow;
  switch (c.field) {
    case "lifecycle_state": {
      if (op === "in" && Array.isArray(c.value) && c.value.every((v) => typeof v === "string")) {
        return { ...base("lifecycle_state"), op, values: c.value as string[] };
      }
      return (op === "is" || op === "is_not") && typeof c.value === "string" ? { ...base("lifecycle_state"), op, value: c.value } : null;
    }
    case "first_seen":
    case "last_seen":
      return (op === "within_days" || op === "before_days") && typeof c.days === "number" ? { ...base(c.field), op, days: String(c.days) } : null;
    case "event": {
      if ((op !== "performed" && op !== "not_performed") || typeof c.name !== "string" || typeof c.within_days !== "number") return null;
      return { ...base("event"), op, name: c.name, days: String(c.within_days), minCount: typeof c.min_count === "number" ? String(c.min_count) : "" };
    }
    default: {
      // Everything a trigger audience can say: read by the audience module so the two stay in step.
      const parsed = audienceToRows({ conditions: [leaf] });
      if (parsed.unreadable || parsed.rows.length !== 1) return null;
      const r = parsed.rows[0]!;
      return { ...base(r.field), key: r.key, op: r.op, value: r.value, values: r.values };
    }
  }
}

// ---------------------------------------------------------------------------
// Plain English
// ---------------------------------------------------------------------------

function describeLeaf(leaf: unknown): string {
  if (!leaf || typeof leaf !== "object") return JSON.stringify(leaf);
  const c = leaf as Record<string, unknown>;
  switch (c.field) {
    case "lifecycle_state":
      return c.op === "in" && Array.isArray(c.value)
        ? `lifecycle stage is one of ${c.value.join(", ")}`
        : `lifecycle stage ${c.op === "is_not" ? "is not" : "is"} ${String(c.value)}`;
    case "first_seen":
    case "last_seen": {
      const what = c.field === "first_seen" ? "first seen" : "last seen";
      const days = Number(c.days);
      if (c.op === "within_days") return days === 0 ? `${what} today` : `${what} in the last ${days} day${days === 1 ? "" : "s"}`;
      return `${what} more than ${days} day${days === 1 ? "" : "s"} ago`;
    }
    case "event": {
      const times = typeof c.min_count === "number" ? ` at least ${c.min_count} times` : "";
      const days = Number(c.within_days);
      return `${c.op === "not_performed" ? "did not do" : "did"} ${String(c.name)}${times} in the last ${days} day${days === 1 ? "" : "s"}`;
    }
    default:
      return describeAudience({ conditions: [leaf] })[0] ?? JSON.stringify(leaf);
  }
}

/** A definition as one readable sentence, for lists and summaries. Never throws on a shape it does not know. */
export function describeSegment(definition: unknown): string {
  if (!definition || typeof definition !== "object") return "";
  const d = definition as { match?: unknown; rules?: unknown };
  if (!Array.isArray(d.rules) || d.rules.length === 0) return "";
  const joiner = d.match === "any" ? " or " : " and ";
  return d.rules
    .map((rule) => {
      if (rule && typeof rule === "object" && Array.isArray((rule as { rules?: unknown }).rules)) {
        const g = rule as { match?: unknown; rules: unknown[] };
        const inner = g.rules.map(describeLeaf).join(g.match === "any" ? " or " : " and ");
        return g.rules.length > 1 ? `(${inner})` : inner;
      }
      return describeLeaf(rule);
    })
    .join(joiner);
}

// ---------------------------------------------------------------------------
// From the People page's filters
// ---------------------------------------------------------------------------

export interface PeopleFilters {
  lifecycle_state?: string;
  engagement_depth?: string;
  search?: string;
  tenure_bucket?: string;
  recency_bucket?: string;
}

export interface FromFilters {
  /** The rows to start the new segment with, or null when the filters cannot be turned into rules. */
  state: SegmentState | null;
  /** Why not, in a sentence for the person, when state is null. */
  reason?: string;
}

/** "Save as segment" on the People page: turn the current filters into rules, or say why they cannot be. */
export function stateFromFilters(f: PeopleFilters): FromFilters {
  if (f.search && f.search.trim()) return { state: null, reason: "A text search cannot be saved as a segment. Clear it first." };
  if (f.tenure_bucket || f.recency_bucket) {
    return { state: null, reason: "A retention cell cannot be saved as a segment here. Use the 'last seen' and 'first seen' rules instead." };
  }
  const items: SegmentItem[] = [];
  if (f.lifecycle_state) {
    items.push({ kind: "row", row: { ...newSegmentRow("lifecycle_state"), op: "is", value: f.lifecycle_state } });
  }
  if (f.engagement_depth) {
    items.push({ kind: "row", row: { ...newSegmentRow("engagement_depth"), op: "is", value: f.engagement_depth } });
  }
  if (items.length === 0) return { state: null, reason: "Pick a lifecycle stage or engagement level first." };
  return { state: { match: "all", items } };
}

// ---------------------------------------------------------------------------
// Small formatting helpers for the screens
// ---------------------------------------------------------------------------

/** "1,234", or "100,000+" when counting stopped at the limit. A segment never counted shows a dash. */
export function formatMemberCount(count: number | null, capped: boolean): string {
  if (count === null) return "-";
  return `${count.toLocaleString("en-US")}${capped ? "+" : ""}`;
}

/** "just now", "5 minutes ago", "3 hours ago", "2 days ago", or a date after a month; "never" for no time. */
export function timeAgo(iso: string | null, now: Date = new Date()): string {
  if (!iso) return "never";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "never";
  const seconds = Math.max(0, Math.floor((now.getTime() - then) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  if (days < 31) return `${days} day${days === 1 ? "" : "s"} ago`;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
