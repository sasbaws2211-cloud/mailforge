/**
 * Tests for the email shell accent: the top bar and the link color follow the
 * tenant accent, with the Mailforge default when none is set.
 */
import { describe, it, expect } from "vitest";
import { wrapInShell, wrapInTextShell, brandLinkStyle, DEFAULT_ACCENT } from "../src/index.js";

const LINK_DEFAULT = (href: string) => `<a href="${href}" style="${brandLinkStyle()}">go</a>`;

function shell(bodyHtml: string, accent?: string): string {
  return wrapInShell({
    bodyHtml,
    brand: accent === undefined ? {} : { accent_color: accent },
    tenantName: "Acme",
    complianceFooterHtml: "<p>footer</p>",
  });
}

/** Colors on every anchor in the html, in order. */
function linkColors(html: string): string[] {
  return [...html.matchAll(/<a [^>]*style="color:(#[0-9a-fA-F]{3,8});/g)].map((m) => m[1]!.toLowerCase());
}

function barColor(html: string): string | undefined {
  return html.match(/height:4px;background-color:(#[0-9a-fA-F]{3,8})/)?.[1]?.toLowerCase();
}

describe("email shell accent", () => {
  it("defaults to the Mailforge accent for the bar and for links", () => {
    const html = shell(LINK_DEFAULT("https://a.test"));
    expect(DEFAULT_ACCENT).toBe("#b8541a");
    expect(barColor(html)).toBe("#b8541a");
    expect(linkColors(html)).toEqual(["#b8541a"]);
  });

  it("recolors links to the tenant accent and keeps the bar in sync", () => {
    const html = shell(LINK_DEFAULT("https://a.test") + LINK_DEFAULT("https://b.test"), "#2563eb");
    expect(barColor(html)).toBe("#2563eb");
    expect(linkColors(html)).toEqual(["#2563eb", "#2563eb"]);
  });

  it("recolors links already stored by earlier builds (legacy blue default)", () => {
    const legacy = `<a href="https://a.test" style="${brandLinkStyle("#2563eb")}">old</a>`;
    expect(linkColors(shell(legacy))).toEqual(["#b8541a"]);
    expect(linkColors(shell(legacy, "#117733"))).toEqual(["#117733"]);
  });

  it("leaves links that do not carry the renderer style untouched", () => {
    const custom = '<a href="https://a.test" style="color:#ff00ff;text-decoration:underline;">x</a>';
    const html = shell(custom + LINK_DEFAULT("https://b.test"), "#117733");
    expect(linkColors(html)).toEqual(["#ff00ff", "#117733"]);
  });

  it("darkens an accent too light to read as a link, but leaves the bar as set", () => {
    const html = shell(LINK_DEFAULT("https://a.test"), "#ffd84d");
    expect(barColor(html)).toBe("#ffd84d");
    const [link] = linkColors(html);
    expect(link).not.toBe("#ffd84d");
    // Darkened toward black, still the same hue family (red >= green >= blue).
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(link!.slice(i, i + 2), 16)) as [number, number, number];
    expect(r).toBeGreaterThanOrEqual(g);
    expect(g).toBeGreaterThan(b);
    // 4.5:1 against white.
    const lin = (c: number) => ((c / 255) <= 0.03928 ? c / 255 / 12.92 : Math.pow((c / 255 + 0.055) / 1.055, 2.4));
    const lum = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    expect(1.05 / (lum + 0.05)).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps an accent that already reads well exactly as set", () => {
    expect(linkColors(shell(LINK_DEFAULT("https://a.test"), "#117733"))).toEqual(["#117733"]);
  });

  it("handles 3-digit and 8-digit hex accents", () => {
    expect(linkColors(shell(LINK_DEFAULT("https://a.test"), "#173"))).toEqual(["#117733"]);
    expect(linkColors(shell(LINK_DEFAULT("https://a.test"), "#117733cc"))).toEqual(["#117733"]);
  });

  describe("dark mode link rule", () => {
    const DARK_BG = [0x16, 0x21, 0x3e] as const;
    const lin = (c: number) => (c / 255 <= 0.03928 ? c / 255 / 12.92 : Math.pow((c / 255 + 0.055) / 1.055, 2.4));
    const lum = (r: number, g: number, b: number) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
    const contrastOnDark = (hex: string) => (lum(...rgb(hex)) + 0.05) / (lum(...DARK_BG) + 0.05);

    /** The dark-mode link color, plus whether the rule sits inside the dark @media block. */
    function darkRule(html: string): { color: string; inDarkBlock: boolean } {
      const m = html.match(/\.email-content a \{ color: (#[0-9a-f]{6}) !important; \}/i);
      expect(m, "dark-mode link rule present").not.toBeNull();
      const media = html.indexOf("@media (prefers-color-scheme: dark)");
      const styleEnd = html.indexOf("</style>");
      return { color: m![1]!.toLowerCase(), inDarkBlock: media >= 0 && m!.index! > media && m!.index! < styleEnd };
    }

    it("adds a rule for body links inside the dark block only", () => {
      const { inDarkBlock } = darkRule(shell(LINK_DEFAULT("https://a.test")));
      expect(inDarkBlock).toBe(true);
      // Not applied outside dark mode: the inline link color stays the light one.
      expect(linkColors(shell(LINK_DEFAULT("https://a.test")))).toEqual(["#b8541a"]);
    });

    it("lightens the default orange until it reads on the dark card", () => {
      const { color } = darkRule(shell(LINK_DEFAULT("https://a.test")));
      expect(color).not.toBe("#b8541a");
      expect(contrastOnDark(color)).toBeGreaterThanOrEqual(4.5);
      // Still orange: red stays the dominant channel.
      const [r, g, b] = rgb(color);
      expect(r).toBeGreaterThan(g);
      expect(g).toBeGreaterThanOrEqual(b);
    });

    it("keeps an accent that already reads on dark exactly as set", () => {
      expect(darkRule(shell(LINK_DEFAULT("https://a.test"), "#ffd84d")).color).toBe("#ffd84d");
    });

    it("lightens a dark brand color and meets 4.5:1", () => {
      for (const accent of ["#000000", "#2563eb", "#117733", "#800000"]) {
        const { color } = darkRule(shell(LINK_DEFAULT("https://a.test"), accent));
        expect(contrastOnDark(color), accent).toBeGreaterThanOrEqual(4.5);
      }
    });

    it("leaves the footer link rule and the accent bar untouched", () => {
      const html = shell(LINK_DEFAULT("https://a.test"), "#117733");
      expect(html).toContain(".email-footer a { color: #a0a0a0 !important; }");
      expect(barColor(html)).toBe("#117733");
    });

    it("uses the default for an invalid accent (no CSS injection)", () => {
      const { color } = darkRule(shell(LINK_DEFAULT("https://a.test"), "red;}body{display:none"));
      expect(contrastOnDark(color)).toBeGreaterThanOrEqual(4.5);
    });
  });

  it("falls back to the default for an invalid accent (no CSS injection)", () => {
    const html = shell(LINK_DEFAULT("https://a.test"), "red;}body{display:none");
    expect(barColor(html)).toBe("#b8541a");
    expect(linkColors(html)).toEqual(["#b8541a"]);
    expect(html).not.toContain("display:none");
  });
});

describe("powered-by credit line", () => {
  const withCredit = (poweredBy?: { name: string; url: string }) =>
    wrapInShell({ bodyHtml: "<p>hi</p>", brand: {}, tenantName: "Acme", complianceFooterHtml: "<p>footer</p>", poweredBy });
  const textWith = (poweredBy?: { name: string; url: string }) =>
    wrapInTextShell({ bodyText: "hi", brand: {}, tenantName: "Acme", complianceFooterText: "footer", poweredBy });

  it("is absent unless asked for", () => {
    expect(withCredit()).not.toContain("Sent with");
    expect(textWith()).not.toContain("Sent with");
  });

  it("adds a small link under the compliance footer in HTML", () => {
    const html = withCredit({ name: "Mailforge", url: "https://mailforge.example" });
    expect(html).toContain('<a href="https://mailforge.example"');
    expect(html).toContain("Sent with Mailforge");
    expect(html.indexOf("footer")).toBeLessThan(html.indexOf("Sent with Mailforge"));
    // It lives inside the footer cell, so the dark-mode footer link color applies.
    const footerCell = html.slice(html.indexOf("email-footer"));
    expect(footerCell).toContain("Sent with Mailforge");
  });

  it("adds a plain line in the text version", () => {
    const text = textWith({ name: "Mailforge", url: "https://mailforge.example" });
    expect(text.endsWith("footer\n\nSent with Mailforge: https://mailforge.example")).toBe(true);
  });

  it("refuses any link that is not http(s): no javascript:, data: or relative links", () => {
    for (const url of ["javascript:alert(1)", "data:text/html,x", "/relative", "ftp://x.test", "", "mailforge.example"]) {
      expect(withCredit({ name: "Mailforge", url }), url).not.toContain("Sent with");
      expect(textWith({ name: "Mailforge", url }), url).not.toContain("Sent with");
    }
  });

  it("escapes the name and the url in HTML", () => {
    const html = withCredit({ name: '<b>Evil</b> & "Co"', url: 'https://x.test/?a="b"&c=<d>' });
    expect(html).not.toContain("<b>Evil</b>");
    expect(html).toContain("&lt;b&gt;Evil&lt;/b&gt;");
    expect(html).not.toContain('?a="b"');
    expect(html).toContain("&quot;");
  });
});
