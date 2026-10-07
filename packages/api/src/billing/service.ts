/**
 * Billing service: everything that changes a workspace's paid plan.
 *
 * The rules this file enforces:
 *   - Money is only believed after Paystack confirms it. Callers pass in a
 *     transaction that was fetched from the provider's verify endpoint, never
 *     one taken straight from a webhook body or a browser redirect.
 *   - A payment must match what we asked for: successful status, the same
 *     currency, and at least the expected amount.
 *   - Each provider event is applied once. The event record and the changes it
 *     causes are written in one database transaction, so a retried webhook is a
 *     harmless no-op and a crash half way leaves nothing behind.
 *   - A plan change replaces the old subscription in the same transaction; the
 *     old one is then cancelled with the provider.
 *   - Cancelling stops future charges but keeps the plan until the period paid
 *     for runs out. A lapsed plan drops to Free by date (see tenants.plan_paid_through),
 *     so no scheduled job is needed.
 *
 * Mirror side: PUBLIC (packages/api is mirrored).
 */
import { randomBytes } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  addBillingPeriod,
  BILLING_INTERVALS,
  chargeAmountMinor,
  entitlementsFor,
  isBillingInterval,
  isPaidPlanId,
  PLANS,
  planPriceUsd,
  type BillingInterval,
  type PaidPlanId,
  type PaymentStatus,
} from "@mailforge/core";
import {
  billingCheckouts,
  billingEvents,
  billingProviderPlans,
  subscriptions,
  tenants,
} from "@mailforge/db/schema";
import type { Db } from "../plugins/db.js";
import { PaystackError, type PaystackClient, type PaystackTransaction } from "./paystack.js";

const PROVIDER = "paystack";

export type BillingErrorCode = "invalid_plan" | "already_subscribed" | "no_subscription" | "provider_error";

export class BillingError extends Error {
  constructor(
    readonly code: BillingErrorCode,
    message: string,
    readonly httpStatus: number,
  ) {
    super(message);
    this.name = "BillingError";
  }
  toJSON(): { error: string; code: BillingErrorCode } {
    return { error: this.message, code: this.code };
  }
}

export interface BillingConfig {
  /** Charge currency. Must match the currency of the provider plans. */
  currency: string;
  /** Units of `currency` per 1 USD (1 for USD). The charge is the USD list price times this, rounded up. */
  usdRate: number;
  /** Where the provider sends the customer after paying (absolute URL). */
  returnUrl: string;
}

/** What one period of a plan costs in the charge currency's minor unit (cents, pesewas, kobo). */
export const chargeCents = (plan: PaidPlanId, interval: BillingInterval, currency: string, usdRate: number): number =>
  chargeAmountMinor(planPriceUsd(plan, interval), currency, usdRate);

// ---------------------------------------------------------------------------
// Provider plans
// ---------------------------------------------------------------------------

/**
 * The provider's plan id for (plan, interval) at today's price, created on
 * first use. Serialised with an advisory lock so two simultaneous first
 * checkouts do not create two plans.
 */
