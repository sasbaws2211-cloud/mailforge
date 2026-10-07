/**
 * Paystack client: just the calls billing needs.
 *
 *   POST /plan                      create a recurring plan
 *   POST /transaction/initialize    create a hosted checkout link (with plan)
 *   GET  /transaction/verify/:ref   confirm a transaction really happened
 *   GET  /customer/:email           find a customer's numeric id
 *   GET  /subscription?customer=    list a customer's subscriptions
 *   GET  /subscription/:code        read one subscription (carries the email token)
 *   POST /subscription/disable      stop future charges ({ code, token })
 *
 * Every response is the envelope { status: boolean, message, data }. Anything that is
 * not an HTTP 2xx with status true becomes a PaystackError. The base URL and fetch are
 * injectable so tests (and the local fake) never touch the real API.
 *
 * Amounts are in the currency's minor unit (cents for USD, pesewas for GHS, kobo for NGN),
 * which is also how this codebase stores money, so no conversion happens here.
 *
 * Paystack signs webhooks with the same secret key it authenticates API calls with
 * (HMAC SHA-512 of the raw body in the x-paystack-signature header); see
 * verifyPaystackSignature.
 *
 * Mirror side: PUBLIC (packages/api is mirrored).
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const PAYSTACK_DEFAULT_BASE_URL = "https://api.paystack.co";

export interface PaystackConfig {
  secretKey: string;
  /** Defaults to the live API. Point at a fake in tests and local development. */
  baseUrl?: string;
  /** Injectable for tests. Defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Per-request timeout. Keep it well under the provider's webhook timeout. */
  timeoutMs?: number;
}

export class PaystackError extends Error {
  constructor(
    message: string,
    /** HTTP status, or undefined for network errors and timeouts. */
    readonly httpStatus?: number,
    /** True when retrying later might succeed (network, timeout, 5xx, 429). */
    readonly transient: boolean = false,
  ) {
    super(message);
    this.name = "PaystackError";
  }
}

export interface PaystackTransaction {
  id: number | string;
  /** Our own reference for a first payment; Paystack generates one for each renewal. */
  reference: string;
  /** "success" is the only status that means money moved. */
  status: string;
  /** Minor units (cents). */
  amount: number;
  currency: string;
  customer?: { id?: number; customer_code?: string; email?: string } | null;
  /** The plan the charge was made under. An empty object (or null) when there is none. */
  plan?: { plan_code?: string } | null;
  metadata?: Record<string, unknown> | string | null;
}

export interface PaystackSubscription {
  subscription_code: string;
  /** "active" | "non-renewing" | "attention" | "completed" | "cancelled" */
  status: string;
  plan?: { plan_code?: string } | null;
  customer?: { email?: string; customer_code?: string } | null;
}

export interface InitializeTransactionInput {
  reference: string;
  /** Minor units. Paystack charges the plan's amount when a plan is given. */
  amount: number;
  currency: string;
  email: string;
  callbackUrl: string;
  /** Where Paystack sends the customer if they close the payment page. */
  cancelUrl: string;
  planCode: string;
  metadata?: Record<string, unknown>;
}

export interface PaystackClient {
  createPlan(input: { name: string; amountCents: number; interval: "monthly" | "yearly"; currency: string }): Promise<{ code: string }>;
  /**
   * `url` is the hosted checkout page; `accessCode` opens the same payment in Paystack's inline
   * popup (null if Paystack did not send one, in which case use the URL).
   */
  initializeTransaction(input: InitializeTransactionInput): Promise<{ url: string; accessCode: string | null }>;
  verifyTransaction(reference: string): Promise<PaystackTransaction>;
  /** All of an email's subscriptions, newest first. Empty when the customer is unknown. */
  listSubscriptions(email: string): Promise<PaystackSubscription[]>;
  /** Stop future charges. Looks up the email token Paystack requires. */
  cancelSubscription(subscriptionCode: string): Promise<void>;
}

interface Envelope<T> {
  status?: boolean;
  message?: string;
  data?: T;
}

