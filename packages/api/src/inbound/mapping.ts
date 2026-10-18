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
  /** The payment provider's customer id, remembered on the contact so later events that carry no email can find them. */
  customerId?: string;
  /** The trait that remembers it ("stripe_customer_id", "paystack_customer_code", ...). Stripe's when absent. */
  customerTrait?: string;
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

export const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A `[key=value]` step in a path: pick the first element of an array whose `key` (itself a dotted path) equals `value`. */
const FILTER_STEP = /(\[[A-Za-z0-9_.-]+=[^\]]*\])/;

/**
 * Read a value by a dotted path ("data.user.id", "items.0.price"). Missing anywhere along the way gives undefined.
 *
 * An array can also be searched instead of indexed: `form_response.answers[type=email].email` is the `email` of the first
 * answer whose `type` is `email`. The key can be dotted (`answers[field.ref=work_email].email`). That keeps working when an
 * optional question is skipped and the answers after it change position, which an index (`answers.1.email`) does not.
 * Values are compared as text, so `[number=5]` matches 5.
 */
export function getPath(root: unknown, path: string): unknown {
  const pieces = path.split(FILTER_STEP);
  // Steps in order: a name or index to step into, or a filter to search the array we are in.
  const steps: Array<string | { key: string; value: string }> = [];
  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i]!;
    if (i % 2 === 1) {
      const eq = piece.indexOf("=");
      steps.push({ key: piece.slice(1, eq), value: piece.slice(eq + 1, -1) });
      continue;
    }
    if (piece === "" && pieces.length > 1 && i > 0) continue; // nothing between two filters, or after the last one
    // A name after a filter must be joined with a dot: `answers[type=email].email`.
    const text = i > 0 ? (piece.startsWith(".") ? piece.slice(1) : null) : piece;
    if (text === null) return undefined;
    for (const part of text.split(".")) {
      if (part === "") return undefined;
      steps.push(part);
    }
  }
  let cur: unknown = root;
  for (const step of steps) {
    if (typeof step === "string") {
      if (Array.isArray(cur)) {
        if (!/^\d+$/.test(step)) return undefined;
        cur = cur[Number(step)];
      } else if (isObj(cur) && Object.prototype.hasOwnProperty.call(cur, step)) {
        cur = cur[step];
      } else {
        return undefined;
      }
    } else {
      if (!Array.isArray(cur)) return undefined;
      cur = cur.find((el) => {
        const v = getPath(el, step.key);
        return (typeof v === "string" || typeof v === "number" || typeof v === "boolean") && String(v) === step.value;
      });
      if (cur === undefined) return undefined;
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
/** An HTTP header name: letters, digits and hyphens. */
const headerNameSchema = z.string().trim().regex(/^[A-Za-z0-9-]{1,64}$/, "A header name: letters, numbers and hyphens.");

export const genericConfigSchema = z
  .object({
    /** A fixed event name, or the path to one in the payload. With neither, the request only sets traits. */
    event_name: z.string().trim().min(1).max(100).optional(),
    event_name_path: pathSchema.optional(),
    /** The name of a request header that holds the event name (Shopify: `X-Shopify-Topic`), for senders that keep it out of the body. */
    event_name_header: headerNameSchema.optional(),
    /** Where the person is. user_id_path wins; email_path is used when it is missing (and as the email trait). */
    user_id_path: pathSchema.optional(),
    email_path: pathSchema.optional(),
    /**
     * Where the sender's own id for this event is in the payload (Typeform: `event_id`). A repeat delivery of the same id is
     * recorded once. Senders that can set a header can send `X-Loomail-Event-Id` instead, which wins when both are given.
     */
    event_id_path: pathSchema.optional(),
    /** Or the request header that holds it (Shopify: `X-Shopify-Event-Id`). `X-Loomail-Event-Id` wins over both. */
    event_id_header: headerNameSchema.optional(),
    /**
     * How calls are checked: with the token Loomail made (the default), or with the sender's own signature, an HMAC-SHA256 of the
     * exact body made with a secret the sender and Loomail share (Shopify, Tally, WooCommerce, Cal.com). A signature source holds
     * that secret and has no token. It cannot change once the source is made.
     */
    verification: z.enum(["token", "signature"]).default("token"),
    /** The header that carries the signature (Shopify: `X-Shopify-Hmac-Sha256`). */
    signature_header: headerNameSchema.optional(),
    /** How the signature is written: hex, base64, or either (the default accepts both: the same 256-bit value). */
    signature_encoding: z.enum(["hex", "base64", "either"]).default("either"),
    /** Text in front of the signature that is not part of it, such as `sha256=`. */
    signature_prefix: z.string().trim().max(20).optional(),
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
    if (!c.event_name && !c.event_name_path && !c.event_name_header && Object.keys(c.trait_paths).length === 0) {
      ctx.addIssue({ code: "custom", path: ["event_name"], message: "Give an event name, or at least one trait to set." });
    }
    if (c.verification === "signature" && !c.signature_header) {
      ctx.addIssue({ code: "custom", path: ["signature_header"], message: "Say which header carries the signature." });
    }
    if (c.verification === "token" && (c.signature_header || c.signature_prefix)) {
      ctx.addIssue({ code: "custom", path: ["verification"], message: "A signature header only applies when calls are checked by signature." });
    }
  });

export type GenericConfig = z.infer<typeof genericConfigSchema>;

/**
 * Is `header` the HMAC-SHA256 of `rawBody` made with `secret`? The sender's value may be hex or base64 (per `encoding`) and may
 * carry a prefix such as `sha256=`. Compared in constant time. Anything that is not a 32-byte value is simply not a match.
 */
export function verifyHmacSignature(secret: string, rawBody: string, header: string, opts: { encoding?: "hex" | "base64" | "either"; prefix?: string } = {}): boolean {
  let given = header.trim();
  const prefix = opts.prefix?.trim();
  if (prefix && given.toLowerCase().startsWith(prefix.toLowerCase())) given = given.slice(prefix.length).trim();
  const encoding = opts.encoding ?? "either";
  let bytes: Buffer | null = null;
  if ((encoding === "hex" || encoding === "either") && /^[0-9a-fA-F]{64}$/.test(given)) bytes = Buffer.from(given, "hex");
  else if ((encoding === "base64" || encoding === "either") && /^[A-Za-z0-9+/]{43}=?$/.test(given)) bytes = Buffer.from(given, "base64");
  else if ((encoding === "base64" || encoding === "either") && /^[A-Za-z0-9_-]{43}=?$/.test(given)) bytes = Buffer.from(given.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  if (!bytes || bytes.length !== 32) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  return timingSafeEqual(bytes, expected);
}

/**
 * The key that makes a repeat harmless. An id the source reads from the sender's own payload or headers can stand for different
 * events when the name comes from the request too (a booking created, then cancelled), so the name is part of the key then.
 * An `X-Loomail-Event-Id` the sender chose is used exactly as sent: they decide what counts as a repeat.
 */
function dedupeKey(config: GenericConfig, eventId: string, event: string, extras: GenericRequestExtras): string {
  return extras.idFromSettings && (config.event_name_path || config.event_name_header) ? `${eventId}:${event}` : eventId;
}

/** What the request carried outside the body that a generic source may read. */
export interface GenericRequestExtras {
  /** The value of the header named by `event_name_header`, when it was sent. */
  eventNameFromHeader?: string;
  /** The event id was read through this source's settings (a body path or a named header), not sent as X-Loomail-Event-Id. */
  idFromSettings?: boolean;
}

export function mapGeneric(config: GenericConfig, body: unknown, eventId?: string, extras: GenericRequestExtras = {}): MapResult {
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
  if (config.event_name_header) {
    const named = extras.eventNameFromHeader?.trim();
    if (named) event = named.slice(0, 100);
  }
  if (!extras.eventNameFromHeader?.trim() && config.event_name_path) {
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
        ? { track: { event, properties: config.send_properties ? body : {}, ...(eventId ? { messageId: dedupeKey(config, eventId, event, extras) } : {}) } }
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

export const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
export const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

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
    customerTrait: "stripe_customer_id",
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
