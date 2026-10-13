/**
 * Billing routes for signed-in owners.
 *
 *   POST /v1/billing/checkout   { plan, interval }  -> { url, reference, access_code }   start a payment
 *   POST /v1/billing/addons/checkout { kind, packs } -> { url, reference, access_code }   buy extra usage
 *   GET  /v1/billing/payments                        -> { payments: [...] }                  billing history
 *   GET  /v1/billing/receipts/:reference             -> HTML receipt (print or save as PDF)
 *   GET  /v1/billing/checkouts/:reference            -> { status, plan, interval }       poll one of your checkouts
 *   POST /v1/billing/cancel                          -> subscription summary
 *
 * Only owners can change the plan. When billing is not configured both answer
 * 503, so the dashboard can fall back to its "contact us" link.
 *
 * Mirror side: PUBLIC (packages/api is mirrored).
 */
import type { FastifyPluginAsync } from "fastify";
import { eq, sql } from "drizzle-orm";
import {
  ADDONS,
  PLANS,
  addonUnits,
  isAddonKind,
  isBillingInterval,
  isPaidPlanId,
  isPlanId,
  isValidPackCount,
  parseAddonCheckoutPlan,
} from "@loomail/core";
import { billingEvents, tenants, users } from "@loomail/db/schema";
import type { Db } from "../plugins/db.js";
import type { BillingRuntime } from "../billing/config.js";
import { BillingError, cancelSubscriptionForTenant, checkoutStatus, startAddonCheckout, startCheckout } from "../billing/service.js";
import { stopAddonRenewal } from "../billing/addon-renewals.js";

export interface BillingRouteOptions {
  runtime: BillingRuntime;
  /** Absolute URL of GET /billing/return, where the provider sends the customer back. */
  returnUrl: string;
}

/** Why a customer cancelled, as the dashboard offers it. Kept so the operator can see patterns. */
export const CANCEL_REASONS = ["too_expensive", "missing_feature", "not_using", "switched_tool", "just_testing", "other"] as const;

const esc = (v: unknown): string =>
  String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

interface PaymentRow {
  reference: string;
  paid_at: string;
  description: string;
  amount: number;
  currency: string;
  payer_email: string | null;
}

/** This workspace's successful payments, newest first, with what each one was for. */
async function loadPayments(db: Db, tenantId: string, onlyReference?: string): Promise<PaymentRow[]> {
  const events = await db.execute<{ created_at: Date | string; payload: Record<string, unknown> | null }>(sql`
    SELECT created_at, payload FROM billing_events
    WHERE tenant_id = ${tenantId}::uuid AND event_type = 'charge.completed' AND outcome LIKE 'applied%'
      ${onlyReference ? sql`AND payload->>'reference' = ${onlyReference}` : sql``}
    ORDER BY created_at DESC LIMIT 100`);
  const refs = events.rows.map((e) => String(e.payload?.reference ?? "")).filter(Boolean);
  const checkouts = new Map<string, { plan: string; interval: string }>();
  if (refs.length > 0) {
    const rows = await db.execute<{ tx_ref: string; plan: string; interval: string }>(sql`
      SELECT tx_ref, plan, interval FROM billing_checkouts
      WHERE tenant_id = ${tenantId}::uuid AND tx_ref = ANY(string_to_array(${refs.join(",")}, ','))`);
    for (const r of rows.rows) checkouts.set(r.tx_ref, { plan: r.plan, interval: r.interval });
  }
  const sub = await db.execute<{ plan: string }>(sql`
    SELECT plan FROM subscriptions WHERE tenant_id = ${tenantId}::uuid ORDER BY created_at DESC LIMIT 1`);
  const subPlan = sub.rows[0]?.plan;

  return events.rows.map((e) => {
    const ref = String(e.payload?.reference ?? "");
    const co = checkouts.get(ref);
    let description: string;
    const addon = co ? parseAddonCheckoutPlan(co.plan) : null;
    if (co && addon) {
      const packs = Number(co.interval.replace(/^x/, "")) || 1;
      description = `${ADDONS[addon].label}: +${addonUnits(addon, packs).toLocaleString("en-US")}`;
    } else if (co && isPlanId(co.plan)) {
      description = `${PLANS[co.plan].name} plan, billed ${co.interval}`;
    } else {
      description = `${subPlan && isPlanId(subPlan) ? PLANS[subPlan].name : "Subscription"} plan, renewal`;
    }
    return {
      reference: ref,
      paid_at: new Date(e.created_at).toISOString(),
      description,
      amount: Number(e.payload?.amount ?? 0) / 100,
      currency: String(e.payload?.currency ?? "USD").toUpperCase(),
      payer_email: typeof e.payload?.email === "string" ? e.payload.email : null,
    };
  });
}

