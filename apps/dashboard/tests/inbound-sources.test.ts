/** Inbound sources, form half: building and reading the settings, and the helper text. */
import { describe, it, expect } from "vitest";
import {
  buildGenericConfig,
  emptyGenericForm,
  PAYSTACK_EVENTS,
  PAYSTACK_IPS,
  SOURCE_KIND_LABEL,
  addressWithToken,
  genericFormFromConfig,
  looksLikePaystackKey,
  looksLikeStripeSecret,
  sampleCurl,
  sourceUrl,
  type GenericForm,
} from "../src/inbound-sources.js";

const form = (over: Partial<GenericForm> = {}): GenericForm => ({ ...emptyGenericForm(), eventValue: "form_submitted", userIdPath: "data.id", ...over });

describe("buildGenericConfig", () => {
  it("builds the settings the API takes", () => {
    const r = buildGenericConfig(form({ emailPath: " data.email ", traits: [{ name: "plan", path: "data.plan" }, { name: "", path: "" }], sendProperties: false }));
    expect(r).toEqual({
      ok: true,
      config: { event_name: "form_submitted", user_id_path: "data.id", email_path: "data.email", trait_paths: { plan: "data.plan" }, send_properties: false },
    });
  });

  it("an event named by a field uses event_name_path", () => {
    const r = buildGenericConfig(form({ eventMode: "path", eventValue: "type" }));
    expect(r).toMatchObject({ ok: true, config: { event_name_path: "type" } });
    expect((r as any).config.event_name).toBeUndefined();
  });

  it("no event: only traits, and then at least one trait is needed", () => {
    expect(buildGenericConfig(form({ eventMode: "none", eventValue: "" }))).toMatchObject({ ok: false });
    const ok = buildGenericConfig(form({ eventMode: "none", eventValue: "", traits: [{ name: "tier", path: "tier" }] }));
    expect(ok).toMatchObject({ ok: true });
    expect((ok as any).config.event_name).toBeUndefined();
    expect((ok as any).config.event_name_path).toBeUndefined();
  });

  it("needs a person, an event name when there is an event, and complete trait rows", () => {
    const problems = (f: GenericForm) => (buildGenericConfig(f) as { ok: false; problems: string[] }).problems.join(" | ");
    expect(problems(form({ userIdPath: "", emailPath: "" }))).toMatch(/where the person is/);
    expect(problems(form({ eventValue: " " }))).toMatch(/name/);
    expect(problems(form({ eventMode: "path", eventValue: "" }))).toMatch(/field holds the event name/);
    expect(problems(form({ traits: [{ name: "plan", path: "" }] }))).toMatch(/both a name and a field/);
    expect(problems(form({ traits: [{ name: "a", path: "x" }, { name: "a", path: "y" }] }))).toMatch(/listed twice/);
    expect(problems(form({ traits: [{ name: "n".repeat(65), path: "x" }] }))).toMatch(/longer than 64/);
    expect(problems(form({ traits: Array.from({ length: 21 }, (_, i) => ({ name: `t${i}`, path: "x" })) }))).toMatch(/at most 20/);
  });

  it("an email alone is enough to find the person", () => {
    expect(buildGenericConfig(form({ userIdPath: "", emailPath: "email" }))).toMatchObject({ ok: true });
  });
});

describe("genericFormFromConfig", () => {
  it("is the inverse of building", () => {
    const f = form({ eventMode: "path", eventValue: "type", emailPath: "data.email", traits: [{ name: "plan", path: "data.plan" }], sendProperties: false });
    const built = buildGenericConfig(f) as { ok: true; config: Record<string, unknown> };
    expect(genericFormFromConfig(built.config)).toEqual(f);
    const fixed = buildGenericConfig(form()) as { ok: true; config: Record<string, unknown> };
    expect(genericFormFromConfig(fixed.config)).toEqual(form());
    const traitsOnly = buildGenericConfig(form({ eventMode: "none", eventValue: "", traits: [{ name: "t", path: "p" }] })) as { ok: true; config: Record<string, unknown> };
    expect(genericFormFromConfig(traitsOnly.config).eventMode).toBe("none");
  });
  it("copes with an empty or odd config", () => {
    expect(genericFormFromConfig({})).toMatchObject({ eventMode: "none", eventValue: "", traits: [], sendProperties: true });
    expect(genericFormFromConfig({ trait_paths: "nope", send_properties: false }).traits).toEqual([]);
  });
});

describe("helpers", () => {
  it("builds the address a sender posts to", () => {
    expect(sourceUrl("https://app.example.com", "abc")).toBe("https://app.example.com/webhooks/in/abc");
    expect(sourceUrl("https://app.example.com/", "abc")).toBe("https://app.example.com/webhooks/in/abc");
  });

  it("makes a curl example whose payload has every configured field", () => {
    const f = form({ eventMode: "path", eventValue: "type", emailPath: "data.email", traits: [{ name: "plan", path: "data.plan" }] });
    const curl = sampleCurl("https://x.test/webhooks/in/abc", "mf_in_tok", f);
    expect(curl).toContain("'https://x.test/webhooks/in/abc'");
    expect(curl).toContain("Authorization: Bearer mf_in_tok");
    const body = JSON.parse(curl.split("-d '")[1]!.slice(0, -1));
    expect(body).toEqual({ type: "form_submitted", data: { id: "user_123", email: "ada@example.com", plan: "example" } });
  });

  it("recognises a Stripe signing secret", () => {
    expect(looksLikeStripeSecret("whsec_" + "a1b2c3d4e5f6a7b8")).toBe(true);
    expect(looksLikeStripeSecret("  whsec_" + "a1b2c3d4e5f6a7b8  ")).toBe(true);
    for (const bad of ["", "whsec_short", "sk_live_abcdefghijklmnop", "a1b2c3d4e5f6a7b8c9"]) expect(looksLikeStripeSecret(bad), bad).toBe(false);
  });
});

describe("Paystack and Flutterwave helpers", () => {
  it("puts a token in the address Paystack is given, whatever the address already has", () => {
    expect(addressWithToken("https://x.test/webhooks/in/abc", "mf_in_t")).toBe("https://x.test/webhooks/in/abc?token=mf_in_t");
    expect(addressWithToken("https://x.test/webhooks/in/abc?a=1", "mf_in_t")).toBe("https://x.test/webhooks/in/abc?a=1&token=mf_in_t");
    expect(addressWithToken("https://x.test/h", "a b&c")).toBe("https://x.test/h?token=a%20b%26c");
  });

  it("recognises a Paystack secret key and refuses a public key", () => {
    expect(looksLikePaystackKey("sk_test_a1b2c3d4e5f6a7b8c9d0")).toBe(true);
    expect(looksLikePaystackKey("  sk_live_a1b2c3d4e5f6a7b8c9d0  ")).toBe(true);
    for (const bad of ["", "pk_live_a1b2c3d4e5f6a7b8c9d0", "sk_test_short", "whsec_a1b2c3d4e5f6a7b8c9d0"]) expect(looksLikePaystackKey(bad), bad).toBe(false);
  });

  it("names every kind of source and lists what Paystack sends", () => {
    expect(SOURCE_KIND_LABEL).toEqual({ generic: "JSON webhook", stripe: "Stripe", paystack: "Paystack", flutterwave: "Flutterwave" });
    expect(PAYSTACK_EVENTS).toContain("charge.success");
    expect(PAYSTACK_IPS).toHaveLength(3);
  });
});
