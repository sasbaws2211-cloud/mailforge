/** CSV contact import, browser half: parsing, column guessing, row building and chunked sending. */
import { describe, it, expect } from "vitest";
import {
  COLUMN_GUIDE,
  SAMPLE_CSV,
  buildImportRows,
  chunk,
  detectDelimiter,
  guessTargets,
  inferValue,
  mappingProblems,
  parseCsv,
  runImport,
  type ImportChunkResult,
  type ImportRow,
} from "../src/contact-import.js";

describe("parseCsv", () => {
  it("reads headers and rows, trimming cells", () => {
    const p = parseCsv("email, name\nada@x.com , Ada\ngrace@x.com,Grace\n");
    expect(p.headers).toEqual(["email", "name"]);
    expect(p.rows).toEqual([["ada@x.com", "Ada"], ["grace@x.com", "Grace"]]);
    expect(p.lines).toEqual([2, 3]);
  });

  it("handles quotes, embedded delimiters, doubled quotes and line breaks inside a field", () => {
    const p = parseCsv('name,note\n"Lovelace, Ada","says ""hi"""\n"Two\nlines",x\nlast,row');
    expect(p.rows).toEqual([["Lovelace, Ada", 'says "hi"'], ["Two\nlines", "x"], ["last", "row"]]);
    // The row after a multi-line field reports its true line.
    expect(p.lines).toEqual([2, 3, 5]);
  });

  it("handles CRLF, a BOM, a missing final newline and blank lines", () => {
    const p = parseCsv("﻿email\r\na@x.com\r\n\r\nb@x.com");
    expect(p.headers).toEqual(["email"]);
    expect(p.rows).toEqual([["a@x.com"], ["b@x.com"]]);
  });

  it("pads short rows and cuts long ones to the header width", () => {
    const p = parseCsv("a,b,c\n1\n1,2,3,4");
    expect(p.rows).toEqual([["1", "", ""], ["1", "2", "3"]]);
  });

  it("detects semicolon and tab delimiters", () => {
    expect(detectDelimiter("a;b;c")).toBe(";");
    expect(detectDelimiter("a\tb")).toBe("\t");
    expect(detectDelimiter("single")).toBe(",");
    expect(parseCsv("email;name\na@x.com;Ada").rows).toEqual([["a@x.com", "Ada"]]);
  });

  it("an empty file has no headers or rows", () => {
    expect(parseCsv("")).toEqual({ headers: [], rows: [], lines: [] });
    expect(parseCsv("\n\n  \n").rows).toEqual([]);
  });
});

describe("guessTargets and mappingProblems", () => {
  it("recognises the usual column names, using each built-in field once", () => {
    expect(guessTargets(["Email Address", "ID", "Full Name", "Company", "Payment Status", "Plan", "city", "email"])).toEqual([
      "email",
      "user_id",
      "name",
      "company",
      "payment_status",
      "plan",
      "custom",
      "custom",
    ]);
    expect(guessTargets(["", "x"])).toEqual(["skip", "custom"]);
  });

  it("needs an email or a user id", () => {
    expect(mappingProblems(["city"], ["custom"])).toHaveLength(1);
    expect(mappingProblems(["email"], ["email"])).toEqual([]);
    expect(mappingProblems(["id"], ["user_id"])).toEqual([]);
  });

  it("refuses duplicates and custom columns that shadow a built-in field", () => {
    expect(mappingProblems(["a", "b"], ["email", "email"]).join(" ")).toMatch(/More than one/);
    expect(mappingProblems(["email", "x", "x"], ["email", "custom", "custom"]).join(" ")).toMatch(/both named/);
    expect(mappingProblems(["email", "company"], ["email", "custom"]).join(" ")).toMatch(/built-in/);
    expect(mappingProblems(["email", "x".repeat(65)], ["email", "custom"]).join(" ")).toMatch(/longer than 64/);
  });
});

describe("the column guide and sample file", () => {
  it("the sample imports cleanly with the guessed mapping, and every guide column is recognised", () => {
    const parsed = parseCsv(SAMPLE_CSV);
    const targets = guessTargets(parsed.headers);
    expect(mappingProblems(parsed.headers, targets)).toEqual([]);
    expect(buildImportRows(parsed, targets).rows[0]).toEqual({
      user_id: "u_1001",
      email: "ada@example.com",
      traits: { name: "Ada Lovelace", company: "Analytical Engines", payment_status: "paid", plan: "Growth", city: "London", seats: 4 },
    });
    expect(guessTargets(COLUMN_GUIDE.map((c) => c.column))).toEqual(COLUMN_GUIDE.map((c) => c.target));
  });
});

