/**
 * Webhook signature rules for Paystack: the HMAC SHA-512 of the exact body under the
 * secret key. Pure functions, no network and no database.
 */
import { describe, it, expect } from "vitest";
import { signPaystackBody, verifyPaystackSignature } from "../src/billing/paystack.js";

describe("webhook signatures", () => {
  const body = JSON.stringify({ event: "charge.success", data: { reference: "r1", amount: 4900 } });
  const key = "sk_test_signing_key";

  it("accepts the HMAC SHA-512 of the exact body under the secret key", () => {
    expect(verifyPaystackSignature(body, signPaystackBody(body, key), key)).toBe(true);
  });

  it("matches a known HMAC SHA-512 value, so the algorithm cannot drift", () => {
    // openssl: printf 'hello' | openssl dgst -sha512 -hmac 'secret'
    expect(signPaystackBody("hello", "secret")).toBe(
      "db1595ae88a62fd151ec1cba81b98c39df82daae7b4cb9820f446d5bf02f1dcfca6683d88cab3e273f5963ab8ec469a746b5b19086371239f67d1e5f99a79440",
    );
  });

  it("rejects a different body, a different key, and every kind of malformed signature", () => {
    const good = signPaystackBody(body, key);
    expect(verifyPaystackSignature(body + " ", good, key)).toBe(false);
    expect(verifyPaystackSignature(body, good, "another_key")).toBe(false);
    for (const bad of [undefined, null, 5, "", "zz", good.slice(0, -2), good + "00", good.toUpperCase().slice(0, 10), ["x"]]) {
      expect(verifyPaystackSignature(body, bad, key), String(bad)).toBe(false);
    }
  });

  it("is case-insensitive about hex digits, since both spell the same bytes", () => {
    expect(verifyPaystackSignature(body, signPaystackBody(body, key).toUpperCase(), key)).toBe(true);
  });
});
