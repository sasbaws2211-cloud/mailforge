/** Inbound mapping: reading a JSON payload, Stripe's signature and Stripe's events. No database. */
import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import {
  cleanEmail,
  genericConfigSchema,
  getPath,
  mapGeneric,
  mapStripeEvent,
  paymentStatusFromSubscription,
  stripeConfigSchema,
  verifyStripeSignature,
  STRIPE_TOLERANCE_SECONDS,
} from "../src/inbound/mapping.js";

const generic = (c: Record<string, unknown>) => genericConfigSchema.parse(c);
const stripeCfg = stripeConfigSchema.parse({});

describe("getPath", () => {
  const o = { a: { b: [{ c: 1 }, { c: 2 }] }, "x.y": 5, n: null };
  it("walks objects and array indexes", () => {
    expect(getPath(o, "a.b.1.c")).toBe(2);
    expect(getPath(o, "a.b.0")).toEqual({ c: 1 });
  });
  it("gives undefined for anything missing, never throwing", () => {
    for (const p of ["z", "a.z", "a.b.9.c", "a.b.x", "n.q", "", "a..b", "a.b.0.c.d"]) expect(getPath(o, p), p).toBeUndefined();
  });
  it("does not read inherited properties", () => {
    expect(getPath({}, "__proto__")).toBeUndefined();
    expect(getPath({}, "constructor")).toBeUndefined();
    expect(getPath({ a: {} }, "a.toString")).toBeUndefined();
  });
});

describe("cleanEmail", () => {
  it("trims, lower-cases and checks the shape", () => {
    expect(cleanEmail("  Ada@Example.COM ")).toBe("ada@example.com");
    for (const bad of ["nope", "a@b", "a b@c.com", 5, null, undefined, "x".repeat(320) + "@a.com"]) expect(cleanEmail(bad)).toBeUndefined();
  });
});

describe("genericConfigSchema", () => {
  it("needs a person and something to do", () => {
    expect(genericConfigSchema.safeParse({ event_name: "x" }).success).toBe(false); // no person
    expect(genericConfigSchema.safeParse({ user_id_path: "id" }).success).toBe(false); // nothing to do
    expect(genericConfigSchema.safeParse({ user_id_path: "id", event_name: "x" }).success).toBe(true);
    expect(genericConfigSchema.safeParse({ email_path: "e", trait_paths: { plan: "p" } }).success).toBe(true);
  });
  it("limits traits and rejects unknown keys", () => {
    const many = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`t${i}`, "p"]));
    expect(genericConfigSchema.safeParse({ email_path: "e", trait_paths: many }).success).toBe(false);
    expect(genericConfigSchema.safeParse({ email_path: "e", event_name: "x", trait_paths: { ["n".repeat(65)]: "p" } }).success).toBe(false);
    expect(genericConfigSchema.safeParse({ email_path: "e", event_name: "x", extra: 1 }).success).toBe(false);
  });
  it("defaults to sending the whole payload as properties", () => {
    expect(generic({ email_path: "e", event_name: "x" }).send_properties).toBe(true);
  });
});

describe("mapGeneric", () => {
  const body = { type: "form.submitted", data: { user: { id: 42, email: "Ada@Example.com" }, plan: "Pro", seats: 4, vip: true, nested: { a: 1 } } };

  it("maps person, event, traits and the payload", () => {
    const r = mapGeneric(
      generic({ event_name_path: "type", user_id_path: "data.user.id", email_path: "data.user.email", trait_paths: { plan: "data.plan", seats: "data.seats", vip: "data.vip" } }),
      body,
      "in:s:evt1",
    );
    expect(r).toEqual({
      ok: true,
      mapped: {
        actor: { userId: "42", email: "ada@example.com" },
        traits: { plan: "Pro", seats: 4, vip: true },
        track: { event: "form.submitted", properties: body, messageId: "in:s:evt1" },
      },
    });
  });

  it("a fixed event name works, and send_properties false sends none", () => {
    const r = mapGeneric(generic({ event_name: "signed_up_elsewhere", email_path: "data.user.email", send_properties: false }), body);
    expect(r).toMatchObject({ ok: true, mapped: { actor: { email: "ada@example.com" }, track: { event: "signed_up_elsewhere", properties: {} } } });
  });

  it("the path wins over a fixed name when it finds one, and the fixed name is the fallback", () => {
    const c = generic({ event_name: "fallback", event_name_path: "type", user_id_path: "data.user.id" });
    expect((mapGeneric(c, body) as any).mapped.track.event).toBe("form.submitted");
    expect((mapGeneric(c, { data: { user: { id: 1 } } }) as any).mapped.track.event).toBe("fallback");
  });

  it("traits only: no event name anywhere means an identify without a track", () => {
    const r = mapGeneric(generic({ email_path: "data.user.email", trait_paths: { plan: "data.plan" } }), body);
    expect(r).toMatchObject({ ok: true, mapped: { traits: { plan: "Pro" } } });
    expect((r as any).mapped.track).toBeUndefined();
  });

  it("skips trait values that are missing, empty or not simple", () => {
    const r = mapGeneric(generic({ user_id_path: "id", event_name: "x", trait_paths: { a: "missing", b: "empty", c: "obj", d: "list", e: "ok" } }), { id: "u", empty: "  ", obj: { z: 1 }, list: [1], ok: "yes" });
    expect((r as any).mapped.traits).toEqual({ e: "yes" });
  });

  it("falls back to the email when there is no user id", () => {
    const r = mapGeneric(generic({ user_id_path: "nope", email_path: "e", event_name: "x" }), { e: "A@B.co" });
    expect((r as any).mapped.actor).toEqual({ userId: undefined, email: "a@b.co" });
  });

  it("rejects a payload that is not an object or has no person", () => {
    const c = generic({ user_id_path: "id", event_name: "x" });
    for (const bad of ["text", 5, null, [1], undefined]) expect(mapGeneric(c, bad)).toMatchObject({ ok: false, status: "rejected" });
    expect(mapGeneric(c, { other: 1 })).toMatchObject({ ok: false, status: "rejected" });
    expect(mapGeneric(generic({ user_id_path: "id", event_name: "x" }), { id: true })).toMatchObject({ ok: false });
  });

  it("ignores a request with no event name and no traits", () => {
    expect(mapGeneric(generic({ user_id_path: "id", event_name_path: "type" }), { id: "u" })).toMatchObject({ ok: false, status: "ignored" });
  });
});

