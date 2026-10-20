import { SITE_NAME } from "../../layout.js";
import { OURS, cmpTable, comparisonFooter, note } from "../html.js";

export const CHECKED = "2026-10-20";

export const body = (): string => `
<p class="lead">Dittofeed and ${SITE_NAME} are the closest pair in this list: both describe themselves as open source, both can be hosted on your own server, and both are aimed at product teams. The difference is breadth against focus.</p>

${note(`<b>The short answer.</b> If you want more channels than email, an embeddable product, or a drag-and-drop journey builder, look at Dittofeed. Choose ${SITE_NAME} if email is all you send and you want to describe flows in plain language, review them, and see your users as a retention grid.`)}

<h2>Side by side</h2>
${cmpTable(
  ["", "Dittofeed", SITE_NAME],
  [
    ["What it says it is", "&ldquo;The open-source, embeddable customer engagement platform for automating email, SMS, mobile push, WhatsApp, &amp; more&rdquo; (its homepage).", "The open-source lifecycle email engine: flows in plain language, users tracked from signup to churn."],
    ["Channels", "Email, SMS, mobile push and WhatsApp, in its own words.", "Email only. We do not send SMS, push or in-app messages."],
    ["Open source and self-hosting", "Describes itself as open source. Its pricing page says &ldquo;Self-hosting is free&rdquo;.", "MIT-licensed. Self-hosting is free: Postgres, one Docker image."],
    ["Hosted price", "Cloud Pro, $75 a month, includes 10,000 unique users. Beyond that, $0.004 per additional user a month up to 100,000 users, then lower rates.", `${OURS.plan}, ${OURS.price} a month, includes ${OURS.profiles} customer profiles and ${OURS.emails} emails a month. Then ${OURS.extraProfile}.`],
    ["Trial", "A 14-day free trial.", `A ${OURS.trialDays}-day trial of everything, no credit card.`],
    ["Enterprise", "Self-hosted and cloud licences for white-labelling, embedded components and priority support, priced on request.", "One plan with everything included. Talk to us for needs beyond its limits."],
    ["How you build a flow", "A &ldquo;simple drag-and-drop journey builder&rdquo; with low-code segmentation and message templates (its homepage).", "Describe the flow in plain language and review the plan it produces, or write the emails yourself in the flow editor."],
    ["Insight into your users", "Segments and journeys. We could not see a retention view on the pages we read.", "Lifecycle stages updated automatically, and a retention grid you can open and act on."],
  ],
)}

<h2>When Dittofeed is the better choice</h2>
<ul>
  <li>You send SMS, push or WhatsApp as well as email. We only do email.</li>
  <li>You want to embed messaging features inside your own product: it lists embedded components, and we have nothing like that.</li>
  <li>You prefer to build journeys by dragging and connecting steps.</li>
  <li>You want a lower hosted price for a larger audience: $75 a month for 10,000 users is more included than our ${OURS.profiles} profiles for ${OURS.price}.</li>
  <li>You want a longer trial: 14 days, against our ${OURS.trialDays}.</li>
</ul>

<h2>When ${SITE_NAME} is the better choice</h2>
<ul>
  <li>You only need email, and a focused tool is easier to learn and to run.</li>
  <li>You want to say what should happen in your own words, read the resulting plan, and have anything the AI writes wait for approval before it is sent.</li>
  <li>You want the retention grid and automatic lifecycle stages, so you can see who is slipping without building the report yourself.</li>
  <li>You want unlimited team members and ${OURS.emails} emails a month on one fixed price.</li>
</ul>

<h2>If you plan to host it yourself</h2>
<p>Both can run on your own server, so the real cost is your time: setting it up, keeping it updated, backing up the database and watching your sending reputation. ${SITE_NAME} is deliberately small to run: it needs only Postgres, with no queue or cache to look after. If you would rather not run anything, both also offer a hosted service.</p>

${comparisonFooter(
  "Dittofeed",
  CHECKED,
  [
    "Its software licence. We rely on its own description of itself as open source.",
    "How many emails its cloud plan includes, or how its email sending compares with ours.",
    "How its journey builder, segmentation and integrations behave in practice: we did not test them.",
  ],
  "we read Dittofeed's public homepage and its pricing page, as shown to a visitor who is not signed in.",
)}
<p>More: <a href="/alternatives">other comparisons</a>, and <a href="/blog/retention-grid-explained">the retention grid, explained</a>.</p>
`;
