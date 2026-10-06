/**
 * Entitlements: what a tenant is allowed to do right now, and the rules for
 * checking usage against it. Pure functions, no I/O: callers fetch the tenant
 * plan row and the usage counts, then ask here.
 *
 * Enforcement is OFF unless MAILFORGE_ENFORCE_PLANS=true. With it off every
 * tenant is unlimited and nothing is gated, so self-hosted installs behave as
 * they always did. Turn it on only for a hosted service that sells plans.
 *
 * What happens at a limit (the policy, in one place):
 *   - contacts:  new contacts are refused; existing contacts and their events
 *                keep working, so a product never loses data it already has.
 *   - emails:    sending pauses for the rest of the calendar month (UTC); queued
 *                messages wait and go out when the month rolls over or the plan
 *                is upgraded. Nothing is dropped.
 *   - seats:     new invitations are refused; current members keep access.
 *   - when a trial ends the tenant becomes Free. Data is kept; the Free limits
 *                then apply to anything new.
 *
 * Mirror side: PUBLIC (packages/core is mirrored).
 */
import { PLANS, effectivePlan, paymentStatus, trialDaysLeft, type PaymentStatus, type PlanId, type PlanLimits } from "./plans.js";
import type { PoweredBy } from "./email-shell.js";

export type LimitKind = "contacts" | "emails" | "seats" | "ai";

/** True when plan limits are enforced for this process. */
export function plansEnforced(env: Record<string, string | undefined> = process.env): boolean {
  return env.MAILFORGE_ENFORCE_PLANS === "true";
}

export interface Entitlements {
  /** Whether limits are enforced at all. When false every limit is null (unlimited). */
  enforced: boolean;
  /** The plan the tenant is entitled to right now (a running trial counts as the trial plan). */
  plan: PlanId;
  /** The value stored on the tenant: "trial" or a plan id. */
  storedPlan: string;
  onTrial: boolean;
  trialEndsAt: Date | null;
  /** Whole days left in a running trial; 0 when not on a trial or it has ended. */
  trialDaysLeft: number;
  /** A signup trial that has run out (tenant is now on Free). */
  trialExpired: boolean;
  /** The date a paid plan is paid through; null for Free, trials and plans granted by hand. */
  paidThrough: Date | null;
  /** current | overdue (inside the grace period, still works) | lapsed (now on Free) | none. */
  paymentStatus: PaymentStatus;
  limits: PlanLimits;
  /** Emails and public pages carry a small "Powered by" link. */
  showsPoweredBy: boolean;
}

const UNLIMITED: PlanLimits = { contacts: null, emailsPerMonth: null, seats: null, aiTokensPerMonth: null };

/** The plan's limits with a workspace's own AI allowance laid over them, if an admin set one. */
function applyAiOverride(limits: PlanLimits, override: number | null | undefined): PlanLimits {
  if (override === null || override === undefined) return limits;
  return { ...limits, aiTokensPerMonth: override < 0 ? null : override };
}

export function entitlementsFor(input: {
  plan: string | null | undefined;
  trialEndsAt: Date | null | undefined;
  /** When a paid plan runs out of paid time. Omit for plans granted by hand. */
  paidThrough?: Date | null | undefined;
  /**
   * A platform admin's own Mailforge AI token allowance for this workspace.
   * null/omitted = the plan's; negative = no cap; 0 or more = exactly that many.
   */
  aiTokensOverride?: number | null | undefined;
  now?: Date;
  enforced?: boolean;
}): Entitlements {
  const now = input.now ?? new Date();
  const enforced = input.enforced ?? plansEnforced();
  const trialEndsAt = input.trialEndsAt ?? null;
  const paidThrough = input.paidThrough ?? null;
  const plan = effectivePlan(input.plan, trialEndsAt, now, paidThrough);
  const storedPlan = input.plan ?? "free";
  const onTrial = storedPlan === "trial" && plan !== "free";
  const trialExpired = storedPlan === "trial" && !onTrial;
  return {
    enforced,
    plan,
    storedPlan,
    onTrial,
    trialEndsAt,
    trialDaysLeft: onTrial ? trialDaysLeft(trialEndsAt, now) : 0,
    trialExpired,
    paidThrough,
    paymentStatus: paymentStatus(input.plan, paidThrough, now),
    limits: enforced ? applyAiOverride(PLANS[plan].limits, input.aiTokensOverride) : UNLIMITED,
    showsPoweredBy: enforced && Boolean(PLANS[plan].showsPoweredBy),
  };
}

