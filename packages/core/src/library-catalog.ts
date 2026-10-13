/**
 * Library catalog: the ready-made flows a customer can install in one click, no AI key needed.
 *
 * Every flow here has fixed, hand-written copy (rendered from templates) and a pre-compiled
 * plan, so installing one gives a working draft immediately. Installing and activating are
 * separate acts: the flow starts as a draft.
 *
 * Each entry says which event (if any) the customer's app must send to start it, so the
 * gallery can say so before installing.
 *
 * The first entry is the original Welcome Onboarding flow (see library-flows.ts); the rest are
 * defined here. Template slugs are unique per workspace, so every slug below is distinct.
 *
 * Mirror side: PUBLIC (packages/core is mirrored).
 */
import {
  LIBRARY_FLOW_WELCOME,
  LIBRARY_TEMPLATES,
  type LibraryFlow,
  type LibraryTemplate,
} from "./library-flows.js";

export interface LibraryCatalogEntry {
  /** Stable id used by the install endpoint. */
  id: string;
  /** One line a customer reads in the gallery. */
  tagline: string;
  /** What starts it, in words ("when someone signs up"). */
  when: string;
  /** An event the customer's app must send for this to start, or null when no event is needed. */
  needsEvent: string | null;
  /** Roughly how long the sequence runs ("over 4 days"). */
  span: string;
  flow: LibraryFlow;
  templates: LibraryTemplate[];
}

const WRAP_OPEN =
  `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">`;

/** Build a template from paragraphs: `<p>` per paragraph, plain text with blank lines. */
function tpl(slug: string, name: string, subject: string, paragraphs: string[], category = "nurture"): LibraryTemplate {
  const sig = "The {{tenant.name}} team";
  const html =
    WRAP_OPEN +
    "\n" +
    [`<p>Hi {{contact.first_name|there}},</p>`, ...paragraphs.map((p) => `<p>${p}</p>`), `<p>${sig}</p>`].join("\n\n") +
    "\n</div>";
  const text = ["Hi {{contact.first_name|there}},", ...paragraphs.map((p) => p.replace(/<[^>]+>/g, "")), sig].join("\n\n");
  return { slug, name, subject, bodyHtml: html, bodyText: text, variables: ["tenant.name"], category };
}

interface StepDef {
  delay: string;
  template: string;
  action?: string;
  /** Only send if the contact is (or is not) in this lifecycle state when the step comes due. */
  stateIs?: string;
  stateIsNot?: string;
}

function flow(o: {
  name: string;
  description: string;
  trigger: { type: "event" | "lifecycle_transition"; config: Record<string, unknown> };
  steps: StepDef[];
  exits: Array<Record<string, unknown>>;
  reentry?: "once" | "cooldown";
  cooldownDays?: number;
  priority?: number;
}): LibraryFlow {
  const steps = o.steps.map((s, i) => ({
    order: i + 1,
    action_type: s.action ?? (i === 0 ? "welcome" : "nurture_value"),
    delay: s.delay,
    template_ref: s.template,
  }));
  const planSteps = o.steps.map((s, i) => ({
    order: i + 1,
    action_type: s.action ?? (i === 0 ? "welcome" : "nurture_value"),
    delay: s.delay,
    window_policy: s.delay === "0m" ? "immediate" : "respect_window",
    template_ref: s.template,
    ...(s.stateIs ? { condition: { lifecycle_state: s.stateIs } } : {}),
    ...(s.stateIsNot ? { condition: { lifecycle_state_not: s.stateIsNot } } : {}),
  }));
  return {
    name: o.name,
    description: o.description,
    triggerType: o.trigger.type,
    triggerConfig: o.trigger.config,
    steps,
    compiledPlan: {
      trigger: { type: o.trigger.type, condition: o.trigger.config },
      steps: planSteps,
      exit_conditions: o.exits,
    },
    flowClass: "nurture",
    approvalMode: "auto",
    reentryPolicy: o.reentry ?? "once",
    reentryCooldownDays: o.cooldownDays ?? 0,
    priority: o.priority ?? 10,
    source: "library",
  };
}

