/**
 * Flutterwave v3 client: just the calls billing needs.
 *
 *   POST /v3/payment-plans              create a recurring plan
 *   POST /v3/payments                   create a hosted checkout link (with payment_plan)
 *   GET  /v3/transactions/:id/verify    confirm a transaction really happened
 *   GET  /v3/subscriptions?email=       find a customer's subscriptions
 *   PUT  /v3/subscriptions/:id/cancel   stop future charges
 *
 * Every response is the v3 envelope { status, message, data }. Anything that is
 * not an HTTP 2xx with status "success" becomes a FlutterwaveError. The base URL
 * and fetch are injectable so tests (and the local fake) never touch the real API.
 *
 * Flutterwave recurring billing is card only, and the charge currency must match
 * the plan currency; both are enforced on their side.
 *
 * Mirror side: PUBLIC (packages/api is mirrored).
 */

export const FLUTTERWAVE_DEFAULT_BASE_URL = "https://api.flutterwave.com/v3";

export interface FlutterwaveConfig {
  secretKey: string;
  /** Defaults to the live v3 API. Point at a fake in tests and local development. */
  baseUrl?: string;
  /** Injectable for tests. Defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Per-request timeout. Webhooks must answer within 60 s, so keep this well under. */
  timeoutMs?: number;
}

export class FlutterwaveError extends Error {
  constructor(
    message: string,
    /** HTTP status, or undefined for network errors and timeouts. */
    readonly httpStatus?: number,
    /** True when retrying later might succeed (network, timeout, 5xx, 429). */
    readonly transient: boolean = false,
  ) {
    super(message);
    this.name = "FlutterwaveError";
  }
}

export interface FlutterwaveTransaction {
  id: number | string;
  tx_ref: string;
  flw_ref?: string;
  amount: number;
  charged_amount?: number;
  currency: string;
  /** "successful" is the only status that means money moved. */
  status: string;
  payment_type?: string;
  customer?: { id?: number; email?: string; name?: string };
  meta?: Record<string, unknown> | null;
  /** Present on charges made under a payment plan (field name varies by endpoint). */
  plan?: number | string | null;
  payment_plan?: number | string | null;
}

export interface FlutterwaveSubscription {
  id: number | string;
  amount?: number;
  customer?: { id?: number; customer_email?: string };
  plan: number | string;
  status: string;
  created_at?: string;
}

export interface CreatePaymentLinkInput {
  txRef: string;
  amount: number;
  currency: string;
  redirectUrl: string;
  customer: { email: string; name: string };
  paymentPlanId: string;
  title: string;
  description: string;
  meta?: Record<string, string>;
}

export interface FlutterwaveClient {
  createPaymentPlan(input: {
    name: string;
    amount: number;
    interval: "monthly" | "yearly";
    currency: string;
  }): Promise<{ id: string }>;
  createPaymentLink(input: CreatePaymentLinkInput): Promise<{ link: string }>;
  verifyTransaction(transactionId: string | number): Promise<FlutterwaveTransaction>;
  listSubscriptions(email: string): Promise<FlutterwaveSubscription[]>;
  cancelSubscription(subscriptionId: string | number): Promise<void>;
}

interface Envelope<T> {
  status?: string;
  message?: string;
  data?: T;
}

export function createFlutterwaveClient(cfg: FlutterwaveConfig): FlutterwaveClient {
  const base = (cfg.baseUrl ?? FLUTTERWAVE_DEFAULT_BASE_URL).replace(/\/+$/, "");
  const doFetch = cfg.fetch ?? fetch;
  const timeoutMs = cfg.timeoutMs ?? 20_000;
  const allowHttp = base.startsWith("http://");

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
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
      throw new FlutterwaveError(
        aborted ? `Flutterwave request timed out after ${timeoutMs} ms` : `Could not reach Flutterwave: ${err instanceof Error ? err.message : String(err)}`,
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
      throw new FlutterwaveError(
        json?.message ? `Flutterwave: ${json.message}` : `Flutterwave returned HTTP ${res.status}`,
        res.status,
        res.status >= 500 || res.status === 429,
      );
    }
    if (!json || json.status !== "success" || json.data === undefined) {
      throw new FlutterwaveError(json?.message ? `Flutterwave: ${json.message}` : "Flutterwave returned an unexpected response", res.status, false);
    }
    return json.data;
  }

  return {
    async createPaymentPlan(input) {
      const data = await call<{ id: number | string }>("POST", "/payment-plans", {
        name: input.name,
        amount: input.amount,
        interval: input.interval,
        currency: input.currency,
      });
      if (data.id === undefined || data.id === null) throw new FlutterwaveError("Flutterwave did not return a plan id");
      return { id: String(data.id) };
    },

    async createPaymentLink(input) {
      const data = await call<{ link?: string }>("POST", "/payments", {
        tx_ref: input.txRef,
        amount: input.amount,
        currency: input.currency,
        redirect_url: input.redirectUrl,
        payment_plan: input.paymentPlanId,
        customer: { email: input.customer.email, name: input.customer.name },
        customizations: { title: input.title, description: input.description },
        meta: input.meta ?? {},
      });
      // The customer is sent to this URL, so it must be https. Plain http is accepted
      // only when this client itself points at a local http fake (tests, local dev).
      const ok = data.link && (/^https:\/\//i.test(data.link) || (allowHttp && /^http:\/\//i.test(data.link)));
      if (!ok) throw new FlutterwaveError("Flutterwave did not return a usable checkout link");
      return { link: data.link as string };
    },

    verifyTransaction(transactionId) {
      return call<FlutterwaveTransaction>("GET", `/transactions/${encodeURIComponent(String(transactionId))}/verify`);
    },

    async listSubscriptions(email) {
      const data = await call<FlutterwaveSubscription[]>("GET", `/subscriptions?email=${encodeURIComponent(email)}`);
      return Array.isArray(data) ? data : [];
    },

    async cancelSubscription(subscriptionId) {
      await call<unknown>("PUT", `/subscriptions/${encodeURIComponent(String(subscriptionId))}/cancel`);
    },
  };
}
