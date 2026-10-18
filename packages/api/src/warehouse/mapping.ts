/**
 * Turning one warehouse row into what Loomail records. Pure: no database, no network.
 *
 * Column names are matched without regard to case (the adapters hand back lower-case names). A row with neither a
 * user id nor a usable email is skipped, not an error: warehouses are messy, and one bad row must not stop a sync.
 *
 * Mirror side: PUBLIC (packages/api is mirrored).
 */
import { createHash } from "node:crypto";
import type { CellValue } from "@loomail/adapters";
import { cleanEmail, type Mapped, type TraitValue } from "../inbound/mapping.js";
import type { WarehouseConfig } from "./config.js";

export type RowMapResult = { ok: true; mapped: Mapped } | { ok: false; reason: string };

function text(v: CellValue | undefined): string | undefined {
  if (v === null || v === undefined) return undefined;
  const s = String(v).trim();
  return s === "" ? undefined : s;
}

function trait(v: CellValue | undefined): TraitValue | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v === "string") return v.trim() === "" ? undefined : v.slice(0, 2000);
  return v;
}

/** Stable text for a row, so the same row read twice has the same message id. */
export function rowFingerprint(row: Record<string, CellValue>): string {
  const keys = Object.keys(row).sort();
  return createHash("sha256").update(JSON.stringify(keys.map((k) => [k, row[k]]))).digest("hex").slice(0, 32);
}

/** One fingerprint for a set of rows, whatever order they came in. */
export function rowsFingerprint(rows: Array<Record<string, CellValue>>): string {
  return createHash("sha256").update(rows.map(rowFingerprint).sort().join(",")).digest("hex").slice(0, 32);
}

export function mapWarehouseRow(config: WarehouseConfig, row: Record<string, CellValue>, sourceId: string): RowMapResult {
  const col = (name: string | undefined): CellValue | undefined => (name ? row[name.toLowerCase()] : undefined);

  const userId = text(col(config.user_id_column))?.slice(0, 255);
  const email = cleanEmail(col(config.email_column));
  if (!userId && !email) return { ok: false, reason: "no user id or email in this row" };

  const traits: Record<string, TraitValue> = {};
  for (const [name, c] of Object.entries(config.trait_columns)) {
    const v = trait(col(c));
    if (v !== undefined) traits[name] = v;
  }

  let event = config.event_name;
  if (config.event_name_column) {
    const named = text(col(config.event_name_column));
    if (named) event = named.slice(0, 100);
    else if (!config.event_name) event = undefined;
  }
  if (!event && Object.keys(traits).length === 0) return { ok: false, reason: "no event name and no traits in this row" };

  let timestamp: string | undefined;
  const rawTs = text(col(config.timestamp_column));
  if (rawTs && !Number.isNaN(new Date(rawTs).getTime())) timestamp = new Date(rawTs).toISOString();

  let properties: Record<string, unknown> = {};
  if (config.send_properties) {
    properties = Object.fromEntries(Object.entries(row).filter(([, v]) => v !== null));
  }

  return {
    ok: true,
    mapped: {
      actor: { userId, email },
      traits,
      ...(event
        ? { track: { event, properties, ...(timestamp ? { timestamp } : {}), messageId: `wh:${sourceId}:${rowFingerprint(row)}` } }
        : {}),
    },
  };
}

/** The value of the cursor column in a row, as the text the next query will receive. Null when the row has none. */
export function cursorOf(config: WarehouseConfig, row: Record<string, CellValue>): string | null {
  const v = row[config.cursor_column.toLowerCase()];
  if (v === null || v === undefined) return null;
  return String(v);
}

/** The larger of two cursor values, compared as numbers, instants or text according to the cursor type. */
export function laterCursor(type: WarehouseConfig["cursor_type"], a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  if (type === "number") return Number(b) > Number(a) ? b : a;
  if (type === "timestamp") {
    const x = Date.parse(a);
    const y = Date.parse(b);
    if (Number.isNaN(x) || Number.isNaN(y)) return b > a ? b : a;
    return y > x ? b : a;
  }
  return b > a ? b : a;
}