// ---------------------------------------------------------------------------
// Activation nudge
// ---------------------------------------------------------------------------

const ACTIVATION_TEMPLATES: LibraryTemplate[] = [
  tpl("activation-nudge-1", "Activation nudge", "Quick question about getting started", [
    "You signed up for {{tenant.name}} a few days ago, and I noticed you have not got going yet. That is completely normal: most people get stuck on the first step.",
    "What is the one thing you were hoping to do? Reply with a sentence and I will point you at the fastest way to get it done.",
  ]),
  tpl("activation-nudge-2", "Activation nudge, last", "Still want help getting set up?", [
    "A week in, and it looks like {{tenant.name}} has not clicked yet. That is on us, not you.",
    "If something was confusing or missing, tell me by replying. If it is simply not the right time, no problem: your account stays exactly as it is.",
  ]),
];

const ACTIVATION_NUDGE = flow({
  name: "Activation nudge",
  description:
    "For people who signed up but have not activated. Two short emails, on day 3 and day 7, that ask what is in the way. Stops as soon as they activate.",
  trigger: { type: "event", config: { event: "signed_up" } },
  steps: [
    { delay: "3d", template: "activation-nudge-1", action: "nurture_value", stateIs: "signed_up" },
    { delay: "7d", template: "activation-nudge-2", action: "nurture_value", stateIs: "signed_up" },
  ],
  exits: [{ event: "activated" }],
});

// ---------------------------------------------------------------------------
// First win (celebrate activation)
// ---------------------------------------------------------------------------

const FIRST_WIN_TEMPLATES: LibraryTemplate[] = [
  tpl("first-win", "First win", "You are set up. Here is what to do next", [
    "You just did the thing most people never get round to: you are up and running on {{tenant.name}}.",
    "Over the next week, the best next step is to use it for one real task, not a test. That is when the value shows up.",
    "If anything looks off, reply to this email and a person will help.",
  ]),
  tpl("first-win-followup", "First win follow-up", "How was your first week?", [
    "A week on: how is {{tenant.name}} working for you?",
    "If it is helping, a one-line reply telling us what you use it for helps us build more of it. If it is not, tell us what is missing and we will do our best.",
  ]),
];

const FIRST_WIN = flow({
  name: "First win",
  description:
    "Celebrates the moment someone activates, then checks in a week later. Starts when your app sends the activated event.",
  trigger: { type: "event", config: { event: "activated" } },
  steps: [
    { delay: "0m", template: "first-win", action: "welcome" },
    { delay: "7d", template: "first-win-followup", action: "nurture_value" },
  ],
  exits: [],
});

// ---------------------------------------------------------------------------
// Feature discovery
// ---------------------------------------------------------------------------

const FEATURE_TEMPLATES: LibraryTemplate[] = [
  tpl("feature-discovery-1", "Feature discovery 1", "One feature worth trying this week", [
    "You have got the basics of {{tenant.name}} working. Here is the single feature that people who stay with us most often turn on next.",
    "Pick one thing to try this week, not everything. Small steps stick.",
  ]),
  tpl("feature-discovery-2", "Feature discovery 2", "A shortcut most people miss", [
    "One more thing that saves time in {{tenant.name}}: the shortcuts and saved settings. Setting them up once means you never repeat yourself.",
    "If you would like a hand, reply and tell us what you do most often.",
  ]),
];

const FEATURE_DISCOVERY = flow({
  name: "Feature discovery",
  description:
    "After someone activates, two emails a few days apart that point them at the next most useful thing. Replace the wording with your own features.",
  trigger: { type: "lifecycle_transition", config: { from: "signed_up", to: "activated" } },
  steps: [
    { delay: "2d", template: "feature-discovery-1", action: "nurture_value" },
    { delay: "6d", template: "feature-discovery-2", action: "nurture_value" },
  ],
  exits: [{ lifecycle_state_change: { to: "churned" } }],
  reentry: "cooldown",
  cooldownDays: 60,
});

// ---------------------------------------------------------------------------
// At-risk check-in
// ---------------------------------------------------------------------------

