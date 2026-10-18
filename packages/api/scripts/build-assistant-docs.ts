/**
 * Builds packages/api/src/assistant/docs-data.generated.ts: the guides, cut into pieces, for the in-app assistant.
 *
 * Run `pnpm assistant:docs` after changing a guide or src/assistant/app-map.ts, and commit the result. The server does not read the
 * guide folder at run time (a deployed image may not contain it), so the pieces are built into the code. A test fails when this file is
 * out of date, so a changed guide cannot silently leave the assistant answering from the old text.
 *
 * Usage: tsx scripts/build-assistant-docs.ts [--check]
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { buildDocs, outFile, render } from "./assistant-docs-lib.js";

const rendered = render(buildDocs());
if (process.argv.includes("--check")) {
  const current = existsSync(outFile) ? readFileSync(outFile, "utf8").replace(/\r\n/g, "\n") : "";
  if (current !== rendered) {
    console.error("The assistant's documentation is out of date. Run: pnpm assistant:docs");
    process.exit(1);
  }
  console.log("The assistant's documentation is up to date.");
} else {
  writeFileSync(outFile, rendered, "utf8");
  console.log(`Wrote ${outFile} (${rendered.length} bytes).`);
}
