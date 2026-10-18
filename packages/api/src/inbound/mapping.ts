/**
 * Turning what an outside system sent into what Loomail records: one function per kind of source, no database and
 * no network, so every rule here is testable on its own. inbound/process.ts applies the result.
 *
 * Mirror side: PUBLIC (packages/api is mirrored).
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

export type TraitValue = string | number | boolean;

/** Who an incoming request is about, before it is matched to a contact. Any of these may be missing. */
export interface Actor {
  /** The customer's own id for the person (becomes the contact's external id). */
  userId?: string;
  /** A second id the sender uses for "this is my user" (Stripe's client_reference_id). */
  clientRef?: string;
  /** Stripe's customer id, remembered on the contact so later events that carry no email can find them. */
  customerId?: string;
  email?: string;
}

export interface Mapped {
  actor: Actor;
  /**
   * When the sender says this happened (Stripe's event time, in seconds). Used to stop an old event that arrives late
   * from overwriting a newer payment status: Stripe does not deliver events in order.
   */
  statusAt?: number;
  /** Traits to set on the person (an identify). May be empty. */
  traits: Record<string, TraitValue>;
  /** The event to record (a track), if any. */
  track?: { event: string; properties: Record<string, unknown>; timestamp?: string; messageId?: string };
}

export type MapResult =
  | { ok: true; mapped: Mapped }
  /** ignored: fine, nothing to do. rejected: the request itself is wrong. */
  | { ok: false; status: "ignored" | "rejected"; reason: string };

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function cleanEmail(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const e = v.trim().toLowerCase();
  return e.length <= 320 && EMAIL_SHAPE.test(e) ? e : undefined;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Read a value by a dotted path ("data.user.id", "items.0.price"). Missing anywhere along the way gives undefined. */
export function getPath(root: unknown, path: string): unknown {
  let cur: unknown = root;
  for (const part of path.split(".")) {
    if (part === "") return undefined;
    if (Array.isArray(cur)) {
      if (!/^\d+$/.test(part)) return undefined;
      cur = cur[Number(part)];
    } else if (isObj(cur) && Object.prototype.hasOwnProperty.call(cur, part)) {
      cur = cur[part];
    } else {
      return undefined;
    }
  }
  return cur;
}

/** A value that can be an id or a trait: a non-empty string, a finite number or a boolean. */
function scalar(v: unknown): TraitValue | undefined {
  if (typeof v === "string") return v.trim() === "" ? undefined : v.slice(0, 2000);
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "boolean") return v;
  return undefined;
}

// ---------------------------------------------------------------------------
// Generic JSON sources
// ---------------------------------------------------------------------------

const pathSchema = z.string().trim().min(1).max(200);

export const genericConfigSchema = z
  .object({
    /** A fixed event name, or the path to one in the payload. With neither, the request only sets traits. */
    event_name: z.string().trim().min(1).max(100).optional(),
    event_name_path: pathSchema.optional(),
    /** Where the person is. user_id_path wins; email_path is used when it is missing (and as the email trait). */
    user_id_path: pathSchema.optional(),
    email_path: pathSchema.optional(),
    /** Trait name -> path in the payload. */
    trait_paths: z
      .record(pathSchema)
      .refine((t) => Object.keys(t).length <= 20 && Object.keys(t).every((k) => k.length >= 1 && k.length <= 64), {
        message: "Up to 20 traits, with names of 1 to 64 characters.",
      })
      .default({}),
    /** Record the whole payload as the event's properties. */
    send_properties: z.boolean().default(true),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (!c.user_id_path && !c.email_path) {
      ctx.addIssue({ code: "custom", path: ["user_id_path"], message: "Say where the person is in the payload: a user id path or an email path." });
    }
    if (!c.event_name && !c.event_name_path && Object.keys(c.trait_paths).length === 0) {
      ctx.addIssue({ code: "custom", path: ["event_name"], message: "Give an event name, or at least one trait to set." });
    }
  });

export type GenericConfig = z.infer<typeof genericConfigSchema>;