const AT_RISK_TEMPLATES: LibraryTemplate[] = [
  tpl("at-risk-1", "At-risk check-in", "Is everything okay?", [
    "We have not seen you in {{tenant.name}} for a little while, and I wanted to check that nothing is wrong.",
    "If something got in the way, reply and tell me: I would rather fix it than lose you.",
  ]),
  tpl("at-risk-2", "At-risk follow-up", "Anything we can do to help?", [
    "Just one more note from us. If {{tenant.name}} stopped being useful, we would love to know why.",
    "A single sentence is plenty. And if you are busy, no need to reply: we will leave you in peace.",
  ]),
];

const AT_RISK_CHECKIN = flow({
  name: "At-risk check-in",
  description:
    "When an engaged person goes quiet, a friendly check-in straight away and a follow-up four days later. Stops if they come back.",
  trigger: { type: "lifecycle_transition", config: { from: "engaged", to: "at_risk" } },
  steps: [
    { delay: "0m", template: "at-risk-1", action: "welcome" },
    { delay: "4d", template: "at-risk-2", action: "nurture_value", stateIs: "at_risk" },
  ],
  exits: [{ lifecycle_state_change: { to: "engaged" } }],
  reentry: "cooldown",
  cooldownDays: 30,
});

// ---------------------------------------------------------------------------
// Win-back
// ---------------------------------------------------------------------------

const WIN_BACK_TEMPLATES: LibraryTemplate[] = [
  tpl("win-back-1", "Win-back", "We miss you at {{tenant.name}}", [
    "It has been a while since you used {{tenant.name}}, and a lot has improved since.",
    "If you would like to pick up where you left off, everything is exactly as you left it.",
  ]),
  tpl("win-back-2", "Win-back, last", "Should we keep your account open?", [
    "This is the last note from us on this. Your {{tenant.name}} account is still here whenever you want it.",
    "If you no longer want to hear from us, you can unsubscribe below and we will not email again.",
  ]),
];

const WIN_BACK = flow({
  name: "Win-back",
  description:
    "For people who have gone dormant: one email when they do, and a last one a week later. Stops if they come back.",
  trigger: { type: "lifecycle_transition", config: { from: "at_risk", to: "dormant" } },
  steps: [
    { delay: "0m", template: "win-back-1", action: "welcome" },
    { delay: "7d", template: "win-back-2", action: "nurture_value", stateIs: "dormant" },
  ],
  exits: [{ lifecycle_state_change: { to: "resurrected" } }],
  reentry: "cooldown",
  cooldownDays: 90,
});

// ---------------------------------------------------------------------------
// Upgrade nudge (limit reached)
// ---------------------------------------------------------------------------

const UPGRADE_TEMPLATES: LibraryTemplate[] = [
  tpl("upgrade-nudge-1", "Upgrade nudge", "You are getting close to your limit", [
    "You have been getting real use out of {{tenant.name}}, and you have reached the limit of your current plan.",
    "Upgrading takes a minute and keeps everything running without interruption. If you would like to talk it through first, just reply.",
  ]),
  tpl("upgrade-nudge-2", "Upgrade nudge, follow-up", "A quick note about your plan", [
    "Following up on my last note: your plan limit is still in place, so some things may be paused.",
    "If upgrading is not right for you, tell me what would be and I will see what I can do.",
  ]),
];

const UPGRADE_NUDGE = flow({
  name: "Upgrade nudge",
  description:
    "When someone reaches a plan limit in your product, a helpful email straight away and a follow-up three days later. Starts when your app sends a hit_plan_limit event.",
  trigger: { type: "event", config: { event: "hit_plan_limit" } },
  steps: [
    { delay: "0m", template: "upgrade-nudge-1", action: "welcome" },
    { delay: "3d", template: "upgrade-nudge-2", action: "nurture_value" },
  ],
  exits: [{ event: "upgraded" }],
  reentry: "cooldown",
  cooldownDays: 30,
});

// ---------------------------------------------------------------------------
// Cancellation feedback
// ---------------------------------------------------------------------------