describe("inferValue", () => {
  it("makes booleans and plain numbers, leaves codes and text alone", () => {
    expect(inferValue("true")).toBe(true);
    expect(inferValue("FALSE")).toBe(false);
    expect(inferValue("42")).toBe(42);
    expect(inferValue("-3.5")).toBe(-3.5);
    expect(inferValue("0")).toBe(0);
    expect(inferValue("01234")).toBe("01234");
    expect(inferValue("12345678901234567890")).toBe("12345678901234567890");
    expect(inferValue("1,000")).toBe("1,000");
    expect(inferValue("London")).toBe("London");
  });
});

describe("buildImportRows", () => {
  const parsed = parseCsv("id,email,name,seats,vip,notes\nu1,ada@x.com,Ada,4,true,\n,grace@x.com,,,,hello\n,,,,,\nu3,,Linus,12,false,");
  const targets = guessTargets(parsed.headers);

  it("maps reserved columns to traits and custom ones by header, leaving empty cells out", () => {
    const { rows, lines } = buildImportRows(parsed, targets);
    expect(rows).toEqual([
      { user_id: "u1", email: "ada@x.com", traits: { name: "Ada", seats: 4, vip: true } },
      { email: "grace@x.com", traits: { notes: "hello" } },
      { user_id: "u3", traits: { name: "Linus", seats: 12, vip: false } },
    ]);
    // The all-empty line (4) is dropped; lines still point at the file.
    expect(lines).toEqual([2, 3, 5]);
  });

  it("skipped columns are not sent", () => {
    const t = [...targets];
    t[2] = "skip";
    expect(buildImportRows(parsed, t).rows[0]).toEqual({ user_id: "u1", email: "ada@x.com", traits: { seats: 4, vip: true } });
  });
});

describe("chunk and runImport", () => {
  it("splits into chunks of at most the size", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 2)).toEqual([]);
  });

  const makeBuilt = (n: number) => ({
    rows: Array.from({ length: n }, (_, i): ImportRow => ({ user_id: `u${i}` })),
    lines: Array.from({ length: n }, (_, i) => i + 2),
  });
  const ok = (rows: ImportRow[]): ImportChunkResult => ({ created: rows.length, updated: 0, failed: 0, errors: [] });

  it("sends 500 at a time, totals the results and reports progress", async () => {
    const sizes: number[] = [];
    const progress: Array<[number, number]> = [];
    const summary = await runImport(makeBuilt(1200), async (rows) => (sizes.push(rows.length), ok(rows)), (s, t) => progress.push([s, t]));
    expect(sizes).toEqual([500, 500, 200]);
    expect(progress).toEqual([[500, 1200], [1000, 1200], [1200, 1200]]);
    expect(summary).toMatchObject({ created: 1200, updated: 0, failed: 0, stopped: false, planLimit: null });
  });

  it("maps a failed row back to its line in the file, across chunks", async () => {
    const send = async (rows: ImportRow[]): Promise<ImportChunkResult> => {
      const bad = rows.findIndex((r) => r.user_id === "u0" || r.user_id === "u502");
      return bad < 0
        ? ok(rows)
        : { created: rows.length - 1, updated: 0, failed: 1, errors: [{ index: bad, message: "nope" }] };
    };
    const summary = await runImport(makeBuilt(600), send);
    expect(summary.failed).toBe(2);
    expect(summary.errors).toEqual([{ line: 2, message: "nope" }, { line: 504, message: "nope" }]);
  });

  it("a chunk that throws stops the run and keeps what was counted", async () => {
    let calls = 0;
    const summary = await runImport(makeBuilt(1200), async (rows) => {
      if (++calls === 2) throw new Error("network down");
      return ok(rows);
    });
    expect(summary.stopped).toBe(true);
    expect(summary.created).toBe(500);
    expect(summary.errors).toEqual([{ line: 502, message: "network down" }]);
    expect(calls).toBe(2);
  });

  it("carries the plan-limit message", async () => {
    const summary = await runImport(makeBuilt(3), async () => ({
      created: 1,
      updated: 0,
      failed: 2,
      errors: [{ index: 1, message: "limit" }, { index: 2, message: "limit" }],
      plan_limit: { error: "Your plan allows 1 contact." },
    }));
    expect(summary.planLimit).toBe("Your plan allows 1 contact.");
  });
});
