/**
 * Billing runtime configuration.
 *
 * Billing is on only when Flutterwave is configured:
 *   FLUTTERWAVE_SECRET_KEY    API secret key (FLWSECK_TEST-... or FLWSECK-...)
 *   FLUTTERWAVE_WEBHOOK_HASH  the secret hash you set on the Flutterwave webhook
 *   FLUTTERWAVE_CURRENCY      charge currency, default USD (must be enabled on your account)
 *   FLUTTERWAVE_BASE_URL      override the API base, for tests and local development only
 *
 * With neither key set, billing is off: the checkout routes answer 503, the
 * public webhook is not registered, and the dashboard keeps its "contact us" link.
 *
 * Mirror side: PUBLIC (packages/api is mirrored).
 */
import { createFlutterwaveClient, type FlutterwaveClient } from "./flutterwave.js";

export interface BillingRuntime {
  /** True when a client and a webhook hash are both present. */
  enabled: boolean;
  client: FlutterwaveClient | null;
  /** Compared with the verif-hash header on every webhook. */
  webhookHash: string | null;
  currency: string;
}

type Env = Record<string, string | undefined>;

export function billingRuntimeFromEnv(env: Env = process.env): BillingRuntime {
  const secretKey = env.FLUTTERWAVE_SECRET_KEY?.trim();
  const webhookHash = env.FLUTTERWAVE_WEBHOOK_HASH?.trim();
  const currency = (env.FLUTTERWAVE_CURRENCY?.trim() || "USD").toUpperCase();
  if (!secretKey || !webhookHash) return { enabled: false, client: null, webhookHash: null, currency };
  return {
    enabled: true,
    client: createFlutterwaveClient({ secretKey, baseUrl: env.FLUTTERWAVE_BASE_URL?.trim() || undefined }),
    webhookHash,
    currency,
  };
}

/** Merge test or embedding overrides onto the environment-derived runtime. */
export function resolveBillingRuntime(override: Partial<BillingRuntime> | undefined, env: Env = process.env): BillingRuntime {
  const base = billingRuntimeFromEnv(env);
  if (!override) return base;
  const merged: BillingRuntime = { ...base, ...override };
  merged.enabled = Boolean(merged.client && merged.webhookHash);
  return merged;
}
