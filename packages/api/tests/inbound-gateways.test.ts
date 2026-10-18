/**
 * Paystack and Flutterwave mapping, driven by the sample payloads in each provider's own documentation (trimmed to the
 * fields that matter). No database.
 */
import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import {
  PAYSTACK_IPS,
  flutterwaveConfigSchema,
  mapFlutterwaveEvent,
  mapPaystackEvent,
  paystackConfigSchema,
  verifyPaystackSignature,
} from "../src/inbound/african-gateways.js";

const NOW = 1_800_000_000;
const ps = (evt: unknown, over: Record<string, unknown> = {}, fp = "abc123") => mapPaystackEvent(evt, paystackConfigSchema.parse(over), fp, NOW);
const fw = (evt: unknown, over: Record<string, unknown> = {}) => mapFlutterwaveEvent(evt, flutterwaveConfigSchema.parse(over), NOW);
const ok = (r: ReturnType<typeof ps>) => {
  if (!r.ok) throw new Error(`expected ok, got ${r.status}: ${r.reason}`);
  return r.mapped;
};

// ---------------------------------------------------------------------------
// Paystack, from paystack.com/docs/payments/webhooks
// ---------------------------------------------------------------------------
const customer = { first_name: "BoJack", last_name: "Horseman", email: "BoJack@Horseman.com", customer_code: "CUS_xnxdt6s1zg1f4nx", phone: "", metadata: {}, risk_action: "default" };

const chargeSuccess = {
  event: "charge.success",
  data: {
    id: 302961,
    domain: "live",
    status: "success",
    reference: "qTPrJoy9Bx",
    amount: 10000,
    paid_at: "2026-10-17T21:10:19.000Z",
    created_at: "2026-10-17T21:09:56.000Z",
    channel: "card",
    currency: "NGN",
    metadata: 0, // Paystack sends the number 0 when there is no metadata
    customer: { id: 68324, email: "bojack@horseman.com", customer_code: "CUS_qo38as2hpsgk2r0", metadata: null },
    plan: {},
  },
};

const subscriptionCreate = {
  event: "subscription.create",
  data: {
    domain: "test",
    status: "active",
    subscription_code: "SUB_vsyqdmlzble3uii",
    amount: 50000,
    next_payment_date: "2016-05-19T07:00:00.000Z",
    plan: { name: "Monthly retainer", plan_code: "PLN_gx2wn530m0i3w3m", amount: 50000, interval: "monthly", currency: "NGN" },
    customer,
    created_at: "2016-10-01T10:59:59.000Z",
  },
};

const invoiceFailed = {
  event: "invoice.payment_failed",
  data: {
    domain: "test",
    invoice_code: "INV_3kfmqw48ca7b48k",
    amount: 10000,
    status: "pending",
    paid: false,
    paid_at: null,
    subscription: { status: "active", subscription_code: "SUB_f7ct8g01mtcjf78" },
    customer: { id: 6910995, email: "xxx@gmail.com", customer_code: "CUS_3p3ylxyf07605kx", metadata: null },
    transaction: {},
    created_at: "2026-10-17T14:00:03.000Z",
  },
};

const invoiceUpdate = {
  event: "invoice.update",
  data: {
    invoice_code: "INV_kmhuaaur5c9ruh2",
    amount: 50000,
    status: "success",
    paid: true,
    paid_at: "2026-10-17T06:00:09.000Z",
    subscription: { status: "active", subscription_code: "SUB_l07i1s6s39nmytr" },
    customer,
    transaction: { reference: "rdtmivs7zf", status: "success", amount: 50000, currency: "NGN" },
    created_at: "2026-10-16T13:45:03.000Z",
  },
};

describe("verifyPaystackSignature", () => {
  const key = "sk_test_abcdef1234567890";
  const body = JSON.stringify(chargeSuccess);
  const sign = (k = key, b = body) => createHmac("sha512", k).update(b).digest("hex");

  it("accepts the HMAC-SHA512 of the exact body made with the secret key, in either case", () => {
    expect(verifyPaystackSignature(key, sign(), body)).toBe(true);
    expect(verifyPaystackSignature(key, sign().toUpperCase(), body)).toBe(true);
  });
  it("rejects a changed body, a different key, a SHA-256 signature, a short one and garbage", () => {
    expect(verifyPaystackSignature(key, sign(), body + " ")).toBe(false);
    expect(verifyPaystackSignature(key, sign("sk_test_other0000000000"), body)).toBe(false);
    expect(verifyPaystackSignature(key, createHmac("sha256", key).update(body).digest("hex"), body)).toBe(false);
    expect(verifyPaystackSignature(key, sign().slice(0, 20), body)).toBe(false);
    for (const bad of ["", "nonsense", "zz".repeat(64)]) expect(verifyPaystackSignature(key, bad, body), bad).toBe(false);
  });
  it("knows the three addresses Paystack sends from", () => {
    expect(PAYSTACK_IPS).toEqual(["52.31.139.75", "52.49.173.169", "52.214.14.220"]);
  });
});

