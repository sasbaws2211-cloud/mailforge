/**
 * Plan route: the workspace's plan, trial status and usage against its limits.
 *
 *   GET /v1/plan
 *
 * Read by the dashboard for the trial banner and the Plan & usage page. When
 * plan enforcement is off (self-hosted default) it still answers, with
 * enforced:false and every limit null, so the dashboard knows to show nothing.
 *
 * Mirror side: PUBLIC (packages/api is mirrored).
 */
import type { FastifyPluginAsync } from "fastify";
import {
  BILLING_GRACE_DAYS,
  PLANS,
  PLAN_IDS,
  limitFor,
  startOfNextMonthUtc,
  usageFraction,
  type LimitKind,
} from "@mailforge/core";
import type { Db } from "../plugins/db.js";
import { loadEntitlements, loadUsage } from "../plan/usage.js";
import type { BillingRuntime } from "../billing/config.js";
import { subscriptionSummary } from "../billing/service.js";
import { loadAiStatus } from "../ai/resolver.js";

export type MeterState = "unlimited" | "ok" | "near" | "at_limit" | "over";

/** Share of a limit at which we start warning. */
export const NEAR_LIMIT_FRACTION = 0.8;

export function meterState(limit: number | null, used: number): MeterState {
  if (limit === null) return "unlimited";
  if (used > limit) return "over";
  if (used === limit) return "at_limit";
  const f = usageFraction(limit, used);
  return f !== null && f >= NEAR_LIMIT_FRACTION ? "near" : "ok";
}

const planRoutes: FastifyPluginAsync<{ billing?: BillingRuntime }> = async (app, opts) => {
  const billing = opts.billing;
  app.get("/", { config: { minRole: "member" } }, async (request) => {
    const db: Db = request.server.db;
    const tenantId = request.tenant!.id;
    const now = new Date();
    const [ent, usage, subscription, ai] = await Promise.all([
      loadEntitlements(db, tenantId, now),
      loadUsage(db, tenantId, now),
      subscriptionSummary(db, tenantId, now),
      loadAiStatus(db, tenantId, now),
    ]);

    const used: Record<LimitKind, number> = {
      contacts: usage.contacts,
      emails: usage.emailsThisMonth,
      seats: usage.seats,
      ai: ai.allowance.used,
    };
    const meter = (kind: LimitKind) => {
      const limit = limitFor(ent, kind);
      return { used: used[kind], limit, state: meterState(limit, used[kind]) };
    };

    return {
      enforced: ent.enforced,
      plan: { id: ent.plan, name: PLANS[ent.plan].name, tagline: PLANS[ent.plan].tagline },
      stored_plan: ent.storedPlan,
      shows_powered_by: ent.showsPoweredBy,
      // Where a customer asks to change plan until self-serve billing exists.
      support_email: process.env.MAILFORGE_SUPPORT_EMAIL?.trim() || null,
      // Money: whether the customer can pay online here, and their subscription if any.
      billing: {
        enabled: billing?.enabled === true,
        currency: billing?.currency ?? "USD",
        subscription: subscription
          ? {
              plan: subscription.plan,
              interval: subscription.interval,
              amount_usd: subscription.amountUsd,
              status: subscription.status,
              current_period_end: subscription.currentPeriodEnd.toISOString(),
              cancel_at_period_end: subscription.cancelAtPeriodEnd,
            }
          : null,
      },
      // current | overdue (inside the grace period) | lapsed (now on Free) | none (no billing date)
      payment: {
        status: ent.paymentStatus,
        paid_through: ent.paidThrough ? ent.paidThrough.toISOString() : null,
        // The last moment the paid plan still works if no payment arrives.
        grace_ends_at: ent.paidThrough ? new Date(ent.paidThrough.getTime() + BILLING_GRACE_DAYS * 86_400_000).toISOString() : null,
      },
      trial: {
        active: ent.onTrial,
        expired: ent.trialExpired,
        ends_at: ent.trialEndsAt ? ent.trialEndsAt.toISOString() : null,
        days_left: ent.trialDaysLeft,
      },
      meters: {
        contacts: meter("contacts"),
        emails: { ...meter("emails"), resets_at: startOfNextMonthUtc(now).toISOString() },
        seats: { ...meter("seats"), members: usage.members, pending_invites: usage.pendingInvites },
        // Mailforge AI tokens. Only calls served by the platform's provider count; a workspace on
        // its own key is never capped (source: "byok").
        ai: { ...meter("ai"), source: ai.source, resets_at: startOfNextMonthUtc(now).toISOString() },
      },
      plans: PLAN_IDS.map((id) => {
        const p = PLANS[id];
        return {
          id,
          name: p.name,
          tagline: p.tagline,
          price_monthly_usd: p.priceMonthlyUsd,
          price_annual_usd: p.priceAnnualUsd,
          limits: {
            contacts: p.limits.contacts,
            emails_per_month: p.limits.emailsPerMonth,
            seats: p.limits.seats,
            ai_tokens_per_month: p.limits.aiTokensPerMonth,
          },
          features: p.features,
          recommended: Boolean(p.recommended),
          current: id === ent.plan,
        };
      }),
    };
  });
};

export default planRoutes;
