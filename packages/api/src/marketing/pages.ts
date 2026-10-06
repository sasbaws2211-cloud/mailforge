/**
 * Public site pages: landing, pricing, signup, signup-sent.
 *
 * Copy only claims what the product does today. Plan names, prices and limits
 * come from @mailforge/core PLANS so this page can never disagree with what the
 * product enforces.
 *
 * Mirror side: PUBLIC (packages/api is mirrored).
 */
import { GOAL_INFO, ONBOARDING_GOALS, PLANS, PLAN_IDS, TRIAL_DAYS, TRIAL_PLAN, type OnboardingGoal, type PlanId, managedSendingConfigFromEnv } from "@mailforge/core";
import { esc, renderPage, SITE_NAME, type SiteContext } from "./layout.js";

const TRIAL_NOTE = `${TRIAL_DAYS} days of ${PLANS[TRIAL_PLAN].name}. No credit card.`;

// ---------------------------------------------------------------------------
// Landing
// ---------------------------------------------------------------------------

const FEATURES: Array<{ ico: string; title: string; body: string }> = [
  {
    ico: "Aa",
    title: "Flows in plain language",
    body: "Say what should happen and when. Mailforge turns it into a fixed plan you can read before it goes live, then runs it the same way every time.",
  },
  {
    ico: "↻",
    title: "Lifecycle that updates itself",
    body: "Every user moves through signed up, activated, engaged, at risk and dormant on their own, based on what they do and what they stop doing.",
  },
  {
    ico: "▦",
    title: "A retention grid, not a vanity chart",
    body: "See who is new, growing or loyal against how long they have been quiet, and open any cell to act on exactly those people.",
  },
  {
    ico: "@",
    title: "Your sender, your domain",
    body: "Send through your own Resend account or any SMTP server, and bring your own AI key. Your reputation stays yours and there is no per-email markup.",
  },
  {
    ico: "✓",
    title: "Compliance is built in",
    body: "One-click unsubscribe, a suppression list, a postal address in every footer, quiet hours and frequency caps are on by default, not an add-on.",
  },
  {
    ico: "☺",
    title: "Built for the whole team",
    body: "Invite teammates with owner and member roles, create API keys for your product, and keep every send in one searchable log.",
  },
];

const STEPS: Array<{ title: string; body: string }> = [
  {
    title: "Send your product events",
    body: "Post identify and track calls from your app. The endpoints are Segment-compatible, so the SDKs you already use work.",
  },
  {
    title: "Describe the flows",
    body: "Write what you want in plain language, or start from a ready-made flow like Welcome Onboarding. Review the plan, then switch it on.",
  },
  {
    title: "Mailforge does the rest",
    body: "Emails go out inside your quiet hours and frequency limits. Anyone who unsubscribes is never emailed again.",
  },
];

/** Is Mailforge Sending (we send the email for you) offered on this service? The marketing copy follows. */
const managedOffered = (): boolean => managedSendingConfigFromEnv().enabled;

const homeFaq = (): Array<{ q: string; a: string }> => [
  {
    q: "Does Mailforge send the emails?",
    a: managedOffered()
      ? "Yes. Mailforge decides who gets what and when, and can send the email for you, so there is no email provider to sign up for. Add your own domain so messages come from you, or connect your own provider (Resend, or any SMTP server) if you prefer."
      : "Mailforge decides who gets what and when, and sends through your own email provider: Resend, or any SMTP server. Messages come from your domain, so your sender reputation is yours.",
  },
  {
    q: "Do I need an AI key?",
    a: "The lifecycle engine and the ready-made flows work without one. Writing new flows in plain language uses an AI provider key that you supply, so you control the model and the cost.",
  },
  {
    q: "What happens after the trial?",
    a: `You get ${TRIAL_NOTE.toLowerCase()} When it ends you move to the Free plan unless you choose a paid one. Your data stays in your workspace.`,
  },
  {
    q: "Who owns the contact data?",
    a: "You do. Your contacts and events belong to your workspace and are used only to run your flows and show you your own reports.",
  },
];