export function mapGeneric(config: GenericConfig, body: unknown, eventId?: string): MapResult {
  if (!isObj(body)) return { ok: false, status: "rejected", reason: "The body must be a JSON object." };

  const email = config.email_path ? cleanEmail(getPath(body, config.email_path)) : undefined;
  const rawId = config.user_id_path ? scalar(getPath(body, config.user_id_path)) : undefined;
  const userId = rawId === undefined || typeof rawId === "boolean" ? undefined : String(rawId).slice(0, 255);
  if (!userId && !email) return { ok: false, status: "rejected", reason: "The payload has no person: neither the user id nor the email was found at the configured paths." };

  const traits: Record<string, TraitValue> = {};
  for (const [name, path] of Object.entries(config.trait_paths)) {
    const v = scalar(getPath(body, path));
    if (v !== undefined) traits[name] = v;
  }

  let event: string | undefined = config.event_name;
  if (config.event_name_path) {
    const named = getPath(body, config.event_name_path);
    if (typeof named === "string" && named.trim() !== "") event = named.trim().slice(0, 100);
    else if (!config.event_name) event = undefined;
  }
  if (!event && Object.keys(traits).length === 0) {
    return { ok: false, status: "ignored", reason: "No event name found at the configured path, and no traits to set." };
  }

  return {
    ok: true,
    mapped: {
      actor: { userId, email },
      traits,
      ...(event
        ? { track: { event, properties: config.send_properties ? body : {}, ...(eventId ? { messageId: eventId } : {}) } }
        : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Stripe
// ---------------------------------------------------------------------------

export const stripeConfigSchema = z
  .object({
    /** The metadata key on your Stripe customers, subscriptions or checkout sessions that holds your own user id. */
    user_id_metadata_key: z.string().trim().min(1).max(64).default("user_id"),
  })
  .strict();

export type StripeConfig = z.infer<typeof stripeConfigSchema>;

/** How long a Stripe signature stays valid, in seconds. Stripe's own libraries use 5 minutes. */
export const STRIPE_TOLERANCE_SECONDS = 300;

/**
 * Check a Stripe-Signature header: `t=<unix seconds>,v1=<hex>[,v1=<hex>...]`, where v1 is
 * HMAC-SHA256(endpoint secret, `${t}.${raw body}`). More than one v1 appears while Stripe is rolling a secret; any
 * match passes. The timestamp must be within the tolerance of `nowSeconds`.
 */
export function verifyStripeSignature(secret: string, header: string, rawBody: string, nowSeconds: number): boolean {
  let t: number | null = null;
  const sigs: string[] = [];
  for (const part of header.split(",")) {
    const [k, ...rest] = part.trim().split("=");
    const v = rest.join("=");
    if (k === "t") t = Number(v);
    else if (k === "v1" && /^[0-9a-f]+$/i.test(v)) sigs.push(v.toLowerCase());
  }
  if (t === null || !Number.isInteger(t) || sigs.length === 0) return false;
  if (Math.abs(nowSeconds - t) > STRIPE_TOLERANCE_SECONDS) return false;
  const expected = Buffer.from(createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex"), "hex");
  return sigs.some((s) => {
    const given = Buffer.from(s, "hex");
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

/** Stripe subscription status -> Loomail payment status. Undefined: leave the payment status as it is. */
export function paymentStatusFromSubscription(status: unknown): "trial" | "paid" | "past_due" | "cancelled" | undefined {
  switch (status) {
    case "trialing":
      return "trial";
    case "active":
      return "paid";
    case "past_due":
    case "unpaid":
      return "past_due";
    case "canceled":
      return "cancelled";
    default:
      return undefined; // incomplete, incomplete_expired, paused
  }
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** The plan's name: the price's nickname, else its lookup key, else its id. */
function planOf(sub: Record<string, unknown>): string | undefined {
  const item = getPath(sub, "items.data.0");
  const price = isObj(item) && isObj(item.price) ? item.price : isObj(item) && isObj(item.plan) ? item.plan : undefined;
  return price ? (str(price.nickname) ?? str(price.lookup_key) ?? str(price.id)) : undefined;
}

/**
 * The key an event is recorded under, so the same thing arriving twice is recorded once. Stripe sometimes sends two
 * different events for one occurrence, so for things that happen once per object (a checkout, a subscription starting or
 * ending, an invoice being paid) the key is the object, not the event. An invoice can fail several times, once per
 * attempt. A subscription can change many times, so for `updated` only the event id identifies a repeat.
 */
export function stripeMessageId(type: string, eventId: string | undefined, obj: Record<string, unknown>): string | undefined {
  const objectId = str(obj.id);
  const once = type === "checkout.session.completed" || type === "customer.subscription.created" || type === "customer.subscription.deleted" || type === "invoice.paid";
  if (objectId && once) return `stripe:${type}:${objectId}`;
  const attempt = num(obj.attempt_count);
  if (objectId && type === "invoice.payment_failed" && attempt !== undefined) return `stripe:${type}:${objectId}:${attempt}`;
  return eventId ? `stripe:${eventId}` : undefined;
}

/**
 * Stripe's "thin" events carry ids, not the object, and Loomail needs the object. They come from an event destination
 * set to the Thin payload. Recognised so they can be acknowledged (Stripe stops retrying) with a message that says what
 * to change.
 */
function isThinEvent(evt: Record<string, unknown>): boolean {
  return evt.object === "v2.core.event" || "related_object" in evt || (typeof evt.type === "string" && /^v[12]\./.test(evt.type));
}

export const STRIPE_THIN_MESSAGE =
  "This is a Stripe thin event, which carries no details. In Stripe, edit the destination and set its payload to Snapshot.";

const STRIPE_EVENT_NAMES: Record<string, string> = {
  "customer.subscription.created": "subscription_started",
  "customer.subscription.updated": "subscription_updated",
  "customer.subscription.deleted": "subscription_cancelled",
};

/** Event types Loomail uses. The setup instructions list these so a customer subscribes to exactly them. */
export const STRIPE_EVENT_TYPES = [
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.paid",
  "invoice.payment_failed",
] as const;

export function mapStripeEvent(evt: unknown, config: StripeConfig): MapResult {
  if (isObj(evt) && isThinEvent(evt)) return { ok: false, status: "ignored", reason: STRIPE_THIN_MESSAGE };
  if (!isObj(evt) || typeof evt.type !== "string" || !isObj(evt.data) || !isObj(evt.data.object)) {
    return { ok: false, status: "rejected", reason: "That is not a Stripe event." };
  }
  const type = evt.type;
  if (!(STRIPE_EVENT_TYPES as readonly string[]).includes(type)) {
    return { ok: false, status: "ignored", reason: `Event type ${type} is not used.` };
  }
  const obj = evt.data.object;
  const meta = isObj(obj.metadata) ? obj.metadata : {};
  const customerId = str(obj.customer) ?? (isObj(obj.customer) ? str(obj.customer.id) : undefined);
  const email = cleanEmail(obj.customer_email) ?? cleanEmail(getPath(obj, "customer_details.email"));
  const actor: Actor = {
    userId: str(meta[config.user_id_metadata_key]),
    clientRef: str(obj.client_reference_id),
    customerId,
    email,
  };

  const traits: Record<string, TraitValue> = {};
  if (customerId) traits.stripe_customer_id = customerId;

  const created = num(evt.created);
  const messageId = stripeMessageId(type, str(evt.id), obj);
  const base = {
    ...(created !== undefined ? { timestamp: new Date(created * 1000).toISOString() } : {}),
    ...(messageId ? { messageId } : {}),
  };
  const statusAt = created;

  if (type === "checkout.session.completed") {
    return {
      ok: true,
      mapped: {
        actor,
        traits,
        track: {
          event: "checkout_completed",
          properties: { amount_total: num(obj.amount_total), currency: str(obj.currency), mode: str(obj.mode), payment_status: str(obj.payment_status) },
          ...base,
        },
      },
    };
  }

  if (type.startsWith("customer.subscription.")) {
    const status = type === "customer.subscription.deleted" ? "canceled" : obj.status;
    const paymentStatus = paymentStatusFromSubscription(status);
    if (paymentStatus) traits.payment_status = paymentStatus;
    const plan = planOf(obj);
    if (plan && type !== "customer.subscription.deleted") traits.plan = plan;
    return {
      ok: true,
      mapped: {
        actor,
        traits,
        statusAt,
        track: {
          event: STRIPE_EVENT_NAMES[type]!,
          properties: { status: str(obj.status), plan, cancel_at_period_end: typeof obj.cancel_at_period_end === "boolean" ? obj.cancel_at_period_end : undefined },
          ...base,
        },
      },
    };
  }

  if (type === "invoice.paid") {
    const paid = num(obj.amount_paid);
    // A zero-amount invoice (a free trial starting) is not a payment, so it does not make the person "paid".
    if (paid !== undefined && paid > 0) traits.payment_status = "paid";
    return { ok: true, mapped: { actor, traits, statusAt, track: { event: "payment_succeeded", properties: { amount_paid: paid, currency: str(obj.currency) }, ...base } } };
  }

  // invoice.payment_failed
  traits.payment_status = "past_due";
  return {
    ok: true,
    mapped: {
      actor,
      traits,
      statusAt,
      track: { event: "payment_failed", properties: { amount_due: num(obj.amount_due), currency: str(obj.currency), attempt_count: num(obj.attempt_count) }, ...base },
    },
  };
}
