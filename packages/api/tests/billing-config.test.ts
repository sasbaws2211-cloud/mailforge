/**
 * How the billing runtime is read from the environment, in particular the rule that a
 * non-USD charge currency needs an exchange rate. No network, no database.
 */
import { describe, it, expect } from "vitest";
import { billingRuntimeFromEnv } from "../src/billing/config.js";

const run = (env: Record<string, string | undefined>) => {
  const warnings: string[] = [];
  const runtime = billingRuntimeFromEnv(env, (m) => warnings.push(m));
  return { runtime, warnings };
};

describe("billing runtime from the environment", () => {
  it("is off with no key, whatever else is set", () => {
    const { runtime, warnings } = run({ PAYSTACK_CURRENCY: "GHS", PAYSTACK_USD_RATE: "15.5" });
    expect(runtime).toMatchObject({ enabled: false, client: null, webhookSecret: null });
    expect(warnings).toEqual([]);
  });

  it("USD needs no rate and uses a rate of 1, ignoring any rate that is set", () => {
    expect(run({ PAYSTACK_SECRET_KEY: "sk_test_x" }).runtime).toMatchObject({ enabled: true, currency: "USD", usdRate: 1 });
    expect(run({ PAYSTACK_SECRET_KEY: "sk_test_x", PAYSTACK_CURRENCY: "usd", PAYSTACK_USD_RATE: "15.5" }).runtime).toMatchObject({ currency: "USD", usdRate: 1 });
  });

  it("the secret key doubles as the webhook secret", () => {
    expect(run({ PAYSTACK_SECRET_KEY: " sk_test_abc " }).runtime.webhookSecret).toBe("sk_test_abc");
  });

  it("GHS with a valid rate is on and carries the rate", () => {
    const { runtime, warnings } = run({ PAYSTACK_SECRET_KEY: "sk_test_x", PAYSTACK_CURRENCY: "ghs", PAYSTACK_USD_RATE: "15.5" });
    expect(runtime).toMatchObject({ enabled: true, currency: "GHS", usdRate: 15.5 });
    expect(warnings).toEqual([]);
  });

  it("GHS with no rate, or a bad one, turns billing OFF and says why, rather than charging the USD figure in cedis", () => {
    for (const rate of [undefined, "", "abc", "0", "-3", "15,5", "1e2"]) {
      const { runtime, warnings } = run({ PAYSTACK_SECRET_KEY: "sk_test_x", PAYSTACK_CURRENCY: "GHS", PAYSTACK_USD_RATE: rate });
      expect(runtime.enabled, String(rate)).toBe(false);
      expect(runtime.client).toBeNull();
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("PAYSTACK_USD_RATE");
      expect(warnings[0]).toContain("GHS");
    }
  });

  it("the warning never contains the secret key", () => {
    const { warnings } = run({ PAYSTACK_SECRET_KEY: "sk_test_SUPERSECRET", PAYSTACK_CURRENCY: "GHS" });
    expect(warnings.join(" ")).not.toContain("SUPERSECRET");
  });
});
