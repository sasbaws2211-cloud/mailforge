/**
 * Plan hooks and the pure rules the plan UI uses to decide what to say.
 *
 * Mirror side: PUBLIC (apps/dashboard is mirrored).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  cancelBillingSubscription,
  fetchCheckoutStatus,
  fetchPlan,
  startBillingCheckout,
  type BillingInterval,
  type PlanInfo,
  type PlanMeterState,
} from "./api.js";
import { loadPaystackInline, pollCheckoutUntilDone, type PaystackPopConstructor } from "./paystack-popup.js";

export const PLAN_QUERY_KEY = ["plan"] as const;

/**
 * GET /v1/plan, refreshed every five minutes so usage and trial days stay current.
 * Pass a faster `pollMs` while waiting for a payment to be confirmed.
 */
export function usePlan(opts: { pollMs?: number } = {}) {
  return useQuery({
    queryKey: PLAN_QUERY_KEY,
    queryFn: fetchPlan,
    staleTime: 60_000,
    refetchInterval: opts.pollMs ?? 5 * 60_000,
  });
}

/**
 * Where an in-page payment stands.
 *   starting  asking the server to set the payment up
 *   popup     Paystack's popup is open (or was just closed) and we are watching for the result
 *   paid | failed  the server confirmed it with Paystack
 *   closed    the customer closed the popup without paying
 *   timeout   no answer for a long while; the webhook or a refresh will still catch up
 */
export type CheckoutPhase = "idle" | "starting" | "popup" | "paid" | "failed" | "closed" | "timeout";

/** After the popup is closed, keep looking this long in case the payment went through just before. */
export const CLOSE_GRACE_MS = 8_000;

/** What to tell the customer for each phase of an in-page payment (null while there is nothing to say). */
export function checkoutPhaseNotice(phase: CheckoutPhase): { tone: "success" | "warning" | "info"; message: string } | null {
  switch (phase) {
    case "popup":
      return { tone: "info", message: "Complete the payment in the Paystack window. This page updates by itself as soon as it goes through." };
    case "paid":
      return billingReturnNotice("success");
    case "failed":
      return billingReturnNotice("failed");
    case "closed":
      return billingReturnNotice("cancelled");
    case "timeout":
      return billingReturnNotice("pending");
    default:
      return null;
  }
}

/**
 * Pay inside the page: ask the server to set the payment up, open Paystack's popup, and poll the
 * server until it says the payment is done, then refresh the plan so the UI changes by itself.
 * If the popup script cannot be loaded the browser is sent to the hosted checkout page instead
 * (the old redirect flow, which the server still supports).
 */
export function useCheckoutFlow() {
  const qc = useQueryClient();
  const [phase, setPhase] = useState<CheckoutPhase>("idle");
  const stopped = useRef(false);
  useEffect(() => {
    stopped.current = false;
    return () => {
      stopped.current = true;
    };
  }, []);

  const start = useCallback(
    async ({ plan, interval }: { plan: string; interval: BillingInterval }): Promise<void> => {
      setPhase("starting");
      let started;
      try {
        started = await startBillingCheckout(plan, interval);
      } catch (err) {
        setPhase("idle");
        throw err;
      }

      let Pop: PaystackPopConstructor | null = null;
      if (started.access_code) {
        try {
          Pop = await loadPaystackInline();
        } catch {
          Pop = null;
        }
      }
      if (!Pop || !started.access_code) {
        window.location.assign(started.url);
        return;
      }

      setPhase("popup");
      let closedAt: number | null = null;
      try {
        new Pop().resumeTransaction(started.access_code, {
          onCancel: () => {
            closedAt = Date.now();
          },
          onError: () => {
            closedAt = Date.now();
          },
          // onSuccess is deliberately not trusted: the poll below asks the server, which asks Paystack.
        });
      } catch {
        window.location.assign(started.url);
        return;
      }

      const outcome = await pollCheckoutUntilDone(() => fetchCheckoutStatus(started.reference), {
        shouldStop: () => stopped.current || (closedAt !== null && Date.now() - closedAt > CLOSE_GRACE_MS),
      });
      if (stopped.current) return;
      if (outcome === "paid") {
        await qc.invalidateQueries({ queryKey: PLAN_QUERY_KEY });
        setPhase("paid");
      } else if (outcome === "failed") {
        setPhase("failed");
      } else if (outcome === "timeout") {
        setPhase("timeout");
      } else {
        setPhase("closed"); // cancelled, or the popup was closed and nothing arrived
      }
    },
    [qc],
  );

  const reset = useCallback(() => setPhase("idle"), []);
  return { phase, start, reset, busy: phase === "starting" || phase === "popup" };
}

