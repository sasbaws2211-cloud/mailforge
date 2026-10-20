/**
 * Small helpers the page bodies share, so every comparison looks the same and Loomail's own numbers always come from the plan data.
 *
 * Mirror side: PUBLIC (packages/api is mirrored).
 */
import { ADDONS, PLANS, TRIAL_DAYS } from "@loomail/core";
import { esc } from "../layout.js";

/** "$100", "$0.009", "$1,000". Whole dollars have no decimals; small rates keep what they need. */
export function usd(amount: number): string {
  return `$${amount.toLocaleString("en-US", { maximumFractionDigits: 3 })}`;
}

const essential = PLANS.essential;

/** Everything a page says about Loomail's own price and limits, read from the plan data. */
export const OURS = {
  plan: essential.name,
  price: usd(essential.priceMonthlyUsd),
  profiles: (essential.limits.contacts ?? 0).toLocaleString("en-US"),
  emails: (essential.limits.emailsPerMonth ?? 0).toLocaleString("en-US"),
  trialDays: TRIAL_DAYS,
  extraProfile: ADDONS.profiles.rateLabel,
  extraEmails: ADDONS.emails.rateLabel,
  extraAi: ADDONS.ai.rateLabel,
} as const;

/** A side-by-side table. The first cell of each row is its label (a row header); the others are trusted HTML. */
export function cmpTable(head: string[], rows: Array<[string, ...string[]]>): string {
  return `<table class="cmp">
<thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead>
<tbody>
${rows.map(([label, ...cells]) => `<tr><th scope="row">${esc(label)}</th>${cells.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("\n")}
</tbody>
</table>`;
}

/** The highlighted "short answer" box at the top of a comparison. */
export const note = (html: string): string => `<div class="note">${html}</div>`;

/** "20 October 2026" from "2026-10-20". */
export function longDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const names = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  return `${d} ${names[(m ?? 1) - 1]} ${y}`;
}

/** The sections every comparison ends with, so none can leave one out. */
export function comparisonFooter(competitor: string, checked: string, couldNot: string[], how: string): string {
  return `<h2>What we could not confirm</h2>
<ul>
${couldNot.map((c) => `  <li>${c}</li>`).join("\n")}
</ul>

<h2>How we checked</h2>
<p>On ${esc(longDate(checked))} ${how} We did not sign in or test ${esc(competitor)}, and we do not repeat what other sites say about it. Our side of the table is taken from Loomail's own plans and features. Both products change, so check the details that matter to you.</p>`;
}