export function createPaystackClient(cfg: PaystackConfig): PaystackClient {
  const base = (cfg.baseUrl ?? PAYSTACK_DEFAULT_BASE_URL).replace(/\/+$/, "");
  const doFetch = cfg.fetch ?? fetch;
  const timeoutMs = cfg.timeoutMs ?? 20_000;
  const allowHttp = base.startsWith("http://");

  async function call<T>(method: string, path: string, body?: unknown, opts: { noData?: boolean } = {}): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${cfg.secretKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (err) {
      const aborted = err instanceof Error && err.name === "AbortError";
      throw new PaystackError(
        aborted ? `Paystack request timed out after ${timeoutMs} ms` : `Could not reach Paystack: ${err instanceof Error ? err.message : String(err)}`,
        undefined,
        true,
      );
    } finally {
      clearTimeout(timer);
    }

    let json: Envelope<T> | null = null;
    try {
      json = (await res.json()) as Envelope<T>;
    } catch {
      json = null;
    }

    if (!res.ok) {
      throw new PaystackError(
        json?.message ? `Paystack: ${json.message}` : `Paystack returned HTTP ${res.status}`,
        res.status,
        res.status >= 500 || res.status === 429,
      );
    }
    // Some calls (disabling a subscription) answer { status: true, message } with no data.
    if (!json || json.status !== true || (!opts.noData && (json.data === undefined || json.data === null))) {
      throw new PaystackError(json?.message ? `Paystack: ${json.message}` : "Paystack returned an unexpected response", res.status, false);
    }
    return json.data as T;
  }

  async function customerId(email: string): Promise<number | string | null> {
    try {
      const data = await call<{ id?: number | string }>("GET", `/customer/${encodeURIComponent(email)}`);
      return data.id ?? null;
    } catch (err) {
      // An address Paystack has never seen is not an error: it simply has no subscriptions.
      if (err instanceof PaystackError && err.httpStatus === 404) return null;
      throw err;
    }
  }

  return {
    async createPlan(input) {
      const data = await call<{ plan_code?: string }>("POST", "/plan", {
        name: input.name,
        amount: input.amountCents,
        // Paystack calls a yearly plan "annually".
        interval: input.interval === "yearly" ? "annually" : "monthly",
        currency: input.currency,
      });
      if (!data.plan_code) throw new PaystackError("Paystack did not return a plan code");
      return { code: data.plan_code };
    },

    async initializeTransaction(input) {
      const data = await call<{ authorization_url?: string; access_code?: string }>("POST", "/transaction/initialize", {
        email: input.email,
        amount: input.amount,
        currency: input.currency,
        reference: input.reference,
        callback_url: input.callbackUrl,
        plan: input.planCode,
        metadata: { ...(input.metadata ?? {}), cancel_action: input.cancelUrl },
      });
      // The customer is sent to this URL, so it must be https. Plain http is accepted
      // only when this client itself points at a local http fake (tests, local dev).
      const url = data.authorization_url;
      const ok = url && (/^https:\/\//i.test(url) || (allowHttp && /^http:\/\//i.test(url)));
      if (!ok) throw new PaystackError("Paystack did not return a usable checkout link");
      const accessCode = typeof data.access_code === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(data.access_code) ? data.access_code : null;
      return { url: url as string, accessCode };
    },

    verifyTransaction(reference) {
      return call<PaystackTransaction>("GET", `/transaction/verify/${encodeURIComponent(reference)}`);
    },

    async listSubscriptions(email) {
      const id = await customerId(email);
      if (id === null) return [];
      const data = await call<PaystackSubscription[]>("GET", `/subscription?customer=${encodeURIComponent(String(id))}`);
      return Array.isArray(data) ? data : [];
    },

    async cancelSubscription(subscriptionCode) {
      const sub = await call<{ subscription_code?: string; email_token?: string }>("GET", `/subscription/${encodeURIComponent(subscriptionCode)}`);
      if (!sub.email_token) throw new PaystackError("Paystack did not return a token for this subscription");
      await call<unknown>("POST", "/subscription/disable", { code: subscriptionCode, token: sub.email_token }, { noData: true });
    },
  };
}

/**
 * True when `signature` is the HMAC SHA-512 (hex) of the raw request body under the
 * secret key, which is how Paystack proves a webhook is its own. Compared in constant time.
 */
export function verifyPaystackSignature(rawBody: string, signature: unknown, secretKey: string): boolean {
  if (typeof signature !== "string" || signature === "") return false;
  const expected = createHmac("sha512", secretKey).update(rawBody).digest();
  let given: Buffer;
  try {
    given = Buffer.from(signature, "hex");
  } catch {
    return false;
  }
  // Buffer.from(hex) stops at the first bad character, so require the full length back.
  if (given.length !== expected.length) return false;
  return timingSafeEqual(given, expected);
}

/** The signature header value for a body: used by tests and the local fake. */
export function signPaystackBody(rawBody: string, secretKey: string): string {
  return createHmac("sha512", secretKey).update(rawBody).digest("hex");
}
