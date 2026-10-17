/**
 * CSV contact import, the browser half: reading the file, guessing what each column is, and turning rows
 * into the shape POST /v1/contacts/import takes. The server does the saving; nothing here talks to the network.
 *
 * Mirror side: PUBLIC (apps/dashboard is mirrored).
 */

/** The most rows one request may carry; mirrors the API. */
export const IMPORT_CHUNK_SIZE = 500;
/** A file bigger than this is refused up front: it would take too long in one sitting. */
export const IMPORT_MAX_ROWS = 50_000;

// ---------------------------------------------------------------------------
// Reading the file
// ---------------------------------------------------------------------------

export interface ParsedCsv {
  headers: string[];
  /** Data rows, each padded or cut to the header count. Blank lines are dropped. */
  rows: string[][];
  /** The 1-based line of each data row in the file, so a row can be named in an error message. */
  lines: number[];
}

/** Comma, semicolon or tab, whichever the header line uses most (spreadsheets in some locales save with ";"). */
export function detectDelimiter(firstLine: string): string {
  const counts = [",", ";", "\t"].map((d) => ({ d, n: firstLine.split(d).length - 1 }));
  counts.sort((a, b) => b.n - a.n);
  return counts[0]!.n > 0 ? counts[0]!.d : ",";
}

/** RFC 4180: quoted fields may hold the delimiter, line breaks and doubled quotes. A leading BOM is ignored. */
export function parseCsv(input: string): ParsedCsv {
  const text = input.replace(/^﻿/, "");
  const firstLine = text.split(/\r\n|\n|\r/, 1)[0] ?? "";
  const delimiter = detectDelimiter(firstLine);

  const records: Array<{ cells: string[]; line: number }> = [];
  let cells: string[] = [];
  let cell = "";
  let inQuotes = false;
  let line = 1;
  let recordLine = 1;
  const endCell = () => {
    cells.push(cell);
    cell = "";
  };
  const endRecord = () => {
    endCell();
    records.push({ cells, line: recordLine });
    cells = [];
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else inQuotes = false;
      } else {
        if (ch === "\n") line++;
        cell += ch;
      }
      continue;
    }
    if (ch === '"' && cell === "") inQuotes = true;
    else if (ch === delimiter) endCell();
    else if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      endRecord();
      line++;
      recordLine = line;
    } else cell += ch;
  }
  if (cell !== "" || cells.length > 0) endRecord();

  const nonBlank = records.filter((r) => r.cells.some((c) => c.trim() !== ""));
  if (nonBlank.length === 0) return { headers: [], rows: [], lines: [] };
  const headers = nonBlank[0]!.cells.map((h) => h.trim());
  const width = headers.length;
  const body = nonBlank.slice(1);
  return {
    headers,
    rows: body.map((r) => Array.from({ length: width }, (_, i) => (r.cells[i] ?? "").trim())),
    lines: body.map((r) => r.line),
  };
}

// ---------------------------------------------------------------------------
// What each column is
// ---------------------------------------------------------------------------

export type ColumnTarget = "skip" | "user_id" | "email" | "name" | "company" | "payment_status" | "plan" | "custom";

export const TARGET_LABELS: Record<ColumnTarget, string> = {
  skip: "Don't import",
  user_id: "User ID",
  email: "Email",
  name: "Name",
  company: "Company",
  payment_status: "Payment status",
  plan: "Plan",
  custom: "Custom trait (named after the column)",
};

const GUESSES: Array<[ColumnTarget, RegExp]> = [
  ["email", /^(e-?mail|email[ _-]?address|mail)$/i],
  ["user_id", /^(user[ _-]?id|userid|external[ _-]?id|customer[ _-]?id|id)$/i],
  ["name", /^(name|full[ _-]?name)$/i],
  ["company", /^(company|organi[sz]ation|org|account)$/i],
  ["payment_status", /^(payment[ _-]?status|billing[ _-]?status)$/i],
  ["plan", /^(plan|plan[ _-]?name|subscription)$/i],
];

/** What each built-in column is for, shown before a file is chosen. `required` means one of the two ID columns. */
export const COLUMN_GUIDE: Array<{ column: string; target: ColumnTarget; note: string; required?: boolean }> = [
  { column: "email", target: "email", note: "The person's email address. Needed unless you have a user ID.", required: true },
  { column: "user_id", target: "user_id", note: "Your own ID for the person (the same one your product sends in events). Needed unless you have an email; if you give both, the ID is the key.", required: true },
  { column: "name", target: "name", note: "Full name." },
  { column: "company", target: "company", note: "Company or organisation." },
  { column: "payment_status", target: "payment_status", note: "One of free, trial, paid, past_due or cancelled." },
  { column: "plan", target: "plan", note: "The plan name, such as Growth. (The words free, trial, paid, past_due and cancelled set the payment status instead.)" },
];

/** A file people can download, fill in and import: the column guide as a header plus two example people. */
export const SAMPLE_CSV =
  "email,user_id,name,company,payment_status,plan,city,seats\n" +
  "ada@example.com,u_1001,Ada Lovelace,Analytical Engines,paid,Growth,London,4\n" +
  "grace@example.com,u_1002,Grace Hopper,Navy Labs,trial,,New York,1\n";