const CANCEL_TEMPLATES: LibraryTemplate[] = [
  tpl("cancel-feedback-1", "Cancellation feedback", "Sorry to see you go: what happened?", [
    "We were sorry to see you cancel {{tenant.name}}. If you have a minute, I would really like to know what went wrong.",
    "Reply with a sentence, however blunt. It genuinely helps us get better.",
  ]),
  tpl("cancel-feedback-2", "Cancellation, door open", "The door is always open", [
    "A quick note to say your {{tenant.name}} data is safe, and you are welcome back any time.",
    "If something we changed would make you reconsider, I would love to hear it.",
  ]),
];

const CANCEL_FEEDBACK = flow({
  name: "Cancellation feedback",
  description:
    "When someone cancels, asks why and leaves the door open a week later. Starts when your app sends a subscription_cancelled event.",
  trigger: { type: "event", config: { event: "subscription_cancelled" } },
  steps: [
    { delay: "1h", template: "cancel-feedback-1", action: "welcome" },
    { delay: "7d", template: "cancel-feedback-2", action: "nurture_value" },
  ],
  exits: [{ event: "resubscribed" }],
  reentry: "cooldown",
  cooldownDays: 180,
});

// ---------------------------------------------------------------------------
// Abandoned cart
// ---------------------------------------------------------------------------

const CART_TEMPLATES: LibraryTemplate[] = [
  tpl("abandoned-cart-1", "Abandoned cart, reminder", "You left something behind", [
    "You left a few things in your cart at {{tenant.name}}. We have saved them for you, so you can pick up right where you stopped.",
    "If you ran into a problem at checkout, just reply and we will help.",
  ]),
  tpl("abandoned-cart-2", "Abandoned cart, follow-up", "Still thinking it over?", [
    "Your cart at {{tenant.name}} is still waiting. Items can sell out, so we did not want you to miss out.",
    "Questions about sizing, delivery or anything else? Reply to this email and a person will answer.",
  ]),
  tpl("abandoned-cart-3", "Abandoned cart, last call", "Last reminder about your cart", [
    "This is the last time we will mention the items in your cart at {{tenant.name}}.",
    "If you still want them, they are one click away. If not, no problem at all.",
  ]),
];

const ABANDONED_CART = flow({
  name: "Abandoned cart",
  description:
    "Reminds people who left items in their cart: an hour later, the next day and after three days. Stops the moment they complete the order. Starts when your app sends a cart_abandoned event.",
  trigger: { type: "event", config: { event: "cart_abandoned" } },
  steps: [
    { delay: "1h", template: "abandoned-cart-1", action: "welcome" },
    { delay: "1d", template: "abandoned-cart-2", action: "nurture_value" },
    { delay: "3d", template: "abandoned-cart-3", action: "nurture_value" },
  ],
  exits: [{ event: "order_completed" }],
  reentry: "cooldown",
  cooldownDays: 7,
});

// ---------------------------------------------------------------------------
// Renewal reminder
// ---------------------------------------------------------------------------

const RENEWAL_TEMPLATES: LibraryTemplate[] = [
  tpl("renewal-reminder-1", "Renewal reminder", "Your {{tenant.name}} plan renews soon", [
    "A heads-up: your {{tenant.name}} plan is coming up for renewal in about a week.",
    "You do not need to do anything to keep going. If you would like to change your plan or update your payment details first, you can do that from your account.",
  ]),
  tpl("renewal-reminder-2", "Renewal reminder, final", "Two days until your plan renews", [
    "Just a final note: your {{tenant.name}} plan renews in two days.",
    "If something has changed and you would like to adjust or cancel, now is the time. Reply if you would like a hand.",
  ]),
];

const RENEWAL_REMINDER = flow({
  name: "Renewal reminder",
  description:
    "Tells customers their plan or trial is about to renew or expire: a week before and again two days before. Starts when your app sends a renewal_upcoming event, about a week ahead.",
  trigger: { type: "event", config: { event: "renewal_upcoming" } },
  steps: [
    { delay: "0m", template: "renewal-reminder-1", action: "welcome" },
    { delay: "5d", template: "renewal-reminder-2", action: "nurture_value" },
  ],
  exits: [{ event: "renewed" }, { event: "subscription_cancelled" }],
  reentry: "cooldown",
  cooldownDays: 20,
});

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

