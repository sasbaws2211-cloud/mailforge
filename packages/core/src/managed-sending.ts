/**
 * Managed sending: Mailforge sends a workspace's email through the operator's own
 * Resend account, so a customer does not need an email provider of their own.
 *
 * Which sending a workspace uses (same layering idea as AI):
 *   1. a transport of their own (Resend or SMTP they connected): always wins
 *   2. otherwise managed sending, if the operator offers it and the workspace turned it on
 *   3. otherwise nothing: messages wait until a transport exists
 *
 * Managed sending sends From one of two places:
 *   - the workspace's own verified domain (hello@mail.theirdomain.com): best for
 *     deliverability, and it keeps each customer's reputation their own
 *   - a shared operator address, with the workspace's brand as the display name and
 *     their own address as Reply-To, until a domain is verified: lets a new signup send
 *     at once, at a low daily volume, because one shared address shares one reputation
 *
 * Pure functions, no I/O.
 *
 * Mirror side: PUBLIC (packages/core is mirrored).
 */

// ---------------------------------------------------------------------------
// Operator configuration
// ---------------------------------------------------------------------------

export interface ManagedSendingConfig {
  /** Whether managed sending is offered at all: the operator gave it a Resend API key. */
  enabled: boolean;
  /** The operator's Resend key for customer email (never the key used for account emails). */
  apiKey: string | null;
  /** Signing secret for Resend webhooks sent to /webhooks/resend-platform. */
  webhookSecret: string | null;
  /** A verified address on a domain the operator owns, used until a workspace verifies its own. null = none offered. */
  sharedFrom: string | null;
  /** Emails per workspace per day while using the shared address. */
  sharedDailyLimit: number;
  /** Resend API base URL. Only ever from operator config (tests point it at a fake). */
  baseUrl: string;
}

export const DEFAULT_SHARED_DAILY_LIMIT = 100;
export const RESEND_API_BASE = "https://api.resend.com";

/** The operator's managed sending settings from the environment. */
export function managedSendingConfigFromEnv(env: Record<string, string | undefined> = process.env): ManagedSendingConfig {
  const apiKey = env.MAILFORGE_MANAGED_RESEND_API_KEY?.trim() || null;
  const sharedFrom = env.MAILFORGE_MANAGED_SHARED_FROM?.trim().toLowerCase() || null;
  const limitRaw = Number(env.MAILFORGE_MANAGED_SHARED_DAILY_LIMIT);
  return {
    enabled: apiKey !== null && env.MAILFORGE_MANAGED_SENDING !== "false",
    apiKey,
    webhookSecret: env.MAILFORGE_MANAGED_RESEND_WEBHOOK_SECRET?.trim() || null,
    sharedFrom: sharedFrom && SENDER_ADDRESS_RE.test(sharedFrom) ? sharedFrom : null,
    sharedDailyLimit: Number.isInteger(limitRaw) && limitRaw >= 1 ? limitRaw : DEFAULT_SHARED_DAILY_LIMIT,
    baseUrl: (env.MAILFORGE_MANAGED_RESEND_BASE_URL?.trim() || RESEND_API_BASE).replace(/\/+$/, ""),
  };
}

// ---------------------------------------------------------------------------
// Domains and sender names
// ---------------------------------------------------------------------------

/** A sending domain's state at Resend. */
export const DOMAIN_STATUSES = ["none", "not_started", "pending", "verified", "failed", "temporary_failure"] as const;
export type DomainStatus = (typeof DOMAIN_STATUSES)[number];

export function isDomainStatus(v: unknown): v is DomainStatus {
  return typeof v === "string" && (DOMAIN_STATUSES as readonly string[]).includes(v);
}

/** Free mail providers: nobody can verify these, and sending as them would be impersonation. */
const FREE_MAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "yahoo.co.uk", "ymail.com", "outlook.com", "hotmail.com", "live.com", "msn.com",
  "icloud.com", "me.com", "mac.com", "aol.com", "proton.me", "protonmail.com", "pm.me", "gmx.com", "gmx.net", "mail.com",
  "zoho.com", "yandex.com", "yandex.ru", "qq.com", "163.com", "126.com", "mail.ru", "fastmail.com", "hey.com", "tutanota.com",
  "example.com", "example.org", "example.net", "localhost", "test.com",
]);

const LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const SENDER_ADDRESS_RE = /^[a-z0-9._+-]{1,64}@[a-z0-9.-]{3,253}$/;
const LOCAL_PART_RE = /^[a-z0-9]([a-z0-9._+-]{0,62}[a-z0-9])?$/;

export type DomainCheck = { ok: true; domain: string } | { ok: false; error: string };

/**
 * Clean up and validate a sending domain a person typed. Accepts what people paste
 * (a URL, an email address, capitals, a trailing dot) and returns the bare domain.
 * `platformDomains` are the operator's own domains, which a customer may not claim.
 */
export function validateSendingDomain(input: unknown, platformDomains: readonly string[] = []): DomainCheck {
  if (typeof input !== "string") return { ok: false, error: "Enter the domain you send email from, for example mail.yourcompany.com." };
  let d = input.trim().toLowerCase();
  d = d.replace(/^[a-z][a-z0-9+.-]*:\/\//, ""); // https://
  d = d.replace(/^.*@/, ""); // anyone@
  d = d.split(/[/?#]/)[0] ?? "";
  d = d.replace(/:\d+$/, "").replace(/\.$/, "");
  if (d === "") return { ok: false, error: "Enter the domain you send email from, for example mail.yourcompany.com." };
  if (d.length > 253) return { ok: false, error: "That domain name is too long." };
  const labels = d.split(".");
  if (labels.length < 2) return { ok: false, error: "That does not look like a full domain name. Use something like mail.yourcompany.com." };
  if (!labels.every((l) => LABEL_RE.test(l))) {
    return { ok: false, error: "A domain can only use letters, numbers and hyphens, separated by dots." };
  }
  const tld = labels[labels.length - 1]!;
  if (/^\d+$/.test(tld)) return { ok: false, error: "Use a domain name, not an IP address." };
  if (!/^[a-z]{2,63}$|^xn--[a-z0-9-]+$/.test(tld)) return { ok: false, error: "That domain ending is not valid." };
  if ([...FREE_MAIL_DOMAINS].some((f) => d === f || d.endsWith(`.${f}`))) {
    return { ok: false, error: "That is a free email service's domain, which you cannot send from. Use a domain you own." };
  }
  for (const p of platformDomains) {
    const pd = p.trim().toLowerCase();
    if (pd !== "" && (d === pd || d.endsWith(`.${pd}`))) {
      return { ok: false, error: "That domain belongs to this service. Use a domain you own." };
    }
  }
  return { ok: true, domain: d };
}

/** The part before the @ on the sending address: letters, numbers and . _ + - only. */
export function validateFromLocalPart(input: unknown): { ok: true; local: string } | { ok: false; error: string } {
  if (typeof input !== "string") return { ok: false, error: "Enter the part before the @, for example hello." };
  const local = input.trim().toLowerCase();
  if (!LOCAL_PART_RE.test(local) || local.includes("..")) {
    return { ok: false, error: "Use letters, numbers and . _ + - only, for example hello or team." };
  }
  return { ok: true, local };
}

/**
 * A display name that is safe to put in a From header: no line breaks (header injection), no
 * quotes or angle brackets, collapsed spaces, at most 64 characters. Returns null when nothing is left.
 */
export function sanitizeDisplayName(name: unknown): string | null {
  if (typeof name !== "string") return null;
  const cleaned = name
    .replace(/[\r\n\t\0]+/g, " ")
    .replace(/["<>\\]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 64)
    .trim();
  return cleaned === "" ? null : cleaned;
}

/** Is this a sensible reply address? (One plain address, no name part, no whitespace.) */
export function isValidReplyAddress(v: unknown): v is string {
  return typeof v === "string" && v.length <= 254 && /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/.test(v);
}

// ---------------------------------------------------------------------------
// Choosing the sender
// ---------------------------------------------------------------------------

export interface ManagedSenderInput {
  /** The workspace's sending domain and its state, if it set one. */
  domain: string | null;
  domainStatus: DomainStatus;
  /** Part before the @ on the workspace's domain. */
  fromLocal: string;
  /** Display name the workspace chose, else its brand or workspace name. */
  fromName: string | null;
  fallbackName: string;
  /** Where replies go: the workspace's reply address, else its owner. */
  replyTo: string | null;
  /** The operator's shared address, if one is offered. */
  sharedFrom: string | null;
}

export type ManagedSender =
  | { ok: true; mode: "domain" | "shared"; fromEmail: string; fromName: string; replyTo: string | null }
  | { ok: false; reason: "needs_domain" };

/** Who a managed message is sent as. */
export function chooseManagedSender(i: ManagedSenderInput): ManagedSender {
  const name = sanitizeDisplayName(i.fromName) ?? sanitizeDisplayName(i.fallbackName) ?? "Notifications";
  if (i.domain && i.domainStatus === "verified") {
    return { ok: true, mode: "domain", fromEmail: `${i.fromLocal}@${i.domain}`, fromName: name, replyTo: i.replyTo };
  }
  if (i.sharedFrom) {
    return { ok: true, mode: "shared", fromEmail: i.sharedFrom, fromName: name, replyTo: i.replyTo };
  }
  return { ok: false, reason: "needs_domain" };
}

// ---------------------------------------------------------------------------
// Sender health: pause a workspace whose mail is hurting the shared account
// ---------------------------------------------------------------------------

/** How far back sender health looks. */
export const SENDER_HEALTH_WINDOW_DAYS = 7;
/** Fewest emails sent in the window before rates mean anything. */
export const SENDER_HEALTH_MIN_SENT = 100;
/** Complaints at or above this share of sent mail (and at least MIN_COMPLAINTS of them) trigger a pause. */
export const SENDER_COMPLAINT_RATE_PAUSE = 0.003;
export const SENDER_MIN_COMPLAINTS = 2;
/** Permanent bounces at or above this share (and at least MIN_HARD_BOUNCES) trigger a pause. */
export const SENDER_HARD_BOUNCE_RATE_PAUSE = 0.05;
export const SENDER_MIN_HARD_BOUNCES = 5;
/** Half of a pause threshold is a warning to the workspace. */
export const SENDER_WARN_FRACTION = 0.5;

export type SenderHealthState = "ok" | "warn" | "pause";

export interface SenderHealth {
  state: SenderHealthState;
  sent: number;
  hardBounces: number;
  complaints: number;
  bounceRate: number;
  complaintRate: number;
  /** Plain-language reasons, empty when ok. */
  reasons: string[];
}

const pct = (r: number) => `${(r * 100).toFixed(r < 0.01 ? 2 : 1)}%`;

/** Judge a workspace's recent sending from its counts. Too little volume is never judged. */
export function senderHealth(sent: number, hardBounces: number, complaints: number): SenderHealth {
  const bounceRate = sent > 0 ? hardBounces / sent : 0;
  const complaintRate = sent > 0 ? complaints / sent : 0;
  const base = { sent, hardBounces, complaints, bounceRate, complaintRate };
  if (sent < SENDER_HEALTH_MIN_SENT) return { ...base, state: "ok", reasons: [] };

  const pauseReasons: string[] = [];
  if (complaints >= SENDER_MIN_COMPLAINTS && complaintRate >= SENDER_COMPLAINT_RATE_PAUSE) {
    pauseReasons.push(`${complaints} spam complaints out of ${sent} emails (${pct(complaintRate)})`);
  }
  if (hardBounces >= SENDER_MIN_HARD_BOUNCES && bounceRate >= SENDER_HARD_BOUNCE_RATE_PAUSE) {
    pauseReasons.push(`${hardBounces} addresses that do not exist out of ${sent} emails (${pct(bounceRate)})`);
  }
  if (pauseReasons.length > 0) return { ...base, state: "pause", reasons: pauseReasons };

  const warnReasons: string[] = [];
  if (complaints >= 1 && complaintRate >= SENDER_COMPLAINT_RATE_PAUSE * SENDER_WARN_FRACTION) {
    warnReasons.push(`${complaints} spam complaints out of ${sent} emails (${pct(complaintRate)})`);
  }
  if (hardBounces >= 2 && bounceRate >= SENDER_HARD_BOUNCE_RATE_PAUSE * SENDER_WARN_FRACTION) {
    warnReasons.push(`${hardBounces} addresses that do not exist out of ${sent} emails (${pct(bounceRate)})`);
  }
  return { ...base, state: warnReasons.length > 0 ? "warn" : "ok", reasons: warnReasons };
}