describe("paystackConfigSchema", () => {
  it("defaults to a token in the address, no address check, and user_id metadata", () => {
    expect(paystackConfigSchema.parse({})).toEqual({ user_id_metadata_key: "user_id", verification: "token", require_paystack_ip: false });
  });
  it("rejects unknown settings and unknown verification methods", () => {
    expect(paystackConfigSchema.safeParse({ nope: 1 }).success).toBe(false);
    expect(paystackConfigSchema.safeParse({ verification: "ip" }).success).toBe(false);
  });
});

describe("mapPaystackEvent", () => {
  it("charge.success: a payment, paid, matched by email and the remembered customer code, with Paystack's own time", () => {
    const m = ok(ps(chargeSuccess));
    expect(m.actor).toEqual({ userId: undefined, customerId: "CUS_qo38as2hpsgk2r0", customerTrait: "paystack_customer_code", email: "bojack@horseman.com" });
    expect(m.traits).toEqual({ paystack_customer_code: "CUS_qo38as2hpsgk2r0", payment_status: "paid" });
    expect(m.track).toEqual({
      event: "payment_succeeded",
      properties: { amount: 10000, currency: "NGN", reference: "qTPrJoy9Bx", channel: "card" },
      timestamp: "2026-10-17T21:10:19.000Z",
      messageId: "paystack:charge.success:qTPrJoy9Bx",
    });
    expect(m.statusAt).toBe(Date.parse("2026-10-17T21:10:19.000Z") / 1000);
  });

  it("charge.success on a plan sets the plan name; a zero amount does not make anyone paid; a failed charge is ignored", () => {
    const planned = ok(ps({ ...chargeSuccess, data: { ...chargeSuccess.data, plan: { name: "Growth", plan_code: "PLN_1" } } }));
    expect(planned.traits.plan).toBe("Growth");
    expect(ok(ps({ ...chargeSuccess, data: { ...chargeSuccess.data, amount: 0 } })).traits.payment_status).toBeUndefined();
    expect(ps({ ...chargeSuccess, data: { ...chargeSuccess.data, status: "failed" } })).toMatchObject({ ok: false, status: "ignored" });
  });

  it("finds your user id in the charge metadata, in the customer's metadata, as a JSON string, or as a whole number", () => {
    const withMeta = (data: Record<string, unknown>) => ok(ps({ ...chargeSuccess, data: { ...chargeSuccess.data, ...data } })).actor.userId;
    expect(withMeta({ metadata: { user_id: "app-1" } })).toBe("app-1");
    expect(withMeta({ metadata: { user_id: 42 } })).toBe("42");
    expect(withMeta({ metadata: '{"user_id":"from-string"}' })).toBe("from-string");
    expect(withMeta({ metadata: "not json" })).toBeUndefined();
    expect(withMeta({ customer: { ...chargeSuccess.data.customer, metadata: { user_id: "from-customer" } } })).toBe("from-customer");
    expect(withMeta({ metadata: { user_id: "meta-wins" }, customer: { ...chargeSuccess.data.customer, metadata: { user_id: "customer" } } })).toBe("meta-wins");
    expect(ok(ps({ ...chargeSuccess, data: { ...chargeSuccess.data, metadata: { app_user: "custom-key" } } }, { user_id_metadata_key: "app_user" })).actor.userId).toBe("custom-key");
  });

  it("subscription.create: started, paid, with the plan and the subscription code remembered", () => {
    const m = ok(ps(subscriptionCreate));
    expect(m.traits).toEqual({ paystack_customer_code: "CUS_xnxdt6s1zg1f4nx", payment_status: "paid", plan: "Monthly retainer", paystack_subscription_code: "SUB_vsyqdmlzble3uii" });
    expect(m.track).toMatchObject({ event: "subscription_started", properties: { plan: "Monthly retainer", amount: 50000, interval: "monthly", currency: "NGN" }, messageId: "paystack:subscription.create:SUB_vsyqdmlzble3uii:abc123" });
    expect(m.statusAt).toBe(NOW); // no dependable event time: arrival
    expect(m.actor.email).toBe("bojack@horseman.com");
  });

  it("subscription.disable: cancelled; subscription.not_renew: an event only, still paid until the period ends", () => {
    const disabled = ok(ps({ event: "subscription.disable", data: { ...subscriptionCreate.data, status: "complete", email_token: "x" } }));
    expect(disabled.traits.payment_status).toBe("cancelled");
    expect(disabled.track).toMatchObject({ event: "subscription_cancelled", messageId: "paystack:subscription.disable:SUB_vsyqdmlzble3uii:abc123" });
    const notRenew = ok(ps({ event: "subscription.not_renew", data: { ...subscriptionCreate.data, status: "non-renewing", next_payment_date: null } }));
    expect(notRenew.traits.payment_status).toBeUndefined();
    expect(notRenew.statusAt).toBeUndefined();
    expect(notRenew.track).toMatchObject({ event: "subscription_not_renewing" });
  });

  it("a subscription disabled, enabled and disabled again under one code is two cancellations, while a redelivery is one", () => {
    const disable = { event: "subscription.disable", data: { ...subscriptionCreate.data, status: "complete", next_payment_date: "2026-11-01T00:00:00.000Z" } };
    const again = { event: "subscription.disable", data: { ...subscriptionCreate.data, status: "complete", next_payment_date: "2026-12-01T00:00:00.000Z" } };
    const key = (e: unknown, fp: string) => ok(ps(e, {}, fp)).track!.messageId;
    expect(key(disable, "fpA")).toBe(key(disable, "fpA")); // the same delivery
    expect(key(disable, "fpA")).not.toBe(key(again, "fpB")); // a second, different cancellation
  });

  it("invoice.payment_failed: past due, at the invoice's time, one record per identical redelivery", () => {
    const m = ok(ps(invoiceFailed, {}, "fp1"));
    expect(m.traits.payment_status).toBe("past_due");
    expect(m.track).toMatchObject({ event: "payment_failed", properties: { invoice_code: "INV_3kfmqw48ca7b48k", amount: 10000 }, messageId: "paystack:invoice.payment_failed:INV_3kfmqw48ca7b48k:fp1" });
    expect(m.statusAt).toBe(Date.parse("2026-10-17T14:00:03.000Z") / 1000);
    // A different body (a genuinely new failure) has a different key.
    expect((ok(ps(invoiceFailed, {}, "fp2")).track!.messageId)).not.toBe(m.track!.messageId);
  });

  it("invoice.update: only a paid invoice counts", () => {
    const m = ok(ps(invoiceUpdate));
    expect(m.traits.payment_status).toBe("paid");
    expect(m.track).toMatchObject({ event: "invoice_paid", properties: { invoice_code: "INV_kmhuaaur5c9ruh2", amount: 50000, currency: "NGN", reference: "rdtmivs7zf" }, messageId: "paystack:invoice.update:INV_kmhuaaur5c9ruh2:paid" });
    expect(m.statusAt).toBe(Date.parse("2026-10-17T06:00:09.000Z") / 1000);
    expect(ps({ ...invoiceUpdate, data: { ...invoiceUpdate.data, paid: false, status: "pending" } })).toMatchObject({ ok: false, status: "ignored" });
  });

  it("ignores events it does not use, rejects what is not a Paystack event, and works with no email", () => {
    for (const e of ["invoice.create", "transfer.success", "refund.processed", "charge.dispute.create", "customeridentification.failed"]) {
      expect(ps({ event: e, data: {} }), e).toMatchObject({ ok: false, status: "ignored" });
    }
    for (const bad of [null, "x", {}, { event: 5, data: {} }, { event: "charge.success" }, { event: "charge.success", data: [] }]) {
      expect(ps(bad), JSON.stringify(bad)).toMatchObject({ ok: false, status: "rejected" });
    }
    const noEmail = ok(ps({ ...chargeSuccess, data: { ...chargeSuccess.data, customer: { email: "not an email", customer_code: "CUS_x" } } }));
    expect(noEmail.actor.email).toBeUndefined();
    expect(noEmail.actor.customerId).toBe("CUS_x");
  });
});

