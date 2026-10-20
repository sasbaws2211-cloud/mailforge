/**
 * Tests for the public marketing site: landing, pricing, legal, signup form,
 * robots.txt and sitemap.xml. No database needed for the pages themselves.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { PLANS, TRIAL_DAYS } from "@loomail/core";
import { buildApp } from "../src/index.js";

let app: FastifyInstance;
let off: FastifyInstance;

beforeAll(async () => {
  app = await buildApp({ publicSite: true, baseUrl: "https://loomail.test", logger: false });
  off = await buildApp({ logger: false });
});
afterAll(async () => {
  await app.close();
  await off.close();
});

async function get(path: string, headers: Record<string, string> = {}) {
  return app.inject({ method: "GET", url: path, headers });
}

/** Parse every JSON-LD block in a page. */
function jsonLd(html: string): unknown[] {
  return [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]!));
}

describe("public site is opt-in", () => {
  it("without publicSite none of the marketing routes exist", async () => {
    for (const path of ["/pricing", "/terms", "/privacy", "/signup", "/robots.txt", "/sitemap.xml"]) {
      const res = await off.inject({ method: "GET", url: path });
      expect(res.statusCode, path).toBe(404);
    }
  });
});

describe("landing page", () => {
  it("serves HTML with a clear call to action and correct metadata", async () => {
    const res = await get("/");
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.body).toContain("<h1>");
    expect(res.body).toContain('href="/signup"');
    expect(res.body).toContain("Start free trial");
    expect(res.body).toContain('<link rel="canonical" href="https://loomail.test/">');
    expect(res.body).toMatch(/<meta name="description" content="[^"]{40,}"/);
    expect(res.body).toContain('property="og:title"');
    expect(res.headers.vary).toMatch(/cookie/i);
  });

  it("states the trial in the plan terms, from the plans config", async () => {
    const res = await get("/");
    expect(res.body).toContain(`${TRIAL_DAYS} days of ${PLANS.essential.name}`);
    expect(res.body).toContain("No credit card");
  });

  it("shows the four use cases, in Loomail's own words, each tied to a ready-made flow", async () => {
    const body = (await get("/")).body;
    expect(body).toContain('id="use-cases"');
    for (const t of ["Welcome emails", "Recover abandoned purchases", "Subscription reminders", "Bring inactive users back"]) {
      expect(body).toContain(t);
    }
    for (const f of ["Welcome Onboarding", "Abandoned cart", "Renewal reminder"]) expect(body).toContain(f);
    expect(body.toLowerCase()).not.toContain("customer.io");
    expect(body).toContain('href="/#use-cases"');
  });

  it("emits valid JSON-LD: the product first, then the company and the site", async () => {
    const blocks = jsonLd((await get("/")).body) as Array<{ "@type": string }>;
    expect(blocks.map((b) => b["@type"])).toEqual(["SoftwareApplication", "Organization", "WebSite"]);
  });

  it("carries no leftover upstream brand and no fabricated social proof", async () => {
    const body = (await get("/")).body.toLowerCase();
    expect(body).not.toContain("claros");
    expect(body).not.toMatch(/trusted by|testimonial|as seen in|\d+\+? customers/);
  });

  it("without the dashboard built, a visitor with a session cookie still gets a page", async () => {
    const res = await get("/", { cookie: "loomail_session=abc" });
    expect(res.statusCode).toBe(200);
  });
});

