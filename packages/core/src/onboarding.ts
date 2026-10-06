/**
 * Customer onboarding: the path from a new workspace to its first delivered email.
 *
 * Pure rules, no I/O. The API gathers the facts (packages/api/src/onboarding) and
 * this file turns them into the steps a customer sees, which one is next, and how
 * far along they are.
 *
 * The steps are the real preconditions of sending, in the order a person can do
 * them, not a tour of the product:
 *   address  - the postal address CAN-SPAM requires; the drain refuses to send without it
 *   sender   - somewhere for mail to go out from (own provider or Mailforge Sending)
 *   flow     - at least one active flow, or nothing is ever sent
 *   events   - a first event, which creates a contact and starts a flow
 *   email    - a first email actually sent: the moment the product has worked
 *
 * Mirror side: PUBLIC (packages/core is mirrored).
 */

export const ONBOARDING_STEP_IDS = ["workspace", "address", "sender", "flow", "events", "email"] as const;
export type OnboardingStepId = (typeof ONBOARDING_STEP_IDS)[number];

/** What the API observed about a workspace. Every field is a plain yes/no. */
export interface OnboardingFacts {
  /** A postal address is saved in the workspace settings. */
  hasPostalAddress: boolean;
  /** The workspace has its own active transport, or Mailforge Sending is switched on. */
  hasSender: boolean;
  /** At least one flow is active. */
  hasActiveFlow: boolean;
  /** At least one event has been received. */
  hasEvents: boolean;
  /** At least one lifecycle email has been sent. */
  hasSentEmail: boolean;
}

/** What is stored per workspace (tenants.settings.onboarding). All optional ISO timestamps. */
export interface OnboardingState {
  /** The customer chose "later"; the full panel steps aside for a slim banner. */
  dismissed_at?: string;
  /** First time every step was done. Set once, never cleared. */
  completed_at?: string;
  /** The welcome email went out (or was deliberately skipped). Set once. */
  welcome_sent_at?: string;
  /** Stall nudge emails sent so far (at most MAX_NUDGES). */
  nudge_count?: number;
  /** When the last nudge went out. */
  last_nudge_at?: string;
}

export interface OnboardingStep {
  id: OnboardingStepId;
  title: string;
  /** One sentence: what this is and why it matters, in the customer's terms. */
  description: string;
  done: boolean;
  /** Where in the dashboard the step is done. */
  href: string;
  /** Button text for the step when it is the next one. */
  cta: string;
  /** Rough minutes it takes, to make the path feel finite. */
  minutes: number;
}

export interface OnboardingProgress {
  steps: OnboardingStep[];
  done: number;
  total: number;
  /** 0-100, whole number. */
  percent: number;
  /** Every step done. */
  complete: boolean;
  /** The first step not done, or null when complete. */
  next: OnboardingStepId | null;
  /** Minutes left across the steps not done. */
  minutesLeft: number;
}

interface StepDef {
  id: OnboardingStepId;
  title: string;
  description: string;
  href: string;
  cta: string;
  minutes: number;
  done: (f: OnboardingFacts) => boolean;
}

const STEP_DEFS: readonly StepDef[] = [
  {
    id: "workspace",
    title: "Create your workspace",
    description: "Your free trial is running and nothing has been charged.",
    href: "/home",
    cta: "Done",
    minutes: 0,
    done: () => true,
  },
  {
    id: "address",
    title: "Add your business address",
    description: "Law requires a postal address in the footer of every marketing email. Mailforge will not send without one.",
    href: "/settings/postal",
    cta: "Add address",
    minutes: 1,
    done: (f) => f.hasPostalAddress,
  },
  {
    id: "sender",
    title: "Choose how email is sent",
    description: "Turn on Mailforge Sending with your own domain, or connect Resend, SES or SMTP.",
    href: "/settings/transport",
    cta: "Set up sending",
    minutes: 5,
    done: (f) => f.hasSender,
  },
  {
    id: "flow",
    title: "Turn on your first flow",
    description: "A flow decides who gets which email and when. The Welcome flow is ready to use and needs no AI setup.",
    href: "/home#welcome-flow",
    cta: "Choose a flow",
    minutes: 2,
    done: (f) => f.hasActiveFlow,
  },
  {
    id: "events",
    title: "Send your first event",
    description: "Your product tells Mailforge when someone signs up or does something. That is what starts a flow.",
    href: "/integrate",
    cta: "Connect your app",
    minutes: 10,
    done: (f) => f.hasEvents,
  },
  {
    id: "email",
    title: "Get your first email delivered",
    description: "When an event matches a flow, the email goes out. Check it landed and looks right.",
    href: "/sent",
    cta: "See sent email",
    minutes: 2,
    done: (f) => f.hasSentEmail,
  },
];

/** Turn the observed facts into the steps, the next one, and the progress. */
export function computeOnboarding(facts: OnboardingFacts): OnboardingProgress {
  const steps: OnboardingStep[] = STEP_DEFS.map((d) => ({
    id: d.id,
    title: d.title,
    description: d.description,
    done: d.done(facts),
    href: d.href,
    cta: d.cta,
    minutes: d.minutes,
  }));
  const done = steps.filter((s) => s.done).length;
  const total = steps.length;
  const next = steps.find((s) => !s.done)?.id ?? null;
  return {
    steps,
    done,
    total,
    percent: Math.round((done / total) * 100),
    complete: done === total,
    next,
    minutesLeft: steps.filter((s) => !s.done).reduce((n, s) => n + s.minutes, 0),
  };
}