// ---------------------------------------------------------------------------
// Flutterwave, from developer.flutterwave.com/docs/webhooks
// ---------------------------------------------------------------------------
const chargeCompleted = {
  event: "charge.completed",
  data: {
    id: 285959875,
    tx_ref: "Links-616626414629",
    flw_ref: "PeterEkene/FLW270177170",
    amount: 100,
    currency: "NGN",
    charged_amount: 100,
    processor_response: "Approved by Financial Institution",
    status: "successful",
    payment_type: "card",
    created_at: "2026-10-17T19:17:04.000Z",
    customer: { id: 215604089, name: "Yemi Desola", phone_number: null, email: "User@Gmail.com", created_at: "2020-07-06T19:17:04.000Z" },
    card: { last_4digits: "7889" },
  },
};

const subscriptionCancelled = {
  event: "subscription.cancelled",
  data: {
    status: "deactivated",
    currency: "NGN",
    amount: 200,
    customer: { email: "adeoyesamuel14@gmail.com", full_name: "Anonymous customer" },
    plan: { id: 10944, name: "month", amount: 200, currency: "NGN", interval: "monthly", duration: 1, status: "cancel", date_created: "2021-04-19T10:52:06.000Z" },
  },
};

describe("flutterwaveConfigSchema", () => {
  it("defaults to user_id and rejects unknown settings", () => {
    expect(flutterwaveConfigSchema.parse({})).toEqual({ user_id_metadata_key: "user_id" });
    expect(flutterwaveConfigSchema.safeParse({ x: 1 }).success).toBe(false);
  });
});