/** A first guess for every column; the person corrects it. Each built-in target is used for at most one column. */
export function guessTargets(headers: string[]): ColumnTarget[] {
  const used = new Set<ColumnTarget>();
  return headers.map((h) => {
    if (h === "") return "skip";
    for (const [target, pattern] of GUESSES) {
      if (!used.has(target) && pattern.test(h)) {
        used.add(target);
        return target;
      }
    }
    return "custom";
  });
}

/** Problems with the mapping that stop an import; empty when it can go ahead. */
export function mappingProblems(headers: string[], targets: ColumnTarget[]): string[] {
  const problems: string[] = [];
  if (!targets.includes("user_id") && !targets.includes("email")) {
    problems.push("Choose which column holds each person's email or user ID.");
  }
  for (const t of ["user_id", "email", "name", "company", "payment_status", "plan"] as const) {
    if (targets.filter((x) => x === t).length > 1) problems.push(`More than one column is set to ${TARGET_LABELS[t]}.`);
  }
  const customNames = new Map<string, number>();
  headers.forEach((h, i) => {
    if (targets[i] !== "custom") return;
    if (h === "" || h.length > 64) problems.push(`Column ${i + 1} cannot be a custom trait: its name is empty or longer than 64 characters.`);
    customNames.set(h, (customNames.get(h) ?? 0) + 1);
  });
  for (const [name, n] of customNames) if (n > 1 && name !== "") problems.push(`Two custom columns are both named "${name}".`);
  const reserved = new Set(["email", "name", "company", "payment_status", "plan"]);
  for (const [name] of customNames) {
    if (reserved.has(name)) problems.push(`The column "${name}" is also a built-in field: set it to that field instead of a custom trait.`);
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Rows for the API
// ---------------------------------------------------------------------------

export interface ImportRow {
  user_id?: string;
  email?: string;
  traits?: Record<string, string | number | boolean>;
}

/** "true"/"false" and plain numbers become real booleans and numbers, so segments can compare them. Anything else stays text. */
export function inferValue(raw: string): string | number | boolean {
  if (/^true$/i.test(raw)) return true;
  if (/^false$/i.test(raw)) return false;
  // No leading zeros ("01234" is a code, not a number) and nothing too long to hold exactly.
  if (/^-?(0|[1-9]\d{0,14})(\.\d{1,10})?$/.test(raw)) return Number(raw);
  return raw;
}

export interface BuiltRows {
  rows: ImportRow[];
  /** For each built row, the 1-based line of the file it came from. */
  lines: number[];
}

/** Empty cells are left out so an import never clears what a contact already has. Rows with nothing in them are dropped. */
export function buildImportRows(parsed: ParsedCsv, targets: ColumnTarget[]): BuiltRows {
  const rows: ImportRow[] = [];
  const lines: number[] = [];
  parsed.rows.forEach((cells, r) => {
    const row: ImportRow = {};
    const traits: Record<string, string | number | boolean> = {};
    cells.forEach((value, c) => {
      const target = targets[c] ?? "skip";
      if (value === "" || target === "skip") return;
      if (target === "user_id") row.user_id = value;
      else if (target === "email") row.email = value;
      else if (target === "custom") traits[parsed.headers[c]!] = inferValue(value);
      else traits[target] = value;
    });
    if (row.user_id === undefined && row.email === undefined && Object.keys(traits).length === 0) return;
    if (Object.keys(traits).length > 0) row.traits = traits;
    rows.push(row);
    lines.push(parsed.lines[r]!);
  });
  return { rows, lines };
}

export function chunk<T>(items: T[], size = IMPORT_CHUNK_SIZE): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// ---------------------------------------------------------------------------
// Running it
// ---------------------------------------------------------------------------

export interface ImportChunkResult {
  created: number;
  updated: number;
  failed: number;
  errors: Array<{ index: number; message: string }>;
  plan_limit?: { error: string };
}

export interface ImportSummary {
  created: number;
  updated: number;
  failed: number;
  /** File line and reason for each failed row. */
  errors: Array<{ line: number; message: string }>;
  /** Set when the plan's contact limit stopped some new people from being added. */
  planLimit: string | null;
  /** True when the run stopped before every chunk was sent. */
  stopped: boolean;
}

/**
 * Send the rows chunk by chunk, calling `onProgress` after each. `send` is the network call; a chunk that
 * throws (network down, session gone) stops the run and keeps what was already counted.
 */
export async function runImport(
  built: BuiltRows,
  send: (rows: ImportRow[]) => Promise<ImportChunkResult>,
  onProgress?: (sent: number, total: number) => void,
): Promise<ImportSummary> {
  const summary: ImportSummary = { created: 0, updated: 0, failed: 0, errors: [], planLimit: null, stopped: false };
  const chunks = chunk(built.rows);
  let offset = 0;
  for (const rows of chunks) {
    let result: ImportChunkResult;
    try {
      result = await send(rows);
    } catch (err) {
      summary.stopped = true;
      summary.errors.push({ line: built.lines[offset]!, message: err instanceof Error ? err.message : "The import was interrupted." });
      break;
    }
    summary.created += result.created;
    summary.updated += result.updated;
    summary.failed += result.failed;
    for (const e of result.errors) summary.errors.push({ line: built.lines[offset + e.index] ?? 0, message: e.message });
    if (result.plan_limit) summary.planLimit = result.plan_limit.error;
    offset += rows.length;
    onProgress?.(offset, built.rows.length);
  }
  return summary;
}
