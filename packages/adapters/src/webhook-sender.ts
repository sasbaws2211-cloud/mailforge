/**
 * Outbound webhook calls: what a flow's webhook step sends, how it is signed, and the rules for where it may go.
 *
 * A customer types the URL, and the server connects to it, so the same worry as the SMTP guard applies: it must not
 * be a way to reach the operator's own network (database, other containers, the cloud metadata address). When the
 * guard is on:
 *   - the address must be https
 *   - the host is resolved and the call is refused if ANY resolved address is loopback, private, link-local,
 *     carrier-grade NAT, reserved or multicast (the same check as the SMTP guard)
 *   - the connection goes to the address that was checked, with TLS still verifying the original name, so a name
 *     that changes its answer between the check and the call cannot slip through (DNS rebinding)
 *   - redirects are never followed (a public server answering "go to 169.254.169.254" gets nothing)
 *
 * The operator can exempt hosts they trust with LOOMAIL_WEBHOOK_ALLOWED_HOSTS. The guard is on by default for a
 * hosted service and off for a self-hosted install, where calling a service on your own network is normal;
 * LOOMAIL_RESTRICT_WEBHOOK_HOSTS=true|false overrides either way.
 *
 * Signing: every call carries `X-Loomail-Signature: t=<unix seconds>,v1=<hex>` where v1 is
 * HMAC-SHA256(secret, `${t}.${raw body}`). The receiver recomputes it over the raw bytes it received, compares in
 * constant time, and rejects a `t` that is too old.
 *
 * Mirror side: PUBLIC (packages/adapters is mirrored).
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import http from "node:http";
import https from "node:https";
import { decrypt, encrypt, parseEncryptionKey } from "./crypto.js";
import { isBlockedIp, normalizeHost, type LookupFn } from "./smtp-guard.js";

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

export interface WebhookHostPolicy {
  /** When false nothing is checked. */
  restrict: boolean;
  /** Hostnames or addresses the operator trusts; they skip the checks. Lower case. */
  allowedHosts: readonly string[];
  /** Test hook: replaces DNS. */
  lookup?: LookupFn;
}

function flag(v: string | undefined): boolean | null {
  if (v === undefined || v.trim() === "") return null;
  const t = v.trim().toLowerCase();
  if (t === "true" || t === "1") return true;
  if (t === "false" || t === "0") return false;
  return null;
}

export function webhookHostPolicyFromEnv(env: Record<string, string | undefined> = process.env): WebhookHostPolicy {
  const explicit = flag(env.LOOMAIL_RESTRICT_WEBHOOK_HOSTS);
  const hosted = env.LOOMAIL_PUBLIC_SITE === "true" || env.LOOMAIL_ENFORCE_PLANS === "true";
  return {
    restrict: explicit ?? hosted,
    allowedHosts: (env.LOOMAIL_WEBHOOK_ALLOWED_HOSTS ?? "")
      .split(",")
      .map((h) => normalizeHost(h))
      .filter((h) => h !== ""),
  };
}

export const WEBHOOK_HOST_NOT_ALLOWED =
  "That address is not allowed on this service. Use a public https address, not a local or private one.";

const defaultLookup: LookupFn = (host) => dnsLookup(host, { all: true, verbatim: true });

export type WebhookTargetResult =
  | { ok: true; url: URL; /** Connect here. Same as the host when nothing was resolved. */ address: string; servername: string }
  | { ok: false; error: string };

/** Decide whether the server may call this URL, and which address to connect to. */
export async function resolveWebhookTarget(rawUrl: string, policy: WebhookHostPolicy): Promise<WebhookTargetResult> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, error: "The webhook address is not a valid web address." };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { ok: false, error: "The webhook address must start with https://." };
  if (url.username !== "" || url.password !== "") return { ok: false, error: "The webhook address must not contain a username or password." };

  const name = normalizeHost(url.hostname);
  if (!policy.restrict || policy.allowedHosts.includes(name)) return { ok: true, url, address: url.hostname, servername: url.hostname };

  if (url.protocol !== "https:") return { ok: false, error: "The webhook address must use https:// on this service." };
  if (name === "" || name === "localhost" || name.endsWith(".localhost") || name.endsWith(".internal") || name.endsWith(".local")) {
    return { ok: false, error: WEBHOOK_HOST_NOT_ALLOWED };
  }

  let addresses: Array<{ address: string; family: number }>;
  if (isIP(name) !== 0) {
    addresses = [{ address: name, family: isIP(name) }];
  } else {
    try {
      addresses = await (policy.lookup ?? defaultLookup)(name);
    } catch {
      return { ok: false, error: "The webhook address could not be found. Check the spelling." };
    }
  }
  if (addresses.length === 0) return { ok: false, error: "The webhook address could not be found. Check the spelling." };
  if (addresses.some((a) => isBlockedIp(a.address))) return { ok: false, error: WEBHOOK_HOST_NOT_ALLOWED };

  const chosen = addresses.find((a) => a.family === 4) ?? addresses[0]!;
  return { ok: true, url, address: chosen.address, servername: name };
}

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

/** The value of X-Loomail-Signature for a body sent at `timestamp` (unix seconds). */
export function signWebhook(secret: string, timestamp: number, body: string): string {
  const mac = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return `t=${timestamp},v1=${mac}`;
}

