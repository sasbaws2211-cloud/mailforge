/**
 * @loomail/node tests. A real local HTTP server stands in for Loomail, so the whole
 * path is exercised: headers, bodies, retries, timeouts, a dead port.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Loomail, LoomailError, MAX_BATCH_ITEMS } from "../src/index.js";

interface Seen {
  path: string;
  auth: string | undefined;
  body: any;
}

let server: http.Server;
let host: string;
let seen: Seen[];
/** Per-test behaviour: given the request number (1-based), answer it. */
let respond: (n: number, seen: Seen, res: http.ServerResponse) => void;

const json = (res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
};

beforeEach(async () => {
  seen = [];
  respond = (_n, s, res) => json(res, 200, s.body.messageId ? { success: true, deduplicated: false } : { success: true });
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const entry: Seen = { path: req.url ?? "", auth: req.headers.authorization, body: raw ? JSON.parse(raw) : null };
      seen.push(entry);
      respond(seen.length, entry, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  host = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});

const client = (extra: Record<string, unknown> = {}) =>
  new Loomail({ secretKey: "mf_live_test", host, sleep: async () => {}, ...extra });

describe("identify and track", () => {
  it("sends identify with a Bearer secret key, traits and a generated messageId", async () => {
    await client().identify("u1", { email: "a@b.c", plan: "trial" });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.path).toBe("/v1/identify");
    expect(seen[0]!.auth).toBe("Bearer mf_live_test");
    expect(seen[0]!.body).toMatchObject({ userId: "u1", traits: { email: "a@b.c", plan: "trial" } });
    expect(seen[0]!.body.messageId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("sends track with properties, context, and a Date timestamp as ISO", async () => {
    const when = new Date("2026-05-01T10:00:00Z");
    await client().track("u1", "paid", { amount: 4900 }, { timestamp: when, context: { ip: "1.2.3.4" } });
    expect(seen[0]!.path).toBe("/v1/track");
    expect(seen[0]!.body).toMatchObject({
      userId: "u1",
      event: "paid",
      properties: { amount: 4900 },
      timestamp: "2026-05-01T10:00:00.000Z",
      context: { ip: "1.2.3.4" },
    });
  });

  it("uses the messageId you give it and reports a deduplicated repeat", async () => {
    respond = (_n, _s, res) => json(res, 200, { success: true, deduplicated: true });
    const r = await client().track("u1", "paid", {}, { messageId: "paid:inv_9" });
    expect(seen[0]!.body.messageId).toBe("paid:inv_9");
    expect(r).toEqual({ deduplicated: true });
  });

  it("strips a trailing slash from the host", async () => {
    await new Loomail({ secretKey: "mf_live_x", host: host + "///" }).track("u1", "e");
    expect(seen[0]!.path).toBe("/v1/track");
  });

  it("rejects bad arguments before any request", async () => {
    const l = client();
    await expect(l.track("", "e")).rejects.toMatchObject({ code: "invalid_argument" });
    await expect(l.track("u1", "  ")).rejects.toMatchObject({ code: "invalid_argument" });
    await expect(l.identify(undefined as never)).rejects.toMatchObject({ code: "invalid_argument" });
    await expect(l.track("u1", "e", {}, { timestamp: "not a date" })).rejects.toMatchObject({ code: "invalid_argument" });
    expect(seen).toHaveLength(0);
  });
});

describe("keys", () => {
  it("refuses a publishable key, which belongs in a browser", () => {
    expect(() => new Loomail({ secretKey: "mf_pub_abc" })).toThrow(/publishable/);
  });

  it("needs a key from options or LOOMAIL_SECRET_KEY", () => {
    const saved = process.env.LOOMAIL_SECRET_KEY;
    delete process.env.LOOMAIL_SECRET_KEY;
    try {
      expect(() => new Loomail()).toThrow(LoomailError);
      process.env.LOOMAIL_SECRET_KEY = "mf_live_env";
      expect(() => new Loomail({ host })).not.toThrow();
    } finally {
      if (saved === undefined) delete process.env.LOOMAIL_SECRET_KEY;
      else process.env.LOOMAIL_SECRET_KEY = saved;
    }
  });
});

describe("retries", () => {
  it("retries a 503 and resends the same messageId", async () => {
    respond = (n, _s, res) => (n < 3 ? json(res, 503, { error: "down" }) : json(res, 200, { success: true, deduplicated: false }));
    await client().track("u1", "e");
    expect(seen).toHaveLength(3);
    const ids = new Set(seen.map((s) => s.body.messageId));
    expect(ids.size).toBe(1);
  });

  it("waits Retry-After seconds on a 429", async () => {
    const waits: number[] = [];
    respond = (n, _s, res) => (n === 1 ? json(res, 429, {}, { "Retry-After": "2" }) : json(res, 200, { success: true }));
    await client({ sleep: async (ms: number) => void waits.push(ms) }).track("u1", "e");
    expect(waits).toEqual([2000]);
  });

  it("gives up after maxRetries with the server error", async () => {
    respond = (_n, _s, res) => json(res, 500, { error: "boom" });
    const err = await client({ maxRetries: 2 }).track("u1", "e").catch((e) => e);
    expect(err).toBeInstanceOf(LoomailError);
    expect(err).toMatchObject({ code: "server", status: 500 });
    expect(seen).toHaveLength(3); // first try + 2 retries
  });

  it.each([
    [401, "unauthorized"],
    [402, "plan_limit"],
    [403, "forbidden"],
    [400, "validation"],
    [422, "validation"],
  ])("does not retry a %i", async (status, code) => {
    respond = (_n, _s, res) => json(res, status, { error: "no" });
    const err = await client().track("u1", "e").catch((e) => e);
    expect(err).toMatchObject({ code, status });
    expect(seen).toHaveLength(1);
  });

  it("keeps the server's explanation on the error", async () => {
    respond = (_n, _s, res) => json(res, 402, { error: "Contact limit reached" });
    const err = await client().track("u1", "e").catch((e) => e);
    expect(err.message).toContain("Contact limit reached");
    expect(err.body).toEqual({ error: "Contact limit reached" });
  });

  it("reports a network error when nothing is listening", async () => {
    const dead = new Loomail({ secretKey: "mf_live_x", host: "http://127.0.0.1:1", maxRetries: 1, sleep: async () => {} });
    await expect(dead.track("u1", "e")).rejects.toMatchObject({ code: "network" });
  });

  it("times out a server that never answers", async () => {
    respond = () => {}; // hang
    const l = client({ timeoutMs: 50, maxRetries: 0 });
    await expect(l.track("u1", "e")).rejects.toMatchObject({ code: "network" });
  });
});

describe("batch", () => {
  const items = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ type: "track" as const, userId: `u${i}`, event: "e" }));

  it("splits into requests of at most 100 items and totals the results", async () => {
    respond = (_n, s, res) => json(res, 200, { success: true, received: s.body.batch.length, errors: [] });
    const r = await client().batch(items(250));
    expect(seen.map((s) => s.body.batch.length)).toEqual([MAX_BATCH_ITEMS, MAX_BATCH_ITEMS, 50]);
    expect(seen.every((s) => s.path === "/v1/batch")).toBe(true);
    expect(r).toEqual({ received: 250, errors: [] });
  });

  it("maps per-item errors back to positions in the original array", async () => {
    respond = (n, s, res) =>
      json(res, 200, {
        success: true,
        received: s.body.batch.length - (n === 2 ? 1 : 0),
        errors: n === 2 ? [{ index: 4, message: "boom", code: "plan_limit" }] : [],
      });
    const r = await client().batch(items(150));
    expect(r.received).toBe(149);
    expect(r.errors).toEqual([{ index: 104, message: "boom", code: "plan_limit" }]); // 100 + 4
  });

  it("gives every item a messageId, mixes identify and track, and leaves explicit ids alone", async () => {
    await client().batch([
      { type: "identify", userId: "u1", traits: { plan: "paid" } },
      { type: "track", userId: "u1", event: "paid", messageId: "paid:1", timestamp: new Date("2026-05-01T00:00:00Z") },
    ]);
    const [a, b] = seen[0]!.body.batch;
    expect(a).toMatchObject({ type: "identify", userId: "u1", traits: { plan: "paid" } });
    expect(a.messageId).toBeTruthy();
    expect(b).toMatchObject({ type: "track", messageId: "paid:1", timestamp: "2026-05-01T00:00:00.000Z" });
  });

  it("names the bad item and sends nothing when one is invalid", async () => {
    const bad = [...items(2), { type: "track" as const, userId: "", event: "e" }];
    await expect(client().batch(bad)).rejects.toThrow(/batch\[2\]/);
    expect(seen).toHaveLength(0);
  });

  it("does nothing for an empty batch", async () => {
    expect(await client().batch([])).toEqual({ received: 0, errors: [] });
    expect(seen).toHaveLength(0);
  });

  it("splits a batch that is too large in bytes even under 100 items", async () => {
    respond = (_n, s, res) => json(res, 200, { success: true, received: s.body.batch.length, errors: [] });
    const fat = Array.from({ length: 60 }, (_, i) => ({
      type: "track" as const,
      userId: `u${i}`,
      event: "e",
      properties: { blob: "x".repeat(10_000) }, // 60 x ~10 KB = ~600 KB
    }));
    const r = await client().batch(fat);
    expect(seen.length).toBeGreaterThan(1);
    expect(r.received).toBe(60);
  });
});
