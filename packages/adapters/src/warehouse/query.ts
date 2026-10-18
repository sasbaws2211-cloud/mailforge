/**
 * Checking and compiling the customer's SELECT.
 *
 * The customer types a query once; Loomail runs it on every sync. It must be a single read: one SELECT (or WITH ...
 * SELECT), no second statement. The only parameter is `:cursor`, the sync position, which each warehouse spells its
 * own way ($1, ?, @cursor) and always receives as a bound value, never pasted into the text.
 *
 * Loomail wraps the query to order the batch by the cursor column and cap it:
 *   SELECT * FROM (<query>) AS loomail_q ORDER BY <cursor_column> ASC LIMIT <n>
 * so the query itself needs no ORDER BY or LIMIT.
 *
 * This check is a guard rail against mistakes and casual abuse, not a security boundary. The real boundary is the
 * credential: the docs tell customers to connect with a read-only role, and Postgres runs inside a READ ONLY
 * transaction.
 *
 * Mirror side: PUBLIC (packages/adapters is mirrored).
 */
import type { WarehouseKind } from "./types.js";

export const MAX_QUERY_LENGTH = 10_000;
export const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

export type QueryCheck = { ok: true; sql: string; cursorUses: number[] } | { ok: false; error: string };

/**
 * Walk the text, skipping string literals, quoted names and comments. Calls `visit(index)` for every character that
 * is real SQL. Returns an error text for text that could hide a second statement from this check.
 */
function scan(sql: string, kind: WarehouseKind, visit: (i: number) => void): string | null {
  const backslash = kind !== "postgres" && kind !== "mssql"; // Snowflake, BigQuery and MySQL treat \ as an escape inside strings
  let i = 0;
  while (i < sql.length) {
    const c = sql[i]!;
    const next = sql[i + 1];
    if (c === "-" && next === "-") {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? sql.length : end + 1;
      continue;
    }
    if (c === "#" && (kind === "bigquery" || kind === "mysql")) {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? sql.length : end + 1;
      continue;
    }
    if (c === "/" && next === "*") {
      // MySQL runs the text of /*! ... */ and /*+ ... */ as SQL, so it cannot be skipped as a comment.
      if (kind === "mysql" && (sql[i + 2] === "!" )) return "MySQL's /*! ... */ comments run as SQL and are not allowed. Remove it.";
      const end = sql.indexOf("*/", i + 2);
      if (end === -1) return "A comment is never closed.";
      i = end + 2;
      continue;
    }
    if (c === "$" && (kind === "postgres" || kind === "snowflake")) {
      // $$...$$ and $tag$...$tag$ quoting would hide text from this check.
      if (/^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.test(sql.slice(i))) return "Dollar-quoted text ($$...$$) is not allowed. Use ordinary quotes.";
    }
    if (c === "[" && kind === "mssql") {
      // [quoted name]; ]] is a literal ]
      let j = i + 1;
      let closed = false;
      while (j < sql.length) {
        if (sql[j] === "]") {
          if (sql[j + 1] === "]") {
            j += 2;
            continue;
          }
          closed = true;
          break;
        }
        j++;
      }
      if (!closed) return "A [quoted name] is never closed.";
      i = j + 1;
      continue;
    }
    if (c === "'" || c === '"' || (c === "`" && (kind === "bigquery" || kind === "mysql"))) {
      let j = i + 1;
      let closed = false;
      while (j < sql.length) {
        const d = sql[j]!;
        if (backslash && d === "\\") {
          j += 2;
          continue;
        }
        if (d === c) {
          if (sql[j + 1] === c) {
            j += 2; // doubled quote is an escaped quote
            continue;
          }
          closed = true;
          break;
        }
        j++;
      }
      if (!closed) return "A quote is never closed.";
      i = j + 1;
      continue;
    }
    visit(i);
    i++;
  }
  return null;
}

