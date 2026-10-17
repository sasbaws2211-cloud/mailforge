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
import { describe, it, expect, beforeEach, vi } from "vitest";
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

/** A localStorage stand-in. Pass the same one to two browsers to simulate a second page load. */
function makeStorage(opts: { throws?: boolean } = {}) {
  const data = new Map<string, string>();
  return {
    getItem(k: string) {
      if (opts.throws) throw new Error("storage blocked");
      return data.has(k) ? data.get(k)! : null;
    },
    setItem(k: string, v: string) {
      if (opts.throws) throw new Error("storage blocked");
      data.set(k, v);
    },
  };
}

function makeBrowser(opts: {
  beacon?: boolean;
  beaconFails?: boolean;
  noFetch?: boolean;
  storage?: ReturnType<typeof makeStorage>;
}) {
  const sent: SentCall[] = [];
  const win: Record<string, unknown> = {};
  if (opts.storage) win.localStorage = opts.storage;
  win.location = { href: "https://shop.test/pricing?x=1", pathname: "/pricing", search: "?x=1" };
  win.document = { title: "Pricing", referrer: "https://google.test/" };
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

  describe("anonymous visitors and persistence", () => {
    type Loomail = (...args: unknown[]) => void;
    const boot = (storage: ReturnType<typeof makeStorage>, autoPage = false) => {
      const b = makeBrowser({ storage });
      b.run(b.win, b.nav, undefined as never);
      const l = b.win.loomail as Loomail;
      l("init", "mf_pub_x", { endpoint: "http://x.test", autoPage });
      return { b, l };
    };

    describe("with anonymousTracking: true", () => {
      const bootServerMode = (storage = makeStorage()) => {
        const b = makeBrowser({ storage });
        b.run(b.win, b.nav, undefined as never);
        const l = b.win.loomail as Loomail;
        l("init", "mf_pub_x", { endpoint: "http://x.test", anonymousTracking: true });
        return { b, l };
      };

      it("sends anonymous events straight to the server under the anonymous id, with no userId", () => {
        const { b, l } = bootServerMode();
        l("track", "viewed_pricing", { plan: "pro" });
        l("page");
        expect(b.sent.map((s) => s.url)).toEqual(["http://x.test/v1/track", "http://x.test/v1/track"]);
        const first = b.sent[0]!.body;
        expect(first).toMatchObject({ event: "viewed_pricing", properties: { plan: "pro" } });
        expect(first.userId).toBeUndefined();
        expect(typeof first.anonymousId).toBe("string");
        expect((first.context as { anonymousId: string }).anonymousId).toBe(first.anonymousId);
        expect(String(first.messageId)).toMatch(/^anon:/);
        expect(b.sent[1]!.body.anonymousId).toBe(first.anonymousId);
        expect(b.sent[1]!.body.event).toBe("page_viewed");
      });

      it("identify then carries the same anonymous id, so the server can move the events", () => {
        const { b, l } = bootServerMode();
        l("track", "viewed_pricing");
        l("identify", "u1", { email: "a@b.c" });
        const aid = b.sent[0]!.body.anonymousId;
        expect(b.sent.map((s) => s.url)).toEqual(["http://x.test/v1/track", "http://x.test/v1/identify"]);
        expect((b.sent[1]!.body.context as { anonymousId: string }).anonymousId).toBe(aid);
        expect(b.sent[1]!.body).toMatchObject({ userId: "u1" });
        // Once identified, later events carry the userId as usual.
        l("track", "upgraded");
        expect(b.sent[2]!.body).toMatchObject({ userId: "u1", event: "upgraded" });
      });

      it("the default still holds events in the browser", () => {
        const { b, l } = boot(makeStorage());
        l("track", "viewed_pricing");
        expect(b.sent.length).toBe(0);
      });
    });

    it("holds anonymous events in the browser and never sends them", () => {
      const { b, l } = boot(makeStorage());
      l("track", "viewed_pricing");
      l("page");
      expect(b.sent.length).toBe(0);
    });

    it("sends held events under the real userId when identify runs, identify first", () => {
      const { b, l } = boot(makeStorage());
      l("track", "viewed_pricing", { plan: "pro" });
      l("identify", "u1", { email: "a@b.c" });
      expect(b.sent.map((s) => s.url)).toEqual([
        "http://x.test/v1/identify",
        "http://x.test/v1/track",
      ]);
      const replayed = b.sent[1]!.body;
      expect(replayed).toMatchObject({ userId: "u1", event: "viewed_pricing", properties: { plan: "pro" } });
      expect(typeof replayed.timestamp).toBe("string");
      expect(new Date(replayed.timestamp as string).toISOString()).toBe(replayed.timestamp);
      expect(String(replayed.messageId)).toMatch(/^anon:/);
      // the same anonymous id travels with both calls so the server can stitch later
      expect((b.sent[0]!.body.context as { anonymousId: string }).anonymousId).toBe(
        (replayed.context as { anonymousId: string }).anonymousId,
      );
    });

    it("sends held events once only", () => {
      const { b, l } = boot(makeStorage());
      l("track", "a");
      l("identify", "u1");
      l("identify", "u1");
      expect(b.sent.filter((s) => s.url.endsWith("/v1/track")).length).toBe(1);
    });

    it("remembers the identified user across page loads", () => {
      const storage = makeStorage();
      const first = boot(storage);
      first.l("identify", "u1");
      const second = boot(storage); // a new page load, same browser
      second.l("track", "clicked_upgrade");
      expect(second.b.sent.length).toBe(1);
      expect(second.b.sent[0]!.body).toMatchObject({ userId: "u1", event: "clicked_upgrade" });
    });

    it("keeps held events across page loads until identify", () => {
      const storage = makeStorage();
      boot(storage).l("track", "landed");
      const second = boot(storage);
      second.l("identify", "u1");
      expect(second.b.sent.map((s) => s.body.event ?? "identify")).toEqual(["identify", "landed"]);
    });

    it("keeps one anonymous id per browser", () => {
      const storage = makeStorage();
      const first = boot(storage);
      first.l("identify", "u1");
      const second = boot(storage);
      second.l("track", "x");
      const aid = (first.b.sent[0]!.body.context as { anonymousId: string }).anonymousId;
      expect((second.b.sent[0]!.body.context as { anonymousId: string }).anonymousId).toBe(aid);
    });

    it("reset forgets the user, starts a new anonymous id and drops held events", () => {
      const storage = makeStorage();
      const { b, l } = boot(storage);
      l("identify", "u1");
      const aidBefore = (b.sent[0]!.body.context as { anonymousId: string }).anonymousId;
      l("reset");
      l("track", "after_logout"); // held, because nobody is identified now
      expect(b.sent.length).toBe(1);
      l("identify", "u2");
      const aidAfter = (b.sent[1]!.body.context as { anonymousId: string }).anonymousId;
      expect(aidAfter).not.toBe(aidBefore);
      expect(b.sent[2]!.body).toMatchObject({ userId: "u2", event: "after_logout" });
    });

    it("drops held events that are too old to keep their timestamp", () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
        const storage = makeStorage();
        boot(storage).l("track", "ancient");
        vi.setSystemTime(new Date("2026-01-04T00:00:00Z")); // 72h later
        const second = boot(storage);
        second.l("identify", "u1");
        expect(second.b.sent.length).toBe(1); // identify only
      } finally {
        vi.useRealTimers();
      }
    });

    it("caps what it holds", () => {
      const { b, l } = boot(makeStorage());
      for (let i = 0; i < 80; i++) l("track", "e" + i);
      l("identify", "u1");
      const tracks = b.sent.filter((s) => s.url.endsWith("/v1/track"));
      expect(tracks.length).toBe(50);
      expect(tracks[49]!.body.event).toBe("e79"); // newest kept
    });

    it("still works with storage blocked, for the life of the page", () => {
      const { b, l } = boot(makeStorage({ throws: true }));
      l("track", "a");
      l("identify", "u1");
      l("track", "b");
      expect(b.sent.map((s) => s.body.event ?? "identify")).toEqual(["identify", "a", "b"]);
    });

    it("page() sends page details, and autoPage sends one on init", () => {
      const auto = boot(makeStorage(), true);
      auto.l("identify", "u1");
      expect(auto.b.sent[1]!.body).toMatchObject({
        event: "page_viewed",
        properties: { path: "/pricing", title: "Pricing", referrer: "https://google.test/", search: "?x=1" },
      });
      const { b, l } = boot(makeStorage());
      l("identify", "u1");
      l("page", "Pricing page", { variant: "b" });
      expect(b.sent[1]!.body).toMatchObject({
        event: "page_viewed",
        properties: { name: "Pricing page", variant: "b", path: "/pricing" },
      });
    });

    it("explicit track(userId, event) still works and is remembered", () => {
      const storage = makeStorage();
      const { b, l } = boot(storage);
      l("track", "u9", "evt");
      expect(b.sent[0]!.body).toMatchObject({ userId: "u9", event: "evt" });
      const second = boot(storage);
      second.l("track", "next");
      expect(second.b.sent[0]!.body).toMatchObject({ userId: "u9", event: "next" });
    });
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
