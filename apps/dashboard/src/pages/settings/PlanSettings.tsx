/**
 * Settings / Plan & usage.
 *
 * Shows the workspace plan, trial status, how much of each limit is used
 * (contacts, emails this month, team members), the subscription (renewal date,
 * cancel), and the plans available with working upgrade buttons.
 *
 * Paying happens on Flutterwave's hosted page: the button asks the server for a
 * checkout link and sends the browser there. Flutterwave then returns the
 * customer to this page with ?billing=success|pending|failed|cancelled|unknown,
 * which is turned into a notice here.
 *
 * Only owners can change the plan. When online billing is not configured the
 * plan cards fall back to a "contact us" link.
 *
 * On installs that do not enforce plans this page just says so.
 *
 * Mirror side: PUBLIC (apps/dashboard is mirrored).
 */
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Badge, type BadgeVariant } from "../../components/ui/badge.js";
import { Button, buttonVariants } from "../../components/ui/button.js";
import { Skeleton } from "../../components/ui/skeleton.js";
import { useMe } from "../../auth.js";
import {
  barFraction,
  billingReturnNotice,
  formatDay,
  METER_LABEL,
  usePlan,
  useCancelSubscription,
  useStartCheckout,
  type MeterKind,
} from "../../plan.js";
import type { BillingInterval, BillingSubscription, PlanCatalogEntry, PlanInfo, PlanMeter, PlanMeterState } from "../../api.js";
import { cn } from "../../lib/utils.js";
import { FormError, Notice, Section, errorMessage } from "./shared.js";

const STATE_BADGE: Partial<Record<PlanMeterState, { label: string; variant: BadgeVariant }>> = {
  near: { label: "Near limit", variant: "warning" },
  at_limit: { label: "At limit", variant: "danger" },
  over: { label: "Over limit", variant: "danger" },
};

const BAR_COLOR: Record<PlanMeterState, string> = {
  unlimited: "bg-accent",
  ok: "bg-accent",
  near: "bg-warning",
  at_limit: "bg-danger",
  over: "bg-danger",
};

const n = (v: number): string => v.toLocaleString("en-US");

function Meter({ kind, meter, detail }: { kind: MeterKind | "ai"; meter: PlanMeter; detail?: string }) {
  const label = kind === "ai" ? "Mailforge AI tokens" : METER_LABEL[kind];
  // A full seat meter is normal (a Free workspace has one seat, its owner), so it is
  // shown calmly; only going over the seat allowance is flagged as a problem.
  const badge =
    kind === "seats" && meter.state === "at_limit"
      ? { label: "All seats in use", variant: "neutral" as BadgeVariant }
      : STATE_BADGE[meter.state];
  const unlimited = meter.limit === null;
  // Same calm treatment for the bar: a full seat meter is not an alarm.
  const calmFull = kind === "seats" && meter.state === "at_limit";
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <div className="flex items-center gap-2">
          <h3 className="text-[14px] font-medium text-foreground">{label}</h3>
          {badge && <Badge variant={badge.variant}>{badge.label}</Badge>}
        </div>
        <p className="text-[14px] tabular-nums text-muted-foreground">
          <span className="font-medium text-foreground">{n(meter.used)}</span>
          {unlimited ? " (no limit)" : ` of ${n(meter.limit!)}`}
        </p>
      </div>
      {!unlimited && (
        <div
          role="progressbar"
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={meter.limit!}
          aria-valuenow={Math.min(meter.used, meter.limit!)}
          aria-valuetext={`${n(meter.used)} of ${n(meter.limit!)}`}
          className="mt-2 h-2 overflow-hidden rounded-full bg-sunken"
        >
          <div
            className={cn("h-full rounded-full transition-[width]", calmFull ? "bg-accent" : BAR_COLOR[meter.state])}
            style={{ width: `${Math.round(barFraction(meter.used, meter.limit) * 100)}%` }}
          />
        </div>
      )}
      {detail && <p className="mt-1.5 text-[13px] text-muted-foreground">{detail}</p>}
    </div>
  );
}

