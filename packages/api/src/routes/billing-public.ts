/**
 * Public billing endpoints, called by Flutterwave and by the customer's browser.
 *
 *   POST /webhooks/flutterwave   events from Flutterwave (charge.completed, subscription.cancelled)
 *   GET  /billing/return         where Flutterwave sends the customer after the hosted checkout
 *
 * Neither is trusted on its own:
 *   - The webhook must carry the secret hash we configured (header verif-hash,
 *     compared in constant time). Even then the transaction is fetched from the
 *     provider's verify endpoint and only that answer is used.
 *   - The return page is just a browser redirect anyone could forge. It carries a
 *     tx_ref and a transaction id; we verify the transaction with the provider and
 *     require it to belong to that exact tx_ref before applying anything.
 *
 * Webhook answers are chosen for the provider's retry rule (3 retries, 30 minutes
 * apart): 200 means "handled, do not retry" (including events we deliberately
 * ignore), 401 is a bad signature, and 500 asks for a retry when we could not
 * finish for a reason that may pass (provider unreachable, our key wrong).
 *
 * Mirror side: PUBLIC (packages/api is mirrored).
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import { eq } from "drizzle-orm";
import { billingCheckouts } from "@mailforge/db/schema";
import type { Db } from "../plugins/db.js";
import type { BillingRuntime } from "../billing/config.js";
import { FlutterwaveError } from "../billing/flutterwave.js";
import { applySubscriptionCancelled, applyVerifiedPayment } from "../billing/service.js";

export interface BillingPublicOptions {
  runtime: BillingRuntime;
  /** Where the customer lands afterwards: the dashboard origin. */
  dashboardUrl: string;
}

/** Constant-time string comparison that does not leak length. */
export function safeEqual(a: unknown, b: string): boolean {
  if (typeof a !== "string") return false;
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

export type ReturnState = "success" | "failed" | "cancelled" | "pending" | "unknown";

const billingPublicRoutes: FastifyPluginAsync<BillingPublicOptions> = async (app, opts) => {
  const { runtime, dashboardUrl } = opts;
  const fw = runtime.client!;

  // --- Webhook -------------------------------------------------------------------------
  app.post("/webhooks/flutterwave", async (request, reply) => {
    if (!runtime.webhookHash || !safeEqual(request.headers["verif-hash"], runtime.webhookHash)) {
      return reply.status(401).send({ error: "Invalid signature." });
    }
    const db: Db = request.server.db;
    const body = (request.body ?? {}) as { event?: unknown; data?: Record<string, any> };
    const event = typeof body.event === "string" ? body.event : "";
    const data = body.data ?? {};

    try {
      if (event === "charge.completed") {
        if (data.id === undefined || data.id === null) return { ok: true, ignored: "no transaction id" };
        // Never trust the body: ask the provider what actually happened.
        const tx = await fw.verifyTransaction(data.id);
        const result = await applyVerifiedPayment(db, fw, tx);
        request.log.info({ outcome: result.outcome, reason: result.reason, tenantId: result.tenantId, txId: tx.id }, "flutterwave charge processed");
        return { ok: true, outcome: result.outcome };
      }

      if (event === "subscription.cancelled") {
        const result = await applySubscriptionCancelled(db, {
          subscriptionId: data.id ?? null,
          email: data.customer?.customer_email ?? data.customer?.email ?? data.email ?? null,
          planId: data.plan ?? data.payment_plan ?? null,
        });
        request.log.info({ outcome: result.outcome, reason: result.reason, tenantId: result.tenantId }, "flutterwave subscription cancellation processed");
        return { ok: true, outcome: result.outcome };
      }

      return { ok: true, ignored: "event not handled" };
    } catch (err) {
      // A transaction the provider has never heard of (for example a test-mode event sent
      // to a live install) can never succeed on retry: acknowledge it and move on.
      if (err instanceof FlutterwaveError && err.httpStatus === 404) {
        request.log.warn({ event }, "flutterwave webhook: unknown transaction, ignored");
        return { ok: true, ignored: "unknown transaction" };
      }
      // Anything else (provider down, our key rejected, a database error) may pass:
      // ask Flutterwave to try again later.
      request.log.error({ err: err instanceof Error ? err.message : String(err), event }, "flutterwave webhook failed, asking for a retry");
      return reply.status(500).send({ error: "Could not process the event; please retry." });
    }
  });

  // --- Customer return -----------------------------------------------------------------
  app.get<{ Querystring: { status?: string; tx_ref?: string; transaction_id?: string } }>("/billing/return", async (request, reply) => {
    const db: Db = request.server.db;
    const go = (state: ReturnState) => reply.redirect(`${dashboardUrl}/settings/plan?billing=${state}`);

    const { status, tx_ref: txRef, transaction_id: transactionId } = request.query;
    if (!txRef) return go("unknown");
    const [checkout] = await db.select().from(billingCheckouts).where(eq(billingCheckouts.txRef, txRef)).limit(1);
    if (!checkout) return go("unknown");

    if (status === "cancelled") {
      if (checkout.status === "pending") await db.update(billingCheckouts).set({ status: "cancelled", completedAt: new Date() }).where(eq(billingCheckouts.id, checkout.id));
      return go("cancelled");
    }
    if (!transactionId) return go("pending");

    try {
      const tx = await fw.verifyTransaction(transactionId);
      // The transaction must be for THIS checkout. Without this, someone could pair a
      // checkout reference with a different, genuinely paid, transaction id.
      if (tx.tx_ref !== txRef) return go("unknown");
      await applyVerifiedPayment(db, fw, tx);
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
