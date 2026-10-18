// dist/cjs holds CommonJS output inside a package whose "type" is "module".
// A nested package.json tells Node (and bundlers) to read those files as CommonJS.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

writeFileSync(
  fileURLToPath(new URL("../dist/cjs/package.json", import.meta.url)),
  JSON.stringify({ type: "commonjs" }) + "\n",
);