/** "$49/mo" or "$490/yr", from the exact amounts the server will bill. */
function priceLabel(p: PlanCatalogEntry, interval: BillingInterval): string {
  return interval === "yearly" ? `$${n(p.price_annual_usd)}/yr` : `$${n(p.price_monthly_usd)}/mo`;
}

function PlanCard({
  p,
  interval,
  sub,
  supportEmail,
  canPurchase,
  billingEnabled,
  busyPlan,
  onChoose,
}: {
  p: PlanCatalogEntry;
  interval: BillingInterval;
  sub: BillingSubscription | null;
  supportEmail: string | null;
  canPurchase: boolean;
  billingEnabled: boolean;
  busyPlan: string | null;
  onChoose: (plan: string) => void;
}) {
  const isFree = p.id === "free";
  const liveSub = sub && sub.status !== "ended" ? sub : null;
  const exactlyThis = liveSub !== null && liveSub.plan === p.id && liveSub.interval === interval && liveSub.status === "active";
  const subject = encodeURIComponent(`Change my plan to ${p.name}`);

  let action: React.ReactNode = null;
  if (p.current && isFree) {
    action = <DisabledButton>Current plan</DisabledButton>;
  } else if (isFree) {
    action = null; // Free is reached by cancelling, not bought
  } else if (billingEnabled) {
    if (exactlyThis) action = <DisabledButton>Current plan</DisabledButton>;
    else if (!canPurchase) action = null;
    else {
      const verb = liveSub?.status === "active" ? "Switch to" : "Choose";
      action = (
        <Button
          size="sm"
          variant={p.recommended ? "default" : "outline"}
          disabled={busyPlan !== null}
          onClick={() => onChoose(p.id)}
        >
          {busyPlan === p.id ? "Opening checkout..." : `${verb} ${p.name}`}
        </Button>
      );
    }
  } else if (p.current) {
    action = <DisabledButton>Current plan</DisabledButton>;
  } else if (supportEmail) {
    action = (
      <a
        className={buttonVariants({ variant: p.recommended ? "default" : "outline", size: "sm" })}
        href={`mailto:${supportEmail}?subject=${subject}`}
      >
        Contact us to switch
      </a>
    );
  }

  return (
    <div
      className={cn(
        "flex flex-col rounded-lg border p-4",
        p.current ? "border-accent bg-accent-soft/40" : "border-border bg-card",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-[16px] font-semibold text-foreground">{p.name}</h3>
        {p.current ? (
          <Badge variant="accent">Current plan</Badge>
        ) : p.recommended ? (
          <Badge variant="neutral">Popular</Badge>
        ) : null}
      </div>
      <p className="mt-1 text-[22px] font-semibold tracking-[-0.02em] text-foreground">
        {isFree ? "$0/mo" : priceLabel(p, interval)}
      </p>
      {!isFree && interval === "yearly" && (
        <p className="text-[12px] text-muted-foreground">about ${n(Math.round(p.price_annual_usd / 12))}/mo, two months free</p>
      )}
      <p className="mt-1 min-h-[2.5em] text-[13px] text-muted-foreground">{p.tagline}</p>
      <ul className="my-3 flex-1 space-y-1 text-[13px] text-foreground">
        {p.features.map((f) => (
          <li key={f} className="flex gap-2">
            <span aria-hidden="true" className="text-accent-text">&#10003;</span>
            <span>{f}</span>
          </li>
        ))}
      </ul>
      {action}
    </div>
  );
}

function DisabledButton({ children }: { children: React.ReactNode }) {
  return (
    <span className={cn(buttonVariants({ variant: "outline", size: "sm" }), "pointer-events-none opacity-60")} aria-disabled="true">
      {children}
    </span>
  );
}

function trialLine(plan: PlanInfo): string | null {
  if (plan.trial.active) {
    const d = plan.trial.days_left;
    const ends = plan.trial.ends_at ? ` (ends ${formatDay(plan.trial.ends_at)})` : "";
    return `Free trial: ${d === 1 ? "1 day" : `${d} days`} left${ends}.`;
  }
  if (plan.trial.expired) return "Your free trial has ended. You are on the Free plan.";
  return null;
}

/** The subscription: what you pay, when it renews or ends, and the cancel button. */
function BillingSection({ plan, canManage }: { plan: PlanInfo; canManage: boolean }) {
  const sub = plan.billing.subscription;
  const cancel = useCancelSubscription();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!sub) return null;
  const planName = plan.plans.find((p) => p.id === sub.plan)?.name ?? sub.plan;
  const end = formatDay(sub.current_period_end);
  const price = `$${n(sub.amount_usd)} ${sub.interval === "yearly" ? "a year" : "a month"}`;

  async function doCancel() {
    setError(null);
    try {
      await cancel.mutateAsync();
      setConfirming(false);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <Section
      title="Subscription"
      configured={null}
      description="Your payment plan with Flutterwave."
      actions={
        <Badge variant={sub.status === "active" ? "success" : sub.status === "cancelling" ? "warning" : "muted"}>
          {sub.status === "active" ? "Active" : sub.status === "cancelling" ? "Cancelling" : "Ended"}
        </Badge>
      }
    >
      <p className="text-[14px] text-foreground">
        <span className="font-medium">{planName}</span>, billed {sub.interval}, {price}.
      </p>
      <p className="mt-1 text-[14px] text-muted-foreground">
        {sub.status === "active" && <>Renews automatically on {end}.</>}
        {sub.status === "cancelling" && <>Cancelled. You keep the {planName} plan until {end}, then move to Free. To carry on, choose a plan below.</>}
        {sub.status === "ended" && <>This subscription ended on {end}. Choose a plan below to subscribe again.</>}
      </p>

      {canManage && sub.status === "active" && (
        <div className="mt-4">
          {!confirming ? (
            <Button size="sm" variant="outline" onClick={() => setConfirming(true)}>
              Cancel subscription
            </Button>
          ) : (
            <div className="rounded-md border border-border bg-sunken p-3">
              <p className="text-[14px] text-foreground">
                Cancel your subscription? Nothing more will be charged. You keep the {planName} plan until {end}, and
                your data stays safe.
              </p>
              <div className="mt-3 flex gap-2">
                <Button size="sm" variant="destructive" disabled={cancel.isPending} onClick={() => void doCancel()}>
                  {cancel.isPending ? "Cancelling..." : "Yes, cancel"}
                </Button>
                <Button size="sm" variant="ghost" disabled={cancel.isPending} onClick={() => setConfirming(false)}>
                  Keep my plan
                </Button>
              </div>
            </div>
          )}
          <FormError message={error} />
        </div>
      )}
    </Section>
  );
}

export default function PlanSettings() {
  const [params, setParams] = useSearchParams();
  const returned = params.get("billing");
  const waiting = returned === "pending";

  // While a payment is being confirmed, look again every few seconds.
  const { data: plan, isLoading, error } = usePlan({ pollMs: waiting ? 3000 : undefined });
  const { data: me } = useMe();
  const checkout = useStartCheckout();
  const [interval, setPeriod] = useState<BillingInterval>("monthly");
  const [checkoutError, setCheckoutError] = useState<string | null>(null);

  // When the webhook lands and the subscription becomes active, flip "confirming" to "confirmed".
  const subStatus = plan?.billing.subscription?.status;
  useEffect(() => {
    if (waiting && subStatus === "active") {
      const next = new URLSearchParams(params);
      next.set("billing", "success");
      setParams(next, { replace: true });
    }
  }, [waiting, subStatus, params, setParams]);

  // Open on the interval the customer already pays for.
  const subInterval = plan?.billing.subscription?.interval;
  useEffect(() => {
    if (subInterval) setPeriod(subInterval);
  }, [subInterval]);

  if (isLoading) return <Skeleton className="h-64 w-full" />;
  if (error || !plan) {
    return (
      <Section title="Plan & usage" configured={null}>
        <Notice>Could not load your plan. Please refresh the page.</Notice>
      </Section>
    );
  }

  if (!plan.enforced) {
    return (
      <Section title="Plan & usage" configured={null} description="Plan limits apply to hosted workspaces.">
        <Notice variant="info">Plan limits are not enforced on this install, so nothing here is capped.</Notice>
      </Section>
    );
  }

  const isOwner = me?.user.role === "owner";
  const { meters } = plan;
  const trial = trialLine(plan);
  const returnNotice = billingReturnNotice(returned);
  const seatDetail =
    `${meters.seats.members} ${meters.seats.members === 1 ? "member" : "members"}` +
    (meters.seats.pending_invites > 0
      ? ` and ${meters.seats.pending_invites} pending ${meters.seats.pending_invites === 1 ? "invitation" : "invitations"}`
      : "");

  function dismissReturn() {
    const next = new URLSearchParams(params);
    next.delete("billing");
    setParams(next, { replace: true });
  }

  async function choose(planId: string) {
    setCheckoutError(null);
    try {
      await checkout.mutateAsync({ plan: planId, interval });
    } catch (err) {
      setCheckoutError(errorMessage(err));
    }
  }

  const planDescription = plan.billing.enabled
    ? isOwner
      ? "Pick a plan to pay by card. Switching starts a new billing period; time left on your current plan is not carried over."
      : "Only a workspace owner can change the plan."
    : plan.support_email
      ? "Self-serve plan changes are coming soon. To switch plans today, contact us and we will do it for you."
      : "Self-serve plan changes are coming soon.";

  return (
    <div className="space-y-6">
      {returnNotice && (
        <Notice variant={returnNotice.tone} onDismiss={dismissReturn}>
          {returnNotice.message}
        </Notice>
      )}

      <Section
        title="Plan & usage"
        configured={null}
        description="What your plan includes and how much of it you have used."
        actions={<Badge variant="accent">{plan.plan.name}</Badge>}
      >
        {trial && (
          <Notice variant={plan.trial.expired ? "warning" : "info"} className="mb-5">
            {trial}
          </Notice>
        )}
        <div className="space-y-5">
          <Meter kind="contacts" meter={meters.contacts} />
          <Meter kind="emails" meter={meters.emails} detail={`Resets on ${formatDay(meters.emails.resets_at)}.`} />
          <Meter kind="seats" meter={meters.seats} detail={seatDetail} />
          {meters.ai.source === "byok" ? (
            <div>
              <h3 className="text-[14px] font-medium text-foreground">Mailforge AI tokens</h3>
              <p className="mt-1 text-[13px] text-muted-foreground">
                This workspace uses its own AI key, so no Mailforge AI allowance is used. Your provider bills you directly.
              </p>
            </div>
          ) : (
            <Meter
              kind="ai"
              meter={meters.ai}
              detail={`Used by AI drafting, flow compiling and search when you have no key of your own. Resets on ${formatDay(meters.ai.resets_at)}.`}
            />
          )}
        </div>
        <p className="mt-5 text-[13px] text-muted-foreground">
          Going over a limit never deletes anything. New contacts and invitations pause, sending and AI drafting wait
          for your allowance to reset, and everything you already have keeps working.
        </p>
      </Section>

      {plan.billing.enabled && <BillingSection plan={plan} canManage={isOwner} />}

      <Section
        title="Plans"
        configured={null}
        description={planDescription}
        actions={
          plan.billing.enabled && isOwner ? (
            <div className="inline-flex rounded-md border border-border p-0.5" role="group" aria-label="Billing period">
              {(["monthly", "yearly"] as const).map((i) => (
                <button
                  key={i}
                  type="button"
                  aria-pressed={interval === i}
                  onClick={() => setPeriod(i)}
                  className={cn(
                    "rounded px-3 py-1 text-[13px] font-medium",
                    interval === i ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {i === "monthly" ? "Monthly" : "Yearly"}
                </button>
              ))}
            </div>
          ) : undefined
        }
      >
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {plan.plans.map((p) => (
            <PlanCard
              key={p.id}
              p={p}
              interval={interval}
              sub={plan.billing.subscription}
              supportEmail={plan.support_email}
              canPurchase={isOwner}
              billingEnabled={plan.billing.enabled}
              busyPlan={checkout.isPending ? (checkout.variables?.plan ?? null) : null}
              onChoose={(id) => void choose(id)}
            />
          ))}
        </div>
        <FormError message={checkoutError} />
        {plan.billing.enabled && (
          <p className="mt-4 text-[12px] text-muted-foreground">
            Payments are by card, in US dollars, and are processed by Flutterwave. We never see or store your card.
          </p>
        )}
      </Section>
    </div>
  );
}