/** Validate the query and find where `:cursor` is used. Does not rewrite anything. */
export function checkQuery(raw: string, kind: WarehouseKind): QueryCheck {
  let sql = raw.trim();
  if (sql === "") return { ok: false, error: "The query is empty." };
  if (sql.length > MAX_QUERY_LENGTH) return { ok: false, error: `The query is longer than ${MAX_QUERY_LENGTH} characters.` };

  const cursorUses: number[] = [];
  let code = ""; // the real SQL only: no strings, quoted names or comments
  let semicolonAt = -1;
  let afterSemicolon = false;
  let collision: string | null = null;
  const err = scan(sql, kind, (i) => {
    const c = sql[i]!;
    code += c;
    if (c === ";") {
      if (semicolonAt === -1) semicolonAt = i;
      return;
    }
    if (semicolonAt !== -1 && !/\s/.test(c)) afterSemicolon = true;
    if (c === ":" && sql[i - 1] !== ":" && sql[i + 1] !== ":" && /^:cursor(?![A-Za-z0-9_])/i.test(sql.slice(i))) cursorUses.push(i);
    if (kind === "postgres" && c === "$") collision = "Use :cursor for the sync position, not $1.";
    if (kind === "snowflake" && c === "?") collision = "Use :cursor for the sync position, not ?.";
    if ((kind === "bigquery" || kind === "mssql") && c === "@") collision = "Use :cursor for the sync position, not @name.";
    if (kind === "mysql" && c === "?") collision = "Use :cursor for the sync position, not ?.";
  });
  if (err) return { ok: false, error: err };
  if (collision) return { ok: false, error: collision };
  if (afterSemicolon) return { ok: false, error: "Only one statement is allowed. Remove the semicolon and anything after it." };
  if (semicolonAt !== -1) sql = sql.slice(0, semicolonAt).trim(); // a trailing semicolon is fine; cursor positions are before it
  const first = /^[\s(]*([A-Za-z]+)/.exec(code)?.[1]?.toUpperCase();
  if (first !== "SELECT" && first !== "WITH") return { ok: false, error: "The query must start with SELECT or WITH." };
  return { ok: true, sql, cursorUses };
}

/** The placeholder each warehouse uses for the cursor. */
function placeholder(kind: WarehouseKind): string {
  if (kind === "postgres") return "$1"; // one numbered parameter, however many times it is used
  if (kind === "snowflake" || kind === "mysql") return "?"; // one value per use, in order
  return "@cursor"; // bigquery and mssql: a named parameter, however many times it is used
}

export interface CompiledQuery {
  sql: string;
  /** How many times the query takes the cursor. Snowflake and MySQL bind it once per use. */
  cursorCount: number;
}

/**
 * Check, rewrite `:cursor` into the warehouse's own placeholder and wrap for ordering and the row cap.
 * Throws nothing: a bad query is { ok: false }.
 */
export function compileQuery(
  raw: string,
  kind: WarehouseKind,
  cursorColumn: string,
  maxRows: number,
): ({ ok: true } & CompiledQuery) | { ok: false; error: string } {
  if (!IDENTIFIER.test(cursorColumn)) return { ok: false, error: "The cursor column must be a plain column name (letters, numbers and underscores)." };
  if (!Number.isInteger(maxRows) || maxRows < 1) return { ok: false, error: "The row cap must be a whole number of at least 1." };
  const checked = checkQuery(raw, kind);
  if (!checked.ok) return checked;

  // `checked.sql` may have lost a trailing semicolon, which is after every cursor use, so the positions still hold.
  let out = "";
  let last = 0;
  checked.cursorUses.forEach((pos) => {
    out += checked.sql.slice(last, pos) + placeholder(kind);
    last = pos + ":cursor".length;
  });
  out += checked.sql.slice(last);

  const trailingComment = /--[^\n]*$|#[^\n]*$/.test(out) ? "\n" : "";
  if (kind === "mssql") {
    // SQL Server has no LIMIT, and a WITH clause cannot sit inside the wrapping subquery.
    if (/^[\s(]*WITH\b/i.test(out)) {
      return { ok: false, error: "SQL Server cannot run a WITH (common table expression) query here. Put the WITH part in a view, or rewrite it as a subquery in the FROM clause." };
    }
    return {
      ok: true,
      sql: `SELECT TOP (${maxRows}) * FROM (${out}${trailingComment}) AS loomail_q ORDER BY ${cursorColumn} ASC`,
      cursorCount: checked.cursorUses.length,
    };
  }
  return {
    ok: true,
    sql: `SELECT * FROM (${out}${trailingComment}) AS loomail_q ORDER BY ${cursorColumn} ASC LIMIT ${maxRows}`,
    cursorCount: checked.cursorUses.length,
  };
}
