/**
 * "Test query": run the source's query for a handful of rows and show what each would become, without recording
 * anything. Used before saving a source and from the source's page.
 *
 * Mirror side: PUBLIC (packages/api is mirrored).
 */
import { createWarehouseClient, WarehouseError, type CellValue } from "@loomail/adapters";
import { defaultCursor, toConnection, type WarehouseConfig, type WarehouseSecret } from "./config.js";
import { mapWarehouseRow } from "./mapping.js";
import { missingColumns, type ClientFactory } from "./sync.js";

export const PREVIEW_ROWS = 5;

export interface PreviewRow {
  values: Record<string, CellValue>;
  /** What Loomail would do with the row, or why it would skip it. */
  result: { ok: true; person: string; event: string | null; traits: Record<string, string | number | boolean> } | { ok: false; reason: string };
}

export type Preview =
  | { ok: true; columns: string[]; rows: PreviewRow[]; missing: string[] }
  | { ok: false; error: string };

const clip = (v: CellValue): CellValue => (typeof v === "string" && v.length > 200 ? `${v.slice(0, 200)}...` : v);

export async function previewQuery(config: WarehouseConfig, secret: WarehouseSecret, clientFor?: ClientFactory): Promise<Preview> {
  try {
    const client = (clientFor ?? ((c) => createWarehouseClient(c)))(toConnection(config, secret));
    const res = await client.query({
      sql: config.query,
      cursor: config.initial_cursor ?? defaultCursor(config.cursor_type),
      cursorColumn: config.cursor_column,
      maxRows: PREVIEW_ROWS,
      timeoutMs: Math.min(config.timeout_seconds, 30) * 1000,
    });
    const missing = missingColumns(config, res.columns);
    const rows = res.rows.slice(0, PREVIEW_ROWS).map((row): PreviewRow => {
      const values = Object.fromEntries(Object.entries(row).map(([k, v]) => [k, clip(v)]));
      const m = mapWarehouseRow(config, row, "preview");
      if (!m.ok) return { values, result: { ok: false, reason: m.reason } };
      return {
        values,
        result: { ok: true, person: m.mapped.actor.userId ?? m.mapped.actor.email ?? "", event: m.mapped.track?.event ?? null, traits: m.mapped.traits },
      };
    });
    return { ok: true, columns: res.columns, rows, missing };
  } catch (err) {
    if (err instanceof WarehouseError) return { ok: false, error: err.message };
    return { ok: false, error: "The connection could not be tested." };
  }
}
