/**
 * Inbound sources, the form half: turning what a person types into the settings the API takes, and back. No React,
 * no network. Mirrors the API's genericConfigSchema (packages/api/src/inbound/mapping.ts), which has the last word.
 *
 * Mirror side: PUBLIC (apps/dashboard is mirrored).
 */

export interface TraitRow {
  name: string;
  path: string;
}

export interface GenericForm {
  /** How the event is named: one fixed name, a name read from the payload or from a request header, or none (the request only sets traits). */
  eventMode: "fixed" | "path" | "header" | "none";
  eventValue: string;
  userIdPath: string;
  emailPath: string;
  /** Where the sender's own id for the event is, so a repeat delivery is recorded once. Optional. */
  eventIdPath: string;
  /** Or the request header that carries it (Shopify: X-Shopify-Event-Id). */
  eventIdHeader: string;
  /** How calls are checked: the token Loomail makes, or the sender's own signature (needs the shared signing secret). */
  verification: "token" | "signature";
  signatureHeader: string;
  signatureEncoding: "either" | "hex" | "base64";
  signaturePrefix: string;
  traits: TraitRow[];
  sendProperties: boolean;
}

/** A header name: letters, numbers and hyphens. */
export const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;

export const emptyGenericForm = (): GenericForm => ({
  eventMode: "fixed",
  eventValue: "",
  userIdPath: "",
  emailPath: "",
  eventIdPath: "",
  eventIdHeader: "",
  verification: "token",
  signatureHeader: "",
  signatureEncoding: "either",
  signaturePrefix: "",
  traits: [],
  sendProperties: true,
});

export type BuiltConfig = { ok: true; config: Record<string, unknown> } | { ok: false; problems: string[] };

/** The settings the API takes, or what is wrong with the form. */
export function buildGenericConfig(form: GenericForm): BuiltConfig {
  const problems: string[] = [];
  const userIdPath = form.userIdPath.trim();
  const emailPath = form.emailPath.trim();
  const eventIdPath = form.eventIdPath.trim();
  const eventIdHeader = form.eventIdHeader.trim();
  const signatureHeader = form.signatureHeader.trim();
  if (eventIdHeader && !HEADER_NAME.test(eventIdHeader)) problems.push("The event id header must be a header name: letters, numbers and hyphens.");
  if (form.verification === "signature") {
    if (!signatureHeader) problems.push("Say which header carries the signature.");
    else if (!HEADER_NAME.test(signatureHeader)) problems.push("The signature header must be a header name: letters, numbers and hyphens.");
  }
  if (!userIdPath && !emailPath) problems.push("Say where the person is in the payload: a user id field or an email field.");

  const trait_paths: Record<string, string> = {};
  for (const row of form.traits) {
    const name = row.name.trim();
    const path = row.path.trim();
    if (!name && !path) continue; // an empty row is just skipped
    if (!name || !path) {
      problems.push("Each trait needs both a name and a field to read it from.");
      continue;
    }
    if (name.length > 64) problems.push(`The trait name "${name.slice(0, 20)}..." is longer than 64 characters.`);
    if (name in trait_paths) problems.push(`The trait "${name}" is listed twice.`);
    trait_paths[name] = path;
  }
  if (Object.keys(trait_paths).length > 20) problems.push("A source can set at most 20 traits.");

  const eventValue = form.eventValue.trim();
  if (form.eventMode !== "none" && !eventValue) {
    problems.push(form.eventMode === "fixed" ? "Give the event a name." : form.eventMode === "header" ? "Say which header holds the event name." : "Say which field holds the event name.");
  }
  if (form.eventMode === "header" && eventValue && !HEADER_NAME.test(eventValue)) problems.push("The event name header must be a header name: letters, numbers and hyphens.");
  if (form.eventMode === "none" && Object.keys(trait_paths).length === 0) {
    problems.push("With no event, add at least one trait to set.");
  }
  if (problems.length > 0) return { ok: false, problems };

  return {
    ok: true,
    config: {
      ...(form.eventMode === "fixed" ? { event_name: eventValue } : {}),
      ...(form.eventMode === "path" ? { event_name_path: eventValue } : {}),
      ...(form.eventMode === "header" ? { event_name_header: eventValue } : {}),
      ...(userIdPath ? { user_id_path: userIdPath } : {}),
      ...(emailPath ? { email_path: emailPath } : {}),
      // An id only matters when an event is recorded.
      ...(eventIdPath && form.eventMode !== "none" ? { event_id_path: eventIdPath } : {}),
      ...(eventIdHeader && form.eventMode !== "none" ? { event_id_header: eventIdHeader } : {}),
      ...(form.verification === "signature"
        ? {
            verification: "signature",
            signature_header: signatureHeader,
            signature_encoding: form.signatureEncoding,
            ...(form.signaturePrefix.trim() ? { signature_prefix: form.signaturePrefix.trim() } : {}),
          }
        : {}),
      trait_paths,
      send_properties: form.sendProperties,
    },
  };
}