describe("pricing page", () => {
  it("shows only the Essential plan with its price and features from the plans config", async () => {
    const res = await get("/pricing");
    expect(res.statusCode).toBe(200);
    const p = PLANS.essential;
    expect(res.body).toContain(`<h3>${p.name}</h3>`);
    for (const f of p.features) expect(res.body).toContain(f);
    expect(res.body).toContain("$100");
    expect(res.body.match(/<div class="plan-card/g)).toHaveLength(1);
    for (const gone of ["Starter", "Growth", "Scale", "Free forever", "Start free</a>", "billed yearly"]) {
      expect(res.body, gone).not.toContain(gone);
    }
  });

  it("has no billing-period toggle", async () => {
    const res = await get("/pricing");
    expect(res.body).not.toContain('class="toggle"');
  });

  it("the button starts a free trial of Essential", async () => {
    const res = await get("/pricing");
    expect(res.body).toContain('href="/signup?plan=essential"');
    expect(res.body).toContain(`Start ${TRIAL_DAYS}-day free trial`);
    expect(res.body).not.toContain('href="/signup?plan=free"');
  });

  it("JSON-LD lists the single Essential offer", async () => {
    const [ld] = jsonLd((await get("/pricing")).body) as Array<{ offers: Array<{ name: string; price: string }> }>;
    expect(ld!.offers).toEqual([{ "@type": "Offer", name: "Essential", price: "100", priceCurrency: "USD" }]);
  });
});

describe("legal pages", () => {
  it("terms and privacy render with the support contact and an update date", async () => {
    for (const path of ["/terms", "/privacy"]) {
      const res = await get(path);
      expect(res.statusCode, path).toBe(200);
      expect(res.body).toContain("Last updated");
      expect(res.body).toContain("support@loomail.test");
      expect(res.body.toLowerCase()).not.toContain("claros");
    }
  });

  it("the privacy policy describes only the one essential cookie", async () => {
    const res = await get("/privacy");
    expect(res.body).toContain("one essential cookie");
  });
});

describe("signup page", () => {
  it("renders the form with a honeypot and required terms", async () => {
    const res = await get("/signup");
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('action="/signup"');
    expect(res.body).toContain('name="workspace"');
    expect(res.body).toContain('name="email"');
    expect(res.body).toContain('name="terms"');
    expect(res.body).toContain('name="website"');
    expect(res.body).toContain('class="hp"');
  });

  it("carries the chosen plan, and ignores an invalid one", async () => {
    expect((await get("/signup?plan=essential")).body).toContain('name="plan" value="essential"');
    // The old plans and the internal free state are not offered any more.
    for (const old of ["starter", "growth", "scale", "free"]) {
      const body = (await get(`/signup?plan=${old}`)).body;
      expect(body).toContain('name="plan" value="essential"');
      expect(body).toContain(`Start your ${TRIAL_DAYS}-day free trial`);
    }
    const bad = await get("/signup?plan=%3Cscript%3E");
    expect(bad.body).toContain('name="plan" value="essential"');
    expect(bad.body).not.toContain("<script>");
  });

  it("posting without a database answers 503 as JSON or as the form, never a crash", async () => {
    const json = await app.inject({
      method: "POST",
      url: "/signup",
      payload: { workspace: "Acme", email: "a@acme.com", terms: "yes" },
      headers: { "content-type": "application/json" },
    });
    expect(json.statusCode).toBe(503);
    expect(json.json()).toEqual({ error: "Service unavailable." });

    const form = await app.inject({
      method: "POST",
      url: "/signup",
      payload: "workspace=Acme&email=a%40acme.com&terms=yes",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(form.statusCode).toBe(503);
    expect(form.body).toContain("temporarily unavailable");
  });
});

describe("robots.txt and sitemap.xml", () => {
  it("robots.txt hides app and API paths and points at the sitemap", async () => {
    const res = await get("/robots.txt");
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/plain/);
    for (const p of ["/v1/", "/auth/", "/invite/", "/unsubscribe"]) expect(res.body).toContain(`Disallow: ${p}`);
    expect(res.body).toContain("Sitemap: https://loomail.test/sitemap.xml");
  });

  it("sitemap.xml lists the public pages with absolute URLs", async () => {
    const res = await get("/sitemap.xml");
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/xml/);
    for (const p of ["/", "/pricing", "/signup", "/terms", "/privacy"]) {
      expect(res.body).toContain(`<loc>https://loomail.test${p}</loc>`);
    }
  });
});

describe("accessibility basics on every public page", () => {
  it("each page has a lang, a title, one h1, a skip link and a main landmark", async () => {
    for (const path of ["/", "/pricing", "/terms", "/privacy", "/signup"]) {
      const body = (await get(path)).body;
      expect(body, path).toContain('<html lang="en">');
      expect(body, path).toMatch(/<title>[^<]+<\/title>/);
      expect(body.match(/<h1[ >]/g), path).toHaveLength(1);
      expect(body, path).toContain('class="skip"');
      expect(body, path).toContain('<main id="main">');
    }
  });
});

describe("signup form: goal picker", () => {
  it("offers every goal as an optional radio, none pre-selected", async () => {
    const res = await get("/signup");
    for (const g of ["welcome", "convert_trials", "upgrade_free", "explore"]) {
      expect(res.body).toContain(`name="goal" value="${g}"`);
    }
    expect(res.body).toContain("What do you want to do first?");
    expect(res.body).toContain("(optional)");
    expect(res.body).not.toMatch(/name="goal" value="[a-z_]+" checked/);
  });

  it("pre-selects a goal from the link, and ignores an unknown one", async () => {
    expect((await get("/signup?goal=convert_trials")).body).toMatch(/name="goal" value="convert_trials" checked/);
    expect((await get("/signup?goal=nonsense")).body).not.toMatch(/name="goal" value="[a-z_]+" checked/);
  });

  it("does not make the question required", async () => {
    const res = await get("/signup");
    expect(res.body).not.toMatch(/name="goal"[^>]*required/);
  });
});

// ---------------------------------------------------------------------------------------------
// Search and social metadata
// ---------------------------------------------------------------------------------------------
const INDEXED_PAGES = ["/", "/pricing", "/terms", "/privacy", "/signup"] as const;

function meta(html: string, attr: "name" | "property", key: string): string[] {
  const escaped = key.replace(/[.*+?^${}()|[\]\\:]/g, "\\$&");
  return [...html.matchAll(new RegExp(`<meta ${attr}="${escaped}" content="([^"]*)"`, "g"))].map((m) => m[1]!);
}
const titleOf = (html: string) => /<title>([^<]*)<\/title>/.exec(html)![1]!.replace(/&amp;/g, "&").replace(/&#39;/g, "'");

describe("search and social metadata", () => {
  it.each(INDEXED_PAGES)("%s has a title, description and canonical that fit a search result", async (path) => {
    const html = (await get(path)).body;
    const title = titleOf(html);
    expect(title.length, title).toBeGreaterThanOrEqual(15);
    expect(title.length, title).toBeLessThanOrEqual(60);
    expect(title).toContain("Loomail");
    const [description] = meta(html, "name", "description");
    expect(description!.length, description).toBeGreaterThanOrEqual(70);
    expect(description!.length, description).toBeLessThanOrEqual(160);
    expect(html.match(/<link rel="canonical"/g)).toHaveLength(1);
    expect(meta(html, "name", "description")).toHaveLength(1);
    expect(html).toContain(`<link rel="canonical" href="https://loomail.test${path === "/" ? "/" : path}">`);
  });

  it("every page has a different title and a different description", async () => {
    const pages = await Promise.all(INDEXED_PAGES.map(async (p) => (await get(p)).body));
    expect(new Set(pages.map(titleOf)).size).toBe(INDEXED_PAGES.length);
    expect(new Set(pages.map((h) => meta(h, "name", "description")[0])).size).toBe(INDEXED_PAGES.length);
  });

  it.each(INDEXED_PAGES)("%s shows a large image when shared, on Open Graph and on Twitter", async (path) => {
    const html = (await get(path)).body;
    expect(meta(html, "property", "og:image")).toEqual(["https://loomail.test/og-default.png"]);
    expect(meta(html, "property", "og:image:width")).toEqual(["1200"]);
    expect(meta(html, "property", "og:image:height")).toEqual(["630"]);
    expect(meta(html, "property", "og:image:alt")[0]).toMatch(/Loomail/);
    expect(meta(html, "name", "twitter:card")).toEqual(["summary_large_image"]);
    expect(meta(html, "name", "twitter:image")).toEqual(["https://loomail.test/og-default.png"]);
    expect(meta(html, "name", "twitter:title")).toEqual(meta(html, "property", "og:title"));
    expect(meta(html, "name", "twitter:description")).toEqual(meta(html, "property", "og:description"));
    expect(meta(html, "property", "og:url")).toEqual([`https://loomail.test${path}`]);
  });

  it("the share image is a real 1200x630 PNG in the folder the site serves static files from", async () => {
    const { readFileSync } = await import("node:fs");
    const file = readFileSync(new URL("../../../apps/dashboard/public/og-default.png", import.meta.url));
    expect(file.subarray(1, 4).toString("ascii")).toBe("PNG");
    expect(file.readUInt32BE(16)).toBe(1200); // IHDR: width
    expect(file.readUInt32BE(20)).toBe(630); // IHDR: height
    expect(file.length).toBeLessThan(400_000); // small enough for every platform to accept
  });

  it.each(INDEXED_PAGES)("%s tells search engines it may be indexed and shown with a large image", async (path) => {
    expect(meta((await get(path)).body, "name", "robots")).toEqual(["index,follow,max-image-preview:large"]);
  });

  it("a page that must stay out of search says so and does not allow indexing", async () => {
    const { renderPage } = await import("../src/marketing/layout.js");
    const html = renderPage({ siteUrl: "https://loomail.test", supportEmail: "a@b.c", legalName: "X" }, { title: "T", description: "D", path: "/x", noindex: true }, "<p>x</p>");
    expect(meta(html, "name", "robots")).toEqual(["noindex,nofollow"]);
  });

  it("the homepage's structured data describes the product, its price and the company", async () => {
    const [app, org, site] = jsonLd((await get("/")).body) as Array<Record<string, any>>;
    expect(app).toMatchObject({ "@type": "SoftwareApplication", name: "Loomail", applicationCategory: "BusinessApplication", image: "https://loomail.test/og-default.png" });
    expect(app!.offers).toEqual({ "@type": "Offer", name: PLANS.essential.name, price: String(PLANS.essential.priceMonthlyUsd), priceCurrency: "USD" });
    expect(app!.featureList.length).toBeGreaterThanOrEqual(6);
    expect(org).toMatchObject({ "@type": "Organization", name: "Loomail", url: "https://loomail.test/", logo: "https://loomail.test/apple-touch-icon.png" });
    expect(site).toMatchObject({ "@type": "WebSite", name: "Loomail", url: "https://loomail.test/" });
  });

  it("the home page and the pricing page agree on the price", async () => {
    const [home] = jsonLd((await get("/")).body) as Array<{ offers: { price: string } }>;
    const [pricing] = jsonLd((await get("/pricing")).body) as Array<{ offers: Array<{ price: string }> }>;
    expect(home!.offers.price).toBe(pricing!.offers[0]!.price);
    expect((await get("/pricing")).body).toContain(`$${PLANS.essential.priceMonthlyUsd}`);
  });

  it("the pricing page says its place in the site", async () => {
    const blocks = jsonLd((await get("/pricing")).body) as Array<{ "@type": string; itemListElement?: Array<{ position: number; item: string }> }>;
    const crumbs = blocks.find((b) => b["@type"] === "BreadcrumbList")!;
    expect(crumbs.itemListElement!.map((c) => [c.position, c.item])).toEqual([[1, "https://loomail.test/"], [2, "https://loomail.test/pricing"]]);
  });

  it("the price in the pricing page's title and description is the real price", async () => {
    const html = (await get("/pricing")).body;
    expect(titleOf(html)).toContain(`$${PLANS.essential.priceMonthlyUsd}`);
    expect(meta(html, "name", "description")[0]).toContain(`$${PLANS.essential.priceMonthlyUsd}`);
  });

  it("the legal pages say what they cover instead of repeating their title", async () => {
    for (const path of ["/terms", "/privacy"]) {
      const [d] = meta((await get(path)).body, "name", "description");
      expect(d!.length, path).toBeGreaterThanOrEqual(70);
      expect(d, path).not.toMatch(/^(Terms of Service|Privacy Policy) for /);
    }
  });

  it("every page in the sitemap can be indexed, and exists", async () => {
    const xml = (await get("/sitemap.xml")).body;
    const paths = [...xml.matchAll(/<loc>https:\/\/loomail\.test([^<]*)<\/loc>/g)].map((m) => m[1]!);
    expect(paths.length).toBeGreaterThanOrEqual(5);
    for (const path of paths) {
      const res = await get(path);
      expect(res.statusCode, path).toBe(200);
      expect(meta(res.body, "name", "robots")[0], path).toMatch(/^index,follow/);
    }
  });

  it("JSON-LD text can never close its own script tag", async () => {
    for (const path of INDEXED_PAGES) {
      for (const [, block] of (await get(path)).body.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
        expect(block, path).not.toContain("<");
        expect(() => JSON.parse(block!)).not.toThrow();
      }
    }
  });
});
