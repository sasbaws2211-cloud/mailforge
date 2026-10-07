/**
 * Reading MAILFORGE_TRUST_PROXY. A typo must never silently turn on trust in the
 * X-Forwarded-For header, because that lets a client choose its own address.
 */
import { describe, it, expect } from "vitest";
import { trustProxyFromEnv } from "../src/trust-proxy.js";

describe("trustProxyFromEnv", () => {
  it("does not trust by default", () => {
    for (const v of [undefined, null, "", "  ", "false", "FALSE", "0", "no", "off"]) expect(trustProxyFromEnv(v as string | undefined), String(v)).toBe(false);
  });

  it("trusts every hop for true, in any case and with spaces", () => {
    for (const v of ["true", "TRUE", " True "]) expect(trustProxyFromEnv(v), v).toBe(true);
  });

  it("trusts exactly that many proxies for a number from 1 to 10", () => {
    expect(trustProxyFromEnv("1")).toBe(1);
    expect(trustProxyFromEnv(" 2 ")).toBe(2);
    expect(trustProxyFromEnv("10")).toBe(10);
  });

  it("anything else is NOT trusted: out-of-range numbers, decimals, negatives, words, lists", () => {
    for (const v of ["11", "100", "-1", "1.5", "1e1", "0x2", "yes", "1,2", "127.0.0.1", "loopback", "tru", "ture"]) {
      expect(trustProxyFromEnv(v), v).toBe(false);
    }
  });
});