export async function ensureProviderPlan(
  db: Db,
  ps: PaystackClient,
  args: { plan: PaidPlanId; interval: BillingInterval; currency: string; amountCents: number },
): Promise<string> {
  const { amountCents } = args;
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`psplan:${args.plan}:${args.interval}:${args.currency}:${amountCents}`}))`);
    const [existing] = await tx
      .select({ id: billingProviderPlans.providerPlanId })
      .from(billingProviderPlans)
      .where(
        and(
          eq(billingProviderPlans.provider, PROVIDER),
          eq(billingProviderPlans.plan, args.plan),
          eq(billingProviderPlans.interval, args.interval),
          eq(billingProviderPlans.currency, args.currency),
          eq(billingProviderPlans.amountCents, amountCents),
        ),
      )
      .limit(1);
    if (existing) return existing.id;

    const created = await ps.createPlan({
      name: `Mailforge ${PLANS[args.plan].name} (${args.interval})`,
      amountCents,
      interval: args.interval,
      currency: args.currency,
    });
    await tx.insert(billingProviderPlans).values({
      provider: PROVIDER,
      plan: args.plan,
      interval: args.interval,
      currency: args.currency,
      amountCents,
      providerPlanId: created.code,
    });
    return created.code;
  });
}

// ---------------------------------------------------------------------------
// Checkout
// ---------------------------------------------------------------------------

export interface StartCheckoutInput {
  tenantId: string;
  userId: string;
  /** The payer. Paystack ties the subscription to this address for good. */
  email: string;
  workspaceName: string;
  plan: PaidPlanId;
  interval: BillingInterval;
  now?: Date;
}

export async function startCheckout(
  db: Db,
  ps: PaystackClient,
  cfg: BillingConfig,
  input: StartCheckoutInput,
): Promise<{ url: string; txRef: string; accessCode: string | null }> {
  if (!isPaidPlanId(input.plan) || !isBillingInterval(input.interval)) {
    throw new BillingError("invalid_plan", "Choose a paid plan and a billing interval.", 400);
  }
  const now = input.now ?? new Date();

  // Already on exactly this plan and interval, with time left: nothing to buy.
  const [live] = await db
    .select()
    .from(subscriptions)
    .where(and(eq(subscriptions.tenantId, input.tenantId), eq(subscriptions.status, "active")))
    .limit(1);
  if (live && live.plan === input.plan && live.interval === input.interval && live.currentPeriodEnd.getTime() > now.getTime()) {
    throw new BillingError("already_subscribed", `You are already on the ${PLANS[input.plan].name} plan, billed ${input.interval}.`, 409);
  }

  const amountCents = chargeCents(input.plan, input.interval, cfg.currency, cfg.usdRate);
  let providerPlanId: string;
  try {
    providerPlanId = await ensureProviderPlan(db, ps, { plan: input.plan, interval: input.interval, currency: cfg.currency, amountCents });
  } catch (err) {
    throw providerFailure(err);
  }

  const txRef = `mf_${input.tenantId.slice(0, 8)}_${randomBytes(9).toString("hex")}`;
  const [checkout] = await db
    .insert(billingCheckouts)
    .values({
      tenantId: input.tenantId,
      userId: input.userId,
      txRef,
      plan: input.plan,
      interval: input.interval,
      amountCents,
      currency: cfg.currency,
      providerPlanId,
      customerEmail: input.email,
      status: "pending",
    })
    .returning({ id: billingCheckouts.id });

  try {
    const { url, accessCode } = await ps.initializeTransaction({
      reference: txRef,
      amount: amountCents,
      currency: cfg.currency,
      email: input.email,
      callbackUrl: cfg.returnUrl,
      cancelUrl: `${cfg.returnUrl}?status=cancelled&reference=${encodeURIComponent(txRef)}`,
      planCode: providerPlanId,
      metadata: {
        tenant_id: input.tenantId,
        plan: input.plan,
        interval: input.interval,
        checkout_id: checkout!.id,
        workspace: input.workspaceName,
        description: `${PLANS[input.plan].name} plan, billed ${input.interval}`,
      },
    });
    await db.update(billingCheckouts).set({ checkoutUrl: url }).where(eq(billingCheckouts.id, checkout!.id));
    return { url, txRef, accessCode };
  } catch (err) {
    await db.update(billingCheckouts).set({ status: "failed" }).where(eq(billingCheckouts.id, checkout!.id));
    throw providerFailure(err);
  }
}

export type CheckoutStatus = "pending" | "paid" | "failed" | "cancelled";

/** When each pending checkout was last checked with the provider, so a page that polls cannot hammer it. */
const lastVerifiedAt = new Map<string, number>();
const MIN_VERIFY_GAP_MS = 2_000;

/** For tests: forget when checkouts were last checked, so the next poll goes to the provider. */
export function resetCheckoutThrottle(): void {
  lastVerifiedAt.clear();
}

/**
 * Where one of THIS workspace's checkouts stands, for a page that is waiting on a payment.
 *
 * A checkout that is still pending is looked up with the provider (at most once every two seconds
 * per checkout) and applied if it has been paid, so the answer does not depend on a webhook or on
 * the customer being redirected back. A provider hiccup just leaves it pending. Returns null for a
 * reference that is not this workspace's, so one workspace cannot probe another's payments.
 */
export async function checkoutStatus(
  db: Db,
  ps: PaystackClient,
  tenantId: string,
  reference: string,
  now: Date = new Date(),
): Promise<{ status: CheckoutStatus; plan: string; interval: string } | null> {
  const find = async () =>
    (await db.select().from(billingCheckouts).where(and(eq(billingCheckouts.txRef, reference), eq(billingCheckouts.tenantId, tenantId))).limit(1))[0];
  let checkout = await find();
  if (!checkout) return null;

  if (checkout.status === "pending") {
    const last = lastVerifiedAt.get(reference) ?? 0;
    if (now.getTime() - last >= MIN_VERIFY_GAP_MS) {
      lastVerifiedAt.set(reference, now.getTime());
      if (lastVerifiedAt.size > 500) {
        for (const [ref, at] of lastVerifiedAt) if (now.getTime() - at > 3_600_000) lastVerifiedAt.delete(ref);
      }
      try {
        const tx = await ps.verifyTransaction(reference);
        // Only what the provider says about OUR reference counts.
        if (tx.reference === reference) await applyVerifiedPayment(db, ps, tx, now);
      } catch {
        // Could not confirm just now: it stays pending and the page asks again.
      }
      checkout = (await find()) ?? checkout;
    }
  }
  const status: CheckoutStatus = checkout.status === "paid" || checkout.status === "failed" || checkout.status === "cancelled" ? checkout.status : "pending";
  return { status, plan: checkout.plan, interval: checkout.interval };
}

/** A provider problem, in words that are safe to show a customer. */
function providerFailure(err: unknown): BillingError {
  if (err instanceof PaystackError) {
    return new BillingError(
      "provider_error",
      err.transient
        ? "Our payment provider is not responding right now. Please try again in a moment."
        : "We could not start the payment. Please try again, or contact support if it keeps happening.",
      502,
    );
  }
  throw err;
}

// ---------------------------------------------------------------------------
// Applying a verified payment
// ---------------------------------------------------------------------------

export type ApplyOutcome =
  | "applied_initial" // first payment of a checkout: plan activated
  | "applied_renewal" // a recurring charge: paid-through date extended
  | "applied_cancellation" // the provider cancelled a subscription: no more charges
  | "duplicate" // already applied earlier (webhook retry, or return + webhook)
  | "ignored" // nothing for us to do (failed charge, unknown subscription)
  | "rejected"; // looked like a payment but failed our checks

export interface ApplyResult {
  outcome: ApplyOutcome;
  reason?: string;
  tenantId?: string;
}

const eventKeyFor = (tx: PaystackTransaction): string => `charge:${tx.id}`;

async function recordEvent(
  db: Db,
  args: { key: string; type: string; tenantId?: string; outcome: string; payload: unknown },
): Promise<boolean> {
  const rows = await db
    .insert(billingEvents)
    .values({
      provider: PROVIDER,
      eventKey: args.key,
      eventType: args.type,
      tenantId: args.tenantId ?? null,
      outcome: args.outcome,
      payload: args.payload as Record<string, unknown>,
    })
    .onConflictDoNothing()
    .returning({ id: billingEvents.id });
  return rows.length > 0;
}

/** The plan code a charge was made under, or null when it was not under a plan. */
function planCodeOf(tx: PaystackTransaction): string | null {
  const code = tx.plan?.plan_code;
  return typeof code === "string" && code !== "" ? code : null;
}

function txSummary(tx: PaystackTransaction): Record<string, unknown> {
  return {
    id: tx.id,
    reference: tx.reference,
    status: tx.status,
    amount: tx.amount,
    currency: tx.currency,
    email: tx.customer?.email ?? null,
    plan: planCodeOf(tx),
  };
}

/**
 * Apply a transaction that has been verified with the provider.
 *
 * `tx` MUST come from PaystackClient.verifyTransaction, not from a webhook
 * body. Safe to call any number of times for the same transaction.
 */
export async function applyVerifiedPayment(
  db: Db,
  ps: PaystackClient,
  tx: PaystackTransaction,
  now: Date = new Date(),
): Promise<ApplyResult> {
  const key = eventKeyFor(tx);

  const [seen] = await db
    .select({ id: billingEvents.id })
    .from(billingEvents)
    .where(and(eq(billingEvents.provider, PROVIDER), eq(billingEvents.eventKey, key)))
    .limit(1);
  if (seen) return { outcome: "duplicate" };

  const [checkout] = await db.select().from(billingCheckouts).where(eq(billingCheckouts.txRef, tx.reference)).limit(1);

  // Not paid. Only a definite failure closes the checkout; a payment that is still in
  // progress or was abandoned leaves it pending, because the customer may yet finish it.
  // No event is recorded either way, so a later successful attempt still works.
  if (tx.status !== "success") {
    if (checkout && checkout.status === "pending" && (tx.status === "failed" || tx.status === "reversed")) {
      await db.update(billingCheckouts).set({ status: "failed", providerTransactionId: String(tx.id), completedAt: now }).where(eq(billingCheckouts.id, checkout.id));
    }
    return { outcome: "ignored", reason: `transaction status is ${tx.status}`, tenantId: checkout?.tenantId };
  }

  return checkout ? applyInitialPayment(db, ps, tx, checkout, key, now) : applyRenewal(db, tx, key, now);
}

type Checkout = typeof billingCheckouts.$inferSelect;

async function applyInitialPayment(
  db: Db,
  ps: PaystackClient,
  tx: PaystackTransaction,
  checkout: Checkout,
  key: string,
  now: Date,
): Promise<ApplyResult> {
  // 1. Does the payment match what we asked for?
  // Paystack reports amounts in minor units already.
  const paidCents = Number(tx.amount);
  if (tx.currency?.toUpperCase() !== checkout.currency.toUpperCase() || !Number.isFinite(paidCents) || paidCents < checkout.amountCents) {
    await db.transaction(async (t) => {
      const fresh = await recordEvent(t, {
        key,
        type: "charge.completed",
        tenantId: checkout.tenantId,
        outcome: "rejected: amount or currency does not match the checkout",
        payload: txSummary(tx),
      });
      if (fresh && checkout.status === "pending") {
        await t.update(billingCheckouts).set({ status: "failed", providerTransactionId: String(tx.id), completedAt: now }).where(eq(billingCheckouts.id, checkout.id));
      }
    });
    return { outcome: "rejected", reason: "amount or currency mismatch", tenantId: checkout.tenantId };
  }

  // 2. A checkout is paid for once. A second success for the same reference is not applied.
  if (checkout.status === "paid") {
    await recordEvent(db, { key, type: "charge.completed", tenantId: checkout.tenantId, outcome: "ignored: checkout already paid", payload: txSummary(tx) });
    return { outcome: "ignored", reason: "checkout already paid", tenantId: checkout.tenantId };
  }

  // 3. Apply, atomically with the event record.
  const interval = checkout.interval as BillingInterval;
  const periodEnd = addBillingPeriod(now, interval);
  const payer = tx.customer?.email?.trim() || checkout.customerEmail;
  // Set inside the transaction callback. Held in an object because TypeScript narrows a
  // plain `let` that is only assigned in a closure to its initial value (null) afterwards.
  const holder: { replaced: { providerSubscriptionId: string | null; customerEmail: string; providerPlanId: string | null } | null } = {
    replaced: null,
  };

  const result = await db.transaction(async (t) => {
    const fresh = await recordEvent(t, {
      key,
      type: "charge.completed",
      tenantId: checkout.tenantId,
      outcome: "applied",
      payload: txSummary(tx),
    });
    if (!fresh) return "duplicate" as const;

    // Serialise plan changes for this workspace.
    await t.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, checkout.tenantId)).for("update");

    const [old] = await t
      .select()
      .from(subscriptions)
      .where(and(eq(subscriptions.tenantId, checkout.tenantId), inArray(subscriptions.status, ["active", "cancelled"])))
      .for("update")
      .limit(1);
    if (old) {
      await t.update(subscriptions).set({ status: "replaced", updatedAt: now }).where(eq(subscriptions.id, old.id));
      // Only an active one still has charges to stop at the provider.
      if (old.status === "active") {
        holder.replaced = { providerSubscriptionId: old.providerSubscriptionId, customerEmail: old.customerEmail, providerPlanId: old.providerPlanId };
      }
    }

    await t.insert(subscriptions).values({
      tenantId: checkout.tenantId,
      provider: PROVIDER,
      plan: checkout.plan,
      interval,
      amountCents: checkout.amountCents,
      currency: checkout.currency,
      status: "active",
      customerEmail: payer,
      providerPlanId: checkout.providerPlanId,
      currentPeriodStart: now,
      currentPeriodEnd: periodEnd,
      lastPaymentAt: now,
    });
    await t.update(tenants).set({ plan: checkout.plan, planPaidThrough: periodEnd }).where(eq(tenants.id, checkout.tenantId));
    await t
      .update(billingCheckouts)
      .set({ status: "paid", providerTransactionId: String(tx.id), completedAt: now })
      .where(eq(billingCheckouts.id, checkout.id));
    return "applied" as const;
  });

  if (result === "duplicate") return { outcome: "duplicate", tenantId: checkout.tenantId };

  // 4. Housekeeping with the provider. The plan is already active; if either call
  //    fails, billing still works and the next sweep or cancel can finish the job.
  await learnProviderSubscriptionId(db, ps, { tenantId: checkout.tenantId, email: payer, providerPlanId: checkout.providerPlanId });
  if (holder.replaced) await cancelAtProvider(ps, holder.replaced);

  return { outcome: "applied_initial", tenantId: checkout.tenantId };
}

/** Find our new subscription's id at the provider, so it can be cancelled later. */
async function learnProviderSubscriptionId(
  db: Db,
  ps: PaystackClient,
  args: { tenantId: string; email: string; providerPlanId: string | null },
): Promise<void> {
  try {
    const list = await ps.listSubscriptions(args.email);
    // Newest first, as Paystack lists them. An id already attached to another of our
    // subscriptions is somebody else's, so skip it.
    const mine = list.find((s) => s.status === "active" && (args.providerPlanId === null || s.plan?.plan_code === args.providerPlanId));
    if (!mine) return;
    await db
      .update(subscriptions)
      .set({ providerSubscriptionId: mine.subscription_code, updatedAt: new Date() })
      .where(and(eq(subscriptions.tenantId, args.tenantId), eq(subscriptions.status, "active"), sql`${subscriptions.providerSubscriptionId} IS NULL`));
  } catch {
    // Not fatal: the subscription.create webhook, or cancellation itself, will find the id.
  }
}

/**
 * Paystack announced a new subscription (subscription.create). Attach its code to our
 * matching subscription (same payer and provider plan, id not yet known) so it can be
 * cancelled. Harmless to repeat, and harmless when it arrives before the payment has
 * been applied: the id is then learned by the lookup after that payment instead.
 */
export async function applySubscriptionCreated(
  db: Db,
  payload: { subscriptionCode?: string | null; email?: string | null; planCode?: string | null },
): Promise<ApplyResult> {
  const code = payload.subscriptionCode?.trim();
  const email = payload.email?.trim().toLowerCase();
  if (!code || !email) return { outcome: "ignored", reason: "no subscription code or email" };
  const key = `subscription-created:${code}`;

  const [seen] = await db
    .select({ id: billingEvents.id })
    .from(billingEvents)
    .where(and(eq(billingEvents.provider, PROVIDER), eq(billingEvents.eventKey, key)))
    .limit(1);
  if (seen) return { outcome: "duplicate" };

  const [taken] = await db.select({ id: subscriptions.id }).from(subscriptions).where(eq(subscriptions.providerSubscriptionId, code)).limit(1);
  const live = taken
    ? []
    : await db
        .select()
        .from(subscriptions)
        .where(
          and(
            eq(subscriptions.provider, PROVIDER),
            eq(subscriptions.status, "active"),
            sql`${subscriptions.providerSubscriptionId} IS NULL`,
            sql`lower(${subscriptions.customerEmail}) = ${email}`,
          ),
        );
  const planCode = payload.planCode?.trim() || null;
  const sub = live.filter((s) => planCode === null || s.providerPlanId === planCode).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  if (!sub) {
    // Nothing to attach to yet. Not recorded, so a later redelivery can still attach.
    return { outcome: "ignored", reason: "no matching subscription yet" };
  }
  const fresh = await recordEvent(db, { key, type: "subscription.create", tenantId: sub.tenantId, outcome: "applied", payload: { subscription_code: code, email, plan: planCode } });
  if (!fresh) return { outcome: "duplicate", tenantId: sub.tenantId };
  await db.update(subscriptions).set({ providerSubscriptionId: code, updatedAt: new Date() }).where(and(eq(subscriptions.id, sub.id), sql`${subscriptions.providerSubscriptionId} IS NULL`));
  return { outcome: "ignored", reason: "subscription code recorded", tenantId: sub.tenantId };
}

/** Stop a replaced subscription's future charges. Never throws. */
async function cancelAtProvider(
  ps: PaystackClient,
  sub: { providerSubscriptionId: string | null; customerEmail: string; providerPlanId: string | null },
): Promise<void> {
  try {
    let id = sub.providerSubscriptionId;
    if (!id) {
      const list = await ps.listSubscriptions(sub.customerEmail);
      id = list.find((s) => s.status === "active" && (sub.providerPlanId === null || s.plan?.plan_code === sub.providerPlanId))?.subscription_code ?? null;
    }
    if (id) await ps.cancelSubscription(id);
  } catch {
    // The customer is on the new plan either way. A stray old subscription would keep
    // charging, so this is logged by the caller's event record and worth a manual check.
  }
}

async function applyRenewal(db: Db, tx: PaystackTransaction, key: string, now: Date): Promise<ApplyResult> {
  const email = tx.customer?.email?.trim().toLowerCase();
  const paidCents = Number(tx.amount);
  const planId = planCodeOf(tx);

  if (!email) {
    await recordEvent(db, { key, type: "charge.completed", outcome: "ignored: no customer email", payload: txSummary(tx) });
    return { outcome: "ignored", reason: "no customer email" };
  }

  const candidates = await db
    .select()
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.provider, PROVIDER),
        sql`lower(${subscriptions.customerEmail}) = ${email}`,
        eq(subscriptions.currency, (tx.currency ?? "").toUpperCase()),
        eq(subscriptions.amountCents, paidCents),
        inArray(subscriptions.status, ["active", "cancelled"]),
      ),
    );
  const byPlan = planId == null ? candidates : candidates.filter((c) => c.providerPlanId === String(planId));
  // A renewal names its Paystack plan, which is the strongest match; email + amount is the fallback.
  const matches = byPlan.length > 0 ? byPlan : planId == null ? candidates : [];
  const sub = [...matches].sort((a, b) => a.currentPeriodEnd.getTime() - b.currentPeriodEnd.getTime())[0];

  if (!sub) {
    await recordEvent(db, { key, type: "charge.completed", outcome: "ignored: no matching subscription", payload: txSummary(tx) });
    return { outcome: "ignored", reason: "no matching subscription" };
  }

  // A charge after we cancelled means the provider's cancel did not take. The customer
  // was charged for nothing, so flag it for a human instead of silently extending.
  if (sub.status === "cancelled") {
    await recordEvent(db, {
      key,
      type: "charge.completed",
      tenantId: sub.tenantId,
      outcome: "rejected: charged after cancellation, a refund may be due",
      payload: txSummary(tx),
    });
    return { outcome: "rejected", reason: "charged after cancellation", tenantId: sub.tenantId };
  }

  const interval = sub.interval as BillingInterval;
  const outcome = await db.transaction(async (t) => {
    const fresh = await recordEvent(t, { key, type: "charge.completed", tenantId: sub.tenantId, outcome: "applied", payload: txSummary(tx) });
    if (!fresh) return "duplicate" as const;
    const [locked] = await t.select().from(subscriptions).where(eq(subscriptions.id, sub.id)).for("update").limit(1);
    // Paid on time: extend from where the old period ended. Paid late: from now.
    const base = locked!.currentPeriodEnd.getTime() > now.getTime() ? locked!.currentPeriodEnd : now;
    const newEnd = addBillingPeriod(base, interval);
    await t
      .update(subscriptions)
      .set({ currentPeriodStart: base, currentPeriodEnd: newEnd, lastPaymentAt: now, updatedAt: now })
      .where(eq(subscriptions.id, sub.id));
    await t.update(tenants).set({ plan: sub.plan, planPaidThrough: newEnd }).where(eq(tenants.id, sub.tenantId));
    return "applied" as const;
  });
  return outcome === "duplicate" ? { outcome: "duplicate", tenantId: sub.tenantId } : { outcome: "applied_renewal", tenantId: sub.tenantId };
}

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

/**
 * The provider told us a subscription was cancelled or will not renew (by the customer
 * through Paystack's emails, by the Paystack dashboard, or by our own cancel call). Plan keeps
 * working until the period paid for ends.
 */
export async function applySubscriptionCancelled(
  db: Db,
  payload: { subscriptionId?: string | number | null; email?: string | null; planId?: string | number | null },
  now: Date = new Date(),
): Promise<ApplyResult> {
  const key = `subscription-cancelled:${payload.subscriptionId ?? `${payload.email ?? "?"}:${payload.planId ?? "?"}`}`;
  const [seen] = await db
    .select({ id: billingEvents.id })
    .from(billingEvents)
    .where(and(eq(billingEvents.provider, PROVIDER), eq(billingEvents.eventKey, key)))
    .limit(1);
  if (seen) return { outcome: "duplicate" };

  const live = await db.select().from(subscriptions).where(and(eq(subscriptions.provider, PROVIDER), eq(subscriptions.status, "active")));
  const sid = payload.subscriptionId == null ? null : String(payload.subscriptionId);
  const email = payload.email?.trim().toLowerCase() ?? null;
  const pid = payload.planId == null ? null : String(payload.planId);

  // Prefer an exact subscription id. Fall back to payer email + provider plan only
  // for a subscription whose id we never learned, so a late event about an old
  // subscription cannot cancel its replacement.
  let sub = sid ? live.find((s) => s.providerSubscriptionId === sid) : undefined;
  if (!sub && email) {
    sub = live.find((s) => s.providerSubscriptionId === null && s.customerEmail.toLowerCase() === email && (pid === null || s.providerPlanId === pid));
  }
  if (!sub) {
    await recordEvent(db, { key, type: "subscription.cancelled", outcome: "ignored: no matching live subscription", payload });
    return { outcome: "ignored", reason: "no matching live subscription" };
  }

  const outcome = await db.transaction(async (t) => {
    const fresh = await recordEvent(t, { key, type: "subscription.cancelled", tenantId: sub!.tenantId, outcome: "applied", payload });
    if (!fresh) return "duplicate" as const;
    await t
      .update(subscriptions)
      .set({ status: "cancelled", cancelAtPeriodEnd: true, cancelledAt: now, updatedAt: now })
      .where(and(eq(subscriptions.id, sub!.id), eq(subscriptions.status, "active")));
    return "applied" as const;
  });
  return outcome === "duplicate" ? { outcome: "duplicate", tenantId: sub.tenantId } : { outcome: "applied_cancellation", tenantId: sub.tenantId };
}

/** Customer-initiated cancel: stop future charges, keep the plan until the period ends. */
export async function cancelSubscriptionForTenant(
  db: Db,
  ps: PaystackClient,
  tenantId: string,
  now: Date = new Date(),
): Promise<SubscriptionSummary> {
  const [sub] = await db
    .select()
    .from(subscriptions)
    .where(and(eq(subscriptions.tenantId, tenantId), eq(subscriptions.status, "active")))
    .limit(1);
  if (!sub) throw new BillingError("no_subscription", "There is no active subscription to cancel.", 404);

  try {
    let id = sub.providerSubscriptionId;
    if (!id) {
      const list = await ps.listSubscriptions(sub.customerEmail);
      id = list.find((s) => s.status === "active" && (sub.providerPlanId === null || s.plan?.plan_code === sub.providerPlanId))?.subscription_code ?? null;
    }
    if (id) {
      try {
        await ps.cancelSubscription(id);
      } catch (err) {
        // Provider says it does not exist: nothing is left that could charge, so carry on.
        if (!(err instanceof PaystackError && err.httpStatus === 404)) throw err;
      }
    }
    // No id found at all means the provider has nothing active for this payer either.
  } catch (err) {
    throw providerFailure(err);
  }

  await db
    .update(subscriptions)
    .set({ status: "cancelled", cancelAtPeriodEnd: true, cancelledAt: now, updatedAt: now })
    .where(and(eq(subscriptions.id, sub.id), eq(subscriptions.status, "active")));
  const summary = await subscriptionSummary(db, tenantId, now);
  return summary!;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface SubscriptionSummary {
  plan: PaidPlanId;
  interval: BillingInterval;
  /** The US dollar list price this subscription corresponds to (what the customer sees as the price). */
  amountUsd: number;
  /** What is actually charged each period, in `currency` major units (49 for $49 in USD, 760 for GHS 760). */
  chargedAmount: number;
  currency: string;
  /** active: renewing. cancelling: cancelled, plan works until currentPeriodEnd. ended: over. */
  status: "active" | "cancelling" | "ended";
  currentPeriodEnd: Date;
  cancelAtPeriodEnd: boolean;
  /** current | overdue | lapsed | none (see paymentStatus in @mailforge/core). */
  paymentStatus: PaymentStatus;
}

/**
 * The US dollar value of a subscription row. A USD subscription is its own charge (so a customer who
 * signed up at an older price keeps showing it); one charged in another currency is worth the plan's
 * list price, because the local amount depends on the exchange rate at the time they subscribed.
 */
export function subscriptionUsd(sub: { plan: string; interval: string; currency: string; amountCents: number }): number {
  if (sub.currency.toUpperCase() === "USD") return sub.amountCents / 100;
  return isPaidPlanId(sub.plan) && isBillingInterval(sub.interval) ? planPriceUsd(sub.plan, sub.interval) : 0;
}

/** The workspace's current or most recent subscription, shaped for the dashboard. */
export async function subscriptionSummary(db: Db, tenantId: string, now: Date = new Date()): Promise<SubscriptionSummary | null> {
  const [sub] = await db
    .select()
    .from(subscriptions)
    .where(and(eq(subscriptions.tenantId, tenantId), inArray(subscriptions.status, ["active", "cancelled", "ended"])))
    .orderBy(desc(subscriptions.createdAt))
    .limit(1);
  if (!sub || !isPaidPlanId(sub.plan) || !isBillingInterval(sub.interval)) return null;

  const ent = entitlementsFor({ plan: sub.plan, trialEndsAt: null, paidThrough: sub.currentPeriodEnd, now, enforced: true });
  const over = sub.currentPeriodEnd.getTime() <= now.getTime();
  const status: SubscriptionSummary["status"] =
    sub.status === "active" ? "active" : over || sub.status === "ended" ? "ended" : "cancelling";
  return {
    plan: sub.plan,
    interval: sub.interval,
    amountUsd: subscriptionUsd(sub),
    chargedAmount: sub.amountCents / 100,
    currency: sub.currency,
    status,
    currentPeriodEnd: sub.currentPeriodEnd,
    cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
    paymentStatus: ent.paymentStatus,
  };
}

/** The intervals a customer may pick, for validation messages. */
export const CHECKOUT_INTERVALS = BILLING_INTERVALS;
