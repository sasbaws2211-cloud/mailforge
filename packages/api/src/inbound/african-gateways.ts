/**
 * Paystack and Flutterwave: turning their webhooks into what Loomail records (see mapping.ts for the shape, and for
 * Stripe). No database and no network. Written from the providers' own documentation:
 *
 * PAYSTACK (paystack.com/docs/payments/webhooks)
 *   - Every call carries x-paystack-signature: the HMAC-SHA512 (hex) of the raw body, made with the account's SECRET
 *     KEY. Paystack also publishes the three addresses it sends from, the same for test and live.
 *   - Payloads are { event, data }. They carry no event id and no dependable event time, and `metadata` is the number 0
 *     when empty. Amounts are in the smallest currency unit (kobo for NGN).
 *   - Subscription and invoice events carry the customer's email and customer_code.
 *   - Retried every 3 minutes four times, then hourly for 72 hours (live), until a 200.
 *
 * FLUTTERWAVE (developer.flutterwave.com/docs/webhooks)
 *   - A plain shared secret: the `verif-hash` header equals the "secret hash" set in the dashboard. No payload signature.
 *   - Payloads are { event, data }. The only events that matter here are charge.completed (status "successful" or
 *     "failed") and subscription.cancelled. Flutterwave sends no event when a subscription starts or renews, and a
 *     charge carries nothing that names its plan, so a renewal looks like any other successful charge.
 *   - Amounts are in major units (100 means 100 NGN), unlike Stripe and Paystack.
 *   - Retried 3 times, 30 minutes apart, if enabled; the same event can arrive more than once.
 *
 * Mirror side: PUBLIC (packages/api is mirrored).
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { cleanEmail, isObj, num, str, type Actor, type MapResult, type TraitValue } from "./mapping.js";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Seconds since 1970 for an ISO time string, or undefined. */
function secondsOf(v: unknown): number | undefined {
  if (typeof v !== "string") return undefined;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined;
}

function isoOf(seconds: number | undefined): string | undefined {
  return seconds === undefined ? undefined : new Date(seconds * 1000).toISOString();
}

