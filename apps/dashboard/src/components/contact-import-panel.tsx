/**
 * Import contacts from a CSV: pick a file, check what each column is, import, read the result.
 * The file is read in the browser and sent in chunks (see contact-import.ts); nothing is uploaded as a file.
 *
 * Mirror side: PUBLIC (apps/dashboard is mirrored).
 */
import React, { useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Check, X } from "lucide-react";
import { importContactRows } from "../api.js";
import { CONTACTS_QUERY_KEY } from "../contacts.js";
import {
  COLUMN_GUIDE,
  SAMPLE_CSV,
  IMPORT_MAX_ROWS,
  TARGET_LABELS,
  buildImportRows,
  guessTargets,
  mappingProblems,
  parseCsv,
  runImport,
  type ColumnTarget,
  type ImportSummary,
  type ParsedCsv,
} from "../contact-import.js";
import { Button } from "./ui/button.js";
import { Select } from "./ui/select.js";

const TARGET_ORDER = Object.keys(TARGET_LABELS) as ColumnTarget[];
const PREVIEW_ROWS = 3;
const fmt = (n: number) => n.toLocaleString("en-US");

export function ContactImportPanel({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [parsed, setParsed] = useState<ParsedCsv | null>(null);
  const [targets, setTargets] = useState<ColumnTarget[]>([]);
  const [readError, setReadError] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ sent: number; total: number } | null>(null);
  const [summary, setSummary] = useState<ImportSummary | null>(null);

  const problems = useMemo(() => (parsed ? mappingProblems(parsed.headers, targets) : []), [parsed, targets]);
  const built = useMemo(() => (parsed && problems.length === 0 ? buildImportRows(parsed, targets) : null), [parsed, targets, problems]);
  const running = progress !== null && summary === null;

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setSummary(null);
    setProgress(null);
    setReadError(null);
    const result = parseCsv(await file.text());
    if (result.headers.length === 0 || result.rows.length === 0) {
      setParsed(null);
      setReadError("That file has no rows. The first line must be the column names, followed by one line per person.");
      return;
    }
    if (result.rows.length > IMPORT_MAX_ROWS) {
      setParsed(null);
      setReadError(`That file has ${fmt(result.rows.length)} rows. Import at most ${fmt(IMPORT_MAX_ROWS)} at a time.`);
      return;
    }
    setFileName(file.name);
    setParsed(result);
    setTargets(guessTargets(result.headers));
  }

  async function start() {
    if (!built) return;
    setProgress({ sent: 0, total: built.rows.length });
    const result = await runImport(built, importContactRows, (sent, total) => setProgress({ sent, total }));
    setSummary(result);
    void qc.invalidateQueries({ queryKey: CONTACTS_QUERY_KEY });
  }

  function downloadSample() {
    const url = URL.createObjectURL(new Blob([SAMPLE_CSV], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "loomail-contacts-sample.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  function reset() {
    setParsed(null);
    setFileName(null);
    setSummary(null);
    setProgress(null);
  }

  return (
    <section className="mb-6 rounded-lg border border-border bg-card p-5" aria-label="Import contacts">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-[15px] font-medium text-foreground">Import contacts from a CSV</p>
          <p className="mt-1 text-[13px] text-muted-foreground">
            One line per person, with the column names on the first line. People already in Loomail are updated, not
            duplicated; empty cells never clear what a contact already has. Each person needs an email or a user ID.
          </p>
        </div>
        <button type="button" onClick={onClose} aria-label="Close" disabled={running} className="text-muted-foreground hover:text-foreground">
          <X size={16} />
        </button>
      </div>

      <input ref={fileRef} type="file" accept=".csv,.tsv,.txt,text/csv,text/plain" className="hidden" onChange={onFile} data-testid="import-file" />

      {readError && (
        <p role="alert" className="mt-4 rounded-md border border-danger bg-danger-soft px-3.5 py-2.5 text-[14px] text-foreground">
          {readError}
        </p>
      )}

      {!parsed && (
        <div className="mt-4">
          <p className="text-[13px] font-medium text-foreground">Columns Loomail recognises</p>
          <ul className="mt-2 space-y-1.5 text-[13px] text-muted-foreground">
            {COLUMN_GUIDE.map((c) => (
              <li key={c.column}>
                <code className="font-mono text-foreground">{c.column}</code>
                {c.required && <span className="ml-1.5 text-[11px] uppercase tracking-[0.06em] text-accent-text">email or user_id required</span>}
                {" - "}
                {c.note}
              </li>
            ))}
            <li>
              <span className="text-foreground">Any other column</span> (city, seats, signup_source...) is saved on the person as a
              custom trait, named after the column, and can be used in segments and flows.
            </li>
          </ul>
          <p className="mt-2 text-[13px] text-muted-foreground">
            Your column names don&apos;t have to match: you&apos;ll check what each one is before anything is imported.
          </p>
          <div className="mt-4 flex items-center gap-3">
            <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
              Choose a CSV file
            </Button>
            <button type="button" onClick={downloadSample} className="text-[13px] text-accent-text underline underline-offset-4">
              Download a sample CSV
            </button>
          </div>
        </div>
      )}

      {parsed && summary === null && (
        <div className="mt-4">
          <p className="text-[14px] text-foreground">
            <span className="font-medium">{fileName}</span>: {fmt(parsed.rows.length)} {parsed.rows.length === 1 ? "row" : "rows"}.
            Check what each column is.
          </p>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[480px] text-left text-[13px]">
              <thead>
                <tr className="text-[11px] uppercase tracking-[0.06em] text-muted-foreground">
                  <th className="py-2 pr-4 font-medium">Column</th>
                  <th className="py-2 pr-4 font-medium">Examples</th>
                  <th className="w-64 py-2 font-medium">Import as</th>
                </tr>
              </thead>
              <tbody>
                {parsed.headers.map((h, c) => (
                  <tr key={c} className="border-t border-border align-top">
                    <td className="py-2 pr-4 font-mono text-foreground">{h || <span className="text-muted-foreground">(no name)</span>}</td>
                    <td className="max-w-[16rem] truncate py-2 pr-4 text-muted-foreground">
                      {parsed.rows
                        .slice(0, PREVIEW_ROWS)
                        .map((r) => r[c])
                        .filter(Boolean)
                        .join(", ")}
                    </td>
                    <td className="py-2">
                      <Select
                        aria-label={`Import column ${h || c + 1} as`}
                        value={targets[c]}
                        disabled={running}
                        onChange={(e) => setTargets((prev) => prev.map((t, i) => (i === c ? (e.target.value as ColumnTarget) : t)))}
                      >
                        {TARGET_ORDER.map((t) => (
                          <option key={t} value={t}>
                            {TARGET_LABELS[t]}
                          </option>
                        ))}
                      </Select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {problems.length > 0 && (
            <ul role="alert" className="mt-3 list-disc space-y-1 pl-5 text-[13px] text-danger">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}

          <p className="mt-3 text-[13px] text-muted-foreground">
            New people are added as signed-up contacts. Anyone who matches the audience of an active segment flow will
            enter it on the next scan, so check your flows first if you are importing an old list.
          </p>

          <div className="mt-4 flex items-center gap-3">
            <Button size="sm" onClick={start} disabled={!built || running}>
              {running ? `Importing ${fmt(progress!.sent)} of ${fmt(progress!.total)}...` : `Import ${built ? fmt(built.rows.length) : ""} contacts`}
            </Button>
            <Button variant="ghost" size="sm" onClick={reset} disabled={running}>
              Choose a different file
            </Button>
          </div>
        </div>
      )}

      {summary && (
        <div className="mt-4" role="status">
          <div className="flex items-start gap-3 rounded-md border border-success bg-success-soft px-4 py-3">
            <Check size={16} className="mt-0.5 shrink-0 text-success" />
            <p className="text-[14px] text-foreground">
              {summary.stopped ? "Import stopped. " : "Import complete. "}
              {fmt(summary.created)} added, {fmt(summary.updated)} updated
              {summary.failed > 0 ? `, ${fmt(summary.failed)} could not be imported` : ""}.
              {summary.stopped && " Run it again to finish: people already imported are updated, not duplicated."}
            </p>
          </div>
          {summary.planLimit && (
            <p className="mt-3 rounded-md border border-danger bg-danger-soft px-3.5 py-2.5 text-[14px] text-foreground">
              {summary.planLimit} People already in Loomail were still updated.
            </p>
          )}
          {summary.errors.length > 0 && (
            <details className="mt-3 text-[13px]">
              <summary className="cursor-pointer text-muted-foreground">Show the rows that failed</summary>
              <ul className="mt-2 space-y-1">
                {summary.errors.slice(0, 50).map((e, i) => (
                  <li key={i} className="text-foreground">
                    Line {e.line}: {e.message}
                  </li>
                ))}
                {summary.errors.length > 50 && <li className="text-muted-foreground">and {summary.errors.length - 50} more.</li>}
              </ul>
            </details>
          )}
          <div className="mt-4 flex gap-3">
            <Button variant="outline" size="sm" onClick={reset}>
              Import another file
            </Button>
            <Button variant="ghost" size="sm" onClick={onClose}>
              Done
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
