/**
 * Public site pages: landing, pricing, signup, signup-sent.
 *
 * Copy only claims what the product does today. Plan names, prices and limits
 * come from @loomail/core PLANS so this page can never disagree with what the
 * product enforces.
 *
 * Mirror side: PUBLIC (packages/api is mirrored).
 */
import { ADDONS, ADDON_KINDS, GOAL_INFO, ONBOARDING_GOALS, PLANS, TRIAL_DAYS, TRIAL_PLAN, chargeAmountMinor, type OnboardingGoal, type PlanId, managedSendingConfigFromEnv } from "@loomail/core";
import { esc, renderPage, SITE_NAME, type SiteContext } from "./layout.js";

const TRIAL_NOTE = `${TRIAL_DAYS} days of ${PLANS[TRIAL_PLAN].name}. No credit card.`;

// ---------------------------------------------------------------------------
// Landing
// ---------------------------------------------------------------------------

const FEATURES: Array<{ ico: string; title: string; body: string }> = [
  {
    ico: "Aa",
    title: "Flows in plain language",
    body: "Say what should happen and when. Loomail turns it into a fixed plan you can read before it goes live, then runs it the same way every time.",
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

/** What businesses use Loomail for. Each one has a ready-made flow in the library. */
const USE_CASES: Array<{ ico: string; title: string; body: string; starts: string; flow: string }> = [
  {
    ico: "1",
    title: "Welcome emails",
    body: "When someone registers on your website or app, Loomail sends a welcome email and a short series of onboarding messages, and stops the moment they get going.",
    starts: "When someone signs up",
    flow: "Welcome Onboarding",
  },
  {
    ico: "2",
    title: "Recover abandoned purchases",
    body: "When a customer adds a product to their cart but does not complete checkout, Loomail sends a reminder or two, and stops as soon as they buy.",
    starts: "When a cart is left behind",
    flow: "Abandoned cart",
  },
  {
    ico: "3",
    title: "Subscription reminders",
    body: "Tell customers about an upcoming renewal, an expiring trial or a change to their plan, at the right moment and only to the people it applies to.",
    starts: "About a week before a renewal or trial ends",
    flow: "Renewal reminder",
  },
  {
    ico: "4",
    title: "Bring inactive users back",
    body: "If someone has not logged in for 14 days, Loomail sends a re-engagement message, then one last note if they stay away.",
    starts: "When an active person goes quiet",
    flow: "At-risk check-in and Win-back",
  },
];

const STEPS: Array<{ title: string; body: string }> = [
  {
    title: "Describe the flows",
    body: "Write what you want in plain language, or start from a ready-made flow like Welcome Onboarding. Review the plan, then switch it on.",
  },
  {
    title: "Loomail does the rest",
    body: "Emails go out inside your quiet hours and frequency limits. Anyone who unsubscribes is never emailed again.",
  },
];

/** Is Loomail Sending (we send the email for you) offered on this service? The marketing copy follows. */
const managedOffered = (): boolean => managedSendingConfigFromEnv().enabled;

const homeFaq = (): Array<{ q: string; a: string }> => [
  {
    q: "Does Loomail send the emails?",
    a: managedOffered()
      ? "Yes. Loomail decides who gets what and when, and can send the email for you, so there is no email provider to sign up for. Add your own domain so messages come from you, or connect your own provider (Resend, or any SMTP server) if you prefer."
      : "Loomail decides who gets what and when, and sends through your own email provider: Resend, or any SMTP server. Messages come from your domain, so your sender reputation is yours.",
  },
  {
    q: "Do I need an AI key?",
    a: "The lifecycle engine and the ready-made flows work without one. Writing new flows in plain language uses an AI provider key that you supply, so you control the model and the cost.",
  },
  {
    q: "What happens after the trial?",
    a: `You get ${TRIAL_NOTE.toLowerCase()} When it ends your workspace is paused unless you subscribe to Essential. Your data stays in your workspace.`,
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
  const useCases = USE_CASES.map(
    (u) =>
      `<div class="card usecase"><div class="ico" aria-hidden="true">${esc(u.ico)}</div><h3>${esc(u.title)}</h3><p>${esc(u.body)}</p>` +
      `<dl class="uc-meta"><div><dt>Starts</dt><dd>${esc(u.starts)}</dd></div><div><dt>Ready-made flow</dt><dd>${esc(u.flow)}</dd></div></dl></div>`,
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

<section id="use-cases"><div class="wrap">
  <div class="center"><p class="eyebrow">Use cases</p><h2>What businesses use ${SITE_NAME} for</h2>
  <p class="lead">Four jobs most teams start with. Each has a ready-made flow you can add in one click and make your own.</p></div>
  <div class="cards two">${useCases}</div>
</div></section>

<section id="features" class="band"><div class="wrap">
  <div class="center"><p class="eyebrow">Features</p><h2>Everything lifecycle email needs, nothing it does not</h2>
  <p class="lead">One engine for onboarding, activation, retention and win-back, so you stop stitching scripts and cron jobs together.</p></div>
  <div class="cards">${features}</div>
</div></section>

<section id="how"><div class="wrap">
  <div class="center"><p class="eyebrow">How it works</p><h2>From first flow to first email in an afternoon</h2></div>
  <div class="how">
    <div class="shots">
      <img class="back" src="/landing/lifecycle-grid.png" width="1920" height="1200" loading="lazy" alt="The Loomail retention grid: customers grouped by how long they have been around and how long they have been quiet.">
      <img class="front" src="/landing/flow-editor.png" width="1920" height="1200" loading="lazy" alt="A Loomail flow: the event that starts it, the emails in order, and what ends it early.">
    </div>
    <div class="steps">${steps}</div>
  </div>
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
        `Describe an email flow in plain language and Loomail runs it. Follow every user from signup to churn and ${managedOffered() ? "send from one place" : "send through your own email provider"}.`,
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
    a: "Essential includes up to 6,000 customer profiles, the people your product tells Loomail about. The monthly email allowance is a guardrail against runaway sends, not something you should hit in normal use.",
  },
  {
    q: "Do you charge per email?",
    a: managedOffered()
      ? "Sending is included, up to your plan's monthly email allowance. Need more? Buy extra emails at $0.12 per 1,000. Prefer your own email provider? Connect it and pay them directly at their rates: Loomail only charges for the engine that decides who gets what."
      : "You send through your own email provider, so you pay them directly at their rates. Loomail only charges for the engine that decides who gets what.",
  },
  {
    q: "What if I need more than Essential includes?",
    a: "Buy extra usage for the month in a few clicks: more customer profiles, more emails or more AI credits, at the rates above. It is prepaid, so nothing is ever charged unless you choose it.",
  },
  {
    q: "What happens after the trial?",
    a: `${TRIAL_NOTE} The clock restarts once, when your first event arrives (up to 14 days in total), so setup time does not eat your trial. We email you two days before it ends. When it ends your workspace is paused until you subscribe to Essential. Nothing is deleted.`,
  },
  {
    q: "Can I change or cancel my plan?",
    a: "Yes. There is one plan, billed monthly, and you can cancel at any time. It stays active until the end of the period you paid for.",
  },
  {
    q: "Do you offer discounts for startups or nonprofits?",
    a: "Write to us. We would like to hear what you are building.",
  },
];

function usd(n: number): string {
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 })}`;
}

/** A whole-unit amount with the currency's own symbol ("GH₵760"); the code after it if the symbol is unknown. */
export function localMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency, currencyDisplay: "narrowSymbol", maximumFractionDigits: 0 }).format(amount);
  } catch {
    return `${amount.toLocaleString("en-US")} ${currency}`;
  }
}

export function pricingPage(ctx: SiteContext): string {
  // What a checkout really charges, when that is not US dollars: the same rounding the server uses.
  const local = (usdPrice: number): string | null =>
    ctx.chargeCurrency && ctx.usdRate ? localMoney(chargeAmountMinor(usdPrice, ctx.chargeCurrency, ctx.usdRate) / 100, ctx.chargeCurrency) : null;
  const cards = (["essential"] as const).map((id) => {
    const p = PLANS[id];
    const localMonthly = local(p.priceMonthlyUsd);
    const price = `<div class="price"><span class="amt">${usd(p.priceMonthlyUsd)}</span><small> / month</small></div>
         <div class="billed">Billed monthly</div>${
           localMonthly ? `
         <div class="billed">Charged as ${esc(localMonthly)} a month</div>` : ""
         }`;
    const cta = `<a class="btn block" href="/signup?plan=${id}">Start ${TRIAL_DAYS}-day free trial</a>`;
    return `<div class="plan-card${p.recommended ? " rec" : ""}">

<h3>${esc(p.name)}</h3><p class="muted" style="margin:6px 0 0">${esc(p.tagline)}</p>
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
    <h1 style="font-size:clamp(2rem,4.4vw,3rem)">One plan. Everything included.</h1>
    <p class="lead">One simple price, every feature. ${esc(TRIAL_NOTE)}</p>
  </div>
  <div class="plans single">${cards}</div>
  <div class="center" style="margin-top:56px">
    <h2>Extra usage</h2>
    <p class="lead">Need more than Essential includes in a month? Add it when you need it. Nothing is charged unless you choose to buy.</p>
  </div>
  <div class="faq" style="max-width:640px">
    ${ADDON_KINDS.map((k) => `<details open><summary>${esc(ADDONS[k].label)}: ${esc(ADDONS[k].rateLabel)}</summary><p>${esc(
      `Buy in packs of ${ADDONS[k].packUnits.toLocaleString("en-US")} for ${usd(ADDONS[k].packPriceCents / 100)}. A top-up raises this month's limit.`,
    )}</p></details>`).join("")}
  </div>
  <p class="note">${ctx.chargeCurrency && ctx.usdRate ? `Prices are listed in US dollars and charged in your local currency at a fixed exchange rate, shown under the price.` : "Prices are in US dollars."} Need more than 6,000 customer profiles, a security review or an invoice? <a href="mailto:${esc(ctx.supportEmail)}">Talk to us</a>.</p>
</div></section>
<section class="band"><div class="wrap">
  <div class="center"><h2>Pricing questions</h2></div>
  <div class="faq">${faq}</div>
</div></section>
`;

  const offers = (["essential"] as const).map((id) => ({
    "@type": "Offer",
    name: PLANS[id].name,
    price: String(PLANS[id].priceMonthlyUsd),
    priceCurrency: "USD",
  }));

  return renderPage(
    ctx,
    {
      title: `Pricing: ${SITE_NAME}`,
      description: `${SITE_NAME} Essential: every feature for ${usd(PLANS.essential.priceMonthlyUsd)} a month. ${TRIAL_NOTE}`,
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
    `Start your ${TRIAL_DAYS}-day free trial`;
  const err = state.error ? `<div class="err" role="alert">${esc(state.error)}</div>` : "";
  const perks = [
    `${TRIAL_NOTE}`,
    managedOffered() ? "We can send your email for you, or use your own provider" : "Send through your own email provider",
    "Ready-made onboarding flow to start from",
    "Unsubscribe and compliance handled for you",
  ];

  const body = `
<div class="wrap signup">
  <div>
    <p class="eyebrow">${esc(planName)} trial</p>
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
    <button class="btn block" type="submit">Start free trial</button>
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

export function signupSentPage(ctx: SiteContext, email: string, opts: { resent?: boolean; notice?: string } = {}): string {
  const showResend = email.includes("@");
  const lead = opts.resent
    ? `We sent another link to <b>${esc(email)}</b>. The earlier one stops working once you use the new one.`
    : `If we can send to <b>${esc(email)}</b>, a link to open your workspace is on its way. It usually arrives within a minute and expires in 10 minutes.`;
  const body = `
<div class="wrap" style="max-width:560px;padding:72px 20px;text-align:center">
  <p class="eyebrow">One more step</p>
  <h1 style="font-size:clamp(1.9rem,4vw,2.6rem)">Check your email</h1>
  <p class="lead">${lead}</p>
  ${opts.notice ? `<p class="err" role="alert" style="margin-top:20px">${esc(opts.notice)}</p>` : ""}
  <p class="muted" style="margin-top:28px">Nothing yet? Look in your spam or promotions folder first.</p>
  ${
    showResend
      ? `<form method="post" action="/signup/resend" style="margin-top:14px">
    <input type="hidden" name="email" value="${esc(email)}">
    <button class="btn ghost" type="submit" id="resend" disabled>Send the link again <span id="resend-wait"></span></button>
  </form>
  <script>
  (function(){var b=document.getElementById('resend'),w=document.getElementById('resend-wait'),n=30;
  function t(){if(n<=0){b.disabled=false;w.textContent='';return}w.textContent='('+n+'s)';n--;setTimeout(t,1000)}t();})();
  </script>`
      : ""
  }
  <p class="muted" style="margin-top:20px">Wrong address? <a href="/signup">Start again</a> with a different one.</p>
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
