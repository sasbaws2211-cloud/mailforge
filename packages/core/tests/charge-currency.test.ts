/**
 * Converting a USD list price into the currency a customer is actually charged in.
 * Pure functions: no network, no database.
 */
import { describe, it, expect } from "vitest";
import { chargeAmountMinor, parseUsdRate, planPriceUsd, PLANS, MAX_USD_RATE } from "../src/index.js";

describe("chargeAmountMinor", () => {
  it("in USD it is the exact price in cents, for every plan and interval", () => {
    expect(chargeAmountMinor(49, "USD", 1)).toBe(4900);
    expect(chargeAmountMinor(planPriceUsd("starter", "monthly"), "USD", 1)).toBe(1900);
    expect(chargeAmountMinor(planPriceUsd("growth", "yearly"), "USD", 1)).toBe(49000);
    expect(chargeAmountMinor(planPriceUsd("scale", "yearly"), "USD", 1)).toBe(129000);
  });

  it("the currency code is not case sensitive, and a USD charge ignores whatever rate is passed", () => {
    expect(chargeAmountMinor(49, "usd", 15.5)).toBe(4900);
  });

  it("converts at the rate and rounds UP to a whole unit, never down", () => {
    // 49 x 15.5 = 759.5 -> GHS 760, charged as 76000 pesewas.
    expect(chargeAmountMinor(49, "GHS", 15.5)).toBe(76000);
    // 19 x 10.3 = 195.7 -> 196
    expect(chargeAmountMinor(19, "GHS", 10.3)).toBe(19600);
    // 129 x 12.01 = 1549.29 -> 1550
    expect(chargeAmountMinor(129, "GHS", 12.01)).toBe(155000);
  });

  it("an exact result is not pushed up by floating point noise", () => {
    // 100 x 1.1 is 110.00000000000001 in floating point; it must stay 110.
    expect(chargeAmountMinor(100, "GHS", 1.1)).toBe(11000);
    expect(chargeAmountMinor(49, "GHS", 10)).toBe(49000);
    expect(chargeAmountMinor(19, "NGN", 1500)).toBe(2850000);
  });

  it("always charges whole units: the minor amount is a multiple of 100", () => {
    for (const plan of ["starter", "growth", "scale"] as const) {
      for (const interval of ["monthly", "yearly"] as const) {
        for (const rate of [9.87, 10.3, 11.11, 12.5, 15.5, 16.01, 1650.7]) {
          const minor = chargeAmountMinor(planPriceUsd(plan, interval), "GHS", rate);
          expect(minor % 100, `${plan}/${interval}/${rate}`).toBe(0);
          // Never less than the true converted price, and less than one whole unit above it.
          const exact = planPriceUsd(plan, interval) * rate * 100;
          expect(minor).toBeGreaterThanOrEqual(Math.floor(exact));
          expect(minor - exact).toBeLessThan(100.0001);
        }
      }
    }
  });

  it("a yearly price converts as a whole, not as twelve rounded months", () => {
    // Growth yearly is $490 and monthly $49: at 15.5, 12 rounded months (12 x 760 = 9120) would be
    // dearer than the single yearly figure (7595 -> 7595).
    const yearly = chargeAmountMinor(PLANS.growth.priceAnnualUsd, "GHS", 15.5);
    expect(yearly).toBe(759500);
    expect(yearly).toBeLessThan(12 * chargeAmountMinor(PLANS.growth.priceMonthlyUsd, "GHS", 15.5));
  });
});

describe("parseUsdRate", () => {
  it("accepts plain positive decimal numbers, with surrounding spaces", () => {
    expect(parseUsdRate("15.5")).toBe(15.5);
    expect(parseUsdRate(" 10 ")).toBe(10);
    expect(parseUsdRate("0.0065")).toBe(0.0065);
    expect(parseUsdRate(String(MAX_USD_RATE))).toBe(MAX_USD_RATE);
  });

  it("refuses everything else instead of guessing", () => {
    for (const bad of [undefined, null, "", "  ", "abc", "0", "0.0", "-5", "+5", "1e3", "0x10", "15,5", "15.5.1", ".5", "5.", "NaN", "Infinity", "1 000", String(MAX_USD_RATE + 1), "99999999999999999999999"]) {
      expect(parseUsdRate(bad as string | null | undefined), String(bad)).toBeNull();
    }
  });
});
