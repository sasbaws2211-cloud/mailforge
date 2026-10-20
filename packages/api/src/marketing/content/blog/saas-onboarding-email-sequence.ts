import { SITE_NAME } from "../../layout.js";

export const body = (): string => `
<p class="lead">Most people who sign up for a software product do not reach the point where it is useful to them. A good onboarding sequence is a small number of emails, sent at the right moments, with one job: to help each person take the first step that matters. Here is how to design one.</p>

<h2>Start with the activation event</h2>
<p>Before you write anything, decide what &ldquo;activated&rdquo; means for your product. It is the first action that tells you someone has got value: created a first project, connected a data source, invited a teammate, sent a first message. Pick one, and be specific enough that your product can record it as an event.</p>
<p>Every email in the sequence exists to move someone towards that event, and the sequence stops the moment they reach it. Someone who has already activated should never get a message asking them to.</p>

<h2>A sequence that works for most products</h2>
<ol>
  <li><b>Right away: the welcome.</b> Send it within minutes of signing up. Say what to do first, with one button, and nothing else. Do not list every feature. If you ask for one thing, more people do it.</li>
  <li><b>Day 1 or 2: the nudge, only if they have not activated.</b> Short and plain: &ldquo;You are one step away&rdquo;, and the same single step. If they have done it, they never see this email.</li>
  <li><b>Day 3 or 4: show what good looks like.</b> A short example or a story of someone using the product well. This is for people who got started but have not seen the point yet.</li>
  <li><b>Day 5 to 7: offer help.</b> Ask what is getting in the way and offer a reply, a short call or a link to a guide. This catches people who are stuck.</li>
  <li><b>Then stop.</b> Four emails is enough. If someone has not responded by then, more messages will not change that.</li>
</ol>

<h2>Branch on what people do</h2>
<p>The big improvement over a fixed drip is to send different emails to different people. After three days, someone who created a project and someone who did nothing need different messages. In practice this is one question per decision: &ldquo;did they do X since signing up?&rdquo; If yes, go down one path, and if not, go down the other.</p>
<p>Keep it small. A sequence with one or two decisions is easy to understand and easy to fix. One with ten is a maze that nobody can debug.</p>

<h2>Writing the emails</h2>
<ul>
  <li><b>One idea, one action.</b> If you cannot say what the email is for in a sentence, it is two emails.</li>
  <li><b>Write like a person.</b> Send from a real name, keep the subject plain, and say what you mean. &ldquo;Quick question about your setup&rdquo; is more likely to be read than &ldquo;Unlock the full power of the platform&rdquo;.</li>
  <li><b>Use what you know.</b> If you know their name, their plan or the last thing they did, use it where it helps, and have a fallback for when you do not know.</li>
  <li><b>Make replying easy.</b> Send from an address that a person reads. Replies from new users are some of the most useful feedback you will ever get.</li>
</ul>

<h2>Measuring it</h2>
<p>Opens and clicks are a poor guide. What matters is the share of new sign-ups who reach the activation event, and how fast. Compare it before and after you add the sequence, and compare people who got an email with people who did not if you can. Set it up as a goal: &ldquo;reached the activation event within 14 days of signing up&rdquo;, so you see conversions per email rather than guessing.</p>
<p>When you change an email, change one thing and let it run long enough to compare. If you split traffic between two versions, check whether the difference is large enough to trust before you pick a winner. A small gap on a few dozen people is noise.</p>

<h2>Respect the inbox</h2>
<p>Set a limit on how many lifecycle emails one person can get in a week, include a clear way to unsubscribe, and avoid sending in the middle of the night in the person's own time zone. People tolerate a short, relevant sequence. They do not tolerate being mailed after they have already done the thing you asked.</p>

<h2>Building this in ${SITE_NAME}</h2>
<p>In ${SITE_NAME} you can describe this sequence in your own words, including the stop condition, review the plan it produces, and approve each generated email before anything is sent. You can also write the emails yourself in the flow editor, split a flow into paths, wait for an event, and set the activation event as the flow's goal to see how many people reach it. <a href="/signup">Start a free trial</a> or see <a href="/pricing">pricing</a>.</p>
<p>Related: <a href="/blog/trial-to-paid-email-sequence">a trial-to-paid email sequence</a> and <a href="/blog/lifecycle-vs-marketing-vs-transactional-email">lifecycle vs marketing vs transactional email</a>.</p>
`;
