/** Outbound webhook calls: the destination rules, signing, the secret at rest, and sending. */
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import {
  generateWebhookSecret,
  openWebhookSecret,
  resolveWebhookTarget,
  sealWebhookSecret,
  sendWebhook,
  signWebhook,
  verifyWebhookSignature,
  webhookHostPolicyFromEnv,
  type WebhookHostPolicy,
} from "../src/webhook-sender.js";

const hostedPolicy = (lookup?: WebhookHostPolicy["lookup"]): WebhookHostPolicy => ({ restrict: true, allowedHosts: [], lookup });
const openPolicy: WebhookHostPolicy = { restrict: false, allowedHosts: [] };
const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];

describe("webhookHostPolicyFromEnv", () => {
  it("is on for a hosted service and off for a self-hosted one, and can be forced either way", () => {
    expect(webhookHostPolicyFromEnv({}).restrict).toBe(false);
    expect(webhookHostPolicyFromEnv({ LOOMAIL_PUBLIC_SITE: "true" }).restrict).toBe(true);
    expect(webhookHostPolicyFromEnv({ LOOMAIL_ENFORCE_PLANS: "true" }).restrict).toBe(true);
    expect(webhookHostPolicyFromEnv({ LOOMAIL_PUBLIC_SITE: "true", LOOMAIL_RESTRICT_WEBHOOK_HOSTS: "false" }).restrict).toBe(false);
    expect(webhookHostPolicyFromEnv({ LOOMAIL_RESTRICT_WEBHOOK_HOSTS: "true" }).restrict).toBe(true);
    expect(webhookHostPolicyFromEnv({ LOOMAIL_WEBHOOK_ALLOWED_HOSTS: " Hooks.Internal.Example , 10.0.0.5 " }).allowedHosts).toEqual([
      "hooks.internal.example",
      "10.0.0.5",
    ]);
  });
});

describe("resolveWebhookTarget with the guard on", () => {
  it("accepts a public https host and connects to the checked address", async () => {
    const r = await resolveWebhookTarget("https://hooks.example.com/in?x=1", hostedPolicy(publicLookup));
    expect(r).toMatchObject({ ok: true, address: "93.184.216.34", servername: "hooks.example.com" });
  });

  it.each([
    "http://hooks.example.com/in", // not https
    "https://localhost/in",
    "https://foo.localhost/in",
    "https://db.internal/in",
    "https://printer.local/in",
    "https://127.0.0.1/in",
    "https://[::1]/in",
    "https://10.1.2.3/in",
    "https://192.168.0.10/in",
    "https://169.254.169.254/latest/meta-data/", // cloud metadata
    "https://2130706433/in", // 127.0.0.1 as one decimal number
    "https://0x7f000001/in", // ...and as hex
    "https://[::ffff:127.0.0.1]/in", // IPv4 hidden in IPv6
    "https://user:pw@hooks.example.com/in", // credentials in the address
    "ftp://hooks.example.com/in",
    "not a url",
  ])("refuses %s", async (url) => {
    const r = await resolveWebhookTarget(url, hostedPolicy(publicLookup));
    expect(r.ok).toBe(false);
  });

  it("refuses a name that resolves to a private address, even if only one of its answers is private", async () => {
    const mixed = async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.7", family: 4 },
    ];
    expect((await resolveWebhookTarget("https://rebind.example.com/", hostedPolicy(mixed))).ok).toBe(false);
  });

  it("refuses a name that does not resolve", async () => {
    const none = async () => {
      throw new Error("ENOTFOUND");
    };
    expect((await resolveWebhookTarget("https://nope.example.com/", hostedPolicy(none))).ok).toBe(false);
    expect((await resolveWebhookTarget("https://empty.example.com/", hostedPolicy(async () => []))).ok).toBe(false);
  });

  it("lets the operator exempt a host", async () => {
    const policy: WebhookHostPolicy = { restrict: true, allowedHosts: ["10.0.0.5"], lookup: publicLookup };
    expect((await resolveWebhookTarget("http://10.0.0.5:8080/in", policy)).ok).toBe(true);
    expect((await resolveWebhookTarget("http://10.0.0.6:8080/in", policy)).ok).toBe(false);
  });
});

describe("resolveWebhookTarget with the guard off", () => {
  it("accepts http and private addresses but still refuses malformed or credentialed ones", async () => {
    expect((await resolveWebhookTarget("http://127.0.0.1:3000/in", openPolicy)).ok).toBe(true);
    expect((await resolveWebhookTarget("https://hooks.example.com/in", openPolicy)).ok).toBe(true);
    expect((await resolveWebhookTarget("ftp://x/in", openPolicy)).ok).toBe(false);
    expect((await resolveWebhookTarget("https://u:p@x.example.com/", openPolicy)).ok).toBe(false);
  });
});

describe("signing", () => {
  const secret = "whsec_test";
  const body = JSON.stringify({ hello: "world" });

  it("signs t.body with HMAC-SHA256 and the receiver can verify it", () => {
    const header = signWebhook(secret, 1_700_000_000, body);
    expect(header).toMatch(/^t=1700000000,v1=[0-9a-f]{64}$/);
    expect(verifyWebhookSignature(secret, header, body, 1_700_000_010)).toBe(true);
  });

  it("rejects a changed body, a wrong secret, a stale timestamp and garbage", () => {
    const header = signWebhook(secret, 1_700_000_000, body);
    expect(verifyWebhookSignature(secret, header, body + " ", 1_700_000_010)).toBe(false);
    expect(verifyWebhookSignature("whsec_other", header, body, 1_700_000_010)).toBe(false);
    expect(verifyWebhookSignature(secret, header, body, 1_700_000_000 + 301)).toBe(false);
    expect(verifyWebhookSignature(secret, "nonsense", body, 1_700_000_010)).toBe(false);
    expect(verifyWebhookSignature(secret, "t=1700000000,v1=abcd", body, 1_700_000_010)).toBe(false);
  });
});

