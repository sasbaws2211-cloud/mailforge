/**
 * Browser snippet tests (public/loomail.js).
 *
 * Runs the snippet in a minimal fake browser environment (window, navigator,
 * fetch) built from plain objects - no jsdom dependency. Verifies:
 * - pre-load stub queueing and replay on load
 * - init/identify/track wire payloads (publishable key in body)
 * - sendBeacon is preferred; fetch keepalive is the fallback
 * - track(event, props) reuses the identified user; explicit
 *   track(userId, event, props) also works
 * - host-page safety: throws inside navigator/fetch never propagate
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const snippetSource = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "../public/loomail.js"),
  "utf8",
);

interface SentCall {
  url: string;
  body: Record<string, unknown>;
  via: "beacon" | "fetch";
}

function makeBrowser(opts: { beacon?: boolean; beaconFails?: boolean; noFetch?: boolean }) {
  const sent: SentCall[] = [];
  const win: Record<string, unknown> = {};
  const nav: Record<string, unknown> = {};
  if (opts.beacon !== false) {
    nav.sendBeacon = (url: string, body: string) => {
      if (opts.beaconFails) return false;
      sent.push({ url, body: JSON.parse(body), via: "beacon" });
      return true;
    };
  }
  const fetchFn = opts.noFetch
    ? undefined
    : (url: string, init: { body: string; keepalive?: boolean; headers: Record<string, string> }) => {
        sent.push({ url, body: JSON.parse(init.body), via: "fetch" });
        if (!init.keepalive) throw new Error("fetch must use keepalive");
        if (init.headers["Content-Type"] !== "text/plain") {
          throw new Error("fetch must send text/plain (CORS-simple)");
        }
        return Promise.resolve();
      };

  const sandbox = {
    window: win,
    navigator: nav,
    fetch: fetchFn,
  };
  const run = new Function(
    "window",
    "navigator",
    "fetch",
    snippetSource,
  );
  return { win, nav, sent, run };
}

describe("loomail.js snippet", () => {
  beforeEach(() => {
    // nothing shared between tests; each builds its own browser
  });

  it("replays calls queued before the script loads", () => {
    const b = makeBrowser({});
    // Pre-load stub, as documented
    const q: unknown[][] = [];
    b.win.loomail = function (...args: unknown[]) {
      q.push(args);
    };
    (b.win.loomail as { q?: unknown[][] }).q = q;
    (b.win.loomail as Function)("init", "mf_pub_test", { endpoint: "http://localhost:3000" });
    (b.win.loomail as Function)("identify", "user_1", { email: "a@b.c" });
    (b.win.loomail as Function)("track", "signed_up");

    b.run(b.win, b.nav, b.sent !== undefined ? (undefined as unknown as never) : (undefined as never));
    expect(b.sent.length).toBe(2);

    const [identify, track] = b.sent;
    expect(identify!.url).toBe("http://localhost:3000/v1/identify");
    expect(identify!.body.key).toBe("mf_pub_test");
    expect(identify!.body.userId).toBe("user_1");
    expect((identify!.body.traits as Record<string, unknown>).email).toBe("a@b.c");
    expect(track!.url).toBe("http://localhost:3000/v1/track");
    expect(track!.body.event).toBe("signed_up");
    expect(track!.body.userId).toBe("user_1");
  });

  it("sends via sendBeacon when available", () => {
    const b = makeBrowser({});
    b.run(b.win, b.nav, undefined as never);
    const loomail = b.win.loomail as (...args: unknown[]) => void;
    loomail("init", "mf_pub_x", { endpoint: "http://x.test" });
    loomail("track", "u1", "evt", { a: 1 });
    expect(b.sent[0]!.via).toBe("beacon");
    expect(b.sent[0]!.body).toMatchObject({ key: "mf_pub_x", userId: "u1", event: "evt", properties: { a: 1 } });
  });

  it("falls back to fetch keepalive when beacon is unavailable or declines", () => {
    const noBeacon = makeBrowser({ beacon: false });
    // fetch must exist in the sandbox
    const fetchCalls: SentCall[] = [];
    const fetchFn = (url: string, init: { body: string; keepalive?: boolean }) => {
      fetchCalls.push({ url, body: JSON.parse(init.body), via: "fetch" });
      expect(init.keepalive).toBe(true);
      return Promise.resolve();
    };
    noBeacon.run(noBeacon.win, noBeacon.nav, fetchFn as never);
    const loomail = noBeacon.win.loomail as (...args: unknown[]) => void;
    loomail("init", "mf_pub_x", { endpoint: "http://x.test" });
    loomail("track", "u1", "evt");
    expect(fetchCalls.length).toBe(1);

    const beaconDeclines = makeBrowser({ beaconFails: true });
    const fetchCalls2: SentCall[] = [];
    beaconDeclines.run(beaconDeclines.win, beaconDeclines.nav, ((url: string, init: { body: string }) => {
      fetchCalls2.push({ url, body: JSON.parse(init.body), via: "fetch" });
      return Promise.resolve();
    }) as never);
    const loomail2 = beaconDeclines.win.loomail as (...args: unknown[]) => void;
    loomail2("init", "mf_pub_x", { endpoint: "http://x.test" });
    loomail2("identify", "u2");
    expect(fetchCalls2.length).toBe(1);
  });

  it("does nothing before init and never throws on garbage input", () => {
    const b = makeBrowser({});
    b.run(b.win, b.nav, undefined as never);
    const loomail = b.win.loomail as (...args: unknown[]) => void;
    loomail("track", "no_user_yet");
    loomail("identify", "");
    loomail("init");
    loomail("track", "still_not_ready");
    expect(b.sent.length).toBe(0);
  });

  it("never propagates host-page errors", () => {
    const b = makeBrowser({});
    const throwingFetch = () => {
      throw new Error("host page has a broken fetch");
    };
    b.run(b.win, { sendBeacon: () => false }, throwingFetch as never);
    const loomail = b.win.loomail as (...args: unknown[]) => void;
    expect(() => {
      loomail("init", "mf_pub_x", { endpoint: "http://x.test" });
      loomail("track", "u1", "evt");
    }).not.toThrow();
  });

  it("strips a trailing slash from the endpoint", () => {
    const b = makeBrowser({});
    b.run(b.win, b.nav, undefined as never);
    const loomail = b.win.loomail as (...args: unknown[]) => void;
    loomail("init", "mf_pub_x", { endpoint: "http://x.test/" });
    loomail("track", "u1", "evt");
    expect(b.sent[0]!.url).toBe("http://x.test/v1/track");
  });
});
