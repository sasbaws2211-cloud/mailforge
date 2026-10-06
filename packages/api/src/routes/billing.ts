/**
 * Billing routes for signed-in owners.
 *
 *   POST /v1/billing/checkout   { plan, interval }  -> { url }   start a payment
 *   POST /v1/billing/cancel                          -> subscription summary
 *
 * Only owners can change the plan. When billing is not configured both answer
 * 503, so the dashboard can fall back to its "contact us" link.
 *
 * Mirror side: PUBLIC (packages/api is mirrored).
 */
import type { FastifyPluginAsync } from "fastify";
import { eq } from "drizzle-orm";
import { isBillingInterval, isPaidPlanId } from "@mailforge/core";
import { tenants, users } from "@mailforge/db/schema";
import type { Db } from "../plugins/db.js";
import type { BillingRuntime } from "../billing/config.js";
import { BillingError, cancelSubscriptionForTenant, startCheckout } from "../billing/service.js";

export interface BillingRouteOptions {
  runtime: BillingRuntime;
  /** Absolute URL of GET /billing/return, where the provider sends the customer back. */
  returnUrl: string;
}

const NOT_AVAILABLE = { error: "Online billing is not available on this install.", code: "billing_disabled" } as const;

const billingRoutes: FastifyPluginAsync<BillingRouteOptions> = async (app, opts) => {
  const { runtime, returnUrl } = opts;

  app.post<{ Body: { plan?: unknown; interval?: unknown } }>(
    "/checkout",
    { config: { minRole: "owner" } },
    async (request, reply) => {
      if (!runtime.enabled || !runtime.client) return reply.status(503).send(NOT_AVAILABLE);
      const db: Db = request.server.db;
      const { plan, interval } = request.body ?? {};
      if (!isPaidPlanId(plan) || !isBillingInterval(interval)) {
        return reply.status(400).send({ error: "Choose a paid plan (starter, growth or scale) and monthly or yearly billing.", code: "invalid_plan" });
      }

      const [user] = await db.select({ email: users.email }).from(users).where(eq(users.id, request.tenant!.userId)).limit(1);
      const [tenant] = await db.select({ name: tenants.name }).from(tenants).where(eq(tenants.id, request.tenant!.id)).limit(1);
      if (!user || !tenant) return reply.status(404).send({ error: "Account not found." });

      try {
        const { url } = await startCheckout(
          db,
          runtime.client,
          { currency: runtime.currency, returnUrl },
          {
            tenantId: request.tenant!.id,
            userId: request.tenant!.userId,
            email: user.email,
            workspaceName: tenant.name,
            plan,
            interval,
          },
        );
        return { url };
      } catch (err) {
        if (err instanceof BillingError) return reply.status(err.httpStatus).send(err.toJSON());
        throw err;
      }
    },
  );

  app.post("/cancel", { config: { minRole: "owner" } }, async (request, reply) => {
    if (!runtime.enabled || !runtime.client) return reply.status(503).send(NOT_AVAILABLE);
    try {
      const summary = await cancelSubscriptionForTenant(request.server.db as Db, runtime.client, request.tenant!.id);
      return { subscription: { ...summary, currentPeriodEnd: summary.currentPeriodEnd.toISOString() } };
    } catch (err) {
      if (err instanceof BillingError) return reply.status(err.httpStatus).send(err.toJSON());
      throw err;
    }
  });
};

export default billingRoutes;
