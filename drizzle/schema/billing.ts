import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { tenants } from "./tenants.js";
import { users } from "./users.js";

/**
 * Billing tables. The payment provider (Flutterwave) is recorded on every row
 * so a second provider could be added without a schema change.
 *
 * Money is stored in minor units (cents) as integers, never floats.
 *
 * Mirror side: PUBLIC (drizzle/ is mirrored).
 */

/**
 * A paid subscription for a workspace.
 *
 * status:
 *   active     renewing; current_period_end moves forward on every successful charge
 *   cancelled  the customer cancelled: no more charges, but the plan keeps working
 *              until current_period_end (cancel_at_period_end is true)
 *   ended      the period ran out after a cancellation or a failed renewal
 *   replaced   the customer moved to another plan; this one was cancelled with the provider
 *
 * At most one subscription per workspace is live (active or cancelled), enforced
 * by a partial unique index.
 */
export const subscriptions = pgTable(
  "subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    provider: text("provider").notNull().default("flutterwave"),
    /** starter | growth | scale */
    plan: text("plan").notNull(),
    /** monthly | yearly */
    interval: text("interval").notNull(),
    amountCents: integer("amount_cents").notNull(),
    currency: text("currency").notNull().default("USD"),
    status: text("status").notNull(),
    /** The payer. Flutterwave ties a subscription to this address; it cannot change. */
    customerEmail: text("customer_email").notNull(),
    /** The provider's payment plan id this subscription charges under. */
    providerPlanId: text("provider_plan_id"),
    /** The provider's subscription id, once known (needed to cancel). */
    providerSubscriptionId: text("provider_subscription_id"),
    currentPeriodStart: timestamp("current_period_start", { withTimezone: true }).notNull(),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }).notNull(),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    lastPaymentAt: timestamp("last_payment_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("idx_subscriptions_tenant").on(t.tenantId),
    index("idx_subscriptions_payer").on(t.provider, t.customerEmail),
    uniqueIndex("uq_subscriptions_one_live_per_tenant")
      .on(t.tenantId)
      .where(sql`status IN ('active', 'cancelled')`),
  ],
);

/**
 * One attempt to pay: created when a customer starts checkout, and matched by
 * tx_ref when the provider redirects back or sends a webhook.
 *
 * status: pending | paid | failed | cancelled
 */
export const billingCheckouts = pgTable(
  "billing_checkouts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    userId: uuid("user_id").references(() => users.id),
    /** Our unique reference, sent to the provider and echoed back. */
    txRef: text("tx_ref").notNull(),
    plan: text("plan").notNull(),
    interval: text("interval").notNull(),
    amountCents: integer("amount_cents").notNull(),
    currency: text("currency").notNull().default("USD"),
    providerPlanId: text("provider_plan_id"),
    customerEmail: text("customer_email").notNull(),
    status: text("status").notNull().default("pending"),
    checkoutUrl: text("checkout_url"),
    providerTransactionId: text("provider_transaction_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("uq_billing_checkouts_tx_ref").on(t.txRef),
    index("idx_billing_checkouts_tenant").on(t.tenantId, t.createdAt),
  ],
);

/**
 * Every provider event we act on, keyed so the same event is never applied
 * twice (providers retry webhooks). event_key is the provider's own identifier
 * for the thing that happened, for example "charge:285959875".
 */
export const billingEvents = pgTable(
  "billing_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: text("provider").notNull(),
    eventKey: text("event_key").notNull(),
    eventType: text("event_type").notNull(),
    tenantId: uuid("tenant_id").references(() => tenants.id),
    /** What we did: applied | ignored | rejected, with a short reason. */
    outcome: text("outcome").notNull(),
    payload: jsonb("payload"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("uq_billing_events_key").on(t.provider, t.eventKey)],
);

/**
 * Maps one of our plans (plan + interval + exact price) to the plan we created
 * at the provider, so we create each provider plan once. A price change in
 * plans.ts makes a new row and a new provider plan; subscribers on the old one
 * keep paying the price they signed up for.
 */
export const billingProviderPlans = pgTable(
  "billing_provider_plans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: text("provider").notNull(),
    plan: text("plan").notNull(),
    interval: text("interval").notNull(),
    currency: text("currency").notNull(),
    amountCents: integer("amount_cents").notNull(),
    providerPlanId: text("provider_plan_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("uq_billing_provider_plans").on(t.provider, t.plan, t.interval, t.currency, t.amountCents),
  ],
);
