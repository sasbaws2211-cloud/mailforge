import { SITE_NAME } from "../../layout.js";

export const body = (): string => `
<p class="lead">Three kinds of email get mixed up all the time: lifecycle, marketing and transactional. They have different jobs, different triggers and different expectations from the person who receives them. Knowing which is which makes your emails easier to write, easier to measure and safer to send.</p>

<h2>Transactional email: the message the product has to send</h2>
<p>A transactional email is a direct result of something a person just did, and they are waiting for it. A password reset, a receipt, a sign-in link, a shipping confirmation, a notice that a payment failed. The person asked for it by acting, and they expect it within seconds.</p>
<p>What matters here is speed and reliability. It should be plain, short and focused on the one thing it is for. It is not the place for a sales pitch, and if it does not arrive, the product feels broken.</p>

<h2>Marketing email: the message you choose to send</h2>
<p>A marketing email is sent because you want to tell people something: a new feature, a webinar, a sale, a newsletter. It goes to a group at a time you pick (a broadcast), and nobody was waiting for it. Because it is not expected, it needs a reason to be opened, and the person must be able to opt out easily.</p>
<p>Marketing email is measured by reach and response: opens, clicks and what people did afterwards. The work is in the audience and the timing, not in the trigger.</p>

<h2>Lifecycle email: the message that follows what a person does</h2>
<p>Lifecycle email sits between the two. It is not a direct response to one action like a receipt, and it is not a broadcast. It is sent because of where a person is in their relationship with your product: they signed up and have not done anything yet, they have been active for a month, they have gone quiet, their trial ends in two days.</p>
<p>The trigger is behaviour, or the lack of it, and the timing is relative to the person, not to the calendar. Two people who signed up on the same day can get different emails a week later, because one has set up their account and the other has not.</p>

<h2>Side by side</h2>
<table class="cmp">
<thead><tr><th></th><th>Transactional</th><th>Marketing</th><th>Lifecycle</th></tr></thead>
<tbody>
<tr><th scope="row">Why it is sent</th><td>The person just did something</td><td>You have something to say</td><td>The person is at a certain point in their journey</td></tr>
<tr><th scope="row">What triggers it</th><td>One action, such as a purchase</td><td>A date you choose</td><td>What the person did, or did not do</td></tr>
<tr><th scope="row">Who gets it</th><td>One person</td><td>A whole audience at once</td><td>Each person, at their own time</td></tr>
<tr><th scope="row">Expected?</th><td>Yes, right away</td><td>No</td><td>Somewhat, if it is relevant</td></tr>
<tr><th scope="row">Examples</th><td>Receipt, password reset</td><td>Newsletter, announcement</td><td>Welcome, activation nudge, win-back</td></tr>
</tbody>
</table>

<h2>Why the difference matters</h2>
<ul>
  <li><b>Opt-out rules.</b> People can usually opt out of marketing and lifecycle email, and the rules about what you must include differ from country to country. A message that exists only to complete a transaction is treated differently from one that promotes something. Check the rules where your customers live, and keep promotion out of your transactional messages.</li>
  <li><b>Deliverability.</b> Mailbox providers watch how people respond to each kind of mail. If a password reset shares a sending reputation with a broadcast that many people ignore, the reset can suffer. Many teams send transactional mail from a separate address or stream for this reason.</li>
  <li><b>Measurement.</b> A receipt that is opened tells you nothing. A welcome sequence is judged by whether people reached the first useful action. Using one set of metrics for all three hides the numbers that matter.</li>
  <li><b>Frequency.</b> A person can get a receipt and a lifecycle email on the same day without complaint, but several lifecycle emails in a row feels like spam. Set limits for lifecycle email so that people are not mailed too often.</li>
</ul>

<h2>Where most software products should start</h2>
<p>If you only have time for one, start with lifecycle email, and start small. A welcome email, a nudge for people who have not reached their first useful action, and a message when someone has gone quiet will do more for a young product than a monthly newsletter. They run on their own once they are set up, and they speak to people at the moment it makes sense.</p>
<p>Transactional messages come from your product anyway. Marketing broadcasts can wait until you have something worth announcing.</p>

<h2>Doing lifecycle email with ${SITE_NAME}</h2>
<p>${SITE_NAME} is built for the lifecycle part. You describe a flow in plain language, for example &ldquo;welcome them, and if they have not created a project in two days, send a nudge; stop when they do&rdquo;, and it turns that into a fixed plan you can read before it goes live. Each person moves through stages such as signed up, activated, engaged, at risk and dormant on their own, based on what they do and stop doing. See <a href="/pricing">pricing</a>, or read how other tools compare on our <a href="/alternatives">alternatives page</a>.</p>
<p>Next: <a href="/blog/saas-onboarding-email-sequence">a SaaS onboarding email sequence: what to send and when</a>.</p>
`;
