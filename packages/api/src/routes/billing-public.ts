/**
 * Public billing endpoints, called by Paystack and by the customer's browser.
 *
 *   POST /webhooks/paystack   events from Paystack (charge.success, subscription.create,
 *                             subscription.disable, subscription.not_renew)
 *   GET  /billing/return      where Paystack sends the customer after the hosted checkout
 *
 * Neither is trusted on its own:
 *   - The webhook must carry a valid x-paystack-signature: the HMAC SHA-512 of the raw
 *     body under our secret key, compared in constant time. Even then the transaction is
 *     fetched from the provider's verify endpoint and only that answer is used.
 *   - The return page is just a browser redirect anyone could forge. It carries our own
 *     checkout reference; we verify THAT reference with the provider and apply only what
 *     the provider says about it.
 *
 * Webhook answers are chosen for the provider's retry rule (it retries failures for a
 * while): 200 means "handled, do not retry" (including events we deliberately ignore),
 * 401 is a bad signature, and 500 asks for a retry when we could not finish for a reason
 * that may pass (provider unreachable, our key wrong).
 *
 * Mirror side: PUBLIC (packages/api is mirrored).
 */
import type { FastifyPluginAsync } from "fastify";
import { eq } from "drizzle-orm";
import { billingCheckouts } from "@mailforge/db/schema";
import type { Db } from "../plugins/db.js";
import type { BillingRuntime } from "../billing/config.js";
import { PaystackError, verifyPaystackSignature } from "../billing/paystack.js";
import { applySubscriptionCancelled, applySubscriptionCreated, applyVerifiedPayment } from "../billing/service.js";

export interface BillingPublicOptions {
  runtime: BillingRuntime;
  /** Where the customer lands afterwards: the dashboard origin. */
  dashboardUrl: string;
}

export type ReturnState = "success" | "failed" | "cancelled" | "pending" | "unknown";

const billingPublicRoutes: FastifyPluginAsync<BillingPublicOptions> = async (app, opts) => {
  const { runtime, dashboardUrl } = opts;
  const ps = runtime.client!;

  // The signature covers the exact bytes Paystack sent, so keep the body as a string and
  // parse it ourselves after it has been checked. (Scoped to this plugin only.)
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    done(null, body);
  });

  // --- Webhook -------------------------------------------------------------------------
  app.post("/webhooks/paystack", async (request, reply) => {
    const rawBody = typeof request.body === "string" ? request.body : "";
    if (!runtime.webhookSecret || !verifyPaystackSignature(rawBody, request.headers["x-paystack-signature"], runtime.webhookSecret)) {
      return reply.status(401).send({ error: "Invalid signature." });
    }
    const db: Db = request.server.db;
    let body: { event?: unknown; data?: Record<string, any> };
    try {
      body = JSON.parse(rawBody) as typeof body;
    } catch {
      return reply.status(400).send({ error: "Invalid JSON payload." });
    }
    const event = typeof body?.event === "string" ? body.event : "";
    const data = body?.data ?? {};

    try {
      if (event === "charge.success") {
        if (typeof data.reference !== "string" || data.reference === "") return { ok: true, ignored: "no transaction reference" };
        // Never trust the body: ask the provider what actually happened.
        const tx = await ps.verifyTransaction(data.reference);
        const result = await applyVerifiedPayment(db, ps, tx);
        request.log.info({ outcome: result.outcome, reason: result.reason, tenantId: result.tenantId, txId: tx.id }, "paystack charge processed");
        return { ok: true, outcome: result.outcome };
      }

      if (event === "subscription.create") {
        const result = await applySubscriptionCreated(db, {
          subscriptionCode: data.subscription_code ?? null,
          email: data.customer?.email ?? null,
          planCode: data.plan?.plan_code ?? null,
        });
        request.log.info({ outcome: result.outcome, reason: result.reason, tenantId: result.tenantId }, "paystack subscription creation processed");
        return { ok: true, outcome: result.outcome };
      }

      if (event === "subscription.disable" || event === "subscription.not_renew") {
        const result = await applySubscriptionCancelled(db, {
          subscriptionId: data.subscription_code ?? null,
          email: data.customer?.email ?? null,
          planId: data.plan?.plan_code ?? null,
        });
        request.log.info({ event, outcome: result.outcome, reason: result.reason, tenantId: result.tenantId }, "paystack subscription cancellation processed");
        return { ok: true, outcome: result.outcome };
      }

      return { ok: true, ignored: "event not handled" };
    } catch (err) {
      // A transaction the provider has never heard of (for example a test-mode event sent
      // to a live install) can never succeed on retry: acknowledge it and move on.
      if (err instanceof PaystackError && err.httpStatus === 404) {
        request.log.warn({ event }, "paystack webhook: unknown transaction, ignored");
        return { ok: true, ignored: "unknown transaction" };
      }
      // Anything else (provider down, our key rejected, a database error) may pass:
      // ask Paystack to try again later.
      request.log.error({ err: err instanceof Error ? err.message : String(err), event }, "paystack webhook failed, asking for a retry");
      return reply.status(500).send({ error: "Could not process the event; please retry." });
    }
  });

  // --- Customer return -----------------------------------------------------------------
  // Paystack appends ?trxref=<ref>&reference=<ref> to the callback URL after a payment. When
  // the customer closes the payment page instead, it sends them to our cancel URL, which
  // carries ?status=cancelled&reference=<ref> (see startCheckout).
  app.get<{ Querystring: { status?: string; reference?: string; trxref?: string } }>("/billing/return", async (request, reply) => {
    const db: Db = request.server.db;
    const go = (state: ReturnState) => reply.redirect(`${dashboardUrl}/settings/plan?billing=${state}`);

    const { status } = request.query;
    const reference = request.query.reference || request.query.trxref;
    if (!reference) return go("unknown");
    const [checkout] = await db.select().from(billingCheckouts).where(eq(billingCheckouts.txRef, reference)).limit(1);
    if (!checkout) return go("unknown");

    if (status === "cancelled") {
      if (checkout.status === "pending") await db.update(billingCheckouts).set({ status: "cancelled", completedAt: new Date() }).where(eq(billingCheckouts.id, checkout.id));
      return go("cancelled");
    }

    try {
      // Verified by OUR reference, so the answer is about this checkout and no other.
      const tx = await ps.verifyTransaction(reference);
      if (tx.reference !== reference) return go("unknown");
      await applyVerifiedPayment(db, ps, tx);
      const [after] = await db.select({ status: billingCheckouts.status }).from(billingCheckouts).where(eq(billingCheckouts.id, checkout.id)).limit(1);
      return go(after?.status === "paid" ? "success" : after?.status === "pending" ? "pending" : "failed");
    } catch (err) {
      // Could not confirm just now. The webhook will finish the job; tell the customer so.
      request.log.warn({ err: err instanceof Error ? err.message : String(err) }, "billing return: could not verify yet");
      return go("pending");
    }
  });
};

export default billingPublicRoutes;
