/**
 * Plans: the single source of truth for what each Loomail plan includes.
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

export const PLAN_IDS = ["free", "essential"] as const;
export type PlanId = (typeof PLAN_IDS)[number];

/** Value stored in tenants.plan while a signup trial is running. */
export const TRIAL_PLAN_VALUE = "trial" as const;

/** The paid plan a trial behaves like. */
export const TRIAL_PLAN: PlanId = "essential";

/** Length of the signup trial. No card is taken to start it. */
export const TRIAL_DAYS = 7;

/**
 * The longest a trial can run from signup. The 7 days restart once, when the first real event
 * arrives (setup takes real time: DNS, wiring the app), but never past this many days in total.
 */
export const TRIAL_MAX_DAYS = 14;

export interface PlanLimits {
  /** Contacts a workspace may hold. null = unlimited. */
  contacts: number | null;
  /** Emails a workspace may send per calendar month. null = unlimited. */
  emailsPerMonth: number | null;
  /** Team members (users) per workspace. null = unlimited. */
  seats: number | null;
  /**
   * Tokens per calendar month a workspace may spend on the platform's own AI
   * provider (Loomail AI). Tokens on a customer's own key are never counted
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
  /** Free plan shows a small "Powered by Loomail" link in emails and pages. */
  showsPoweredBy?: boolean;
}

/** A year for the price of 10 months. This exact amount is what gets billed. */
function annualTotal(monthly: number): number {
  return Math.round(monthly * 10 * 100) / 100;
}

/** Per-month equivalent of an annual total, rounded for display. */
function annualMonthly(monthly: number): number {
  return Math.round((annualTotal(monthly) / 12) * 100) / 100;
}

export const PLANS: Readonly<Record<PlanId, PlanDef>> = {
  // Internal only: where a workspace lands when its trial ends without a subscription.
  // It is never offered for sale and allows no contacts, sends or AI use.
  free: {
    id: "free",
    name: "No plan",
    tagline: "Subscribe to Essential to keep using Loomail.",
    priceMonthlyUsd: 0,
    priceAnnualUsd: 0,
    priceAnnualMonthlyUsd: 0,
    limits: { contacts: 0, emailsPerMonth: 0, seats: 1, aiTokensPerMonth: 0 },
    showsPoweredBy: true,
    features: [],
  },
  essential: {
    id: "essential",
    name: "Essential",
    tagline: "Everything in Loomail, for one simple price.",
    priceMonthlyUsd: 100,
    priceAnnualUsd: annualTotal(100),
    priceAnnualMonthlyUsd: annualMonthly(100),
    limits: { contacts: 6_000, emailsPerMonth: 1_000_000, seats: null, aiTokensPerMonth: 8_000_000 },
    recommended: true,
    features: [
      "6,000 customer profiles",
      "1,000,000 emails per month",
      "Email and transactional messages",
      "AI flow builder",
      "Unlimited team members",
      "Priority support",
    ],
  },
};

// ---------------------------------------------------------------------------
// Extra usage (prepaid top-ups)
// ---------------------------------------------------------------------------

export const ADDON_KINDS = ["profiles", "emails", "ai"] as const;
export type AddonKind = (typeof ADDON_KINDS)[number];

export interface AddonDef {
  kind: AddonKind;
  /** Customer-facing name of the thing being added. */
  label: string;
  /** The rate as the customer reads it, e.g. "$0.009 per profile". */
  rateLabel: string;
  /** Units in one pack: the smallest amount that can be bought, and the step for more. */
  packUnits: number;
  /** What one pack costs, in USD cents. Exactly the per-unit rate times packUnits. */
  packPriceCents: number;
  /** Which plan limit the units are added to. */
  limit: "contacts" | "emailsPerMonth" | "aiTokensPerMonth";
}

/**
 * Prepaid top-ups for a month's usage above the plan. Rates:
 *   extra profiles  $0.009 each        -> 1,000 profiles = $9
 *   extra emails    $0.12 per 1,000    -> 100,000 emails = $12
 *   extra AI        $10 per 100,000 credits
 * A top-up raises the limit for the calendar month (UTC) it is bought in.
 */
