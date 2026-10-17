/**
 * Segments to SQL: turn a segment definition into a condition on the `contacts` table.
 *
 *   SELECT ... FROM contacts WHERE contacts.tenant_id = $1 AND <compileSegment(definition)>
 *
 * The definition's SHAPE is checked before it gets here (core's segmentDefinitionSchema, in the API), and this
 * function only trusts it that far. What makes the output safe regardless:
 *   - every value, trait key, event name and number is a bound parameter, never part of the SQL text;
 *   - the only text spliced in is a fixed set of column names written in this file;
 *   - field names and operators select from fixed branches, and an unknown one throws instead of guessing.
 *
 * Meaning, so it matches what the in-memory audience check (core's audience.ts) says about the same contact:
 *   - text comparisons ignore case and surrounding spaces; numbers stored as text ("12") compare as numbers;
 *   - a missing trait never "is" anything and always "is not" it; null and empty text count as not set;
 *   - a missing payment status or engagement counts as "is not" anything.
 * Every check is wrapped so it is true or false, never unknown, which is what makes "any of" and "not" safe.
 *
 * Event checks are bounded: they always carry a time window, they never read more rows than a count needs, and
 * they also filter on received_at, the column the events table is partitioned by, so old months are skipped.
 *
 * The input type is described here, not imported, so this package needs nothing from core. The API passes in
 * core's validated type, so the compiler stops accepting it the day the two disagree (see the API tests).
 *
 * Mirror side: PUBLIC (drizzle/ is mirrored).
 */