export const LIBRARY_CATALOG: readonly LibraryCatalogEntry[] = [
  {
    id: "welcome-onboarding",
    tagline: "A three-email welcome for new signups.",
    when: "when someone signs up",
    needsEvent: "signed_up",
    span: "over 3 days",
    flow: LIBRARY_FLOW_WELCOME,
    templates: LIBRARY_TEMPLATES,
  },
  {
    id: "activation-nudge",
    tagline: "Gets stalled signups moving, then backs off.",
    when: "when someone signs up and has not activated",
    needsEvent: "signed_up",
    span: "over 7 days",
    flow: ACTIVATION_NUDGE,
    templates: ACTIVATION_TEMPLATES,
  },
  {
    id: "first-win",
    tagline: "Celebrates activation and checks in a week later.",
    when: "when someone activates",
    needsEvent: "activated",
    span: "over 7 days",
    flow: FIRST_WIN,
    templates: FIRST_WIN_TEMPLATES,
  },
  {
    id: "feature-discovery",
    tagline: "Shows activated users the next most useful thing.",
    when: "when someone moves from signed up to activated",
    needsEvent: null,
    span: "over 8 days",
    flow: FEATURE_DISCOVERY,
    templates: FEATURE_TEMPLATES,
  },
  {
    id: "at-risk-checkin",
    tagline: "Catches people drifting away, early and kindly.",
    when: "when an engaged person goes quiet",
    needsEvent: null,
    span: "over 4 days",
    flow: AT_RISK_CHECKIN,
    templates: AT_RISK_TEMPLATES,
  },
  {
    id: "win-back",
    tagline: "Two emails for people who have gone dormant.",
    when: "when someone goes dormant",
    needsEvent: null,
    span: "over 7 days",
    flow: WIN_BACK,
    templates: WIN_BACK_TEMPLATES,
  },
  {
    id: "upgrade-nudge",
    tagline: "Turns a reached limit into a conversation about upgrading.",
    when: "when someone hits a plan limit",
    needsEvent: "hit_plan_limit",
    span: "over 3 days",
    flow: UPGRADE_NUDGE,
    templates: UPGRADE_TEMPLATES,
  },
  {
    id: "abandoned-cart",
    tagline: "Brings back people who left items in their cart.",
    when: "when someone leaves a cart without buying",
    needsEvent: "cart_abandoned",
    span: "over 3 days",
    flow: ABANDONED_CART,
    templates: CART_TEMPLATES,
  },
  {
    id: "renewal-reminder",
    tagline: "Tells customers about an upcoming renewal or expiry.",
    when: "about a week before a plan renews or a trial ends",
    needsEvent: "renewal_upcoming",
    span: "over 5 days",
    flow: RENEWAL_REMINDER,
    templates: RENEWAL_TEMPLATES,
  },
  {
    id: "cancellation-feedback",
    tagline: "Learns why people leave and keeps the door open.",
    when: "when someone cancels",
    needsEvent: "subscription_cancelled",
    span: "over 7 days",
    flow: CANCEL_FEEDBACK,
    templates: CANCEL_TEMPLATES,
  },
];

/**
 * The ready-made flow that best fits what the customer said they wanted at signup, or null when
 * they gave no goal. Used to put one flow first in the gallery and mark it "Recommended for you".
 */
export function recommendedLibraryFlow(goal: string | null | undefined): string | null {
  switch (goal) {
    case "welcome":
    case "explore":
      return "welcome-onboarding";
    case "convert_trials":
      return "renewal-reminder";
    case "upgrade_free":
      return "upgrade-nudge";
    default:
      return null;
  }
}

/** A catalog entry by id, or undefined. */
export function libraryEntry(id: string): LibraryCatalogEntry | undefined {
  return LIBRARY_CATALOG.find((e) => e.id === id);
}
