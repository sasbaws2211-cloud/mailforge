/**
 * Brand regression guard: fails if the old upstream brand creeps back into
 * source. Scans every apps/* and packages/* src folder (not tests, not LICENSE,
 * which must keep the original author line).
 *
 * Why this exists: the old droplet logo and blue were once left behind inside
 * HTML strings in the API, where a search-and-replace on the brand name never
 * looked. This test makes that kind of miss loud.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SKIP_DIRS = new Set(["node_modules", "dist", ".turbo", ".git", "tests", "migrations", "meta"]);
const EXTS = /\.(ts|tsx|js|mjs|cjs|css|html|svg|json|md|sh|yml|yaml)$/;

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p);
    else if (EXTS.test(name)) yield p;
  }
}

function sourceFiles(): string[] {
  const out: string[] = [];
  for (const top of ["apps", "packages", "drizzle"]) {
    let entries: string[] = [];
    try {
      entries = readdirSync(join(ROOT, top));
    } catch {
      continue;
    }
    for (const e of entries) {
      const src = top === "drizzle" ? join(ROOT, top) : join(ROOT, top, e);
      if (!statSync(src).isDirectory()) continue;
      out.push(...walk(src));
      if (top === "drizzle") break;
    }
  }
  return out;
}

const files = sourceFiles();

describe("brand guard", () => {
  it("finds the source tree (the scan is not vacuous)", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("no old droplet logo geometry anywhere in source", () => {
    const hits = files.filter((f) => readFileSync(f, "utf8").includes("M0 -10.8"));
    expect(hits).toEqual([]);
  });

  it("no old brand blue (#008fba, #4ac9ec) anywhere in source", () => {
    const hits = files.filter((f) => /#008fba|#4ac9ec/i.test(readFileSync(f, "utf8")));
    expect(hits).toEqual([]);
  });

  it("no mention of the upstream name in source", () => {
    const hits = files.filter((f) => /claros/i.test(readFileSync(f, "utf8")));
    expect(hits).toEqual([]);
  });
});
