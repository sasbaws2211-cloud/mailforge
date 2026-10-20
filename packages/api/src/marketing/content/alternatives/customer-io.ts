import { SITE_NAME } from "../../layout.js";
import { OURS, cmpTable, comparisonFooter, note } from "../html.js";

export const CHECKED = "2026-10-20";

export const body = (): string => `
<p class="lead">Customer.io is a mature platform for sending messages across several channels. ${SITE_NAME} is narrower: lifecycle email for software products, open source, with flows described in plain language. The two start at the same price, so the choice is about what you need to send and how you want to work.</p>

${note(`<b>The short answer.</b> If you need push, in-app, SMS or WhatsApp as well as email, or you qualify for its startup program, choose Customer.io. If email is enough, you want to describe flows in plain language and review them before they run, or you want software you can host yourself, look at ${SITE_NAME}.`)}

<h2>Side by side</h2>
${cmpTable(
  ["", "Customer.io", SITE_NAME],
  [
    ["What it says it is", "&ldquo;A customer engagement platform for creating personalized journeys&hellip; across email, push, SMS, and in-app messaging&rdquo; (its homepage).", "Lifecycle email for software products: flows described in plain language, users tracked from signup to churn."],
    ["Channels", "Email, push, SMS and in-app. Its Essentials plan lists push and in-app (unlimited), WhatsApp, LINE and webhooks; SMS volume is custom.", "Email only. We do not send SMS, push or in-app messages."],
    ["Starting price", "Essentials from $100 a month (5,000 profiles). Premium from $1,000 a month, billed annually. Enterprise on request.", `One plan, ${OURS.plan}: ${OURS.price} a month.`],
    ["Included", "Essentials: 1 million emails a month, 2 object types, 2 workspaces, a visual workflow builder.", `${OURS.profiles} customer profiles, ${OURS.emails} emails a month, unlimited team members, the AI flow builder, priority support.`],
    ["Beyond what is included", "$0.009 per extra profile, $0.12 per extra 1,000 emails, $10 per 100K extra AI credits.", `${OURS.extraProfile}, ${OURS.extraEmails}, ${OURS.extraAi}. The same rates.`],
    ["Free plan or trial", "No free plan listed. A trial is offered; its length is not stated on the pricing page. Companies that have raised under $10M can get a year free through its Startup Program.", `${OURS.trialDays}-day trial of everything, no credit card. Self-hosting the open-source edition is free.`],
    ["How you build a flow", "A visual workflow builder.", "Describe the flow in plain language and review the plan it produces, or write the emails yourself in the flow editor."],
    ["Where it runs", "A hosted service. We did not see a self-hosted option on the pages we read.", "Hosted, or on your own server: it is MIT-licensed, runs on Postgres and ships as one Docker image."],
  ],
)}

<h2>When Customer.io is the better choice</h2>
<ul>
  <li>You need more than email. It covers push, in-app, SMS and WhatsApp in one place, and we do not.</li>
  <li>You are an early company that has raised under $10M: its Startup Program offers a full year free.</li>
  <li>You need what its higher plans list, such as custom role permissions, audit logging, HIPAA compliance or managed deliverability.</li>
  <li>You want a long-established product with a very large library of guides and integrations.</li>
</ul>

<h2>When ${SITE_NAME} is the better choice</h2>
<ul>
  <li>Email is the channel you use, and you would rather have a smaller tool that does it well than a platform that does everything.</li>
  <li>You want to describe a flow in your own words and read the plan before it goes live. Anything the AI writes waits in an approval queue until a person approves it.</li>
  <li>You want to see your users as a retention grid and open any cell to act on exactly those people.</li>
  <li>You want to own the software and the data: it is open source, you can host it yourself, and you send through your own Resend account or SMTP server.</li>
  <li>You do not want to pay per team member: every plan includes unlimited team members.</li>
</ul>

<h2>A note on price</h2>
<p>At the entry level the two cost the same, and the rates for going beyond the included amounts are the same too. We do not claim to be cheaper. The difference is in what the money buys: Customer.io's plan covers its other channels as well as email, and ours puts everything in one email-focused plan.</p>

${comparisonFooter(
  "Customer.io",
  CHECKED,
  [
    "How long its trial lasts, and whether a card is needed to start it.",
    "Whether it offers any way to host it yourself.",
    "How its visual builder, deliverability and support compare with ours in practice: we did not test them.",
  ],
  "we read Customer.io's public homepage and its pricing page, as shown to a visitor who is not signed in.",
)}
<p>More: <a href="/alternatives">other comparisons</a>, and <a href="/blog/lifecycle-vs-marketing-vs-transactional-email">lifecycle vs marketing vs transactional email</a>.</p>
`;