/**
 * Whether the full onboarding panel should take over the home screen: the
 * customer is not finished and has not asked to do it later.
 */
export function showOnboardingPanel(progress: OnboardingProgress, state: OnboardingState): boolean {
  return !progress.complete && !state.dismissed_at;
}

/** The fields a customer may change through PATCH /v1/onboarding. */
export interface OnboardingPatch {
  dismissed?: boolean;
}

/** Parse a PATCH body. Returns null when it is not an object with a boolean `dismissed`. */
export function parseOnboardingPatch(body: unknown): OnboardingPatch | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  if (typeof b.dismissed !== "boolean") return null;
  return { dismissed: b.dismissed };
}

// ---------------------------------------------------------------------------
// Stall nudges
// ---------------------------------------------------------------------------

/** Most nudge emails one workspace ever gets. */
export const MAX_NUDGES = 2;
/** Hours after the welcome email before each nudge may go (index = nudges already sent). */
export const NUDGE_AFTER_WELCOME_HOURS: readonly number[] = [24, 72];
/** Hours that must pass between two nudges. */
export const NUDGE_MIN_GAP_HOURS = 24;

const HOUR_MS = 3_600_000;

/**
 * Whether a workspace that has not finished onboarding is due a nudge now.
 * Timing only: the caller has already decided the workspace is eligible
 * (not finished, not dismissed, not suspended, trial still running).
 */
export function nudgeDue(
  state: Pick<OnboardingState, "welcome_sent_at" | "nudge_count" | "last_nudge_at">,
  now: Date = new Date(),
): boolean {
  const sent = state.nudge_count ?? 0;
  if (sent >= MAX_NUDGES) return false;
  if (!state.welcome_sent_at) return false;
  const welcome = new Date(state.welcome_sent_at).getTime();
  if (Number.isNaN(welcome)) return false;
  if (now.getTime() - welcome < NUDGE_AFTER_WELCOME_HOURS[sent]! * HOUR_MS) return false;
  if (state.last_nudge_at) {
    const last = new Date(state.last_nudge_at).getTime();
    if (!Number.isNaN(last) && now.getTime() - last < NUDGE_MIN_GAP_HOURS * HOUR_MS) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Why mail is waiting
// ---------------------------------------------------------------------------

/** Why approved email is sitting unsent. null = nothing is wrong with how it is set up. */
export type WaitingReason = "no_sender" | "needs_domain" | "paused" | "no_address";

export interface WaitingInput {
  hasOwnTransport: boolean;
  /** Mailforge Sending is switched on for the workspace. */
  managedEnabled: boolean;
  /** Mailforge Sending has somewhere to send from: a verified domain, or the operator's shared address. */
  managedUsable: boolean;
  /** Mailforge Sending is paused for the workspace. */
  managedPaused: boolean;
  hasPostalAddress: boolean;
}

/**
 * The reason approved email would not be going out, in priority order: nowhere to send from,
 * sending paused, then the missing postal address (the drain refuses to send without one).
 */
export function waitingReason(i: WaitingInput): WaitingReason | null {
  if (!i.hasOwnTransport) {
    if (!i.managedEnabled) return "no_sender";
    if (!i.managedUsable) return "needs_domain";
    if (i.managedPaused) return "paused";
  }
  return i.hasPostalAddress ? null : "no_address";
}

// ---------------------------------------------------------------------------
// Signup goal
// ---------------------------------------------------------------------------

/** What a new customer says they want to do first. Asked once at signup, optional. */
export const ONBOARDING_GOALS = ["welcome", "convert_trials", "upgrade_free", "explore"] as const;
export type OnboardingGoal = (typeof ONBOARDING_GOALS)[number];

export interface GoalInfo {
  /** Shown on the signup form. */
  label: string;
  /** One line under the label. */
  hint: string;
  /**
   * The business-model template that fits the goal, or null when the Welcome flow is the whole answer.
   * The Welcome flow is always the first thing everyone turns on, because it needs no AI setup.
   */
  template: "time_limited_trial" | "freemium" | null;
}

export const GOAL_INFO: Record<OnboardingGoal, GoalInfo> = {
  welcome: {
    label: "Welcome new signups",
    hint: "A short series for people who just signed up to your product.",
    template: null,
  },
  convert_trials: {
    label: "Turn trial users into paying customers",
    hint: "Your product has a free trial that ends.",
    template: "time_limited_trial",
  },
  upgrade_free: {
    label: "Move free users to a paid plan",
    hint: "Your product has a free plan people can stay on.",
    template: "freemium",
  },
  explore: {
    label: "Not sure yet, show me around",
    hint: "Start with the welcome flow and look around.",
    template: null,
  },
};

/** A goal from a form or JSON body, or null when absent or not one of ours. */
export function parseGoal(v: unknown): OnboardingGoal | null {
  return typeof v === "string" && (ONBOARDING_GOALS as readonly string[]).includes(v) ? (v as OnboardingGoal) : null;
}