describe("the secret at rest", () => {
  it("generates a fresh secret each time", () => {
    const a = generateWebhookSecret();
    expect(a).toMatch(/^whsec_[0-9a-f]{48}$/);
    expect(generateWebhookSecret()).not.toBe(a);
  });

  it("round-trips encrypted when there is a key, and plain when there is not", () => {
    const key = randomBytes(32).toString("base64");
    const secret = generateWebhookSecret();
    const sealed = sealWebhookSecret(secret, key);
    expect(sealed).not.toContain(secret);
    expect(openWebhookSecret(sealed, key)).toBe(secret);
    expect(() => openWebhookSecret(sealed, undefined)).toThrow();
    const plain = sealWebhookSecret(secret, undefined);
    expect(plain.startsWith("plain:")).toBe(true);
    expect(openWebhookSecret(plain, undefined)).toBe(secret);
    expect(openWebhookSecret(plain, key)).toBe(secret);
  });
});

describe("sendWebhook", () => {
  let server: http.Server;
  let base = "";
  const seen: Array<{ url: string; headers: http.IncomingHttpHeaders; body: string }> = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen.push({ url: req.url ?? "", headers: req.headers, body });
        const path = (req.url ?? "").split("?")[0];
        if (path === "/ok") return res.writeHead(200).end("fine");
        if (path === "/created") return res.writeHead(201).end();
        if (path === "/boom") return res.writeHead(503).end("down");
        if (path === "/limited") return res.writeHead(429).end();
        if (path === "/gone") return res.writeHead(410).end();
        if (path === "/bad") return res.writeHead(400).end("nope");
        if (path === "/redirect") return res.writeHead(302, { Location: "http://169.254.169.254/" }).end();
        if (path === "/slow") return void setTimeout(() => res.writeHead(200).end(), 2000);
        if (path === "/huge") return res.writeHead(200).end("x".repeat(100_000));
        res.writeHead(404).end();
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const send = (path: string, extra: Partial<Parameters<typeof sendWebhook>[0]> = {}) =>
    sendWebhook({ url: `${base}${path}`, body: '{"a":1}', secret: "whsec_t", policy: openPolicy, ...extra });

  it("POSTs the exact body with a verifiable signature and the identifying headers", async () => {
    const r = await send("/ok?token=abc", { timestamp: 1_700_000_000, headers: { "X-Loomail-Delivery": "d-1" } });
    expect(r).toEqual({ ok: true, status: 200, error: null, retryable: false });
    const call = seen.at(-1)!;
    expect(call.url).toBe("/ok?token=abc");
    expect(call.body).toBe('{"a":1}');
    expect(call.headers["content-type"]).toBe("application/json");
    expect(call.headers["user-agent"]).toBe("Loomail-Webhooks/1");
    expect(call.headers["x-loomail-delivery"]).toBe("d-1");
    expect(verifyWebhookSignature("whsec_t", String(call.headers["x-loomail-signature"]), call.body, 1_700_000_001)).toBe(true);
  });

  it("any 2xx is success", async () => {
    expect((await send("/created")).ok).toBe(true);
  });

  it("retries on 5xx, 429 and network failure; does not on other refusals", async () => {
    expect(await send("/boom")).toMatchObject({ ok: false, status: 503, retryable: true });
    expect(await send("/limited")).toMatchObject({ ok: false, status: 429, retryable: true });
    expect(await send("/bad")).toMatchObject({ ok: false, status: 400, retryable: false });
    expect(await send("/gone")).toMatchObject({ ok: false, status: 410, retryable: false });
    const refused = await sendWebhook({ url: "http://127.0.0.1:1/x", body: "{}", secret: "s", policy: openPolicy });
    expect(refused).toMatchObject({ ok: false, status: null, retryable: true });
  });

  it("never follows a redirect", async () => {
    const before = seen.length;
    const r = await send("/redirect");
    expect(r).toMatchObject({ ok: false, status: 302, retryable: false });
    expect(r.error).toMatch(/redirects are not followed/);
    expect(seen.length).toBe(before + 1); // only the one request reached the server
  });

  it("times out a server that does not answer", async () => {
    const r = await send("/slow", { timeoutMs: 200 });
    expect(r).toMatchObject({ ok: false, status: null, retryable: true });
    expect(r.error).toMatch(/in time/);
  });

  it("copes with a huge response without keeping it", async () => {
    expect((await send("/huge")).ok).toBe(true);
  });

  it("with the guard on, never connects to a private address", async () => {
    const before = seen.length;
    const r = await sendWebhook({ url: `${base}/ok`, body: "{}", secret: "s", policy: hostedPolicy(publicLookup) });
    expect(r).toMatchObject({ ok: false, status: null, retryable: false });
    expect(seen.length).toBe(before);
  });

  it("with the guard on, connects to the address it checked, not whatever the name says later", async () => {
    // The name resolves (at check time) to the local test server's address, which is exempted by name.
    const policy: WebhookHostPolicy = { restrict: true, allowedHosts: ["127.0.0.1"], lookup: publicLookup };
    const r = await sendWebhook({ url: `${base}/ok`, body: "{}", secret: "s", policy });
    expect(r.ok).toBe(true);
  });

  it("never throws", async () => {
    await expect(sendWebhook({ url: "::::", body: "{}", secret: "s", policy: openPolicy })).resolves.toMatchObject({ ok: false });
  });
});
