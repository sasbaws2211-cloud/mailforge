import { SITE_NAME } from "../../layout.js";
import { OURS, cmpTable, comparisonFooter, note } from "../html.js";

export const CHECKED = "2026-10-20";

export const body = (): string => `
<p class="lead">Loops and ${SITE_NAME} both aim at software companies that want to send email to their users without a heavy marketing suite. They differ on price, on whether you can host it yourself, and on how flows are built.</p>

${note(`<b>The short answer.</b> If you want to start free, or your list is small, Loops is the easier place to begin: it has a free plan and a $49-a-month paid plan. Choose ${SITE_NAME} if you want open-source software you can host yourself, flows described in plain language, and a retention view of your users.`)}

<h2>Side by side</h2>
${cmpTable(
  ["", "Loops", SITE_NAME],
  [
    ["What it says it is", "&ldquo;Email marketing software for SaaS teams to send marketing, lifecycle, and transactional email from one product. Free to start&rdquo; (its homepage).", "Lifecycle email for software products: flows in plain language, users tracked from signup to churn."],
    ["Plans and price", "Free, $0. Growth, $49 a month. Enterprise on request.", `One plan, ${OURS.plan}: ${OURS.price} a month. Free if you host the open-source edition yourself.`],
    ["What the free plan includes", "Up to 1,000 subscribed contacts and 4,000 sends in a rolling 30 days, with Loops branding in the emails.", `No free hosted plan. A ${OURS.trialDays}-day trial of everything, no credit card.`],
    ["Features by plan", "Its pricing page says all features are available on every plan, and that team seats are not charged separately.", "Everything is on the one plan, and team members are unlimited."],
    ["Contacts and sending on the paid plan", "Growth lists unlimited marketing and transactional sends. Its page lists contact limits by tier; we could not read the Growth figure cleanly, so we do not quote it.", `${OURS.profiles} customer profiles and ${OURS.emails} emails a month, then ${OURS.extraProfile} and ${OURS.extraEmails}.`],
    ["How you build a flow", "We could not confirm from the pages we read.", "Describe the flow in plain language and review the plan, or write the emails yourself in the flow editor."],
    ["Where it runs", "A hosted service. We did not see a self-hosted option on the pages we read.", "Hosted, or on your own server: MIT-licensed, Postgres, one Docker image."],
  ],
)}

<h2>When Loops is the better choice</h2>
<ul>
  <li>You want to start for free, or you have a small list: its free plan covers up to 1,000 subscribed contacts, and ours has no free hosted plan.</li>
  <li>You want the lowest paid price: Growth is $49 a month against our ${OURS.price}.</li>
  <li>You want one product for marketing newsletters as well as lifecycle and transactional email, which is how it describes itself.</li>
</ul>

<h2>When ${SITE_NAME} is the better choice</h2>
<ul>
  <li>You want to own the software: it is open source (MIT), you can run it on your own server, and your data stays in your Postgres database.</li>
  <li>You want to describe a flow in plain language and read the plan before it runs, with anything the AI writes waiting for a person's approval.</li>
  <li>You want each user's lifecycle stage tracked for you, and a retention grid you can act on.</li>
  <li>You want to send through your own Resend account or SMTP server, and keep your sending reputation yours.</li>
</ul>

${comparisonFooter(
  "Loops",
  CHECKED,
  [
    "The Growth plan's exact contact limit, which its pricing page did not show clearly.",
    "How its flows work: how many steps, whether it can branch, split-test or track goals.",
    "Whether it has a trial, beyond the free plan, and what it offers for self-hosting (we saw nothing).",
  ],
  "we read Loops's public homepage and its pricing page, as shown to a visitor who is not signed in.",
)}
<p>More: <a href="/alternatives">other comparisons</a>, and <a href="/blog/saas-onboarding-email-sequence">a SaaS onboarding email sequence</a>.</p>
`;
