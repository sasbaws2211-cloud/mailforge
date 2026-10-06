/**
 * Tests for the Resend domains client and the managed Resend adapter. A fake
 * fetch stands in for Resend: no network.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { createResendDomainsClient } from "../src/resend-domains.js";
import { ManagedResendAdapter } from "../src/managed-resend.js";
import { ResendTransportAdapter } from "../src/resend.js";
import { resolveTransportAdapter } from "../src/resolve-transport.js";
import { encrypt, parseEncryptionKey } from "../src/crypto.js";

const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const DOMAIN = {
  id: "d-1",
  name: "mail.acme-test.dev",
  status: "not_started",
  records: [
    { record: "SPF", name: "send", type: "TXT", value: "v=spf1 include:amazonses.com ~all", ttl: "Auto", status: "not_started" },
    { record: "SPF", name: "send", type: "MX", value: "feedback-smtp.us-east-1.amazonses.com", ttl: "Auto", status: "not_started", priority: 10 },
    { record: "DKIM", name: "resend._domainkey", type: "TXT", value: "p=abc", ttl: 3600, status: "not_started" },
  ],
};

afterEach(() => vi.restoreAllMocks());

describe("createResendDomainsClient", () => {
  const client = (fetchImpl: typeof fetch) => createResendDomainsClient({ apiKey: "re_secret_key", baseUrl: "https://resend.test/", fetchImpl });

  it("creates a domain: POST /domains with the name, bearer key, and returns normalised id, status and records", async () => {
    const f = vi.fn(async () => reply(200, DOMAIN));
    const r = await client(f as never).createDomain("mail.acme-test.dev");
    expect(r).toMatchObject({ ok: true, value: { id: "d-1", name: "mail.acme-test.dev", status: "not_started" } });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://resend.test/domains");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer re_secret_key");
    expect(JSON.parse(init.body as string)).toEqual({ name: "mail.acme-test.dev" });
    if (r.ok) {
      expect(r.value.records).toHaveLength(3);
      expect(r.value.records[1]).toMatchObject({ type: "MX", priority: 10 });
      expect(r.value.records[2]!.ttl).toBe("3600"); // numbers become text
    }
  });

  it("an unknown status becomes pending, and malformed records are dropped", async () => {
    const f = vi.fn(async () => reply(200, { ...DOMAIN, status: "something_new", records: [{ type: "TXT", name: "x", value: "y" }, { nope: true }, null] }));
    const r = await client(f as never).getDomain("d-1");
    expect(r).toMatchObject({ ok: true, value: { status: "pending" } });
    if (r.ok) expect(r.value.records).toEqual([{ record: "", name: "x", type: "TXT", value: "y", ttl: "Auto", status: "not_started" }]);
  });

  it("reads, verifies and deletes by id (encoded)", async () => {
    const f = vi.fn(async (_u: string, init?: RequestInit) => (init?.method === "DELETE" ? reply(200, { id: "a/b", deleted: true }) : reply(200, { ...DOMAIN, id: "a/b" })));
    const c = client(f as never);
    await c.getDomain("a/b");
    await c.verifyDomain("a/b");
    await c.deleteDomain("a/b");
    expect(f.mock.calls.map((x) => `${(x[1] as RequestInit).method} ${x[0]}`)).toEqual([
      "GET https://resend.test/domains/a%2Fb",
      "POST https://resend.test/domains/a%2Fb/verify",
      "DELETE https://resend.test/domains/a%2Fb",
    ]);
  });

  it("maps errors to a kind and a safe message, never including the key", async () => {
    const cases: Array<[number, unknown, string]> = [
      [403, { name: "validation_error", message: "This domain has already been registered." }, "exists"],
      [409, { name: "conflict", message: "domain exists" }, "exists"],
      [429, { name: "rate_limit_exceeded", message: "Too many requests" }, "rate_limited"],
      [404, { name: "not_found", message: "Domain not found" }, "not_found"],
      [401, { name: "restricted_api_key", message: "API key is invalid re_secret_key" }, "auth"],
      [403, { name: "forbidden", message: "restricted" }, "auth"],
      [500, { name: "internal", message: "boom" }, "unavailable"],
      [422, { name: "validation_error", message: "The domain name is invalid." }, "invalid"],
    ];
    for (const [status, body, kind] of cases) {
      const r = await client((async () => reply(status, body)) as never).createDomain("x.example-site.dev");
      expect(r, `${status}`).toMatchObject({ ok: false, kind, status });
      if (!r.ok) expect(r.message).not.toContain("re_secret_key");
    }
  });

  it("a key pasted into an error message is masked in the one message that quotes Resend", async () => {
    const r = await client((async () => reply(422, { name: "validation_error", message: "bad request for re_secret_key_123 here" })) as never).createDomain("x.example-site.dev");
    if (r.ok) throw new Error("expected failure");
    expect(r.message).not.toMatch(/re_secret/);
  });

  it("a network failure or an unreadable answer is 'unavailable'", async () => {
    expect(await client((async () => { throw new Error("ECONNRESET"); }) as never).getDomain("d")).toMatchObject({ ok: false, kind: "unavailable", status: null });
    expect(await client((async () => reply(200, { hello: "world" })) as never).getDomain("d")).toMatchObject({ ok: false, kind: "unavailable" });
    expect(await client((async () => new Response("not json", { status: 200 })) as never).createDomain("x.example-site.dev")).toMatchObject({ ok: false, kind: "unavailable" });
  });
});

describe("ManagedResendAdapter", () => {
  const params = { to: "person@example.org", from: "attacker@evil.test", fromName: "Evil Corp", subject: "Hi", bodyHtml: "<p>x</p>", bodyText: "x", messageId: "m-1", replyTo: "evil@evil.test", headers: { "List-Unsubscribe": "<https://x>" } };
  const adapter = () => new ManagedResendAdapter({ apiKey: "re_platform", baseUrl: "http://resend.test", fromEmail: "hello@mail.acme-test.dev", fromName: "Acme", replyTo: "owner@acme-test.dev" });
  const mockFetch = (status: number, body: unknown) => vi.spyOn(globalThis, "fetch").mockResolvedValue(reply(status, body));
  const sentBody = (spy: ReturnType<typeof mockFetch>) => JSON.parse((spy.mock.calls[0]![1] as RequestInit).body as string) as Record<string, unknown>;

  it("always sends as the platform chose, ignoring whatever sender the caller passes", async () => {
    const spy = mockFetch(200, { id: "msg-1" });
    const r = await adapter().send(params);
    expect(r).toEqual({ success: true, providerMessageId: "msg-1" });
    const body = sentBody(spy);
    expect(body.from).toBe("Acme <hello@mail.acme-test.dev>");
    expect(body.reply_to).toBe("owner@acme-test.dev");
    expect(JSON.stringify(body)).not.toMatch(/evil/i);
    expect(body.headers).toEqual({ "List-Unsubscribe": "<https://x>" }); // compliance headers still pass through
  });

  it("talks to the configured base URL with the operator's key, and uses the message id as the idempotency key", async () => {
    const spy = mockFetch(200, { id: "x" });
    await adapter().send(params);
    expect(spy.mock.calls[0]![0]).toBe("http://resend.test/emails");
    const h = (spy.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(h.Authorization).toBe("Bearer re_platform");
    expect(h["Idempotency-Key"]).toBe("m-1");
  });

  it("omits reply_to when there is none", async () => {
    const spy = mockFetch(200, { id: "x" });
    await new ManagedResendAdapter({ apiKey: "k", fromEmail: "a@b.co", fromName: "A" }).send({ ...params, replyTo: undefined });
    expect(sentBody(spy)).not.toHaveProperty("reply_to");
  });

  it("a problem with the operator's account is NOT permanent, so a customer's message is never lost to it", async () => {
    for (const [status, name] of [[401, "restricted_api_key"], [403, "validation_error"], [404, "not_found"], [405, "method_not_allowed"]] as const) {
      mockFetch(status, { name, message: "domain is not verified", statusCode: status });
      const r = await adapter().send(params);
      expect(r, String(status)).toMatchObject({ success: false, permanent: false });
      expect(r.error).toMatch(/retried/);
      vi.restoreAllMocks();
    }
  });

  it("a problem with the message itself IS permanent, and rate limits and outages are transient, as with plain Resend", async () => {
    mockFetch(422, { name: "validation_error", message: "Invalid `to` field.", statusCode: 422 });
    expect(await adapter().send(params)).toMatchObject({ success: false, permanent: true });
    vi.restoreAllMocks();
    mockFetch(429, { name: "rate_limit_exceeded", message: "slow down", statusCode: 429 });
    expect(await adapter().send(params)).toMatchObject({ success: false, permanent: false });
    vi.restoreAllMocks();
    mockFetch(503, { name: "x", message: "down", statusCode: 503 });
    expect(await adapter().send(params)).toMatchObject({ success: false, permanent: false });
    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));
    expect(await adapter().send(params)).toMatchObject({ success: false, permanent: false });
  });
});

describe("Resend adapter: base URL and reply-to", () => {
  it("defaults to the real Resend API, and the reply_to field is sent only when given", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(reply(200, { id: "x" }));
    await new ResendTransportAdapter({ apiKey: "k" }).send({ to: "a@b.co", from: "c@d.co", subject: "s", bodyHtml: "h", messageId: "m" });
    expect(spy.mock.calls[0]![0]).toBe("https://api.resend.com/emails");
    expect(JSON.parse((spy.mock.calls[0]![1] as RequestInit).body as string)).not.toHaveProperty("reply_to");
  });

  it("a customer's own Resend settings cannot choose the API address (they could point the server anywhere)", async () => {
    const key = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
    const stored = encrypt(JSON.stringify({ apiKey: "re_theirs", baseUrl: "http://169.254.169.254" }), parseEncryptionKey(key));
    const r = resolveTransportAdapter("resend", stored, key);
    if (!r.ok) throw new Error("expected ok");
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(reply(200, { id: "x" }));
    await r.transport.adapter.send({ to: "a@b.co", from: "c@d.co", subject: "s", bodyHtml: "h", messageId: "m" });
    expect(spy.mock.calls[0]![0]).toBe("https://api.resend.com/emails");
  });
});
