/**
 * Plans: the single source of truth for what each Mailforge plan includes.
 *
 * Read by the public pricing page today, and by plan enforcement and billing
 * later, so the numbers a customer sees are the numbers the product enforces.
 * Change prices and limits here and nowhere else.
 *
 * Tenant plan lifecycle:
 *   - Self-hosted installs never have a trial; their tenant stays on "free"
 *     and none of the SaaS limits apply unless billing is switched on.
 *   - A tenant created through public signup starts on "trial": it behaves as
 *     TRIAL_PLAN until trial_ends_at, then drops to "free" unless it has
 *     subscribed to a paid plan.
 *
 * Mirror side: PUBLIC (packages/core is mirrored).
 */

export const PLAN_IDS = ["free", "starter", "growth", "scale"] as const;
export type PlanId = (typeof PLAN_IDS)[number];

/** Value stored in tenants.plan while a signup trial is running. */
export const TRIAL_PLAN_VALUE = "trial" as const;

/** The paid plan a trial behaves like. */
export const TRIAL_PLAN: PlanId = "growth";

/** Length of the signup trial. No card is taken to start it. */
export const TRIAL_DAYS = 14;

export interface PlanLimits {
  /** Contacts a workspace may hold. null = unlimited. */
  contacts: number | null;
  /** Emails a workspace may send per calendar month. null = unlimited. */
  emailsPerMonth: number | null;
  /** Team members (users) per workspace. null = unlimited. */
  seats: number | null;
  /**
   * Tokens per calendar month a workspace may spend on the platform's own AI
   * provider (Mailforge AI). Tokens on a customer's own key are never counted
   * against this. null = unlimited.
   */
  aiTokensPerMonth: number | null;
}

export interface PlanDef {
  id: PlanId;
  name: string;
  /** One-line pitch shown on the pricing card. */
  tagline: string;
  /** Monthly price in USD when billed monthly. */
  priceMonthlyUsd: number;
  /** What a year costs in USD when billed annually: 10 months' price (2 months free). Billing charges this. */
  priceAnnualUsd: number;
  /** Per-month equivalent of priceAnnualUsd, rounded, for display only. Never bill from this. */
  priceAnnualMonthlyUsd: number;
  limits: PlanLimits;
  /** Bullet list for the pricing card, most important first. */
  features: string[];
  /** Highlighted as the recommended plan on the pricing page. */
  recommended?: boolean;
  /** Free plan shows a small "Powered by Mailforge" link in emails and pages. */
  showsPoweredBy?: boolean;
}

/** A year for the price of 10 months. This exact amount is what gets billed. */
function annualTotal(monthly: number): number {
  return monthly * 10;
}

/** Per-month equivalent of an annual total, rounded for display. */
function annualMonthly(monthly: number): number {
  return Math.round(annualTotal(monthly) / 12);
}

export const PLANS: Readonly<Record<PlanId, PlanDef>> = {
  free: {
    id: "free",
    name: "Free",
    tagline: "For trying Mailforge on a side project.",
    priceMonthlyUsd: 0,
    priceAnnualUsd: 0,
    priceAnnualMonthlyUsd: 0,
    limits: { contacts: 500, emailsPerMonth: 5_000, seats: 1, aiTokensPerMonth: 20_000 },
    showsPoweredBy: true,
    features: [
      "500 contacts",
      "5,000 emails per month",
      "Unlimited flows",
      "20,000 Mailforge AI tokens per month",
      "Lifecycle states and retention grid",
      "1 team member",
      "Community support",
    ],
  },
  starter: {
    id: "starter",
    name: "Starter",
    tagline: "For early-stage products finding their first users.",
    priceMonthlyUsd: 19,
    priceAnnualUsd: annualTotal(19),
    priceAnnualMonthlyUsd: annualMonthly(19),
    limits: { contacts: 2_500, emailsPerMonth: 25_000, seats: 3, aiTokensPerMonth: 300_000 },
    features: [
      "2,500 contacts",
      "25,000 emails per month",
      "Unlimited flows",
      "Plain-language flow builder",
      "300,000 Mailforge AI tokens per month",
      "3 team members",
      "Email support",
    ],
  },
  growth: {
    id: "growth",
    name: "Growth",
    tagline: "For growing products that live on retention.",
    priceMonthlyUsd: 49,
    priceAnnualUsd: annualTotal(49),
    priceAnnualMonthlyUsd: annualMonthly(49),
    limits: { contacts: 10_000, emailsPerMonth: 100_000, seats: 10, aiTokensPerMonth: 1_500_000 },
    recommended: true,
    features: [
      "10,000 contacts",
      "100,000 emails per month",
      "Unlimited flows",
      "Plain-language flow builder",
      "1,500,000 Mailforge AI tokens per month",
      "10 team members",
      "No Mailforge branding",
      "Priority email support",
    ],
  },
  scale: {
    id: "scale",
    name: "Scale",
    tagline: "For established products with large audiences.",
    priceMonthlyUsd: 129,
    priceAnnualUsd: annualTotal(129),
    priceAnnualMonthlyUsd: annualMonthly(129),
    limits: { contacts: 50_000, emailsPerMonth: 500_000, seats: null, aiTokensPerMonth: 8_000_000 },
    features: [
      "50,000 contacts",
      "500,000 emails per month",
      "Unlimited flows",
      "Plain-language flow builder",
      "8,000,000 Mailforge AI tokens per month",
      "Unlimited team members",
      "No Mailforge branding",
      "Priority support with a named contact",
    ],
  },
};