describe("mapFlutterwaveEvent", () => {
  it("charge.completed successful: a payment, paid, in major units, matched by email and customer id", () => {
    const m = ok(fw(chargeCompleted));
    expect(m.actor).toEqual({ userId: undefined, customerId: "215604089", customerTrait: "flutterwave_customer_id", email: "user@gmail.com" });
    expect(m.traits).toEqual({ flutterwave_customer_id: "215604089", payment_status: "paid" });
    expect(m.track).toEqual({
      event: "payment_succeeded",
      properties: { amount: 100, currency: "NGN", tx_ref: "Links-616626414629", payment_type: "card" },
      timestamp: "2026-10-17T19:17:04.000Z",
      messageId: "flutterwave:charge.completed:285959875:successful",
    });
    expect(m.statusAt).toBe(Date.parse("2026-10-17T19:17:04.000Z") / 1000);
  });

  it("a failed charge is an event only: the payment status is not touched, and success and failure of one id are different records", () => {
    const failed = ok(fw({ ...chargeCompleted, data: { ...chargeCompleted.data, status: "failed", processor_response: "invalid token supplied" } }));
    expect(failed.traits.payment_status).toBeUndefined();
    expect(failed.statusAt).toBeUndefined();
    expect(failed.track).toMatchObject({ event: "payment_failed", properties: { reason: "invalid token supplied", tx_ref: "Links-616626414629" }, messageId: "flutterwave:charge.completed:285959875:failed" });
    expect(failed.track!.messageId).not.toBe(ok(fw(chargeCompleted)).track!.messageId);
  });

  it("a charge that is not final, a zero amount, and other event types", () => {
    expect(fw({ ...chargeCompleted, data: { ...chargeCompleted.data, status: "pending" } })).toMatchObject({ ok: false, status: "ignored" });
    expect(ok(fw({ ...chargeCompleted, data: { ...chargeCompleted.data, amount: 0 } })).traits.payment_status).toBeUndefined();
    for (const e of ["transfer.completed", "singlebillpayment.status", "bvn.completed"]) expect(fw({ event: e, data: {} }), e).toMatchObject({ ok: false, status: "ignored" });
  });

  it("finds your user id in the charge's meta when you send one", () => {
    expect(ok(fw({ ...chargeCompleted, data: { ...chargeCompleted.data, meta: { user_id: "app-9" } } })).actor.userId).toBe("app-9");
    expect(ok(fw({ ...chargeCompleted, data: { ...chargeCompleted.data, meta: { consumer_id: 23 } } }, { user_id_metadata_key: "consumer_id" })).actor.userId).toBe("23");
    expect(ok(fw(chargeCompleted)).actor.userId).toBeUndefined();
  });

  it("subscription.cancelled: cancelled, found by email alone (no customer id is sent), with the plan", () => {
    const m = ok(fw(subscriptionCancelled));
    expect(m.actor).toEqual({ userId: undefined, customerId: undefined, customerTrait: "flutterwave_customer_id", email: "adeoyesamuel14@gmail.com" });
    expect(m.traits).toEqual({ payment_status: "cancelled" });
    expect(m.track).toMatchObject({ event: "subscription_cancelled", properties: { plan: "month", amount: 200, currency: "NGN", interval: "monthly" }, messageId: "flutterwave:subscription.cancelled:adeoyesamuel14@gmail.com:10944" });
    expect(m.statusAt).toBe(NOW);
  });

  it("rejects what is not a Flutterwave event (refunds and card events have no event name)", () => {
    for (const bad of [null, "x", {}, { id: 1, AmountRefunded: 5, status: "completed" }, { event: "charge.completed" }, { event: 1, data: {} }]) {
      expect(fw(bad), JSON.stringify(bad)).toMatchObject({ ok: false, status: "rejected" });
    }
  });
});
