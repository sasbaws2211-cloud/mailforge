import { SITE_NAME } from "../../layout.js";

export const body = (): string => `
<p class="lead">A free trial is a short window in which someone decides whether your product is worth paying for. Most people do not decide on the last day. They decide in the first few days, by whether they got something done. Your emails during the trial should help them get there, and say clearly what happens next.</p>

<h2>What the trial emails are for</h2>
<p>Trial emails are not there to push people to pay. They are there to make sure that people who would benefit from the product see the benefit before the trial ends. If someone got real value, paying is an easy decision. If they never got started, no clever subject line on day seven will fix that.</p>
<p>So the order of the work is: help them get started, help them reach the result they came for, then be clear and kind about the end of the trial.</p>

<h2>A seven-day timeline</h2>
<table class="cmp">
<thead><tr><th>When</th><th>Who gets it</th><th>What it says</th></tr></thead>
<tbody>
<tr><th scope="row">Day 0</th><td>Everyone who starts a trial</td><td>Welcome, how long the trial lasts, and the one first step to take. State plainly whether a card is needed.</td></tr>
<tr><th scope="row">Day 1 or 2</th><td>Only people who have not reached the first useful action</td><td>A short nudge towards that one step, with a way to ask for help.</td></tr>
<tr><th scope="row">Day 3 or 4</th><td>People who have started</td><td>The next thing worth doing, or an example of how others use the product well.</td></tr>
<tr><th scope="row">Day 5</th><td>Everyone still in the trial</td><td>A heads-up that the trial ends in two days, what happens then, and how to continue or to stop.</td></tr>
<tr><th scope="row">Day 7</th><td>Everyone who has not subscribed</td><td>The last day: what they will keep or lose, and a link to choose a plan.</td></tr>
<tr><th scope="row">After the trial</th><td>People who did not subscribe</td><td>One follow-up a few days later asking what stopped them, and leaving the door open. Then stop.</td></tr>
</tbody>
</table>

<h2>Send different emails to different people</h2>
<p>The same message to everyone is the weak point of most trial sequences. A person who has used the product every day does not need to be told what it does. A person who never opened it needs a reason to try, or an easy way out.</p>
<ul>
  <li><b>Active during the trial:</b> talk about the value they have already got, and what a paid plan adds. Be specific, using what they actually did.</li>
  <li><b>Started but stalled:</b> ask what is in the way, and offer help.</li>
  <li><b>Never started:</b> do not pretend otherwise. Offer a short guide or extend the trial if that is your policy, and accept that some people will leave.</li>
</ul>

<h2>Be plain about the end</h2>
<p>People trust a product that tells them clearly when the trial ends, what it costs and what happens to their data. Say what the price is. Say whether you will charge a card automatically, and if you will not, say so. Make it easy to cancel or to export what they made. Dark patterns such as hidden dates and hard-to-find cancel links win a few payments and lose the trust of everyone else.</p>

<h2>Stop emailing when they subscribe</h2>
<p>As soon as someone becomes a customer, every trial email must stop. Nothing is more irritating than a countdown to a deadline that no longer applies to you. The end of the trial and the start of the subscription are events in your product. Your emails should listen for them.</p>

<h2>Measuring it</h2>
<p>The number to watch is the share of trials that become paying customers, and, before that, the share that reach the first useful action. If many people start but few reach the first action, fix the early emails and the product's first minutes. If many reach it but few pay, the problem is closer to price, timing or the offer. Look at each step separately, and record what each email was followed by.</p>
<p>If you test a change, test one thing at a time, keep the groups comparable, and wait for enough people before you decide. It can help to hold back a small share of trials from the emails altogether, so that you can see whether the emails are making a difference at all.</p>

<h2>Setting it up in ${SITE_NAME}</h2>
<p>In ${SITE_NAME}, a flow can start from an event your product sends, such as a trial starting, wait for the events you care about, send different emails to people who did and did not act, and count how many reached a goal such as subscribing. A flow can also check a contact's payment status, for example trial or paid, so that it stops once they subscribe. You can describe it in plain language and review the plan, or write the emails yourself. <a href="/signup">Start a free trial</a>, or see <a href="/pricing">pricing</a>.</p>
<p>Related: <a href="/blog/saas-onboarding-email-sequence">a SaaS onboarding email sequence</a> and <a href="/blog/retention-grid-explained">the retention grid, explained</a>.</p>
`;