function money(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency, currencyDisplay: "narrowSymbol" }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

function receiptHtml(p: PaymentRow, workspace: { name: string; address: string | null }): string {
  const when = new Date(p.paid_at).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Receipt ${esc(p.reference)}</title>
<style>
body{font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#1f2430;max-width:640px;margin:40px auto;padding:0 20px}
h1{font-size:22px;margin:0 0 4px}.muted{color:#5b6070}table{width:100%;border-collapse:collapse;margin:24px 0}
td,th{text-align:left;padding:10px 0;border-bottom:1px solid #e3e5ea}th{font-weight:600;font-size:13px;color:#5b6070}
.r{text-align:right}.total td{font-weight:700;border-bottom:0}.btn{margin-top:24px}
@media print{.btn{display:none}body{margin:0}}
</style></head><body>
<h1>Receipt</h1>
<p class="muted">Loomail &middot; ${esc(when)}</p>
<p><strong>${esc(workspace.name)}</strong>${workspace.address ? `<br>${esc(workspace.address).replace(/\n/g, "<br>")}` : ""}${p.payer_email ? `<br>${esc(p.payer_email)}` : ""}</p>
<table><thead><tr><th>Description</th><th class="r">Amount</th></tr></thead><tbody>
<tr><td>${esc(p.description)}</td><td class="r">${esc(money(p.amount, p.currency))}</td></tr>
<tr class="total"><td>Total paid</td><td class="r">${esc(money(p.amount, p.currency))}</td></tr>
</tbody></table>
<p class="muted">Payment reference: ${esc(p.reference)}</p>
<button class="btn" onclick="window.print()">Print or save as PDF</button>
</body></html>`;
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
        return reply.status(400).send({ error: "Choose the Essential plan and monthly billing.", code: "invalid_plan" });
      }

      const [user] = await db.select({ email: users.email }).from(users).where(eq(users.id, request.tenant!.userId)).limit(1);
      const [tenant] = await db.select({ name: tenants.name }).from(tenants).where(eq(tenants.id, request.tenant!.id)).limit(1);
      if (!user || !tenant) return reply.status(404).send({ error: "Account not found." });

      try {
        const { url, txRef, accessCode } = await startCheckout(
          db,
          runtime.client,
          { currency: runtime.currency, usdRate: runtime.usdRate, returnUrl },
          {
            tenantId: request.tenant!.id,
            userId: request.tenant!.userId,
            email: user.email,
            workspaceName: tenant.name,
            plan,
            interval,
          },
        );
        // `url` is the hosted page (the fallback); `access_code` opens the same payment in the inline popup.
        return { url, reference: txRef, access_code: accessCode };
      } catch (err) {
        if (err instanceof BillingError) return reply.status(err.httpStatus).send(err.toJSON());
        throw err;
      }
    },
  );

  // Prepaid top-up: extra profiles, emails or AI credits for the current month.
  app.post<{ Body: { kind?: unknown; packs?: unknown; repeat?: unknown } }>(
    "/addons/checkout",
    { config: { minRole: "owner" } },
    async (request, reply) => {
      if (!runtime.enabled || !runtime.client) return reply.status(503).send(NOT_AVAILABLE);
      const db: Db = request.server.db;
      const { kind, packs, repeat } = request.body ?? {};
      if (!isAddonKind(kind) || !isValidPackCount(packs)) {
        return reply.status(400).send({ error: "Choose profiles, emails or AI credits and a number of packs from 1 to 100.", code: "invalid_addon" });
      }
      const [user] = await db.select({ email: users.email }).from(users).where(eq(users.id, request.tenant!.userId)).limit(1);
      const [tenant] = await db.select({ name: tenants.name }).from(tenants).where(eq(tenants.id, request.tenant!.id)).limit(1);
      if (!user || !tenant) return reply.status(404).send({ error: "Account not found." });
      try {
        const { url, txRef, accessCode } = await startAddonCheckout(
          db,
          runtime.client,
          { currency: runtime.currency, usdRate: runtime.usdRate, returnUrl },
          { tenantId: request.tenant!.id, userId: request.tenant!.userId, email: user.email, workspaceName: tenant.name, kind, packs, repeat: repeat === true },
        );
        return { url, reference: txRef, access_code: accessCode };
      } catch (err) {
        if (err instanceof BillingError) return reply.status(err.httpStatus).send(err.toJSON());
        throw err;
      }
    },
  );

  // Stop a top-up that repeats every month, and forget the saved card.
  app.delete<{ Params: { kind: string } }>("/addons/auto/:kind", { config: { minRole: "owner" } }, async (request, reply) => {
    if (!isAddonKind(request.params.kind)) return reply.status(400).send({ error: "Unknown top-up.", code: "invalid_addon" });
    const removed = await stopAddonRenewal(request.server.db as Db, request.tenant!.id, request.params.kind);
    return { ok: true, removed };
  });

  // The page polls this while the payment popup is open. Only the workspace's own checkouts are visible.
  app.get<{ Params: { reference: string } }>("/checkouts/:reference", { config: { minRole: "owner" } }, async (request, reply) => {
    if (!runtime.enabled || !runtime.client) return reply.status(503).send(NOT_AVAILABLE);
    const found = await checkoutStatus(request.server.db as Db, runtime.client, request.tenant!.id, request.params.reference);
    if (!found) return reply.status(404).send({ error: "Checkout not found.", code: "checkout_not_found" });
    reply.header("Cache-Control", "no-store");
    return found;
  });

  // Billing history: every successful payment of this workspace, newest first.
  app.get("/payments", { config: { minRole: "owner" } }, async (request, reply) => {
    const payments = await loadPayments(request.server.db as Db, request.tenant!.id);
    reply.header("Cache-Control", "no-store");
    return {
      payments: payments.map((p) => ({ ...p, receipt_url: `/v1/billing/receipts/${encodeURIComponent(p.reference)}` })),
    };
  });

  // A printable receipt for one payment. Only this workspace's own payments exist here.
  app.get<{ Params: { reference: string } }>("/receipts/:reference", { config: { minRole: "owner" } }, async (request, reply) => {
    const db = request.server.db as Db;
    const [p] = await loadPayments(db, request.tenant!.id, request.params.reference);
    if (!p) return reply.status(404).send({ error: "Receipt not found.", code: "receipt_not_found" });
    const [t] = await db.select({ name: tenants.name, settings: tenants.settings }).from(tenants).where(eq(tenants.id, request.tenant!.id)).limit(1);
    const address = typeof (t?.settings as Record<string, unknown> | null)?.postal_address === "string" ? String((t!.settings as Record<string, unknown>).postal_address) : null;
    return reply
      .header("Content-Type", "text/html; charset=utf-8")
      .header("Cache-Control", "no-store")
      .send(receiptHtml(p, { name: t?.name ?? "Workspace", address }));
  });

  app.post<{ Body: { reason?: unknown; note?: unknown } }>("/cancel", { config: { minRole: "owner" } }, async (request, reply) => {
    if (!runtime.enabled || !runtime.client) return reply.status(503).send(NOT_AVAILABLE);
    try {
      const summary = await cancelSubscriptionForTenant(request.server.db as Db, runtime.client, request.tenant!.id);
      // Why they left, kept for the operator. Never blocks or fails the cancellation.
      const body = request.body ?? {};
      const reason = typeof body.reason === "string" && (CANCEL_REASONS as readonly string[]).includes(body.reason) ? body.reason : null;
      if (reason) {
        const note = typeof body.note === "string" ? body.note.trim().slice(0, 500) : "";
        try {
          await (request.server.db as Db)
            .insert(billingEvents)
            .values({
              provider: "paystack",
              eventKey: `cancel-feedback:${request.tenant!.id}:${Date.now()}`,
              eventType: "cancel.feedback",
              tenantId: request.tenant!.id,
              outcome: "recorded",
              payload: { reason, note: note || null },
            })
            .onConflictDoNothing();
        } catch {
          /* feedback is best effort */
        }
      }
      return { subscription: { ...summary, currentPeriodEnd: summary.currentPeriodEnd.toISOString() } };
    } catch (err) {
      if (err instanceof BillingError) return reply.status(err.httpStatus).send(err.toJSON());
      throw err;
    }
  });
};

export default billingRoutes;