/** The limit for one kind of usage; null means unlimited. */
export function limitFor(ent: Pick<Entitlements, "limits">, kind: LimitKind): number | null {
  if (kind === "contacts") return ent.limits.contacts;
  if (kind === "emails") return ent.limits.emailsPerMonth;
  if (kind === "ai") return ent.limits.aiTokensPerMonth;
  return ent.limits.seats;
}

/** Would using `adding` more on top of `used` go past `limit`? null limit never does. */
export function wouldExceed(limit: number | null, used: number, adding = 1): boolean {
  return limit !== null && used + adding > limit;
}

/** How much of a limit is used, as 0..1+ (can exceed 1 when over). null for unlimited. */
export function usageFraction(limit: number | null, used: number): number | null {
  if (limit === null) return null;
  if (limit === 0) return used > 0 ? Infinity : 0;
  return used / limit;
}

/** First instant of the calendar month containing `now`, in UTC. */
export function startOfMonthUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** First instant of the next calendar month, in UTC: when a monthly allowance resets. */
export function startOfNextMonthUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

/** Singular and plural wording for each kind, so "1 team member" never reads "1 team members". */
const KIND_NOUN: Record<LimitKind, { one: string; many: string }> = {
  contacts: { one: "contact", many: "contacts" },
  emails: { one: "email this month", many: "emails this month" },
  seats: { one: "team member", many: "team members" },
  ai: { one: "Mailforge AI token this month", many: "Mailforge AI tokens this month" },
};

/** Human-readable explanation, safe to show to the customer. */
export function planLimitMessage(kind: LimitKind, limit: number, planName: string): string {
  const noun = limit === 1 ? KIND_NOUN[kind].one : KIND_NOUN[kind].many;
  if (kind === "ai") {
    return `Your ${planName} plan includes ${limit.toLocaleString("en-US")} ${noun}, and they are used up. Upgrade your plan or add your own AI key in Settings.`;
  }
  return `Your ${planName} plan allows up to ${limit.toLocaleString("en-US")} ${noun}. Upgrade your plan to add more.`;
}

/** Thrown when an action would take a tenant past a plan limit. */
export class PlanLimitError extends Error {
  readonly code = "plan_limit" as const;
  constructor(
    readonly kind: LimitKind,
    readonly limit: number,
    readonly used: number,
    readonly plan: PlanId,
  ) {
    super(planLimitMessage(kind, limit, PLANS[plan].name));
    this.name = "PlanLimitError";
  }

  /** Body for an HTTP 402 response. */
  toJSON(): { error: string; code: "plan_limit"; limit_kind: LimitKind; limit: number; used: number; plan: PlanId } {
    return { error: this.message, code: this.code, limit_kind: this.kind, limit: this.limit, used: this.used, plan: this.plan };
  }
}

/**
 * Throw PlanLimitError if adding `adding` would pass the limit for `kind`.
 * A no-op when enforcement is off or the plan has no limit for that kind.
 */
export function assertWithinLimit(ent: Entitlements, kind: LimitKind, used: number, adding = 1): void {
  const limit = limitFor(ent, kind);
  if (limit !== null && wouldExceed(limit, used, adding)) {
    throw new PlanLimitError(kind, limit, used, ent.plan);
  }
}

/**
 * The "Sent with Mailforge" credit for plans that carry it, or undefined for
 * plans that do not. Needs a public site URL (MAILFORGE_SITE_URL, else
 * BASE_URL); without one there is nothing to link to, so no credit is added.
 * Shared by the email drain and the public unsubscribe pages.
 */
export function poweredByFor(
  ent: Pick<Entitlements, "showsPoweredBy">,
  env: Record<string, string | undefined> = process.env,
): PoweredBy | undefined {
  if (!ent.showsPoweredBy) return undefined;
  const url = (env.MAILFORGE_SITE_URL || env.BASE_URL || "").trim();
  return /^https?:\/\//i.test(url) ? { name: "Mailforge", url } : undefined;
}
