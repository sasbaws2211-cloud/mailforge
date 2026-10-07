/**
 * Billing runtime configuration.
 *
 * Billing is on only when Paystack is configured:
 *   PAYSTACK_SECRET_KEY   API secret key (sk_test_... or sk_live_...). Paystack signs
 *                         webhooks with this same key, so there is no separate secret.
 *   PAYSTACK_CURRENCY     charge currency, default USD (must be enabled on your account)
 *   PAYSTACK_USD_RATE     units of PAYSTACK_CURRENCY per 1 US dollar, for example 15.5 for
 *                         GHS. Required for any currency other than USD. Prices are set in
 *                         USD; the charge is the USD price times this rate, rounded up to a
 *                         whole unit.
 *   PAYSTACK_BASE_URL     override the API base, for tests and local development only
 *
 * With no key set, billing is off: the checkout routes answer 503, the public
 * webhook is not registered, and the dashboard keeps its "contact us" link. Billing is
 * also off, with a loud warning, for a non-USD currency with no valid rate: charging the
 * USD figure in another currency would undercharge or overcharge by the exchange rate.
 *
 * Mirror side: PUBLIC (packages/api is mirrored).
 */
import { parseUsdRate } from "@mailforge/core";
import { createPaystackClient, type PaystackClient } from "./paystack.js";

export interface BillingRuntime {
  /** True when a client and a webhook secret are both present. */
  enabled: boolean;
  client: PaystackClient | null;
  /** Verifies the x-paystack-signature header on every webhook (the Paystack secret key). */
  webhookSecret: string | null;
  currency: string;
  /** Units of `currency` per 1 USD. Always 1 for USD. */
  usdRate: number;
}

type Env = Record<string, string | undefined>;

export function billingRuntimeFromEnv(env: Env = process.env, warn: (message: string) => void = (m) => console.warn(m)): BillingRuntime {
  const secretKey = env.PAYSTACK_SECRET_KEY?.trim();
  const currency = (env.PAYSTACK_CURRENCY?.trim() || "USD").toUpperCase();
  const off: BillingRuntime = { enabled: false, client: null, webhookSecret: null, currency, usdRate: 1 };
  if (!secretKey) return off;

  let usdRate = 1;
  if (currency !== "USD") {
    const rate = parseUsdRate(env.PAYSTACK_USD_RATE);
    if (rate === null) {
      warn(
        `[billing] Online billing is OFF: PAYSTACK_CURRENCY is ${currency} but PAYSTACK_USD_RATE ` +
          `("${env.PAYSTACK_USD_RATE ?? ""}") is not a positive number of ${currency} per 1 USD. ` +
          "Set it, for example PAYSTACK_USD_RATE=15.5, or use PAYSTACK_CURRENCY=USD.",
      );
      return off;
    }
    usdRate = rate;
  }

  return {
    enabled: true,
    client: createPaystackClient({ secretKey, baseUrl: env.PAYSTACK_BASE_URL?.trim() || undefined }),
    webhookSecret: secretKey,
    currency,
    usdRate,
  };
}

/** Merge test or embedding overrides onto the environment-derived runtime. */
export function resolveBillingRuntime(override: Partial<BillingRuntime> | undefined, env: Env = process.env): BillingRuntime {
  const base = billingRuntimeFromEnv(env);
  if (!override) return base;
  const merged: BillingRuntime = { ...base, ...override };
  merged.enabled = Boolean(merged.client && merged.webhookSecret);
  return merged;
}