export function homePage(ctx: SiteContext): string {
  const features = FEATURES.map(
    (f) =>
      `<div class="card"><div class="ico" aria-hidden="true">${f.ico}</div><h3>${esc(f.title)}</h3><p>${esc(f.body)}</p></div>`,
  ).join("");
  const steps = STEPS.map(
    (s) => `<div class="step"><h3>${esc(s.title)}</h3><p>${esc(s.body)}</p></div>`,
  ).join("");
  const faq = homeFaq().map(
    (f) => `<details><summary>${esc(f.q)}</summary><p>${esc(f.a)}</p></details>`,
  ).join("");

  const body = `
<section class="hero"><div class="wrap grid">
  <div>
    <p class="eyebrow">Lifecycle email for software products</p>
    <h1>Describe the email flow. <span class="hl">${SITE_NAME} runs it.</span></h1>
    <p class="lead">Send us your product events, say what should happen in plain language, and ${SITE_NAME} follows every user from signup to churn and emails them at the right moment${managedOffered() ? "" : ", through your own email provider"}.</p>
    <div class="cta"><a class="btn" href="/signup">Start free trial</a><a class="btn ghost" href="/pricing">See pricing</a></div>
    <p class="fine">${esc(TRIAL_NOTE)}</p>
  </div>
  <div class="mock" aria-label="Example of a flow">
    <div class="row"><span class="tag">You write</span>
      <div>If someone signs up but has not created a project after 3 days, send a helpful nudge. Stop if they activate.</div></div>
    <div class="arrow">compiled once into a plan you can read</div>
    <div class="row"><span class="tag">The plan</span>
      <ul class="plan">
        <li><code>trigger</code> signed_up</li>
        <li><code>wait</code> 3 days</li>
        <li><code>send</code> Getting started</li>
        <li><code>exit</code> if activated</li>
      </ul></div>
    <div class="arrow">then sent inside your quiet hours</div>
    <div class="row mail"><span class="tag">The email</span>
      <b>Getting the most from your workspace</b>
      <span class="muted">Hi Nana, most people who get value do three things in their first week&hellip;</span></div>
  </div>
</div></section>

<section id="features" class="band"><div class="wrap">
  <div class="center"><p class="eyebrow">Features</p><h2>Everything lifecycle email needs, nothing it does not</h2>
  <p class="lead">One engine for onboarding, activation, retention and win-back, so you stop stitching scripts and cron jobs together.</p></div>
  <div class="cards">${features}</div>
</div></section>

<section id="how"><div class="wrap">
  <div class="center"><p class="eyebrow">How it works</p><h2>From first event to first email in an afternoon</h2></div>
  <div class="steps">${steps}</div>
</div></section>

<section class="band"><div class="wrap">
  <div class="center"><p class="eyebrow">Questions</p><h2>Good to know</h2></div>
  <div class="faq">${faq}</div>
</div></section>

<section><div class="wrap"><div class="cta-band">
  <h2>Start with the free trial</h2>
  <p>${esc(TRIAL_NOTE)} Set up your first flow today.</p>
  <a class="btn" href="/signup">Start free trial</a>
</div></div></section>`;

  return renderPage(
    ctx,
    {
      title: `${SITE_NAME}: lifecycle email for software products`,
      description:
        `Describe an email flow in plain language and Mailforge runs it. Follow every user from signup to churn and ${managedOffered() ? "send from one place" : "send through your own email provider"}.`,
      path: "/",
      headExtra: jsonLd({
        "@context": "https://schema.org",
        "@type": "SoftwareApplication",
        name: SITE_NAME,
        applicationCategory: "BusinessApplication",
        operatingSystem: "Web",
        description:
          "Lifecycle email engine: describe flows in plain language, track users from signup to churn, send through your own provider.",
        url: `${ctx.siteUrl}/`,
      }),
    },
    body,
  );
}

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

const pricingFaq = (): Array<{ q: string; a: string }> => [
  {
    q: "How is usage counted?",
    a: "Plans are sized by contacts, the people your product tells Mailforge about. The monthly email allowance is a guardrail against runaway sends, not something you should hit in normal use.",
  },
  {
    q: "Why are there no per-email fees?",
    a: managedOffered()
      ? "Sending is included, up to your plan's monthly email allowance. Prefer your own email provider? Connect it and pay them directly at their rates: Mailforge only charges for the engine that decides who gets what."
      : "You send through your own email provider, so you pay them directly at their rates. Mailforge only charges for the engine that decides who gets what.",
  },
  {
    q: "What happens after the trial?",
    a: `${TRIAL_NOTE} When it ends you move to the Free plan unless you pick a paid plan. Nothing is deleted.`,
  },
  {
    q: "Can I change or cancel my plan?",
    a: "Yes. You can move up or down between plans, and annual billing gives you two months free compared with paying monthly.",
  },
  {
    q: "Do you offer discounts for startups or nonprofits?",
    a: "Write to us. We would like to hear what you are building.",
  },
];