/** Metadata as an object. Paystack sends the number 0 when there is none, and sometimes a JSON string. */
function metaOf(v: unknown): Record<string, unknown> {
  if (isObj(v)) return v;
  if (typeof v === "string" && v.trim().startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(v);
      return isObj(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

/** A user id read from metadata: a string or a whole number. */
function idFrom(meta: Record<string, unknown>, key: string): string | undefined {
  const v = meta[key];
  if (typeof v === "string" && v !== "") return v.slice(0, 255);
  if (typeof v === "number" && Number.isInteger(v)) return String(v);
  return undefined;
}

const userKeySchema = z.string().trim().min(1).max(64).default("user_id");

// ---------------------------------------------------------------------------
// Paystack
// ---------------------------------------------------------------------------

export const paystackConfigSchema = z
  .object({
    /** The key in the metadata you send Paystack that holds your own user id. */
    user_id_metadata_key: userKeySchema,
    /** "signature": check x-paystack-signature (needs the Paystack secret key). "token": a secret in the address. */
    verification: z.enum(["signature", "token"]).default("token"),
    /** Also refuse calls that do not come from Paystack's published addresses. Only turn on if Loomail sees real client addresses. */
    require_paystack_ip: z.boolean().default(false),
  })
  .strict();

export type PaystackConfig = z.infer<typeof paystackConfigSchema>;

/** Where Paystack says it sends webhooks from (the same for test and live). */
export const PAYSTACK_IPS = ["52.31.139.75", "52.49.173.169", "52.214.14.220"] as const;

export const PAYSTACK_EVENT_TYPES = [
  "charge.success",
  "subscription.create",
  "subscription.disable",
  "subscription.not_renew",
  "invoice.payment_failed",
  "invoice.update",
] as const;

/** x-paystack-signature: HMAC-SHA512 (hex) of the exact body, keyed with the secret key. Constant-time compare. */
export function verifyPaystackSignature(secretKey: string, header: string, rawBody: string): boolean {
  if (!/^[0-9a-f]+$/i.test(header)) return false;
  const expected = Buffer.from(createHmac("sha512", secretKey).update(rawBody).digest("hex"), "hex");
  const given = Buffer.from(header.toLowerCase(), "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * @param fingerprint a short digest of the raw body: an identical redelivery has the same one, so events that have no
 *   id of their own can still be recorded once. It is part of the key for subscription events too, because a Paystack
 *   subscription can be disabled, enabled again and disabled again under the same code: the second cancellation must
 *   not be mistaken for a repeat of the first.
 * @param nowSeconds arrival time, used as the event's time when Paystack gives none.
 */
export function mapPaystackEvent(evt: unknown, config: PaystackConfig, fingerprint: string, nowSeconds: number): MapResult {
  if (!isObj(evt) || typeof evt.event !== "string" || !isObj(evt.data)) {
    return { ok: false, status: "rejected", reason: "That is not a Paystack event." };
  }
  const type = evt.event;
  if (!(PAYSTACK_EVENT_TYPES as readonly string[]).includes(type)) {
    return { ok: false, status: "ignored", reason: `Event type ${type} is not used.` };
  }
  const data = evt.data;
  const customer = isObj(data.customer) ? data.customer : {};
  const customerCode = str(customer.customer_code);
  const actor: Actor = {
    userId: idFrom(metaOf(data.metadata), config.user_id_metadata_key) ?? idFrom(metaOf(customer.metadata), config.user_id_metadata_key),
    customerId: customerCode,
    customerTrait: "paystack_customer_code",
    email: cleanEmail(customer.email),
  };
  const traits: Record<string, TraitValue> = {};
  if (customerCode) traits.paystack_customer_code = customerCode;

  const plan = isObj(data.plan) ? data.plan : {};
  const planName = str(plan.name);
  const subscriptionCode = str(data.subscription_code);

  if (type === "charge.success") {
    if (data.status !== "success") return { ok: false, status: "ignored", reason: `A charge with status ${String(data.status)} is not a payment.` };
    const amount = num(data.amount);
    if (amount !== undefined && amount > 0) traits.payment_status = "paid";
    if (planName) traits.plan = planName;
    const at = secondsOf(data.paid_at) ?? secondsOf(data.created_at);
    const reference = str(data.reference);
    return {
      ok: true,
      mapped: {
        actor,
        traits,
        statusAt: at ?? nowSeconds,
        track: {
          event: "payment_succeeded",
          properties: { amount, currency: str(data.currency), reference, channel: str(data.channel) },
          ...(at !== undefined ? { timestamp: isoOf(at) } : {}),
          messageId: reference ? `paystack:charge.success:${reference}` : `paystack:charge.success:${fingerprint}`,
        },
      },
    };
  }

  if (type === "subscription.create") {
    if (data.status === "active") traits.payment_status = "paid";
    if (planName) traits.plan = planName;
    if (subscriptionCode) traits.paystack_subscription_code = subscriptionCode;
    return {
      ok: true,
      mapped: {
        actor,
        traits,
        statusAt: nowSeconds,
        track: {
          event: "subscription_started",
          properties: { plan: planName, amount: num(data.amount), interval: str(plan.interval), currency: str(plan.currency), subscription_code: subscriptionCode },
          messageId: `paystack:subscription.create:${subscriptionCode ?? "x"}:${fingerprint}`,
        },
      },
    };
  }

  if (type === "subscription.disable") {
    traits.payment_status = "cancelled";
    return {
      ok: true,
      mapped: {
        actor,
        traits,
        statusAt: nowSeconds,
        track: {
          event: "subscription_cancelled",
          properties: { plan: planName, subscription_code: subscriptionCode },
          messageId: `paystack:subscription.disable:${subscriptionCode ?? "x"}:${fingerprint}`,
        },
      },
    };
  }

  if (type === "subscription.not_renew") {
    // Still paid until the period ends; the ending itself arrives as subscription.disable. Only an event.
    return {
      ok: true,
      mapped: {
        actor,
        traits,
        track: {
          event: "subscription_not_renewing",
          properties: { plan: planName, subscription_code: subscriptionCode },
          messageId: `paystack:subscription.not_renew:${subscriptionCode ?? "x"}:${fingerprint}`,
        },
      },
    };
  }

  const invoiceCode = str(data.invoice_code);
  if (type === "invoice.payment_failed") {
    traits.payment_status = "past_due";
    const at = secondsOf(data.created_at);
    return {
      ok: true,
      mapped: {
        actor,
        traits,
        statusAt: at ?? nowSeconds,
        track: {
          event: "payment_failed",
          properties: { invoice_code: invoiceCode, amount: num(data.amount) },
          ...(at !== undefined ? { timestamp: isoOf(at) } : {}),
          messageId: `paystack:invoice.payment_failed:${invoiceCode ?? "x"}:${fingerprint}`,
        },
      },
    };
  }

  // invoice.update
  if (data.paid !== true) return { ok: false, status: "ignored", reason: "The invoice was updated but is not paid." };
  const paidAmount = num(data.amount);
  if (paidAmount !== undefined && paidAmount > 0) traits.payment_status = "paid";
  const at = secondsOf(data.paid_at) ?? secondsOf(data.created_at);
  const transaction = isObj(data.transaction) ? data.transaction : {};
  return {
    ok: true,
    mapped: {
      actor,
      traits,
      statusAt: at ?? nowSeconds,
      track: {
        event: "invoice_paid",
        properties: { invoice_code: invoiceCode, amount: paidAmount, currency: str(transaction.currency), reference: str(transaction.reference) },
        ...(at !== undefined ? { timestamp: isoOf(at) } : {}),
        messageId: `paystack:invoice.update:${invoiceCode ?? fingerprint}:paid`,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Flutterwave
// ---------------------------------------------------------------------------

export const flutterwaveConfigSchema = z
  .object({
    /** The key in a charge's `meta` that holds your own user id, if you send one. */
    user_id_metadata_key: userKeySchema,
  })
  .strict();

export type FlutterwaveConfig = z.infer<typeof flutterwaveConfigSchema>;

export const FLUTTERWAVE_EVENT_TYPES = ["charge.completed", "subscription.cancelled"] as const;

export function mapFlutterwaveEvent(evt: unknown, config: FlutterwaveConfig, nowSeconds: number): MapResult {
  if (!isObj(evt) || typeof evt.event !== "string" || !isObj(evt.data)) {
    return { ok: false, status: "rejected", reason: "That is not a Flutterwave event." };
  }
  const type = evt.event;
  if (!(FLUTTERWAVE_EVENT_TYPES as readonly string[]).includes(type)) {
    return { ok: false, status: "ignored", reason: `Event type ${type} is not used.` };
  }
  const data = evt.data;
  const customer = isObj(data.customer) ? data.customer : {};
  const customerId = typeof customer.id === "number" && Number.isInteger(customer.id) ? String(customer.id) : str(customer.id);
  const actor: Actor = {
    userId: idFrom(metaOf(data.meta), config.user_id_metadata_key),
    customerId,
    customerTrait: "flutterwave_customer_id",
    email: cleanEmail(customer.email),
  };
  const traits: Record<string, TraitValue> = {};
  if (customerId) traits.flutterwave_customer_id = customerId;

  if (type === "subscription.cancelled") {
    traits.payment_status = "cancelled";
    const plan = isObj(data.plan) ? data.plan : {};
    const planKey = typeof plan.id === "number" ? String(plan.id) : (str(plan.id) ?? "x");
    return {
      ok: true,
      mapped: {
        actor,
        traits,
        statusAt: nowSeconds,
        track: {
          event: "subscription_cancelled",
          properties: { plan: str(plan.name), amount: num(data.amount), currency: str(data.currency), interval: str(plan.interval) },
          messageId: `flutterwave:subscription.cancelled:${actor.email ?? "x"}:${planKey}`,
        },
      },
    };
  }

  // charge.completed
  const status = data.status;
  if (status !== "successful" && status !== "failed") return { ok: false, status: "ignored", reason: `A charge with status ${String(status)} is not final.` };
  const id = typeof data.id === "number" ? String(data.id) : str(data.id);
  const at = secondsOf(data.created_at);
  const amount = num(data.amount);
  const common = { amount, currency: str(data.currency), tx_ref: str(data.tx_ref), payment_type: str(data.payment_type) };
  if (status === "failed") {
    // A failed charge could be a stranger's abandoned checkout or a renewal that was declined, and Flutterwave does not
    // say which, so it is an event only: the payment status is not touched.
    return {
      ok: true,
      mapped: {
        actor,
        traits,
        track: {
          event: "payment_failed",
          properties: { ...common, reason: str(data.processor_response) },
          ...(at !== undefined ? { timestamp: isoOf(at) } : {}),
          messageId: `flutterwave:charge.completed:${id ?? str(data.tx_ref) ?? "x"}:failed`,
        },
      },
    };
  }
  if (amount !== undefined && amount > 0) traits.payment_status = "paid";
  return {
    ok: true,
    mapped: {
      actor,
      traits,
      statusAt: at ?? nowSeconds,
      track: {
        event: "payment_succeeded",
        properties: common,
        ...(at !== undefined ? { timestamp: isoOf(at) } : {}),
        messageId: `flutterwave:charge.completed:${id ?? str(data.tx_ref) ?? "x"}:successful`,
      },
    },
  };
}