describe("verifyStripeSignature", () => {
  const secret = "whsec_testsecret1234567890";
  const body = '{"id":"evt_1"}';
  const now = 1_800_000_000;
  const sign = (t: number, b = body, s = secret) => createHmac("sha256", s).update(`${t}.${b}`).digest("hex");

  it("accepts a good signature", () => {
    expect(verifyStripeSignature(secret, `t=${now},v1=${sign(now)}`, body, now + 5)).toBe(true);
  });
  it("accepts any of several v1 signatures (a secret being rolled)", () => {
    expect(verifyStripeSignature(secret, `t=${now},v1=${sign(now, body, "whsec_old")},v1=${sign(now)}`, body, now)).toBe(true);
  });
  it("rejects a changed body, wrong secret, missing parts and garbage", () => {
    expect(verifyStripeSignature(secret, `t=${now},v1=${sign(now)}`, body + " ", now)).toBe(false);
    expect(verifyStripeSignature("whsec_other", `t=${now},v1=${sign(now)}`, body, now)).toBe(false);
    expect(verifyStripeSignature(secret, `v1=${sign(now)}`, body, now)).toBe(false);
    expect(verifyStripeSignature(secret, `t=${now}`, body, now)).toBe(false);
    expect(verifyStripeSignature(secret, "nonsense", body, now)).toBe(false);
    expect(verifyStripeSignature(secret, `t=${now},v1=zz`, body, now)).toBe(false);
    expect(verifyStripeSignature(secret, `t=${now},v1=${sign(now).slice(0, 10)}`, body, now)).toBe(false);
  });
  it("rejects a stale or future timestamp even with a valid signature", () => {
    expect(verifyStripeSignature(secret, `t=${now},v1=${sign(now)}`, body, now + STRIPE_TOLERANCE_SECONDS + 1)).toBe(false);
    expect(verifyStripeSignature(secret, `t=${now},v1=${sign(now)}`, body, now - STRIPE_TOLERANCE_SECONDS - 1)).toBe(false);
    expect(verifyStripeSignature(secret, `t=${now},v1=${sign(now)}`, body, now + STRIPE_TOLERANCE_SECONDS)).toBe(true);
  });
});

describe("paymentStatusFromSubscription", () => {
  it("maps each Stripe status", () => {
    expect(paymentStatusFromSubscription("trialing")).toBe("trial");
    expect(paymentStatusFromSubscription("active")).toBe("paid");
    expect(paymentStatusFromSubscription("past_due")).toBe("past_due");
    expect(paymentStatusFromSubscription("unpaid")).toBe("past_due");
    expect(paymentStatusFromSubscription("canceled")).toBe("cancelled");
    for (const s of ["incomplete", "incomplete_expired", "paused", "weird", undefined, 5]) expect(paymentStatusFromSubscription(s), String(s)).toBeUndefined();
  });
});