/**
 * What a receiver does, for tests and for people writing one in JavaScript: recompute and compare in constant
 * time, and refuse a timestamp more than `toleranceSeconds` from `nowSeconds`.
 */
export function verifyWebhookSignature(
  secret: string,
  header: string,
  body: string,
  nowSeconds: number,
  toleranceSeconds = 300,
): boolean {
  const parts = Object.fromEntries(header.split(",").map((p) => p.trim().split("=", 2) as [string, string]));
  const t = Number(parts.t);
  if (!Number.isInteger(t) || typeof parts.v1 !== "string") return false;
  if (Math.abs(nowSeconds - t) > toleranceSeconds) return false;
  const expected = Buffer.from(signWebhook(secret, t, body).split("v1=")[1]!, "hex");
  const given = Buffer.from(parts.v1, "hex");
  return expected.length === given.length && timingSafeEqual(expected, given);
}

// ---------------------------------------------------------------------------
// The signing secret at rest
// ---------------------------------------------------------------------------

/** A new random signing secret. */
export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(24).toString("hex")}`;
}

/** Encrypted with ENCRYPTION_KEY when the install has one, otherwise kept as `plain:<secret>`. */
export function sealWebhookSecret(secret: string, encryptionKeyEnv: string | undefined = process.env.ENCRYPTION_KEY): string {
  if (!encryptionKeyEnv) return `plain:${secret}`;
  return encrypt(secret, parseEncryptionKey(encryptionKeyEnv));
}

export function openWebhookSecret(sealed: string, encryptionKeyEnv: string | undefined = process.env.ENCRYPTION_KEY): string {
  if (sealed.startsWith("plain:")) return sealed.slice("plain:".length);
  if (!encryptionKeyEnv) throw new Error("The webhook signing secret is encrypted but ENCRYPTION_KEY is not set.");
  return decrypt(sealed, parseEncryptionKey(encryptionKeyEnv));
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

export interface WebhookSendResult {
  ok: boolean;
  status: number | null;
  /** Short reason when not ok. Never contains the response body. */
  error: string | null;
  /** Worth trying again later (network trouble, timeouts, 408, 429, 5xx). False for a refusal that will not change. */
  retryable: boolean;
}

export interface WebhookSendInput {
  url: string;
  /** The exact bytes to send: it is what the signature covers. */
  body: string;
  secret: string;
  /** Unix seconds; defaults to now. */
  timestamp?: number;
  headers?: Record<string, string>;
  policy?: WebhookHostPolicy;
  timeoutMs?: number;
}

export const WEBHOOK_TIMEOUT_MS = 10_000;

/** POST the body, signed. Never throws; every failure is a result. Redirects are not followed. */
export async function sendWebhook(input: WebhookSendInput): Promise<WebhookSendResult> {
  const policy = input.policy ?? webhookHostPolicyFromEnv();
  const target = await resolveWebhookTarget(input.url, policy);
  if (!target.ok) return { ok: false, status: null, error: target.error, retryable: false };

  const ts = input.timestamp ?? Math.floor(Date.now() / 1000);
  const { url } = target;
  const isHttps = url.protocol === "https:";
  const lib = isHttps ? https : http;
  const payload = Buffer.from(input.body, "utf8");

  return new Promise<WebhookSendResult>((resolve) => {
    let settled = false;
    const done = (r: WebhookSendResult) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    try {
      const req = lib.request(
        {
          host: target.address.replace(/^\[|\]$/g, ""),
          port: url.port || (isHttps ? 443 : 80),
          path: `${url.pathname}${url.search}`,
          method: "POST",
          // Connecting to the checked address, but talking to the original name.
          servername: isHttps && isIP(target.servername) === 0 ? target.servername : undefined,
          headers: {
            Host: url.host,
            "Content-Type": "application/json",
            "Content-Length": String(payload.length),
            "User-Agent": "Loomail-Webhooks/1",
            "X-Loomail-Signature": signWebhook(input.secret, ts, input.body),
            ...(input.headers ?? {}),
          },
          timeout: input.timeoutMs ?? WEBHOOK_TIMEOUT_MS,
        },
        (res) => {
          const status = res.statusCode ?? 0;
          // Read a little so the socket frees up, keep none of it.
          let seen = 0;
          res.on("data", (chunk: Buffer) => {
            seen += chunk.length;
            if (seen > 4096) res.destroy();
          });
          const finish = () => {
            if (status >= 200 && status < 300) return done({ ok: true, status, error: null, retryable: false });
            const retryable = status === 408 || status === 429 || status >= 500;
            const reason = status >= 300 && status < 400 ? `The server answered ${status} (redirects are not followed).` : `The server answered ${status}.`;
            done({ ok: false, status, error: reason, retryable });
          };
          res.on("end", finish);
          res.on("close", finish);
          res.on("error", finish);
        },
      );
      req.on("timeout", () => {
        req.destroy();
        done({ ok: false, status: null, error: "The server did not answer in time.", retryable: true });
      });
      req.on("error", (err: NodeJS.ErrnoException) => {
        done({ ok: false, status: null, error: `Could not reach the server (${err.code ?? "network error"}).`, retryable: true });
      });
      req.end(payload);
    } catch {
      done({ ok: false, status: null, error: "Could not send the request.", retryable: false });
    }
  });
}