function usd(n: number): string {
  return `$${n.toLocaleString("en-US")}`;
}

export function pricingPage(ctx: SiteContext): string {
  const cards = PLAN_IDS.map((id) => {
    const p = PLANS[id];
    const paid = p.priceMonthlyUsd > 0;
    const price = paid
      ? `<div class="price" data-monthly="${usd(p.priceMonthlyUsd)}" data-annual="${usd(p.priceAnnualMonthlyUsd)}"><span class="amt">${usd(p.priceMonthlyUsd)}</span><small> / month</small></div>
         <div class="billed" data-monthly="Billed monthly" data-annual="${usd(p.priceAnnualUsd)} billed yearly">Billed monthly</div>`
      : `<div class="price"><span class="amt">$0</span><small> / month</small></div><div class="billed">Free forever</div>`;
    const cta =
      id === "free"
        ? `<a class="btn ghost block" href="/signup?plan=free">Start free</a>`
        : `<a class="btn block${p.recommended ? "" : " ghost"}" href="/signup?plan=${id}">Start ${TRIAL_DAYS}-day trial</a>`;
    return `<div class="plan-card${p.recommended ? " rec" : ""}">
${p.recommended ? '<span class="badge">Most popular</span>' : ""}
<h3>${esc(p.name)}</h3><p class="muted" style="margin:6px 0 0;min-height:3em">${esc(p.tagline)}</p>
${price}
<ul>${p.features.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>
${cta}
</div>`;
  }).join("");

  const faq = pricingFaq().map(
    (f) => `<details><summary>${esc(f.q)}</summary><p>${esc(f.a)}</p></details>`,
  ).join("");

  const body = `
<section><div class="wrap">
  <div class="center">
    <p class="eyebrow">Pricing</p>
    <h1 style="font-size:clamp(2rem,4.4vw,3rem)">Simple pricing that grows with your audience</h1>
    <p class="lead">Priced by contacts, not by email. ${esc(TRIAL_NOTE)}</p>
    <div class="toggle" role="group" aria-label="Billing period">
      <button type="button" data-period="monthly" aria-pressed="true">Monthly</button>
      <button type="button" data-period="annual" aria-pressed="false">Yearly<span class="save">2 months free</span></button>
    </div>
  </div>
  <div class="plans">${cards}</div>
  <p class="note">Prices are in US dollars. Need more than 50,000 contacts, a security review or an invoice? <a href="mailto:${esc(ctx.supportEmail)}">Talk to us</a>.</p>
</div></section>
<section class="band"><div class="wrap">
  <div class="center"><h2>Pricing questions</h2></div>
  <div class="faq">${faq}</div>
</div></section>
<script>
(function(){var b=document.querySelectorAll('.toggle button');
function set(p){b.forEach(function(x){x.setAttribute('aria-pressed',String(x.dataset.period===p))});
document.querySelectorAll('.price[data-monthly]').forEach(function(e){e.querySelector('.amt').textContent=e.dataset[p]});
document.querySelectorAll('.billed[data-monthly]').forEach(function(e){e.textContent=e.dataset[p]})}
b.forEach(function(x){x.addEventListener('click',function(){set(x.dataset.period)})})})();
</script>`;

  const offers = PLAN_IDS.map((id) => ({
    "@type": "Offer",
    name: PLANS[id].name,
    price: String(PLANS[id].priceMonthlyUsd),
    priceCurrency: "USD",
  }));

  return renderPage(
    ctx,
    {
      title: `Pricing: ${SITE_NAME}`,
      description: `${SITE_NAME} plans from free to ${usd(PLANS.scale.priceMonthlyUsd)} a month, priced by contacts. ${TRIAL_NOTE}`,
      path: "/pricing",
      headExtra: jsonLd({
        "@context": "https://schema.org",
        "@type": "SoftwareApplication",
        name: SITE_NAME,
        applicationCategory: "BusinessApplication",
        offers,
      }),
    },
    body,
  );
}

// ---------------------------------------------------------------------------
// Signup
// ---------------------------------------------------------------------------

