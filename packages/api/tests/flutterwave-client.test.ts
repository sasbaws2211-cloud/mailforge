/**
 * Tests for the Flutterwave client against a local fake of the v3 API:
 * request shapes, authentication, error classification, timeouts.
 * No database and no real Flutterwave account needed.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createFlutterwaveClient, FlutterwaveError, type FlutterwaveClient } from "../src/billing/flutterwave.js";
import { startFakeFlutterwave, type FakeFlutterwave } from "./helpers/fake-flutterwave.js";

let fake: FakeFlutterwave;
let client: FlutterwaveClient;

beforeAll(async () => {
  fake = await startFakeFlutterwave("FLWSECK_TEST-unit-key");
  client = createFlutterwaveClient({ secretKey: fake.secretKey, baseUrl: fake.baseUrl });
});
afterAll(async () => {
  await fake.close();
});
beforeEach(() => {
  fake.requests.length = 0;
});

const linkInput = (planId: string, over: Record<string, unknown> = {}) => ({
  txRef: `tx-${Math.random().toString(36).slice(2)}`,
  amount: 49,
  currency: "USD",
  redirectUrl: "https://app.example/billing/return",
  customer: { email: "payer@example.com", name: "Acme" },
  paymentPlanId: planId,
  title: "Mailforge",
  description: "Growth plan (monthly)",
  meta: { tenant_id: "t1" },
  ...over,
});

describe("createPaymentPlan", () => {
  it("posts the plan with a Bearer key and returns the id as a string", async () => {
    const out = await client.createPaymentPlan({ name: "Mailforge Growth (monthly)", amount: 49, interval: "monthly", currency: "USD" });
    expect(typeof out.id).toBe("string");
    const [call] = fake.callsTo("POST", "/payment-plans");
    expect(call!.headers.authorization).toBe("Bearer FLWSECK_TEST-unit-key");
    expect(call!.headers["content-type"]).toContain("application/json");
    expect(call!.body).toEqual({ name: "Mailforge Growth (monthly)", amount: 49, interval: "monthly", currency: "USD" });
  });

  it("supports the yearly interval", async () => {
    await client.createPaymentPlan({ name: "Mailforge Growth (yearly)", amount: 490, interval: "yearly", currency: "USD" });
    expect((fake.callsTo("POST", "/payment-plans")[0]!.body as { interval: string }).interval).toBe("yearly");
  });
});

describe("createPaymentLink", () => {
  it("sends the fields Flutterwave Standard requires, plus the plan, and returns the link", async () => {
    const { id } = await client.createPaymentPlan({ name: "p", amount: 49, interval: "monthly", currency: "USD" });
    const input = linkInput(id);
    const out = await client.createPaymentLink(input);
    expect(out.link).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/hosted\/pay\/tok\d+$/);

    const body = fake.callsTo("POST", "/payments")[0]!.body as Record<string, unknown>;
    expect(body).toMatchObject({
      tx_ref: input.txRef,
      amount: 49,
      currency: "USD",
      redirect_url: "https://app.example/billing/return",
      payment_plan: id,
      customer: { email: "payer@example.com", name: "Acme" },
      customizations: { title: "Mailforge", description: "Growth plan (monthly)" },
      meta: { tenant_id: "t1" },
    });
  });

  it("surfaces Flutterwave's own refusal, for example a currency that does not match the plan", async () => {
    const { id } = await client.createPaymentPlan({ name: "p", amount: 49, interval: "monthly", currency: "USD" });
    await expect(client.createPaymentLink(linkInput(id, { currency: "GHS" }))).rejects.toThrow(/currency does not match/);
  });

  it("refuses a link that is not https when talking to a real (https) base URL", async () => {
    const insecure = createFlutterwaveClient({
      secretKey: "k",
      baseUrl: "https://api.example.test/v3",
      fetch: async () => new Response(JSON.stringify({ status: "success", data: { link: "http://evil.example/pay" } }), { status: 200 }),
    });
    await expect(insecure.createPaymentLink(linkInput("1"))).rejects.toThrow(/usable checkout link/);
  });

  it("refuses a missing link, and links that are not http(s) at all", async () => {
    for (const data of [{}, { link: "" }, { link: "javascript:alert(1)" }, { link: "ftp://x.test/pay" }]) {
      const c = createFlutterwaveClient({
        secretKey: "k",
        baseUrl: "https://api.example.test/v3",
        fetch: async () => new Response(JSON.stringify({ status: "success", data }), { status: 200 }),
      });
      await expect(c.createPaymentLink(linkInput("1")), JSON.stringify(data)).rejects.toThrow(/usable checkout link/);
    }
  });

  it("accepts an https link from a real base URL", async () => {
    const c = createFlutterwaveClient({
      secretKey: "k",
      baseUrl: "https://api.example.test/v3",
      fetch: async () => new Response(JSON.stringify({ status: "success", data: { link: "https://checkout.example/pay/abc" } }), { status: 200 }),
    });
    await expect(c.createPaymentLink(linkInput("1"))).resolves.toEqual({ link: "https://checkout.example/pay/abc" });
  });
});

describe("verifyTransaction", () => {
  it("fetches the transaction by id with the Bearer key", async () => {
    const { id } = await client.createPaymentPlan({ name: "p", amount: 49, interval: "monthly", currency: "USD" });
    const input = linkInput(id);
    await client.createPaymentLink(input);
    const { transactionId } = fake.completePayment(input.txRef);

    const tx = await client.verifyTransaction(transactionId);
    expect(tx).toMatchObject({ tx_ref: input.txRef, amount: 49, currency: "USD", status: "successful", customer: { email: "payer@example.com" } });
    const [call] = fake.callsTo("GET", "/transactions/");
    expect(call!.path).toBe(`/transactions/${transactionId}/verify`);
    expect(call!.headers.authorization).toBe("Bearer FLWSECK_TEST-unit-key");
  });

  it("accepts a string id and url-encodes it", async () => {
    await expect(client.verifyTransaction("../../etc/passwd")).rejects.toThrow(FlutterwaveError);
    expect(fake.requests[0]!.path).not.toContain("../");
    expect(fake.requests[0]!.path).toContain("%2F");
  });

  it("an unknown transaction is a 404 error that is not worth retrying", async () => {
    const e = await client.verifyTransaction(123).catch((x) => x);
    expect(e).toBeInstanceOf(FlutterwaveError);
    expect(e.httpStatus).toBe(404);
    expect(e.transient).toBe(false);
  });
});

describe("subscriptions", () => {
  async function subscribe(email: string): Promise<number> {
    const { id } = await client.createPaymentPlan({ name: "p", amount: 19, interval: "monthly", currency: "USD" });
    const input = linkInput(id, { amount: 19, customer: { email, name: "N" } });
    await client.createPaymentLink(input);
    fake.completePayment(input.txRef);
    return fake.subscriptions[fake.subscriptions.length - 1]!.id;
  }

  it("lists a customer's subscriptions by email, url-encoded, and only theirs", async () => {
    const mine = await subscribe("pay+tag@example.com");
    await subscribe("someone-else@example.com");
    const list = await client.listSubscriptions("pay+tag@example.com");
    expect(list.map((s) => s.id)).toEqual([mine]);
    expect(list[0]).toMatchObject({ status: "active", customer: { customer_email: "pay+tag@example.com" } });
    expect(fake.callsTo("GET", "/subscriptions")[0]!.path).toContain("pay%2Btag%40example.com");
  });

  it("returns an empty list for a customer with none", async () => {
    expect(await client.listSubscriptions("nobody@example.com")).toEqual([]);
  });

  it("cancels a subscription with a PUT to its cancel path", async () => {
    const id = await subscribe("cancel-me@example.com");
    await client.cancelSubscription(id);
    const [call] = fake.callsTo("PUT", "/subscriptions/");
    expect(call!.path).toBe(`/subscriptions/${id}/cancel`);
    expect(fake.subscriptions.find((s) => s.id === id)!.status).toBe("cancelled");
  });

  it("cancelling something that does not exist is an error", async () => {
    await expect(client.cancelSubscription(999999)).rejects.toThrow(/not found/i);
  });
});

describe("authentication and error classification", () => {
  it("a wrong key is a 401, not transient, and the key never appears in the message", async () => {
    const bad = createFlutterwaveClient({ secretKey: "FLWSECK-WRONG-SECRET", baseUrl: fake.baseUrl });
    const e = await bad.listSubscriptions("a@b.com").catch((x) => x);
    expect(e).toBeInstanceOf(FlutterwaveError);
    expect(e.httpStatus).toBe(401);
    expect(e.transient).toBe(false);
    expect(e.message).toContain("Invalid authorization key");
    expect(e.message).not.toContain("FLWSECK-WRONG-SECRET");
    expect(JSON.stringify(e)).not.toContain("FLWSECK-WRONG-SECRET");
  });

  it("a 400 is the caller's problem and not worth retrying", async () => {
    const e = await client.createPaymentPlan({ name: "", amount: 1, interval: "monthly", currency: "USD" }).catch((x) => x);
    expect(e.httpStatus).toBe(400);
    expect(e.transient).toBe(false);
  });

  it("a 500 and a 429 are transient: retrying later may work", async () => {
    fake.failNext("/subscriptions", 500);
    const e500 = await client.listSubscriptions("a@b.com").catch((x) => x);
    expect(e500.httpStatus).toBe(500);
    expect(e500.transient).toBe(true);

    fake.failNext("/subscriptions", 429);
    const e429 = await client.listSubscriptions("a@b.com").catch((x) => x);
    expect(e429.httpStatus).toBe(429);
    expect(e429.transient).toBe(true);

    // And the next call, with no injected failure, simply works again.
    await expect(client.listSubscriptions("a@b.com")).resolves.toEqual([]);
  });

  it("a connection that cannot be made is transient and has no HTTP status", async () => {
    const dead = createFlutterwaveClient({ secretKey: "k", baseUrl: "http://127.0.0.1:1/v3" });
    const e = await dead.listSubscriptions("a@b.com").catch((x) => x);
    expect(e).toBeInstanceOf(FlutterwaveError);
    expect(e.httpStatus).toBeUndefined();
    expect(e.transient).toBe(true);
    expect(e.message).toMatch(/Could not reach Flutterwave/);
  });

  it("times out a request that never answers, and calls it transient", async () => {
    const hang = createFlutterwaveClient({
      secretKey: "k",
      baseUrl: "https://api.example.test/v3",
      timeoutMs: 40,
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          (init as RequestInit).signal!.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
        }),
    });
    const started = Date.now();
    const e = await hang.listSubscriptions("a@b.com").catch((x) => x);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(e).toBeInstanceOf(FlutterwaveError);
    expect(e.transient).toBe(true);
    expect(e.message).toMatch(/timed out after 40 ms/);
  });

  it("a 200 whose envelope says error is a permanent error", async () => {
    const c = createFlutterwaveClient({
      secretKey: "k",
      baseUrl: "https://api.example.test/v3",
      fetch: async () => new Response(JSON.stringify({ status: "error", message: "Declined", data: null }), { status: 200 }),
    });
    const e = await c.verifyTransaction(1).catch((x) => x);
    expect(e).toBeInstanceOf(FlutterwaveError);
    expect(e.transient).toBe(false);
    expect(e.message).toContain("Declined");
  });

  it("a response that is not JSON is an unexpected-response error, never a crash", async () => {
    const c = createFlutterwaveClient({
      secretKey: "k",
      baseUrl: "https://api.example.test/v3",
      fetch: async () => new Response("<html>gateway</html>", { status: 200 }),
    });
    await expect(c.verifyTransaction(1)).rejects.toThrow(/unexpected response/);
  });

  it("an error page from a proxy (HTML 502) is transient", async () => {
    const c = createFlutterwaveClient({
      secretKey: "k",
      baseUrl: "https://api.example.test/v3",
      fetch: async () => new Response("<html>bad gateway</html>", { status: 502 }),
    });
    const e = await c.verifyTransaction(1).catch((x) => x);
    expect(e.httpStatus).toBe(502);
    expect(e.transient).toBe(true);
  });

  it("trailing slashes on the base URL do not break paths", async () => {
    const c = createFlutterwaveClient({ secretKey: fake.secretKey, baseUrl: `${fake.baseUrl}///` });
    await expect(c.listSubscriptions("a@b.com")).resolves.toEqual([]);
  });
});