describe("mapStripeEvent", () => {
  const evt = (type: string, object: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ id: "evt_123", type, created: 1_800_000_000, data: { object }, ...extra });
  const sub = (status: string, extra: Record<string, unknown> = {}) => ({
    id: "sub_1",
    customer: "cus_9",
    status,
    cancel_at_period_end: false,
    metadata: { user_id: "user_7" },
    items: { data: [{ price: { id: "price_1", nickname: "Growth", lookup_key: "growth_monthly" } }] },
    ...extra,
  });

  it("checkout.session.completed: an event, the customer id remembered, who it is", () => {
    const r = mapStripeEvent(evt("checkout.session.completed", { customer: "cus_9", customer_details: { email: "Ada@Example.com" }, client_reference_id: "user_7", amount_total: 4900, currency: "usd", mode: "subscription", payment_status: "paid" }), stripeCfg);
    expect(r).toEqual({
      ok: true,
      mapped: {
        actor: { userId: undefined, clientRef: "user_7", customerId: "cus_9", email: "ada@example.com" },
        traits: { stripe_customer_id: "cus_9" },
        track: { event: "checkout_completed", properties: { amount_total: 4900, currency: "usd", mode: "subscription", payment_status: "paid" }, timestamp: "2027-01-15T08:00:00.000Z", messageId: "stripe:evt_123" },
      },
    });
  });

  it("subscription created/updated: payment status and plan from the subscription, user id from its metadata", () => {
    const created = mapStripeEvent(evt("customer.subscription.created", sub("active")), stripeCfg) as any;
    expect(created.mapped.traits).toEqual({ stripe_customer_id: "cus_9", payment_status: "paid", plan: "Growth" });
    expect(created.mapped.actor).toMatchObject({ userId: "user_7", customerId: "cus_9" });
    expect(created.mapped.track).toMatchObject({ event: "subscription_started", properties: { status: "active", plan: "Growth", cancel_at_period_end: false } });
    const trial = mapStripeEvent(evt("customer.subscription.updated", sub("trialing", { cancel_at_period_end: true })), stripeCfg) as any;
    expect(trial.mapped.traits.payment_status).toBe("trial");
    expect(trial.mapped.track).toMatchObject({ event: "subscription_updated", properties: { cancel_at_period_end: true } });
    const pastDue = mapStripeEvent(evt("customer.subscription.updated", sub("past_due")), stripeCfg) as any;
    expect(pastDue.mapped.traits.payment_status).toBe("past_due");
  });

  it("an incomplete subscription leaves the payment status alone", () => {
    const r = mapStripeEvent(evt("customer.subscription.created", sub("incomplete")), stripeCfg) as any;
    expect(r.mapped.traits.payment_status).toBeUndefined();
  });

  it("the plan falls back to the lookup key, then the price id, then nothing", () => {
    const priceOnly = (price: Record<string, unknown>) => (mapStripeEvent(evt("customer.subscription.created", sub("active", { items: { data: [{ price }] } })), stripeCfg) as any).mapped.traits.plan;
    expect(priceOnly({ id: "price_1", lookup_key: "pro" })).toBe("pro");
    expect(priceOnly({ id: "price_1" })).toBe("price_1");
    expect(priceOnly({})).toBeUndefined();
  });

  it("subscription deleted: cancelled, no plan", () => {
    const r = mapStripeEvent(evt("customer.subscription.deleted", sub("canceled")), stripeCfg) as any;
    expect(r.mapped.traits).toEqual({ stripe_customer_id: "cus_9", payment_status: "cancelled" });
    expect(r.mapped.track.event).toBe("subscription_cancelled");
  });

  it("invoice.paid makes someone paid, but a zero-amount invoice does not", () => {
    const paid = mapStripeEvent(evt("invoice.paid", { customer: "cus_9", customer_email: "a@b.co", amount_paid: 4900, currency: "usd" }), stripeCfg) as any;
    expect(paid.mapped.traits.payment_status).toBe("paid");
    expect(paid.mapped.track).toMatchObject({ event: "payment_succeeded", properties: { amount_paid: 4900, currency: "usd" } });
    const free = mapStripeEvent(evt("invoice.paid", { customer: "cus_9", customer_email: "a@b.co", amount_paid: 0 }), stripeCfg) as any;
    expect(free.mapped.traits.payment_status).toBeUndefined();
    expect(free.mapped.track.event).toBe("payment_succeeded");
  });

  it("invoice.payment_failed: past due", () => {
    const r = mapStripeEvent(evt("invoice.payment_failed", { customer: "cus_9", customer_email: "a@b.co", amount_due: 4900, currency: "usd", attempt_count: 2 }), stripeCfg) as any;
    expect(r.mapped.traits.payment_status).toBe("past_due");
    expect(r.mapped.track).toMatchObject({ event: "payment_failed", properties: { amount_due: 4900, attempt_count: 2 } });
  });

  it("uses the configured metadata key for the user id", () => {
    const cfg = stripeConfigSchema.parse({ user_id_metadata_key: "app_user" });
    const r = mapStripeEvent(evt("customer.subscription.created", sub("active", { metadata: { app_user: "u-from-app", user_id: "ignored" } })), cfg) as any;
    expect(r.mapped.actor.userId).toBe("u-from-app");
  });

  it("the message id is the Stripe event id, so a replay is recognised", () => {
    expect((mapStripeEvent(evt("invoice.paid", { customer: "c", amount_paid: 1 }), stripeCfg) as any).mapped.track.messageId).toBe("stripe:evt_123");
  });

  it("ignores event types it does not use; rejects what is not an event", () => {
    expect(mapStripeEvent(evt("charge.refunded", {}), stripeCfg)).toMatchObject({ ok: false, status: "ignored" });
    for (const bad of [null, "x", {}, { type: "invoice.paid" }, { type: 5, data: { object: {} } }, { type: "invoice.paid", data: { object: [] } }]) {
      expect(mapStripeEvent(bad, stripeCfg), JSON.stringify(bad)).toMatchObject({ ok: false, status: "rejected" });
    }
  });
});