export const ADDONS: Readonly<Record<AddonKind, AddonDef>> = {
  profiles: {
    kind: "profiles",
    label: "Extra customer profiles",
    rateLabel: "$0.009 per profile",
    packUnits: 1_000,
    packPriceCents: 900,
    limit: "contacts",
  },
  emails: {
    kind: "emails",
    label: "Additional emails",
    rateLabel: "$0.12 per 1,000 emails",
    packUnits: 100_000,
    packPriceCents: 1_200,
    limit: "emailsPerMonth",
  },
  ai: {
    kind: "ai",
    label: "Extra AI credits",
    rateLabel: "$10 per 100,000 credits",
    packUnits: 100_000,
    packPriceCents: 1_000,
    limit: "aiTokensPerMonth",
  },
};

/** Most packs of one kind in a single purchase: a typo guard, not a business limit. */
export const MAX_ADDON_PACKS = 100;

export function isAddonKind(value: unknown): value is AddonKind {
  return typeof value === "string" && (ADDON_KINDS as readonly string[]).includes(value);
}

export function isValidPackCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_ADDON_PACKS;
}

/** USD price of `packs` packs, as exact dollars (never a float sum of cents). */
export function addonPriceUsd(kind: AddonKind, packs: number): number {
  return (ADDONS[kind].packPriceCents * packs) / 100;
}

/** Units gained by buying `packs` packs. */
export function addonUnits(kind: AddonKind, packs: number): number {
  return ADDONS[kind].packUnits * packs;
}

/** The value stored in billing_checkouts.plan for a top-up purchase. */
export function addonCheckoutPlan(kind: AddonKind): string {
  return `addon:${kind}`;
}

/** The kind of a billing_checkouts.plan value, or null when it is not a top-up. */
export function parseAddonCheckoutPlan(plan: string | null | undefined): AddonKind | null {
  if (!plan || !plan.startsWith("addon:")) return null;
  const kind = plan.slice("addon:".length);
  return isAddonKind(kind) ? kind : null;
}

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
 * retry or a slow webhook should not cut a customer off at midnight; Paystack
 * itself retries a failed charge three times, 30 minutes apart.
 */
export const BILLING_GRACE_DAYS = 3;

/** The exact amount in USD charged for one billing period of a paid plan. */
export function planPriceUsd(plan: PaidPlanId, interval: BillingInterval): number {
  return interval === "yearly" ? PLANS[plan].priceAnnualUsd : PLANS[plan].priceMonthlyUsd;
}

/**
 * The amount to charge, in the charge currency's minor unit, for a USD list price.
 *
 * In USD it is exact (cents). In any other currency the price is converted at the operator's
 * fixed rate (units of that currency per 1 USD) and rounded UP to a whole unit, so a customer
 * is never charged a fraction of a cedi/naira and the operator is never short by rounding.
 * The 1e-6 allowance keeps floating point noise (100 x 1.1 = 110.00000000000001) from tipping
 * an exact figure up by a whole unit.
 */
export function chargeAmountMinor(usd: number, currency: string, usdRate: number): number {
  if (currency.toUpperCase() === "USD") return Math.round(usd * 100);
  return Math.ceil(usd * usdRate - 1e-6) * 100;
}

/** Highest conversion rate accepted: a typo guard (no real currency is worth less than 1/100000 USD). */
export const MAX_USD_RATE = 100_000;

/**
 * Reads an exchange rate (units of local currency per 1 USD) from configuration text.
 * Returns null unless it is a plain positive decimal number within sane bounds, so values such
 * as "", "abc", "0", "-5", "1e3", "0x10" and "15,5" are all refused rather than guessed at.
 */
export function parseUsdRate(text: string | undefined | null): number | null {
  const t = (text ?? "").trim();
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) && n > 0 && n <= MAX_USD_RATE ? n : null;
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

/**
 * Where a trial ends once the workspace's first real event has arrived: a fresh TRIAL_DAYS from
 * now, never earlier than it already ended, and never later than TRIAL_MAX_DAYS after signup.
 */
export function rebasedTrialEnd(createdAt: Date, currentEnd: Date, now: Date = new Date()): Date {
  const fresh = Math.max(currentEnd.getTime(), now.getTime() + TRIAL_DAYS * 86_400_000);
  const cap = createdAt.getTime() + TRIAL_MAX_DAYS * 86_400_000;
  return new Date(Math.min(fresh, cap));
}
