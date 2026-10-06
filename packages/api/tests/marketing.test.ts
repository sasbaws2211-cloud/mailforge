/**
 * Tests for the public marketing site: landing, pricing, legal, signup form,
 * robots.txt and sitemap.xml. No database needed for the pages themselves.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { PLANS, PLAN_IDS, TRIAL_DAYS } from "@mailforge/core";
import { buildApp } from "../src/index.js";

let app: FastifyInstance;
let off: FastifyInstance;

beforeAll(async () => {
  app = await buildApp({ publicSite: true, baseUrl: "https://mailforge.test", logger: false });
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
    expect(res.body).toContain('<link rel="canonical" href="https://mailforge.test/">');
    expect(res.body).toMatch(/<meta name="description" content="[^"]{40,}"/);
    expect(res.body).toContain('property="og:title"');
    expect(res.headers.vary).toMatch(/cookie/i);
  });

  it("states the trial in the plan terms, from the plans config", async () => {
    const res = await get("/");
    expect(res.body).toContain(`${TRIAL_DAYS} days of ${PLANS.growth.name}`);
    expect(res.body).toContain("No credit card");
  });

  it("emits valid JSON-LD", async () => {
    const blocks = jsonLd((await get("/")).body);
    expect(blocks).toHaveLength(1);
    expect((blocks[0] as { "@type": string })["@type"]).toBe("SoftwareApplication");
  });

  it("carries no leftover upstream brand and no fabricated social proof", async () => {
    const body = (await get("/")).body.toLowerCase();
    expect(body).not.toContain("claros");
    expect(body).not.toMatch(/trusted by|testimonial|as seen in|\d+\+? customers/);
  });

  it("without the dashboard built, a visitor with a session cookie still gets a page", async () => {
    const res = await get("/", { cookie: "mailforge_session=abc" });
    expect(res.statusCode).toBe(200);
  });
});

describe("pricing page", () => {
  it("shows every plan with its price and limits from the plans config", async () => {
    const res = await get("/pricing");
    expect(res.statusCode).toBe(200);
    for (const id of PLAN_IDS) {
      const p = PLANS[id];
      expect(res.body).toContain(`<h3>${p.name}</h3>`);
      for (const f of p.features) expect(res.body).toContain(f);
    }
    expect(res.body).toContain(`$${PLANS.starter.priceMonthlyUsd}`);
    expect(res.body).toContain(`$${PLANS.growth.priceMonthlyUsd}`);
    expect(res.body).toContain(`$${PLANS.scale.priceMonthlyUsd}`);
  });

  it("recommends exactly one plan", async () => {
    const res = await get("/pricing");
    expect(res.body.match(/Most popular/g)).toHaveLength(1);
  });

  it("annual prices are present for the toggle and are lower than monthly", async () => {
    const res = await get("/pricing");
    for (const id of ["starter", "growth", "scale"] as const) {
      const p = PLANS[id];
      expect(res.body).toContain(`data-monthly="$${p.priceMonthlyUsd}" data-annual="$${p.priceAnnualMonthlyUsd}"`);
      expect(p.priceAnnualMonthlyUsd).toBeLessThan(p.priceMonthlyUsd);
      // The yearly total shown is the exact amount that would be billed, not 12 x a rounded figure.
      expect(res.body).toContain(`data-annual="$${p.priceAnnualUsd.toLocaleString("en-US")} billed yearly"`);
    }
    expect(res.body).toContain('data-annual="$190 billed yearly"');
    expect(res.body).toContain('data-annual="$490 billed yearly"');
    expect(res.body).toContain('data-annual="$1,290 billed yearly"');
  });

  it("each plan's button starts signup for that plan", async () => {
    const res = await get("/pricing");
    for (const id of PLAN_IDS) expect(res.body).toContain(`href="/signup?plan=${id}"`);
  });

  it("JSON-LD lists one offer per plan", async () => {
    const [ld] = jsonLd((await get("/pricing")).body) as Array<{ offers: Array<{ name: string; price: string }> }>;
    expect(ld!.offers.map((o) => o.name)).toEqual(PLAN_IDS.map((id) => PLANS[id].name));
    expect(ld!.offers.map((o) => o.price)).toEqual(PLAN_IDS.map((id) => String(PLANS[id].priceMonthlyUsd)));
  });
});

describe("legal pages", () => {
  it("terms and privacy render with the support contact and an update date", async () => {
    for (const path of ["/terms", "/privacy"]) {
      const res = await get(path);
      expect(res.statusCode, path).toBe(200);
      expect(res.body).toContain("Last updated");
      expect(res.body).toContain("support@mailforge.test");
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
    expect((await get("/signup?plan=starter")).body).toContain('name="plan" value="starter"');
    expect((await get("/signup?plan=free")).body).toContain("Create your free workspace");
    const bad = await get("/signup?plan=%3Cscript%3E");
    expect(bad.body).toContain('name="plan" value="growth"');
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
    expect(res.body).toContain("Sitemap: https://mailforge.test/sitemap.xml");
  });

  it("sitemap.xml lists the public pages with absolute URLs", async () => {
    const res = await get("/sitemap.xml");
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/xml/);
    for (const p of ["/", "/pricing", "/signup", "/terms", "/privacy"]) {
      expect(res.body).toContain(`<loc>https://mailforge.test${p}</loc>`);
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
