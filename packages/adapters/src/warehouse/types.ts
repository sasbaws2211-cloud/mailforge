/**
 * Data warehouse connectors: read rows from a customer's warehouse so Loomail can turn them into traits and events.
 *
 * One small interface per warehouse. Each client takes the customer's SELECT (already checked and compiled by
 * query.ts), runs it read-only with a time limit and a row cap, and hands back plain rows: lower-case column names,
 * values as string | number | boolean | null (timestamps as ISO 8601 text).
 *
 * Mirror side: PUBLIC (packages/adapters is mirrored).
 */

export type WarehouseKind = "postgres" | "mysql" | "mssql" | "snowflake" | "bigquery";

export type CellValue = string | number | boolean | null;

export interface WarehouseRows {
  /** Column names, lower case, in the order the query returned them. */
  columns: string[];
  rows: Array<Record<string, CellValue>>;
}

export interface WarehouseQuery {
  /** The customer's SELECT, as typed. The client checks and compiles it. */
  sql: string;
  /** Sync position, passed to the query as :cursor. Always text; the query casts it. */
  cursor: string;
  /** The column the batch is ordered by (an unquoted identifier). */
  cursorColumn: string;
  /** At most this many rows come back. */
  maxRows: number;
  timeoutMs: number;
}

export interface WarehouseClient {
  query(q: WarehouseQuery): Promise<WarehouseRows>;
}

/** A failure with a message safe to show the customer. `retryable`: worth trying again on the next tick. */
export class WarehouseError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean = false,
  ) {
    super(message);
    this.name = "WarehouseError";
  }
}
