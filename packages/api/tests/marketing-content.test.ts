/**
 * The blog and the comparison pages: the records are well formed, every page renders, every link works, and the fairness rules hold.
 * No database needed.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { ADDONS, PLANS, TRIAL_DAYS } from "@loomail/core";
import { buildApp } from "../src/index.js";
import {
  ALTERNATIVES,
  BLOG,
  contentPath,
  entries,
  getEntry,
  plainText,
  readingMinutes,
  related,
  staleAlternatives,
  type ContentEntry,
} from "../src/marketing/content/index.js";
import { longDate, OURS, usd } from "../src/marketing/content/html.js";

const ALL: ContentEntry[] = [...entries("blog"), ...entries("alternative")];
const SITE = "https://loomail.test";

let app: FastifyInstance;
const pages = new Map<string, string>();

beforeAll(async () => {
  app = await buildApp({ publicSite: true, baseUrl: SITE, logger: false });
  for (const e of ALL) {
    const res = await app.inject({ method: "GET", url: contentPath(e) });
    expect(res.statusCode, contentPath(e)).toBe(200);
    pages.set(contentPath(e), res.body);
  }
});
afterAll(async () => {
  await app.close();
});

const get = (url: string) => app.inject({ method: "GET", url });
const meta = (html: string, attr: "name" | "property", key: string): string[] =>
  [...html.matchAll(new RegExp(`<meta ${attr}="${key.replace(/[.*+?^${}()|[\]\\:]/g, "\\$&")}" content="([^"]*)"`, "g"))].map((m) => m[1]!);
const titleOf = (html: string) => /<title>([^<]*)<\/title>/.exec(html)![1]!.replace(/&amp;/g, "&").replace(/&#39;/g, "'");
const jsonLd = (html: string): Array<Record<string, any>> =>
  [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]!));
const articleHtml = (html: string) => /<article class="article">([\s\S]*?)<\/article>/.exec(html)![1]!;
const visible = (html: string) => plainText(html);

// ---------------------------------------------------------------- the records
describe("the records", () => {
  it("there are pages of both kinds", () => {
    expect(BLOG.length).toBeGreaterThanOrEqual(4);
    expect(ALTERNATIVES.length).toBeGreaterThanOrEqual(4);
  });

  it.each(["blog", "alternative"] as const)("%s slugs are unique, url-safe, and the path matches the kind", (kind) => {
    const list = entries(kind);
    expect(new Set(list.map((e) => e.slug)).size).toBe(list.length);
    for (const e of list) {
      expect(e.slug, e.slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(contentPath(e)).toBe(`/${kind === "blog" ? "blog" : "alternatives"}/${e.slug}`);
    }
  });

  it.each(ALL.map((e) => [contentPath(e), e] as const))("%s fits what search results show", (_path, e) => {
    expect(e.seoTitle.length).toBeLessThanOrEqual(51);
    const title = `${e.seoTitle} | Loomail`;
    expect(title.length, title).toBeLessThanOrEqual(60);
    expect(e.description.length, e.description).toBeGreaterThanOrEqual(70);
    expect(e.description.length, e.description).toBeLessThanOrEqual(155);
    expect(e.title.trim()).not.toBe("");
    expect(e.summary.trim()).not.toBe("");
  });

  it.each(ALL.map((e) => [contentPath(e), e] as const))("%s has real dates in order", (_path, e) => {
    for (const d of [e.published, e.updated]) {
      expect(d).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10), d).toBe(d);
    }
    expect(e.published <= e.updated).toBe(true);
    expect(e.updated <= new Date().toISOString().slice(0, 10)).toBe(true);
  });

  it("comparison pages name the other product; blog posts do not", () => {
    for (const e of ALTERNATIVES) {
      expect(e.competitor).toBeTruthy();
      expect(e.title).toContain(e.competitor!);
      expect(e.description).toContain(e.competitor!);
    }
    for (const e of BLOG) expect(e.competitor).toBeUndefined();
  });

  it("listings are newest first and stable", () => {
    for (const kind of ["blog", "alternative"] as const) {
      const list = entries(kind);
      const sorted = [...list].sort((a, b) => b.published.localeCompare(a.published) || a.title.localeCompare(b.title));
      expect(list.map((e) => e.slug)).toEqual(sorted.map((e) => e.slug));
    }
  });

  it("related pages never include the page itself and stay in their own kind", () => {
    for (const e of ALL) {
      const rel = related(e);
      expect(rel.map((r) => r.slug)).not.toContain(e.slug);
      expect(rel.every((r) => r.kind === e.kind)).toBe(true);
      expect(rel.length).toBeLessThanOrEqual(3);
    }
  });

  it("getEntry finds a page and refuses the right slug under the wrong kind", () => {
    expect(getEntry("blog", BLOG[0]!.slug)).toBe(BLOG[0]);
    expect(getEntry("alternative", BLOG[0]!.slug)).toBeUndefined();
    expect(getEntry("blog", "nope")).toBeUndefined();
  });

  it("plain text drops tags, scripts and entities", () => {
    expect(plainText("<p>Hello&nbsp;<b>world</b></p><script>x()</script><style>p{}</style>")).toBe("Hello world");
  });

  it("reading time comes from the page and is sensible", () => {
    for (const e of ALL) {
      const m = readingMinutes(e.body({ siteUrl: SITE, supportEmail: "a@b.c", legalName: "X" }));
      expect(m, e.slug).toBeGreaterThanOrEqual(2);
      expect(m, e.slug).toBeLessThanOrEqual(15);
    }
    expect(readingMinutes("")).toBe(1);
  });

  it("long dates read as people write them", () => {
    expect(longDate("2026-10-20")).toBe("20 October 2026");
    expect(longDate("2026-01-05")).toBe("5 January 2026");
  });
});

// ---------------------------------------------------------------- keeping comparisons fresh
describe("freshness of the comparison pages", () => {
  const day = 86_400_000;
  const checked = Date.parse(`${ALTERNATIVES[0]!.updated}T00:00:00Z`);

  it("nothing is stale within 90 days of the newest check, and everything is stale well after", () => {
    const newest = Math.max(...ALTERNATIVES.map((e) => Date.parse(`${e.updated}T00:00:00Z`)));
    expect(staleAlternatives(new Date(newest + 89 * day))).toHaveLength(0);
    expect(staleAlternatives(new Date(newest + 91 * day)).length).toBeGreaterThan(0);
    expect(staleAlternatives(new Date(newest + 400 * day))).toHaveLength(ALTERNATIVES.length);
  });

  it("the limit can be changed, and a page is stale only past it", () => {
    expect(staleAlternatives(new Date(checked + 31 * day), 30).length).toBeGreaterThan(0);
    expect(staleAlternatives(new Date(checked + 30 * day), 30).filter((e) => e.updated === ALTERNATIVES[0]!.updated)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------- the pages render
describe("the pages render cleanly", () => {
  it.each(ALL.map((e) => [contentPath(e), e] as const))("%s", (path, e) => {
    const html = pages.get(path)!;
    expect(html.match(/<h1[ >]/g)).toHaveLength(1);
    expect(html).toContain(`<h1>${e.title.replace(/&/g, "&amp;")}</h1>`);
    const text = visible(articleHtml(html));
    expect(text.split(" ").length, "too thin to be worth indexing").toBeGreaterThan(450);
    for (const artefact of ["undefined", "[object Object]", "NaN", "${", "{{"]) expect(text, artefact).not.toContain(artefact);
  });
});

describe("search and social metadata on every page", () => {
  it.each(ALL.map((e) => [contentPath(e), e] as const))("%s", (path, e) => {
    const html = pages.get(path)!;
    expect(titleOf(html)).toBe(`${e.seoTitle} | Loomail`);
    expect(titleOf(html).length).toBeLessThanOrEqual(60);
    expect(meta(html, "name", "description")).toEqual([e.description]);
    expect(html).toContain(`<link rel="canonical" href="${SITE}${path}">`);
    expect(meta(html, "name", "robots")).toEqual(["index,follow,max-image-preview:large"]);
    expect(meta(html, "property", "og:type")).toEqual(["article"]);
    expect(meta(html, "property", "og:image")).toEqual([`${SITE}/og-default.png`]);
    expect(meta(html, "name", "twitter:card")).toEqual(["summary_large_image"]);
    const blocks = jsonLd(html);
    expect(blocks.map((b) => b["@type"]).sort()).toEqual(["Article", "BreadcrumbList"]);
    const article = blocks.find((b) => b["@type"] === "Article")!;
    expect(article).toMatchObject({ datePublished: e.published, dateModified: e.updated, headline: e.title });
    expect(article.mainEntityOfPage["@id"]).toBe(`${SITE}${path}`);
    expect(article.publisher.logo.url).toBe(`${SITE}/apple-touch-icon.png`);
    const crumbs = blocks.find((b) => b["@type"] === "BreadcrumbList")!.itemListElement;
    expect(crumbs.map((c: { position: number }) => c.position)).toEqual([1, 2, 3]);
    expect(crumbs[2].item).toBe(`${SITE}${path}`);
  });

  it("every page has a different title and a different description", () => {
    expect(new Set(ALL.map((e) => e.seoTitle)).size).toBe(ALL.length);
    expect(new Set(ALL.map((e) => e.description)).size).toBe(ALL.length);
  });
});

describe("listings and routing", () => {
  it.each([["blog", "/blog"], ["alternative", "/alternatives"]] as const)("the %s listing shows every page with its summary", async (kind, path) => {
    const res = await get(path);
    expect(res.statusCode).toBe(200);
    for (const e of entries(kind)) {
      expect(res.body).toContain(`href="${contentPath(e)}"`);
      expect(res.body).toContain(e.title.replace(/&/g, "&amp;"));
    }
    expect(res.body).toContain(`<link rel="canonical" href="${SITE}${path}">`);
    expect(meta(res.body, "name", "robots")).toEqual(["index,follow,max-image-preview:large"]);
    expect(titleOf(res.body).length).toBeLessThanOrEqual(60);
    expect(meta(res.body, "name", "description")[0]!.length).toBeGreaterThanOrEqual(70);
  });

  it("an unknown page is a 404, and a comparison is not reachable as a blog post", async () => {
    expect((await get("/blog/no-such-post")).statusCode).toBe(404);
    expect((await get("/alternatives/no-such-page")).statusCode).toBe(404);
    expect((await get("/blog/customer-io")).statusCode).toBe(404);
    expect((await get(`/alternatives/${BLOG[0]!.slug}`)).statusCode).toBe(404);
  });

  it("without the public site none of these routes exist", async () => {
    const off = await buildApp({ logger: false });
    for (const path of ["/blog", "/alternatives", contentPath(ALL[0]!)]) expect((await off.inject({ method: "GET", url: path })).statusCode, path).toBe(404);
    await off.close();
  });

  it("every page links to both sections in its footer", () => {
    for (const html of pages.values()) {
      expect(html).toContain('<a href="/blog">Blog</a>');
      expect(html).toContain('<a href="/alternatives">Alternatives</a>');
    }
  });
});

describe("links and the sitemap", () => {
  const known = () => new Set(["/", "/pricing", "/signup", "/terms", "/privacy", "/blog", "/alternatives", ...ALL.map(contentPath)]);

  it.each(ALL.map((e) => [contentPath(e), e] as const))("%s: every internal link goes to a page that exists", async (path) => {
    const links = [...articleHtml(pages.get(path)!).matchAll(/href="([^"]+)"/g)].map((m) => m[1]!).filter((h) => !/^(mailto:|#|https?:)/.test(h));
    for (const link of links) {
      const target = link.split("#")[0]!.split("?")[0]!;
      expect(known().has(target), `${path} links to ${link}`).toBe(true);
      expect((await get(target)).statusCode, target).toBe(200);
    }
  });

  it("no page is an orphan: every one is linked from another page", () => {
    const linked = new Set<string>();
    for (const html of pages.values()) for (const m of articleHtml(html).matchAll(/href="([^"#?]+)"/g)) linked.add(m[1]!);
    for (const e of ALL) expect(linked.has(contentPath(e)), contentPath(e)).toBe(true);
  });

  it("the sitemap lists every article with the date it was last updated, and the listings too", async () => {
    const xml = (await get("/sitemap.xml")).body;
    for (const e of ALL) expect(xml).toContain(`<loc>${SITE}${contentPath(e)}</loc><lastmod>${e.updated}</lastmod>`);
    for (const p of ["/blog", "/alternatives"]) expect(xml).toContain(`<loc>${SITE}${p}</loc></url>`);
    const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]!);
    expect(new Set(locs).size).toBe(locs.length);
  });
});

// ---------------------------------------------------------------- the rules for comparison pages
describe("comparison pages are fair, dated and honest about what they could not confirm", () => {
  it.each(ALTERNATIVES.map((e) => [e.slug, e] as const))("%s says who wrote it, when it was checked, and what it could not confirm", (_slug, e) => {
    const text = visible(articleHtml(pages.get(contentPath(e))!));
    for (const needed of [
      "we are not neutral",
      longDate(e.updated),
      "What we could not confirm",
      "How we checked",
      `When ${e.competitor} is the better choice`,
      "When Loomail is the better choice",
      "The short answer",
      `did not sign in or test ${e.competitor}`,
    ]) {
      expect(text, needed).toContain(needed);
    }
  });

  it.each(ALTERNATIVES.map((e) => [e.slug, e] as const))("%s gives the other product credit and does not attack it", (_slug, e) => {
    const text = visible(articleHtml(pages.get(contentPath(e))!)).toLowerCase();
    for (const word of ["scam", "fake", "worst", "terrible", "rip-off", "ripoff", "useless", "lies", "fraud", "complaint", "trustpilot", "reddit", "beware", "stay away"]) {
      expect(text, word).not.toContain(word);
    }
    const strengths = new RegExp(`when ${e.competitor!.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} is the better choice(.*?)when loomail is the better choice`).exec(text);
    expect(strengths, "the other product's strengths").not.toBeNull();
    expect(strengths![1]!.split(" ").length).toBeGreaterThan(25);
  });

  // Prices read from each product's own pricing page on 20 October 2026. A price may only be on a comparison page if it is here.
  const VERIFIED: Record<string, string[]> = {
    "customer-io": ["$100", "$1,000", "$0.009", "$0.12", "$10", "$10M"],
    loops: ["$0", "$49"],
    dittofeed: ["$75", "$0.004"],
    userlist: ["$10", "$12", "$500k"],
  };
  const ours = [usd(PLANS.essential.priceMonthlyUsd), "$0.009", "$0.12", "$10"];

  it.each(ALTERNATIVES.map((e) => [e.slug, e] as const))("%s quotes only prices that were read from the other product's own site, or are ours", (slug, e) => {
    const text = visible(articleHtml(pages.get(contentPath(e))!));
    const amounts = [...new Set([...text.matchAll(/\$[0-9][0-9,]*(?:\.[0-9]+)?[MKk]?/g)].map((m) => m[0]))];
    const allowed = new Set([...(VERIFIED[slug] ?? []), ...ours]);
    for (const a of amounts) expect(allowed.has(a), `${slug} quotes ${a}`).toBe(true);
  });

  it("our own prices and limits on every comparison come from the plan data", () => {
    for (const e of ALTERNATIVES) {
      const text = visible(articleHtml(pages.get(contentPath(e))!));
      expect(text, e.slug).toContain(OURS.price);
      expect(text, e.slug).toContain(`${TRIAL_DAYS}-day trial`);
    }
    expect(OURS.price).toBe(`$${PLANS.essential.priceMonthlyUsd}`);
    expect(OURS.extraProfile).toBe(ADDONS.profiles.rateLabel);
    expect(OURS.profiles).toBe((PLANS.essential.limits.contacts ?? 0).toLocaleString("en-US"));
  });

  it("where the product has to be called email-only, the page says so", () => {
    for (const slug of ["customer-io", "dittofeed", "userlist"]) {
      const text = visible(articleHtml(pages.get(`/alternatives/${slug}`)!));
      expect(text, slug).toMatch(/We do not send SMS, push or in-app messages|Email only|No\. Email only/);
    }
  });

  it("no page claims a feature Loomail does not have", () => {
    const lacking = [/we (send|support|offer) (sms|push|whatsapp|in-app)/i, /loomail (sends|supports|offers) (sms|push|whatsapp|in-app)/i, /company accounts? (are|is) (included|available)/i, /we autofill/i];
    for (const [path, html] of pages) {
      const text = visible(articleHtml(html));
      for (const re of lacking) expect(re.test(text), `${path}: ${re}`).toBe(false);
    }
  });

  it("the open-source and self-hosting claims match the project's licence", async () => {
    const { readFileSync } = await import("node:fs");
    const licence = readFileSync(new URL("../../../LICENSE", import.meta.url), "utf-8");
    expect(licence).toMatch(/MIT License/);
    for (const slug of ["customer-io", "loops", "dittofeed", "userlist"]) {
      expect(visible(articleHtml(pages.get(`/alternatives/${slug}`)!)), slug).toContain("MIT");
    }
  });
});

describe("blog posts and comparisons do not invent numbers", () => {
  // The only percentages that appear are other products' own published terms.
  const OWN_TERMS: Record<string, string[]> = { "/alternatives/userlist": ["50%"] };

  it.each(ALL.map((e) => [contentPath(e), e] as const))("%s has no made-up statistics", (path) => {
    const text = visible(articleHtml(pages.get(path)!));
    const percents = [...text.matchAll(/\b\d{1,3}(?:\.\d+)?\s?%/g)].map((m) => m[0].replace(/\s/g, ""));
    for (const p of percents) expect((OWN_TERMS[path] ?? []).includes(p), `${path}: ${p}`).toBe(true);
    expect(text).not.toMatch(/\b(studies show|research shows|according to a survey|statistics show|on average,? \d)/i);
  });

  it("every promise of a result is hedged", () => {
    for (const [path, html] of pages) {
      const text = visible(articleHtml(html));
      for (const m of text.matchAll(/\b(guarantee|guaranteed)\b/gi)) {
        const before = text.slice(Math.max(0, m.index! - 30), m.index!).toLowerCase();
        expect(/rather than a|not a|does not|no /.test(before), `${path}: ...${text.slice(Math.max(0, m.index! - 40), m.index! + 20)}`).toBe(true);
      }
    }
  });

  it("no job-posting markup or other structured data that does not belong", () => {
    for (const html of pages.values()) expect(html).not.toContain("JobPosting");
  });
});
