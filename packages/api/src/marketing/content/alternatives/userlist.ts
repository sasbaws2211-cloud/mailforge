import { SITE_NAME } from "../../layout.js";
import { OURS, cmpTable, comparisonFooter, note } from "../html.js";

export const CHECKED = "2026-10-20";

export const body = (): string => `
<p class="lead">Userlist is email automation built for the way software companies work, including company-level data for business products. ${SITE_NAME} is a smaller, open-source tool for lifecycle email. They overlap on onboarding and lifecycle flows.</p>

${note(`<b>The short answer.</b> If your product is sold to companies and you want messages and segments built around company accounts, plus in-app messages, look at Userlist. Choose ${SITE_NAME} if you want open-source software, a single published price, and flows described in plain language.`)}

<h2>Side by side</h2>
${cmpTable(
  ["", "Userlist", SITE_NAME],
  [
    ["What it says it is", "&ldquo;An email tool that meets the complexity of your SaaS business. Onboard, engage, and nurture customers and marketing leads&rdquo; (its homepage).", "Lifecycle email for software products: flows in plain language, users tracked from signup to churn."],
    ["Plans", "Basic, Professional and Enterprise.", `One plan, ${OURS.plan}, with everything included.`],
    ["Price", "We could not read its base prices: its pricing page showed placeholders when we looked, so we quote none. It lists extra users at $10 (Basic) or $12 (Professional) a month per additional 1,000, beyond 10,000 included users.", `${OURS.price} a month, ${OURS.profiles} customer profiles and ${OURS.emails} emails a month included.`],
    ["Trial", "A free 14-day trial; its page says card details are required upfront.", `A ${OURS.trialDays}-day trial of everything, no credit card.`],
    ["Included features", "Basic: marketing and lifecycle email, in-app messages, internal notifications, company accounts, user and company segments, broadcasts, visual workflows and transactional email.", "Flows, saved segments, conditions and branching, goals, A/B tests and holdouts, and transactional messages, all on the one plan. Email only."],
    ["A/B tests and goals", "Listed on its Professional plan, above Basic.", "Included on the one plan."],
    ["Company-level data", "Company accounts and company segments are listed.", "We do not have company accounts: it works with individual users."],
    ["In-app messages", "Listed.", "No. Email only."],
    ["Where it runs", "A hosted service. We did not see a self-hosted option on the pages we read.", "Hosted, or on your own server: MIT-licensed, Postgres, one Docker image."],
    ["Startup discount", "Companies that have raised under $500k in total may get 50% off the first 12 months, for new accounts.", "We do not list one. Self-hosting the open-source edition is free."],
  ],
)}

<h2>When Userlist is the better choice</h2>
<ul>
  <li>You sell to companies and want to message and segment by company as well as by person. We do not have company accounts.</li>
  <li>You want in-app messages and internal notifications alongside email.</li>
  <li>You want hands-on help setting up: its pricing page lists a roadmapping session on Basic and training and data planning on higher plans.</li>
  <li>You are a very early company and may qualify for its startup discount.</li>
</ul>

<h2>When ${SITE_NAME} is the better choice</h2>
<ul>
  <li>You want to describe a flow in plain language, read the plan, and approve anything the AI writes before it goes out.</li>
  <li>You want A/B tests, goals and branching without moving up a plan: they are on the one plan.</li>
  <li>You want a single price you can read on the page, and no card to start the trial.</li>
  <li>You want open-source software you can run yourself.</li>
</ul>

${comparisonFooter(
  "Userlist",
  CHECKED,
  [
    "Its base monthly prices, which its pricing page did not show clearly.",
    "How many emails each plan includes: the page had a label for it but no number.",
    "Whether it offers any way to host it yourself, and how its workflow builder behaves in practice.",
  ],
  "we read Userlist's public homepage and its pricing page, as shown to a visitor who is not signed in.",
)}
<p>More: <a href="/alternatives">other comparisons</a>, and <a href="/blog/trial-to-paid-email-sequence">a trial-to-paid email sequence</a>.</p>
`;
