/**
 * Lists the comparison pages whose facts were last checked more than 90 days ago (or the number of days given as the first
 * argument). A comparison goes stale when the other product changes its prices or features, so each one needs re-checking against
 * that product's own site before it is left up.
 *
 *   pnpm --filter @loomail/api content:freshness        # exits 1 when anything is stale
 *   pnpm --filter @loomail/api content:freshness 60
 *
 * To re-check a page: read the other product's own pages again, correct the page body, then update its `updated` date in
 * src/marketing/content/alternatives/<slug>.ts (the CHECKED constant) and the "Checked on ..." sentence in its description.
 */
import { staleAlternatives } from "../src/marketing/content/index.js";

const maxDays = Number(process.argv[2] ?? 90);
if (!Number.isFinite(maxDays) || maxDays < 1) {
  console.error("Give the number of days as a whole number, for example: content:freshness 60");
  process.exit(2);
}
const stale = staleAlternatives(new Date(), maxDays);
if (stale.length === 0) {
  console.log(`All comparison pages were checked within the last ${maxDays} days.`);
} else {
  console.log(`These comparison pages were last checked more than ${maxDays} days ago and need re-checking:\n`);
  for (const e of stale) {
    const days = Math.floor((Date.now() - Date.parse(`${e.updated}T00:00:00Z`)) / 86_400_000);
    console.log(`  /alternatives/${e.slug}  (${e.competitor}, checked ${e.updated}, ${days} days ago)`);
  }
  process.exit(1);
}
