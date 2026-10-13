/**
 * The public pricing page when customers are charged in a currency other than US dollars.
 * Pure rendering: no network, no database.
 */
import { describe, it, expect } from "vitest";
import { localMoney, pricingPage } from "../src/marketing/pages.js";
import type { SiteContext } from "../src/marketing/layout.js";

const base: SiteContext = { siteUrl: "https://loomail.example", supportEmail: "support@loomail.example", legalName: "Loomail" };
const page = (over: Partial<SiteContext> = {}): string => {
  const out = pricingPage({ ...base, ...over }) as unknown;
  return typeof out === "string" ? out : String((out as { html?: string }).html ?? JSON.stringify(out));
};

describe("pricing page in GHS", () => {
  const ghs = page({ chargeCurrency: "GHS", usdRate: 15.5 });

  it("keeps the dollar price and adds what is really charged under the plan", () => {
    expect(ghs).toContain("$100");
    expect(ghs).toContain("Charged as GH₵1,550 a month"); // 100 x 15.5
    expect(ghs).not.toContain("a year");
  });

  it("shows the cedi line once, for the single paid plan", () => {
    expect(ghs.match(/Charged as/g)?.length).toBe(1);
  });

  it("says prices are listed in dollars and charged in cedis", () => {
    expect(ghs).toContain("charged in your local currency at a fixed exchange rate");
    expect(ghs).not.toContain("Prices are in US dollars.");
  });
});

describe("pricing page in USD (or with no valid rate)", () => {
  it("shows dollars only, with no cedi line", () => {
    for (const ctx of [{}, { chargeCurrency: null, usdRate: null }, { chargeCurrency: "GHS", usdRate: null }, { chargeCurrency: null, usdRate: 15.5 }]) {
      const html = page(ctx);
      expect(html).not.toContain("Charged as");
      expect(html).toContain("Prices are in US dollars.");
    }
  });
});

describe("localMoney", () => {
  it("formats whole units with the local symbol and never throws", () => {
    expect(localMoney(760, "GHS")).toBe("GH₵760");
    expect(localMoney(7595, "GHS")).toBe("GH₵7,595");
    expect(() => localMoney(5, "NOT-A-CURRENCY")).not.toThrow();
    expect(localMoney(5, "NOT-A-CURRENCY")).toBe("5 NOT-A-CURRENCY");
  });
});