/** Cancel the subscription (plan works until the paid period ends), then refresh the plan. */
export function useCancelSubscription() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: cancelBillingSubscription,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: PLAN_QUERY_KEY });
    },
  });
}

/** The name of the plan stored on the workspace (a lapsed Growth subscription is still "Growth"). */
export function storedPlanName(plan: PlanInfo): string {
  return plan.plans.find((p) => p.id === plan.stored_plan)?.name ?? plan.plan.name;
}

/** "Nov 4, 2026" for an ISO timestamp. */
export function formatDay(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
}

/** Whole days from `now` until `iso`, rounded up, never below 0. */
export function daysUntil(iso: string, now: Date = new Date()): number {
  return Math.max(0, Math.ceil((new Date(iso).getTime() - now.getTime()) / 86_400_000));
}

/**
 * An amount in a currency, whole units, with the local symbol where there is one ("GH₵760",
 * "$49"). Falls back to "760 XYZ" for a code the browser does not know, so a typo in the
 * currency setting never throws on the plan page.
 */
export function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency, currencyDisplay: "narrowSymbol", maximumFractionDigits: 0 }).format(amount);
  } catch {
    return `${amount.toLocaleString("en-US")} ${currency}`;
  }
}

/** What the customer is told when Paystack sends them back to the dashboard. */
export type BillingReturn = "success" | "failed" | "cancelled" | "pending" | "unknown";

export function billingReturnNotice(state: string | null): { tone: "success" | "warning" | "info"; message: string } | null {
  switch (state) {
    case "success":
      return { tone: "success", message: "Payment confirmed. Your plan is active." };
    case "pending":
      return { tone: "info", message: "We are confirming your payment. This page updates on its own, usually within a minute." };
    case "failed":
      return { tone: "warning", message: "The payment did not go through, and you have not been charged. You can try again with the same or another card." };
    case "cancelled":
      return { tone: "info", message: "Checkout was cancelled. Nothing was charged." };
    case "unknown":
      return { tone: "warning", message: "We could not match that payment to your account. If you were charged, contact support." };
    default:
      return null;
  }
}

export type MeterKind = "contacts" | "emails" | "seats";

export const METER_LABEL: Record<MeterKind, string> = {
  contacts: "Contacts",
  emails: "Emails this month",
  seats: "Team members",
};

/** Fraction of a limit used, capped at 1 for drawing a bar. 0 when there is no limit. */
export function barFraction(used: number, limit: number | null): number {
  if (limit === null || limit <= 0) return 0;
  return Math.min(1, Math.max(0, used / limit));
}

export interface PlanNotice {
  /** What drives the banner, so a dismissed one can stay dismissed per kind. */
  id: string;
  tone: "danger" | "warning" | "info";
  message: string;
  /** False for messages the customer must not be able to hide (limits reached, trial over). */
  dismissible: boolean;
}

const STATE_RANK: Record<PlanMeterState, number> = { unlimited: 0, ok: 0, near: 1, at_limit: 2, over: 3 };

/**
 * How far a meter must go before it deserves attention. Contacts and emails
 * need it when they reach the limit, because something has stopped. Seats only
 * when they are exceeded: a Free workspace has one seat and its owner fills it,
 * so a full seat meter is normal, not a problem.
 */
function attentionRank(kind: MeterKind): number {
  return kind === "seats" ? STATE_RANK.over : STATE_RANK.at_limit;
}

/** True when the plan needs the customer's attention (drives the settings dot). */
export function planNeedsAttention(plan: PlanInfo | undefined): boolean {
  if (!plan || !plan.enforced) return false;
  if (plan.trial.expired) return true;
  if (plan.payment.status === "overdue" || plan.payment.status === "lapsed") return true;
  return (["contacts", "emails", "seats"] as const).some((k) => STATE_RANK[plan.meters[k].state] >= attentionRank(k));
}

const KIND_PHRASE: Record<MeterKind, { at: string; near: string }> = {
  contacts: {
    at: "New contacts are paused until you upgrade. People you already have keep working.",
    near: "contacts",
  },
  emails: {
    at: "Sending is paused until your allowance resets or you upgrade. Queued emails will go out then.",
    near: "monthly emails",
  },
  seats: {
    at: "You cannot invite more people until you upgrade.",
    near: "team seats",
  },
};

