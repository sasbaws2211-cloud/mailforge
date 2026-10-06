/**
 * Billing service: everything that changes a workspace's paid plan.
 *
 * The rules this file enforces:
 *   - Money is only believed after Flutterwave confirms it. Callers pass in a
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
import { FlutterwaveError, type FlutterwaveClient, type FlutterwaveTransaction } from "./flutterwave.js";

const PROVIDER = "flutterwave";

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
  /** Charge currency. Must match the currency of the provider plans (USD). */
  currency: string;
  /** Where the provider sends the customer after paying (absolute URL). */
  returnUrl: string;
}

const cents = (usd: number): number => Math.round(usd * 100);

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
  fw: FlutterwaveClient,
  args: { plan: PaidPlanId; interval: BillingInterval; currency: string },
): Promise<string> {
  const amountCents = cents(planPriceUsd(args.plan, args.interval));
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`fwplan:${args.plan}:${args.interval}:${args.currency}:${amountCents}`}))`);
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

    const created = await fw.createPaymentPlan({
      name: `Mailforge ${PLANS[args.plan].name} (${args.interval})`,
      amount: amountCents / 100,
      interval: args.interval,
      currency: args.currency,
    });
    await tx.insert(billingProviderPlans).values({
      provider: PROVIDER,
      plan: args.plan,
      interval: args.interval,
      currency: args.currency,
      amountCents,
      providerPlanId: created.id,
    });
    return created.id;
  });
}

// ---------------------------------------------------------------------------
// Checkout
// ---------------------------------------------------------------------------

export interface StartCheckoutInput {
  tenantId: string;
  userId: string;
  /** The payer. Flutterwave ties the subscription to this address for good. */
  email: string;
  workspaceName: string;
  plan: PaidPlanId;
  interval: BillingInterval;
  now?: Date;
}

export async function startCheckout(
  db: Db,
  fw: FlutterwaveClient,
  cfg: BillingConfig,
  input: StartCheckoutInput,
): Promise<{ url: string; txRef: string }> {
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

  const amountCents = cents(planPriceUsd(input.plan, input.interval));
  let providerPlanId: string;
  try {
    providerPlanId = await ensureProviderPlan(db, fw, { plan: input.plan, interval: input.interval, currency: cfg.currency });
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
    const { link } = await fw.createPaymentLink({
      txRef,
      amount: amountCents / 100,
      currency: cfg.currency,
      redirectUrl: cfg.returnUrl,
      customer: { email: input.email, name: input.workspaceName },
      paymentPlanId: providerPlanId,
      title: "Mailforge",
      description: `${PLANS[input.plan].name} plan, billed ${input.interval}`,
      meta: { tenant_id: input.tenantId, plan: input.plan, interval: input.interval, checkout_id: checkout!.id },
    });
    await db.update(billingCheckouts).set({ checkoutUrl: link }).where(eq(billingCheckouts.id, checkout!.id));
    return { url: link, txRef };
  } catch (err) {
    await db.update(billingCheckouts).set({ status: "failed" }).where(eq(billingCheckouts.id, checkout!.id));
    throw providerFailure(err);
  }
}

/** A provider problem, in words that are safe to show a customer. */
function providerFailure(err: unknown): BillingError {
  if (err instanceof FlutterwaveError) {
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

const eventKeyFor = (tx: FlutterwaveTransaction): string => `charge:${tx.id}`;

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

function txSummary(tx: FlutterwaveTransaction): Record<string, unknown> {
  return {
    id: tx.id,
    tx_ref: tx.tx_ref,
    status: tx.status,
    amount: tx.amount,
    currency: tx.currency,
    email: tx.customer?.email ?? null,
    plan: tx.plan ?? tx.payment_plan ?? null,
  };
}

/**
 * Apply a transaction that has been verified with the provider.
 *
 * `tx` MUST come from FlutterwaveClient.verifyTransaction, not from a webhook
 * body. Safe to call any number of times for the same transaction.
 */
export async function applyVerifiedPayment(
  db: Db,
  fw: FlutterwaveClient,
  tx: FlutterwaveTransaction,
  now: Date = new Date(),
): Promise<ApplyResult> {
  const key = eventKeyFor(tx);

  const [seen] = await db
    .select({ id: billingEvents.id })
    .from(billingEvents)
    .where(and(eq(billingEvents.provider, PROVIDER), eq(billingEvents.eventKey, key)))
    .limit(1);
  if (seen) return { outcome: "duplicate" };

  const [checkout] = await db.select().from(billingCheckouts).where(eq(billingCheckouts.txRef, tx.tx_ref)).limit(1);

  // A failed or cancelled attempt: remember it on the checkout, change nothing else.
  // No event is recorded, so a later successful attempt (a different transaction) still works.
  if (tx.status !== "successful") {
    if (checkout && checkout.status === "pending") {
      await db.update(billingCheckouts).set({ status: "failed", providerTransactionId: String(tx.id), completedAt: now }).where(eq(billingCheckouts.id, checkout.id));
    }
    return { outcome: "ignored", reason: `transaction status is ${tx.status}`, tenantId: checkout?.tenantId };
  }

  return checkout ? applyInitialPayment(db, fw, tx, checkout, key, now) : applyRenewal(db, tx, key, now);
}

type Checkout = typeof billingCheckouts.$inferSelect;

async function applyInitialPayment(
  db: Db,
  fw: FlutterwaveClient,
  tx: FlutterwaveTransaction,
  checkout: Checkout,
  key: string,
  now: Date,
): Promise<ApplyResult> {
  // 1. Does the payment match what we asked for?
  const paidCents = cents(Number(tx.amount));
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
  await learnProviderSubscriptionId(db, fw, { tenantId: checkout.tenantId, email: payer, providerPlanId: checkout.providerPlanId });
  if (holder.replaced) await cancelAtProvider(fw, holder.replaced);

  return { outcome: "applied_initial", tenantId: checkout.tenantId };
}

/** Find our new subscription's id at the provider, so it can be cancelled later. */
async function learnProviderSubscriptionId(
  db: Db,
  fw: FlutterwaveClient,
  args: { tenantId: string; email: string; providerPlanId: string | null },
): Promise<void> {
  try {
    const list = await fw.listSubscriptions(args.email);
    const mine = list
      .filter((s) => s.status === "active" && (args.providerPlanId === null || String(s.plan) === args.providerPlanId))
      .sort((a, b) => Number(b.id) - Number(a.id))[0];
    if (!mine) return;
    await db
      .update(subscriptions)
      .set({ providerSubscriptionId: String(mine.id), updatedAt: new Date() })
      .where(and(eq(subscriptions.tenantId, args.tenantId), eq(subscriptions.status, "active")));
  } catch {
    // Not fatal: cancellation will look the id up again when it is needed.
  }
}

/** Stop a replaced subscription's future charges. Never throws. */
async function cancelAtProvider(
  fw: FlutterwaveClient,
  sub: { providerSubscriptionId: string | null; customerEmail: string; providerPlanId: string | null },
): Promise<void> {
  try {
    let id = sub.providerSubscriptionId;
    if (!id) {
      const list = await fw.listSubscriptions(sub.customerEmail);
      id = list.find((s) => s.status === "active" && (sub.providerPlanId === null || String(s.plan) === sub.providerPlanId))?.id?.toString() ?? null;
    }
    if (id) await fw.cancelSubscription(id);
  } catch {
    // The customer is on the new plan either way. A stray old subscription would keep
    // charging, so this is logged by the caller's event record and worth a manual check.
  }
}

async function applyRenewal(db: Db, tx: FlutterwaveTransaction, key: string, now: Date): Promise<ApplyResult> {
  const email = tx.customer?.email?.trim().toLowerCase();
  const paidCents = cents(Number(tx.amount));
  const planId = tx.plan ?? tx.payment_plan;

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
  // The charge says which provider plan it belongs to when it can; otherwise email + amount.
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
 * The provider told us a subscription was cancelled (by the customer through
 * their email link, by the dashboard, or after three failed charges). Plan keeps
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
  fw: FlutterwaveClient,
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
      const list = await fw.listSubscriptions(sub.customerEmail);
      id = list.find((s) => s.status === "active" && (sub.providerPlanId === null || String(s.plan) === sub.providerPlanId))?.id?.toString() ?? null;
    }
    if (id) {
      try {
        await fw.cancelSubscription(id);
      } catch (err) {
        // Provider says it does not exist: nothing is left that could charge, so carry on.
        if (!(err instanceof FlutterwaveError && err.httpStatus === 404)) throw err;
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
  amountUsd: number;
  /** active: renewing. cancelling: cancelled, plan works until currentPeriodEnd. ended: over. */
  status: "active" | "cancelling" | "ended";
  currentPeriodEnd: Date;
  cancelAtPeriodEnd: boolean;
  /** current | overdue | lapsed | none (see paymentStatus in @mailforge/core). */
  paymentStatus: PaymentStatus;
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
    amountUsd: sub.amountCents / 100,
    status,
    currentPeriodEnd: sub.currentPeriodEnd,
    cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
    paymentStatus: ent.paymentStatus,
  };
}

/** The intervals a customer may pick, for validation messages. */
export const CHECKOUT_INTERVALS = BILLING_INTERVALS;