import { sql, type SQL } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Input shape (mirrors core's SegmentDefinition)
// ---------------------------------------------------------------------------

export type SegmentLeafLike =
  | { field: "payment_status" | "engagement_depth"; op: "is" | "is_not"; value: string }
  | { field: "payment_status" | "engagement_depth"; op: "in"; value: string[] }
  | { field: "plan"; op: "is" | "is_not"; value: string }
  | { field: "has_email"; op: "is"; value: boolean }
  | { field: "trait"; key: string; op: "is" | "is_not"; value: string | number | boolean }
  | { field: "trait"; key: string; op: "contains"; value: string }
  | { field: "trait"; key: string; op: "gt" | "lt"; value: number }
  | { field: "trait"; key: string; op: "is_set" | "is_not_set" }
  | { field: "lifecycle_state"; op: "is" | "is_not"; value: string }
  | { field: "lifecycle_state"; op: "in"; value: string[] }
  | { field: "first_seen" | "last_seen"; op: "within_days" | "before_days"; days: number }
  | { field: "event"; name: string; op: "performed" | "not_performed"; within_days: number; min_count?: number | undefined };

export interface SegmentGroupLike {
  match: "all" | "any";
  rules: ReadonlyArray<SegmentLeafLike>;
}

export interface SegmentDefinitionLike {
  match: "all" | "any";
  rules: ReadonlyArray<SegmentLeafLike | SegmentGroupLike>;
}

/**
 * received_at is when the server stored an event; timestamp is when the contact's app says it happened, and the
 * server keeps that within 72 hours of received_at. So an event that happened within the window was received no
 * earlier than window + 3 days ago: that bound lets the database skip older partitions.
 */
export const EVENT_RECEIVED_SLACK_DAYS = 3;

/** Count stops here, so a huge segment is counted in bounded time. */
export const SEGMENT_COUNT_LIMIT = 100_000;

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

const col = (name: "lifecycle_state" | "payment_status" | "engagement_depth" | "email" | "properties" | "first_seen_at" | "last_seen_at" | "id" | "tenant_id") =>
  sql.raw(`contacts."${name}"`);

/** A condition that is always true or false, never unknown. */
const truth = (cond: SQL): SQL => sql`COALESCE((${cond}), false)`;
const not = (cond: SQL): SQL => sql`(NOT ${cond})`;

/** Matches core's number-as-text rule: optional minus, digits, optional decimals. */
const NUMBER_TEXT = "^-?[0-9]+(\\.[0-9]+)?$";

const props = col("properties");
const val = (key: string): SQL => sql`(${props} -> ${key}::text)`;
const txt = (key: string): SQL => sql`(${props} ->> ${key}::text)`;
const typeOf = (key: string): SQL => sql`jsonb_typeof(${val(key)})`;
const trimmed = (key: string): SQL => sql`btrim(${txt(key)})`;
const lowered = (expr: SQL): SQL => sql`lower(btrim(${expr}))`;

/** Present: there, not JSON null, and not empty (or blank) text. */
const present = (key: string): SQL =>
  truth(sql`jsonb_exists(${props}, ${key}::text) AND ${typeOf(key)} <> 'null' AND NOT (${typeOf(key)} = 'string' AND ${trimmed(key)} = '')`);

const days = (n: number): SQL => sql`make_interval(days => ${n}::int)`;

function inList(column: SQL, values: ReadonlyArray<string>): SQL {
  return truth(sql`${column} IN (${sql.join(values.map((v) => sql`${v}::text`), sql`, `)})`);
}

// ---------------------------------------------------------------------------
// Traits
// ---------------------------------------------------------------------------

function traitIs(key: string, value: string | number | boolean): SQL {
  if (typeof value === "string") {
    return truth(
      sql`${typeOf(key)} IN ('string', 'number', 'boolean') AND ${trimmed(key)} <> '' AND ${lowered(txt(key))} = ${lowered(sql`${value}::text`)}`,
    );
  }
  if (typeof value === "number") {
    return truth(sql`CASE
      WHEN ${typeOf(key)} = 'number' THEN (${txt(key)})::numeric = ${value}::numeric
      WHEN ${typeOf(key)} = 'string' AND ${trimmed(key)} ~ ${NUMBER_TEXT} THEN ${trimmed(key)}::numeric = ${value}::numeric
      ELSE false END`);
  }
  return truth(sql`CASE
    WHEN ${typeOf(key)} = 'boolean' THEN ((${txt(key)}) = 'true') = ${value}::boolean
    WHEN ${typeOf(key)} = 'string' THEN ${lowered(txt(key))} = ${value ? "true" : "false"}::text
    ELSE false END`);
}

function traitContains(key: string, needle: string): SQL {
  const wanted = lowered(sql`${needle}::text`);
  return truth(sql`CASE ${typeOf(key)}
    WHEN 'array' THEN EXISTS (
      SELECT 1 FROM jsonb_array_elements(${val(key)}) AS item(x)
      WHERE jsonb_typeof(item.x) IN ('string', 'number', 'boolean')
        AND btrim(item.x #>> '{}') <> ''
        AND lower(btrim(item.x #>> '{}')) = ${wanted})
    WHEN 'string' THEN ${trimmed(key)} <> '' AND position(${wanted} in ${lowered(txt(key))}) > 0
    WHEN 'number' THEN position(${wanted} in ${lowered(txt(key))}) > 0
    ELSE false END`);
}

function traitCompare(key: string, op: "gt" | "lt", value: number): SQL {
  const cmp = op === "gt" ? sql`>` : sql`<`;
  return truth(sql`CASE
    WHEN ${typeOf(key)} = 'number' THEN (${txt(key)})::numeric ${cmp} ${value}::numeric
    WHEN ${typeOf(key)} = 'string' AND ${trimmed(key)} ~ ${NUMBER_TEXT} THEN ${trimmed(key)}::numeric ${cmp} ${value}::numeric
    ELSE false END`);
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

function eventCondition(c: Extract<SegmentLeafLike, { field: "event" }>): SQL {
  const rows = sql`FROM events e
    WHERE e.tenant_id = contacts."tenant_id"
      AND e.contact_id = contacts."id"
      AND e.event_name = ${c.name}::text
      AND e.timestamp >= now() - ${days(c.within_days)}
      AND e.received_at > now() - make_interval(days => ${c.within_days + EVENT_RECEIVED_SLACK_DAYS}::int)`;
  if (c.op === "not_performed") return sql`NOT EXISTS (SELECT 1 ${rows})`;
  const needed = c.min_count ?? 1;
  if (needed <= 1) return sql`EXISTS (SELECT 1 ${rows})`;
  // Read no more rows than the count needs.
  return sql`(SELECT count(*) FROM (SELECT 1 ${rows} LIMIT ${needed}::int) AS counted) >= ${needed}::int`;
}

// ---------------------------------------------------------------------------
// One check, one group, the whole definition
// ---------------------------------------------------------------------------

function unreachable(value: never): never {
  throw new Error(`segment: unsupported check ${JSON.stringify(value)}`);
}

export function compileSegmentLeaf(c: SegmentLeafLike): SQL {
  switch (c.field) {
    case "payment_status":
    case "engagement_depth": {
      const column = col(c.field);
      if (c.op === "in") return inList(column, c.value);
      if (c.op === "is") return truth(sql`${column} = ${c.value}::text`);
      return sql`(${column} IS DISTINCT FROM ${c.value}::text)`; // missing counts as "is not"
    }
    case "lifecycle_state": {
      const column = col("lifecycle_state");
      if (c.op === "in") return inList(column, c.value);
      return c.op === "is" ? truth(sql`${column} = ${c.value}::text`) : truth(sql`${column} <> ${c.value}::text`);
    }
    case "has_email": {
      const has = truth(sql`${col("email")} IS NOT NULL AND btrim(${col("email")}) <> ''`);
      return c.value ? has : not(has);
    }
    case "plan": {
      const same = truth(
        sql`${present("plan")} AND ${lowered(txt("plan"))} = ${lowered(sql`${c.value}::text`)}`,
      );
      return c.op === "is" ? same : not(same);
    }
    case "trait": {
      switch (c.op) {
        case "is":
          return traitIs(c.key, c.value);
        case "is_not":
          return not(traitIs(c.key, c.value));
        case "contains":
          return traitContains(c.key, c.value);
        case "gt":
        case "lt":
          return traitCompare(c.key, c.op, c.value);
        case "is_set":
          return present(c.key);
        case "is_not_set":
          return not(present(c.key));
        default:
          return unreachable(c);
      }
    }
    case "first_seen":
    case "last_seen": {
      const column = col(c.field === "first_seen" ? "first_seen_at" : "last_seen_at");
      return c.op === "within_days"
        ? truth(sql`${column} >= now() - ${days(c.days)}`)
        : truth(sql`${column} < now() - ${days(c.days)}`);
    }
    case "event":
      return truth(eventCondition(c));
    default:
      return unreachable(c);
  }
}

function join(parts: SQL[], match: "all" | "any"): SQL {
  return sql`(${sql.join(parts, match === "all" ? sql` AND ` : sql` OR `)})`;
}

/**
 * The condition for a definition, to go in `WHERE contacts.tenant_id = ... AND <this>`.
 * Always scope the query to the tenant yourself; a definition says nothing about whose contacts to look at.
 */
export function compileSegment(def: SegmentDefinitionLike): SQL {
  const parts = def.rules.map((rule) =>
    "rules" in rule ? join(rule.rules.map(compileSegmentLeaf), rule.match) : compileSegmentLeaf(rule),
  );
  if (parts.length === 0) throw new Error("segment: a definition needs at least one rule");
  return join(parts, def.match);
}