/**
 * The single most important thing to tell the customer about their plan, or
 * null when there is nothing worth a banner. Order of importance:
 *   1. a limit reached or exceeded
 *   2. a payment that is overdue (plan still works for a few days)
 *   3. a subscription that has lapsed (now on Free)
 *   4. a trial that has ended
 *   5. a trial ending soon (3 days or fewer)
 *   6. a cancelled subscription still running out its paid time
 *   7. usage close to a limit
 *   8. a trial in progress
 * Nothing at all when plans are not enforced.
 */
export function planNotice(plan: PlanInfo | undefined): PlanNotice | null {
  if (!plan || !plan.enforced) return null;

  // 1. Worst meter first.
  const kinds: MeterKind[] = ["contacts", "emails", "seats"];
  let worst: { kind: MeterKind; rank: number } | null = null;
  for (const kind of kinds) {
    const rank = STATE_RANK[plan.meters[kind].state];
    if (rank >= attentionRank(kind) && (worst === null || rank > worst.rank)) worst = { kind, rank };
  }
  if (worst) {
    const m = plan.meters[worst.kind];
    const limit = (m.limit ?? 0).toLocaleString("en-US");
    const one = m.limit === 1;
    const what =
      worst.kind === "emails"
        ? one ? "email a month" : "emails a month"
        : worst.kind === "seats"
          ? one ? "team member" : "team members"
          : one ? "contact" : "contacts";
    return {
      id: `limit-${worst.kind}`,
      tone: "danger",
      message: `You have reached the ${plan.plan.name} plan limit of ${limit} ${what}. ${KIND_PHRASE[worst.kind].at}`,
      dismissible: false,
    };
  }

  // 2. Payment overdue: the paid date has passed but the grace period has not.
  if (plan.payment.status === "overdue") {
    const left = plan.payment.grace_ends_at ? daysUntil(plan.payment.grace_ends_at) : 0;
    const days = left <= 1 ? "less than a day" : `${left} more days`;
    return {
      id: "payment-overdue",
      tone: "warning",
      message: `Your ${storedPlanName(plan)} payment is overdue. Your plan keeps working for ${days} while we retry the card. Please check your payment details.`,
      dismissible: false,
    };
  }

  // 3. Subscription lapsed: the paid time and the grace period are both over.
  if (plan.payment.status === "lapsed") {
    return {
      id: "subscription-lapsed",
      tone: "warning",
      message: `Your ${storedPlanName(plan)} subscription has ended and you are now on the ${plan.plan.name} plan. Your data is safe. Choose a plan to get your limits back.`,
      dismissible: false,
    };
  }

  // 4. Trial over.
  if (plan.trial.expired) {
    return {
      id: "trial-expired",
      tone: "warning",
      message: `Your free trial has ended and you are now on the ${plan.plan.name} plan. Your data is safe. Choose a plan to get your limits back.`,
      dismissible: false,
    };
  }

  // 5. Trial ending soon.
  if (plan.trial.active) {
    const d = plan.trial.days_left;
    const days = d === 1 ? "1 day" : `${d} days`;
    if (d <= 3) {
      return {
        id: "trial-ending",
        tone: "warning",
        message: `Your ${plan.plan.name} trial ends in ${days}. Choose a plan to keep your limits.`,
        dismissible: false,
      };
    }
  }

  // 6. Cancelled, but paid for until a known date.
  const sub = plan.billing.subscription;
  if (sub && sub.status === "cancelling") {
    return {
      id: "subscription-cancelling",
      tone: "info",
      message: `Your subscription is cancelled and ends on ${formatDay(sub.current_period_end)}. You keep everything until then.`,
      dismissible: true,
    };
  }

  // 7. Close to a limit.
  const near = kinds.find((k) => plan.meters[k].state === "near");
  if (near) {
    const m = plan.meters[near];
    return {
      id: `near-${near}`,
      tone: "info",
      message: `You have used ${m.used.toLocaleString("en-US")} of ${(m.limit ?? 0).toLocaleString("en-US")} ${KIND_PHRASE[near].near} on the ${plan.plan.name} plan.`,
      dismissible: true,
    };
  }

  // 8. Trial in progress, plenty of time left.
  if (plan.trial.active) {
    const d = plan.trial.days_left;
    return {
      id: "trial-active",
      tone: "info",
      message: `You are on a free ${plan.plan.name} trial, ${d === 1 ? "1 day" : `${d} days`} left.`,
      dismissible: true,
    };
  }

  return null;
}