export function isPlanId(value: unknown): value is PlanId {
  return typeof value === "string" && (PLAN_IDS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Billing
// ---------------------------------------------------------------------------

export type BillingInterval = "monthly" | "yearly";

export const BILLING_INTERVALS: readonly BillingInterval[] = ["monthly", "yearly"];

/** A plan that costs money (everything but Free). */
export type PaidPlanId = Exclude<PlanId, "free">;

export function isPaidPlanId(value: unknown): value is PaidPlanId {
  return isPlanId(value) && value !== "free";
}

export function isBillingInterval(value: unknown): value is BillingInterval {
  return value === "monthly" || value === "yearly";
}

/**
 * Days after the paid-through date during which a paid plan still works. A card
 * retry or a slow webhook should not cut a customer off at midnight; Flutterwave
 * itself retries a failed charge three times, 30 minutes apart.
 */
export const BILLING_GRACE_DAYS = 3;

/** The exact amount in USD charged for one billing period of a paid plan. */
export function planPriceUsd(plan: PaidPlanId, interval: BillingInterval): number {
  return interval === "yearly" ? PLANS[plan].priceAnnualUsd : PLANS[plan].priceMonthlyUsd;
}

function daysInUtcMonth(year: number, month0: number): number {
  return new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
}

/**
 * The end of a billing period that starts at `from`: one calendar month or one
 * calendar year later, same time of day (UTC). A start on a day the target month
 * does not have clamps to that month's last day, so 31 January plus a month is
 * 28 February (29 in a leap year), not 3 March.
 */
export function addBillingPeriod(from: Date, interval: BillingInterval): Date {
  const y = from.getUTCFullYear();
  const m = from.getUTCMonth();
  const targetMonth = interval === "yearly" ? m : m + 1;
  const targetYear = interval === "yearly" ? y + 1 : y + Math.floor(targetMonth / 12);
  const month0 = ((targetMonth % 12) + 12) % 12;
  const day = Math.min(from.getUTCDate(), daysInUtcMonth(targetYear, month0));
  return new Date(
    Date.UTC(
      targetYear,
      month0,
      day,
      from.getUTCHours(),
      from.getUTCMinutes(),
      from.getUTCSeconds(),
      from.getUTCMilliseconds(),
    ),
  );
}

/**
 * Where a paid plan stands against the date it is paid through:
 *   none     no paid-through date: free, a trial, or a plan granted by hand
 *   current  paid through a date still in the future
 *   overdue  the date has passed but we are inside the grace period (still works)
 *   lapsed   past the grace period: the workspace is on Free
 */
export type PaymentStatus = "none" | "current" | "overdue" | "lapsed";

export function paymentStatus(
  plan: string | null | undefined,
  paidThrough: Date | null | undefined,
  now: Date = new Date(),
): PaymentStatus {
  if (!isPaidPlanId(plan) || !paidThrough) return "none";
  if (paidThrough.getTime() > now.getTime()) return "current";
  const graceEnd = paidThrough.getTime() + BILLING_GRACE_DAYS * 86_400_000;
  return graceEnd > now.getTime() ? "overdue" : "lapsed";
}

/**
 * The plan a tenant is actually entitled to right now.
 *
 *   plan "trial", trial still running         -> TRIAL_PLAN
 *   plan "trial", trial over                  -> "free"
 *   a paid plan, paid through a future date   -> that plan
 *   a paid plan, within the grace period      -> that plan
 *   a paid plan, past the grace period        -> "free"
 *   a paid plan with no paid-through date     -> that plan (granted by hand)
 *   "free", null or unknown                   -> "free"
 */
export function effectivePlan(
  plan: string | null | undefined,
  trialEndsAt: Date | null | undefined,
  now: Date = new Date(),
  paidThrough: Date | null | undefined = null,
): PlanId {
  if (plan === TRIAL_PLAN_VALUE) {
    return trialEndsAt && trialEndsAt.getTime() > now.getTime() ? TRIAL_PLAN : "free";
  }
  if (!isPlanId(plan)) return "free";
  return paymentStatus(plan, paidThrough, now) === "lapsed" ? "free" : plan;
}

/** Whole days left in a trial (rounded up), 0 once it has ended. */
export function trialDaysLeft(trialEndsAt: Date | null | undefined, now: Date = new Date()): number {
  if (!trialEndsAt) return 0;
  const ms = trialEndsAt.getTime() - now.getTime();
  return ms > 0 ? Math.ceil(ms / 86_400_000) : 0;
}

/** When a trial that starts at `start` ends. */
export function trialEndDate(start: Date = new Date()): Date {
  return new Date(start.getTime() + TRIAL_DAYS * 86_400_000);
}
