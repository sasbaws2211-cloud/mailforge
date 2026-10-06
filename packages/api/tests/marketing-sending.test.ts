/**
 * The marketing pages must not promise something untrue: when the service offers Mailforge
 * Sending (it sends the email for you), they say so; when it does not, they keep saying
 * customers bring their own email provider. No database needed.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";

let app: FastifyInstance;
beforeAll(async () => {
  app = await buildApp({ publicSite: true, baseUrl: "https://mailforge.test", logger: false });
});
afterEach(() => {
  delete process.env.MAILFORGE_MANAGED_RESEND_API_KEY;
  delete process.env.MAILFORGE_MANAGED_SENDING;
});
afterAll(async () => {
  delete process.env.MAILFORGE_MANAGED_RESEND_API_KEY;
  await app.close();
});

const page = async (path: string) => (await app.inject({ method: "GET", url: path })).body;
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#39;|&apos;/g, "'").replace(/\s+/g, " ");

describe("when the service does not offer managed sending", () => {
  it("every page still says customers use their own email provider", async () => {
    expect(text(await page("/"))).toMatch(/through your own email provider/);
    expect(text(await page("/"))).toMatch(/sends through your own email provider: Resend, or any SMTP server/);
    expect(text(await page("/pricing"))).toMatch(/You send through your own email provider, so you pay them directly/);
    expect(text(await page("/signup"))).toMatch(/Send through your own email provider/);
    expect(text(await page("/"))).not.toMatch(/send the email for you|Sending is included/);
  });
});

describe("when the service offers managed sending", () => {
  it("the landing page and FAQ say Mailforge can send for you, and that connecting your own provider is optional", async () => {
    process.env.MAILFORGE_MANAGED_RESEND_API_KEY = "re_x";
    const home = text(await page("/"));
    expect(home).toMatch(/can send the email for you, so there is no email provider to sign up for/);
    expect(home).toMatch(/connect your own provider \(Resend, or any SMTP server\) if you prefer/);
    expect(home).not.toMatch(/through your own email provider\./); // the hero no longer claims you must bring one
    expect(await page("/")).toMatch(/Follow every user from signup to churn and send from one place/);
  });

  it("the pricing answer says sending is included up to the plan's email allowance, with your own provider as the alternative", async () => {
    process.env.MAILFORGE_MANAGED_RESEND_API_KEY = "re_x";
    const pricing = text(await page("/pricing"));
    expect(pricing).toMatch(/Sending is included, up to your plan's monthly email allowance/);
    expect(pricing).toMatch(/Prefer your own email provider\? Connect it and pay them directly/);
    expect(pricing).not.toMatch(/You send through your own email provider, so you pay them directly/);
  });

  it("the signup page lists it as a perk", async () => {
    process.env.MAILFORGE_MANAGED_RESEND_API_KEY = "re_x";
    expect(text(await page("/signup"))).toMatch(/We can send your email for you, or use your own provider/);
  });

  it("switching it off again (key kept) puts the old wording back", async () => {
    process.env.MAILFORGE_MANAGED_RESEND_API_KEY = "re_x";
    process.env.MAILFORGE_MANAGED_SENDING = "false";
    expect(text(await page("/signup"))).toMatch(/Send through your own email provider/);
  });
});