export interface SignupFormState {
  error?: string;
  workspace?: string;
  email?: string;
  plan?: PlanId;
  goal?: OnboardingGoal | null;
}

export function signupPage(ctx: SiteContext, state: SignupFormState = {}): string {
  const plan = state.plan ?? TRIAL_PLAN;
  const planName = PLANS[plan].name;
  const heading =
    plan === "free" ? "Create your free workspace" : `Start your ${TRIAL_DAYS}-day free trial`;
  const err = state.error ? `<div class="err" role="alert">${esc(state.error)}</div>` : "";
  const perks = [
    plan === "free" ? "Free forever for up to 500 contacts" : `${TRIAL_NOTE}`,
    managedOffered() ? "We can send your email for you, or use your own provider" : "Send through your own email provider",
    "Ready-made onboarding flow to start from",
    "Unsubscribe and compliance handled for you",
  ];

  const body = `
<div class="wrap signup">
  <div>
    <p class="eyebrow">${plan === "free" ? "Free plan" : `${esc(planName)} trial`}</p>
    <h1 style="font-size:clamp(2rem,4vw,2.8rem)">${esc(heading)}</h1>
    <p class="lead">Create a workspace in under a minute. We will email you a link to open it. There is no password to remember.</p>
    <ul class="perks">${perks.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>
  </div>
  <form class="form-card" method="POST" action="/signup" novalidate>
    ${err}
    <input type="hidden" name="plan" value="${esc(plan)}">
    <div class="hp" aria-hidden="true"><label for="website">Leave this empty</label><input type="text" id="website" name="website" tabindex="-1" autocomplete="off"></div>
    <label for="workspace">Workspace name</label>
    <input type="text" id="workspace" name="workspace" required maxlength="60" autocomplete="organization" placeholder="Acme Inc" value="${esc(state.workspace ?? "")}">
    <label for="email">Work email</label>
    <input type="email" id="email" name="email" required maxlength="254" autocomplete="email" placeholder="you@company.com" value="${esc(state.email ?? "")}">
    <fieldset class="goals">
      <legend>What do you want to do first? <span>(optional)</span></legend>
      ${ONBOARDING_GOALS.map(
        (g) => `<label class="goal"><input type="radio" name="goal" value="${g}"${state.goal === g ? " checked" : ""}><span><b>${esc(GOAL_INFO[g].label)}</b><small>${esc(GOAL_INFO[g].hint)}</small></span></label>`,
      ).join("")}
    </fieldset>
    <label class="check" for="terms"><input type="checkbox" id="terms" name="terms" value="yes" required>
      <span>I agree to the <a href="/terms" target="_blank" rel="noopener">Terms</a> and the <a href="/privacy" target="_blank" rel="noopener">Privacy Policy</a>.</span></label>
    <button class="btn block" type="submit">${plan === "free" ? "Create free workspace" : "Start free trial"}</button>
    <p class="muted" style="font-size:.88rem;margin:14px 0 0;text-align:center">Already have a workspace? <a href="/login">Sign in</a></p>
  </form>
</div>`;

  return renderPage(
    ctx,
    {
      title: `Sign up: ${SITE_NAME}`,
      description: `Create your ${SITE_NAME} workspace. ${TRIAL_NOTE}`,
      path: "/signup",
      minimalNav: true,
    },
    body,
  );
}

export function signupSentPage(ctx: SiteContext, email: string): string {
  const body = `
<div class="wrap" style="max-width:560px;padding:72px 20px;text-align:center">
  <p class="eyebrow">One more step</p>
  <h1 style="font-size:clamp(1.9rem,4vw,2.6rem)">Check your email</h1>
  <p class="lead">If we can send to <b>${esc(email)}</b>, a link to open your workspace is on its way. It expires in 10 minutes.</p>
  <p class="muted" style="margin-top:28px">Nothing yet? Check your spam folder, or <a href="/signup">try again</a> with a different address.</p>
</div>`;
  return renderPage(
    ctx,
    {
      title: `Check your email: ${SITE_NAME}`,
      description: "Open the link we emailed you to enter your workspace.",
      path: "/signup",
      minimalNav: true,
      noindex: true,
    },
    body,
  );
}

function jsonLd(data: unknown): string {
  // "<" is escaped so the payload can never close its own script tag.
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  return `<script type="application/ld+json">${json}</script>`;
}
