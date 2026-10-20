import { SITE_NAME } from "../../layout.js";

export const body = (): string => `
<p class="lead">&ldquo;How many active users do we have?&rdquo; is a question that one number cannot answer well. A person who joined last week and a person who joined two years ago, and who has not been seen for a month, both count as &ldquo;users&rdquo;, but they need very different things from you. A retention grid separates them.</p>

<h2>The idea: two questions about every person</h2>
<p>For each person, ask two things:</p>
<ol>
  <li><b>How long have they been with you?</b> That is tenure: new, growing, established or loyal.</li>
  <li><b>How recently were they active?</b> That is recency: active, cooling, idle or dormant.</li>
</ol>
<p>Cross the two and you get a four-by-four grid with sixteen cells. Every person is in exactly one cell at a time, and each cell is a group that you can understand and act on.</p>

<h2>How to read it</h2>
<table class="cmp">
<thead><tr><th>Cell</th><th>What it usually means</th><th>What to consider</th></tr></thead>
<tbody>
<tr><th scope="row">New and active</th><td>A recent sign-up who is using the product</td><td>Help them reach the first useful action, then show what to do next.</td></tr>
<tr><th scope="row">New and idle or dormant</th><td>Signed up and never really started</td><td>The activation problem. A nudge, an offer of help, or a simpler first step.</td></tr>
<tr><th scope="row">Loyal and active</th><td>Your most committed people</td><td>Ask for feedback, invite them to try new things, and do not over-email them.</td></tr>
<tr><th scope="row">Loyal and cooling</th><td>Long-standing users who are slipping</td><td>The most valuable group to notice early. A personal check-in works better than a campaign.</td></tr>
<tr><th scope="row">Established and dormant</th><td>People who used to use it and have stopped</td><td>A win-back message, or a question about why they left.</td></tr>
</tbody>
</table>
<p>You do not need to act on all sixteen. Look for the cells with the most people, and the cells where people are moving the wrong way.</p>

<h2>Why the grid beats one retention number</h2>
<ul>
  <li><b>It tells you where to act.</b> &ldquo;Retention fell two points&rdquo; gives you nothing to do. &ldquo;Loyal users are cooling&rdquo; does.</li>
  <li><b>It stops new and old users being mixed.</b> A flood of new sign-ups can hide a loss of established customers, and the other way round.</li>
  <li><b>It makes the group concrete.</b> Each cell is a list of real people that you can email, call or look at.</li>
</ul>

<h2>The time windows should fit your product</h2>
<p>&ldquo;Cooling&rdquo; means different things for different products. Someone who has not opened a daily tool for a week has gone quiet. Someone who has not opened a tax product for a month is perfectly normal. A useful grid adjusts its recency windows to how often people naturally use your product, rather than using the same numbers for everything.</p>

<h2>From a grid to a lifecycle</h2>
<p>The grid describes where people are right now. A lifecycle describes how they move: signed up, activated, engaged, at risk, dormant, churned and, if they come back, resurrected. The two fit together. The lifecycle tells you what changed, and the grid shows you how many people are in each place.</p>

<h2>What to do with a cell</h2>
<ol>
  <li>Open the cell and look at some of the people in it. Do they share anything?</li>
  <li>Decide on one action: a message, a change in the product, a call.</li>
  <li>Send it, and note the date.</li>
  <li>Check the cell again in a few weeks. Did people move to a better cell?</li>
</ol>
<p>Keep your expectations modest. You will not move everyone, and some people leave for reasons that no email would change. The aim is to see where attention helps and to stop wasting it where it does not.</p>

<h2>The retention grid in ${SITE_NAME}</h2>
<p>${SITE_NAME} builds the grid for you from the events your product sends. Each person's lifecycle stage updates by itself, you can open any cell to see who is in it, watch the trend over time, and start a flow aimed at exactly those people. It adjusts to your product's natural rhythm instead of using one fixed window. <a href="/signup">Start a free trial</a> or see how it fits on <a href="/pricing">the pricing page</a>.</p>
<p>Related: <a href="/blog/trial-to-paid-email-sequence">a trial-to-paid email sequence</a> and <a href="/blog/lifecycle-vs-marketing-vs-transactional-email">lifecycle vs marketing vs transactional email</a>.</p>
`;