/** The form for a stored generic source's settings (the inverse of buildGenericConfig). */
export function genericFormFromConfig(config: Record<string, unknown>): GenericForm {
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const traits = config.trait_paths && typeof config.trait_paths === "object" ? Object.entries(config.trait_paths as Record<string, unknown>).map(([name, path]) => ({ name, path: str(path) })) : [];
  return {
    eventMode: typeof config.event_name_path === "string" ? "path" : typeof config.event_name_header === "string" ? "header" : typeof config.event_name === "string" ? "fixed" : "none",
    eventValue: str(config.event_name_path) || str(config.event_name_header) || str(config.event_name),
    userIdPath: str(config.user_id_path),
    emailPath: str(config.email_path),
    eventIdPath: str(config.event_id_path),
    eventIdHeader: str(config.event_id_header),
    verification: config.verification === "signature" ? "signature" : "token",
    signatureHeader: str(config.signature_header),
    signatureEncoding: config.signature_encoding === "hex" || config.signature_encoding === "base64" ? config.signature_encoding : "either",
    signaturePrefix: str(config.signature_prefix),
    traits,
    sendProperties: config.send_properties !== false,
  };
}

/** The address a sender posts to. The id is not secret; the token (or Stripe's signature) is. */
export const sourceUrl = (origin: string, id: string) => `${origin.replace(/\/+$/, "")}/webhooks/in/${id}`;

/** A curl command that sends a sample request to a generic source. */
export function sampleCurl(url: string, token: string, form: GenericForm): string {
  const sample: Record<string, unknown> = {};
  const put = (path: string, value: unknown) => {
    if (path.includes("[")) return; // a search such as answers[type=email].email has no single place to write a sample value
    const parts = path.split(".").filter(Boolean);
    let cur = sample;
    parts.forEach((p, i) => {
      if (i === parts.length - 1) cur[p] = value;
      else cur = (cur[p] = typeof cur[p] === "object" && cur[p] !== null ? (cur[p] as Record<string, unknown>) : {}) as Record<string, unknown>;
    });
  };
  if (form.eventMode === "path" && form.eventValue.trim()) put(form.eventValue.trim(), "form_submitted");
  if (form.userIdPath.trim()) put(form.userIdPath.trim(), "user_123");
  if (form.emailPath.trim()) put(form.emailPath.trim(), "ada@example.com");
  for (const t of form.traits) if (t.path.trim()) put(t.path.trim(), "example");
  const eventHeader = form.eventMode === "header" && form.eventValue.trim() ? ` \\\n  -H '${form.eventValue.trim()}: form_submitted'` : "";
  return `curl -X POST '${url}' \\\n  -H 'Authorization: Bearer ${token}' \\\n  -H 'Content-Type: application/json'${eventHeader} \\\n  -d '${JSON.stringify(sample)}'`;
}

export const LOG_STATUS_LABEL: Record<"processed" | "ignored" | "rejected" | "error", string> = {
  processed: "Received",
  ignored: "Ignored",
  rejected: "Rejected",
  error: "Error",
};

/** The events Loomail uses from Stripe: what to tick when adding the endpoint in Stripe. */
export const STRIPE_EVENTS_TO_SEND = [
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.paid",
  "invoice.payment_failed",
] as const;

/** The events Loomail uses from Paystack: what to expect in the log. */
export const PAYSTACK_EVENTS = [
  "charge.success",
  "subscription.create",
  "subscription.disable",
  "subscription.not_renew",
  "invoice.payment_failed",
  "invoice.update",
] as const;

/** The addresses Paystack says it sends from (the same for test and live). */
export const PAYSTACK_IPS = ["52.31.139.75", "52.49.173.169", "52.214.14.220"] as const;

/** What a source is called in lists and menus. */
export const SOURCE_KIND_LABEL: Record<"generic" | "stripe" | "paystack" | "flutterwave", string> = {
  generic: "JSON webhook",
  stripe: "Stripe",
  paystack: "Paystack",
  flutterwave: "Flutterwave",
};

/** The address to give Paystack when the source checks a token: it has to travel in the address, since Paystack sets no headers. */
export const addressWithToken = (url: string, token: string) => `${url}${url.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;

/** Does this look like a Paystack secret key? (The API checks again.) */
export const looksLikePaystackKey = (s: string) => /^sk_(test|live)_[A-Za-z0-9]{10,}$/.test(s.trim());

/** Does this look like a Stripe endpoint signing secret? (The API checks again.) */
export const looksLikeStripeSecret = (s: string) => /^whsec_[A-Za-z0-9]{16,}$/.test(s.trim());
