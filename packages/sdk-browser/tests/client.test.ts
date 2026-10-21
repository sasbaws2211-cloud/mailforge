// @vitest-environment jsdom
/** The browser client: identity, anonymous holding, consent, route changes, safety. */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createLoomail, createNoopClient, type StorageLike } from "../src/index.js";

type Call = { url: string; body: Record<string, any> };
let calls: Call[] = [];
const transport = (url: string, body: string) => calls.push({ url, body: JSON.parse(body) });
const memoryStorage = (): StorageLike & { map: Map<string, string> } => {
  const map = new Map<string, string>();
  return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v), removeItem: (k) => void map.delete(k) };
};
const base = { key: "mf_pub_abc", endpoint: "https://loomail.test/", transport };
// Every client a test makes is stopped afterwards, newest first, even when an assertion fails before the test's own stop():
// a client left running keeps its timer and its history patch, and one failure then breaks every test after it.
const clients: Array<{ stop(): void }> = [];
const own = <T extends { stop(): void }>(c: T): T => (clients.push(c), c);
const make = (over: Record<string, unknown> = {}) => own(createLoomail({ ...base, storage: memoryStorage(), routeSettleMs: 1, ...over }));
const paths = () => calls.map((c) => c.url.replace("https://loomail.test", ""));
// Time is faked in the tests that wait, so a slow machine cannot make a settle window miss.
const tick = (ms = 5) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => {
  calls = [];
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
  document.title = "Home";
});
afterEach(() => {
  for (const c of clients.splice(0).reverse()) c.stop();
  vi.useRealTimers();
});

describe("identify and track", () => {
  it("sends identify then tracks under the identified user, with the key in the body and no trailing slash in the url", () => {
    const l = make();
    l.identify("user_1", { email: "a@b.co", plan: "trial" });
    l.track("signed_up", { source: "ads" });
    expect(paths()).toEqual(["/v1/identify", "/v1/track"]);
    expect(calls[0]!.url).toBe("https://loomail.test/v1/identify");
    expect(calls[0]!.body).toMatchObject({ key: "mf_pub_abc", userId: "user_1", traits: { email: "a@b.co", plan: "trial" } });
    expect(calls[1]!.body).toMatchObject({ key: "mf_pub_abc", userId: "user_1", event: "signed_up", properties: { source: "ads" } });
    expect(calls[1]!.body.context.anonymousId).toBe(l.anonymousId());
    expect(l.userId()).toBe("user_1");
  });

  it("ignores empty ids and event names", () => {
    const l = make();
    l.identify("");
    l.track("");
    expect(calls).toHaveLength(0);
  });

  it("remembers the person across clients that share storage (a page reload)", () => {
    const storage = memoryStorage();
    createLoomail({ ...base, storage }).identify("user_9");
    calls = [];
    const again = createLoomail({ ...base, storage });
    again.track("viewed_pricing");
    expect(calls[0]!.body).toMatchObject({ userId: "user_9", event: "viewed_pricing" });
  });

  it("forgets the person on reset and starts a new anonymous id", () => {
    const l = make();
    l.identify("user_1");
    const before = l.anonymousId();
    l.reset();
    expect(l.userId()).toBeNull();
    expect(l.anonymousId()).not.toBe(before);
    calls = [];
    l.track("after_logout");
    expect(calls).toHaveLength(0); // held, anonymous
  });
});

describe("anonymous visitors", () => {
  it("holds events and sends them under the real user, in order, with their original times and ids", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-01T10:00:00Z"));
    const l = make();
    l.track("viewed_home");
    vi.setSystemTime(new Date("2026-03-01T10:05:00Z"));
    l.track("viewed_pricing", { plan: "pro" });
    expect(calls).toHaveLength(0);
    vi.setSystemTime(new Date("2026-03-01T10:10:00Z"));
    l.identify("user_7", { email: "x@y.zz" });
    expect(paths()).toEqual(["/v1/identify", "/v1/track", "/v1/track"]);
    expect(calls[1]!.body).toMatchObject({ userId: "user_7", event: "viewed_home", timestamp: "2026-03-01T10:00:00.000Z" });
    expect(calls[2]!.body).toMatchObject({ event: "viewed_pricing", timestamp: "2026-03-01T10:05:00.000Z", properties: { plan: "pro" } });
    expect(calls[1]!.body.messageId).toMatch(/^anon:/);
    expect(calls[1]!.body.messageId).not.toBe(calls[2]!.body.messageId);
  });

  it("drops held events older than 48 hours and keeps at most 50", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-01T00:00:00Z"));
    const l = make();
    l.track("old");
    vi.setSystemTime(new Date("2026-03-03T01:00:00Z"));
    for (let i = 0; i < 60; i++) l.track("e" + i);
    l.identify("u");
    const tracked = calls.filter((c) => c.url.endsWith("/v1/track")).map((c) => c.body.event);
    expect(tracked).toHaveLength(50);
    expect(tracked).not.toContain("old");
    expect(tracked[0]).toBe("e10");
  });

  it("sends anonymous events to the server when anonymousTracking is on", () => {
    const l = make({ anonymousTracking: true });
    l.track("viewed_home");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toMatchObject({ anonymousId: l.anonymousId(), event: "viewed_home" });
    expect(calls[0]!.body).not.toHaveProperty("userId");
    expect(calls[0]!.body.messageId).toMatch(/^anon:/);
  });
});

describe("storage", () => {
  it("works from memory when storage throws", () => {
    const boom = () => {
      throw new Error("blocked");
    };
    const broken: StorageLike = { getItem: boom, setItem: boom, removeItem: boom };
    const l = createLoomail({ ...base, storage: broken });
    l.identify("u1");
    l.track("e");
    expect(l.userId()).toBe("u1");
    expect(calls[1]!.body.userId).toBe("u1");
  });

  it("works with no storage at all (null)", () => {
    const l = createLoomail({ ...base, storage: null });
    l.identify("u1");
    expect(l.userId()).toBe("u1");
  });

  it("uses the same storage key and shape as the hosted snippet", () => {
    const storage = memoryStorage();
    createLoomail({ ...base, storage }).identify("u1");
    const stored = JSON.parse(storage.map.get("loomail:v1")!);
    expect(stored).toMatchObject({ uid: "u1", buf: [] });
    expect(typeof stored.aid).toBe("string");
  });
});

describe("consent", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("sends and stores nothing until opted in", async () => {
    const storage = memoryStorage();
    const l = own(createLoomail({ ...base, storage, startOptedOut: true, autoPage: true, anonymousTracking: true }));
    l.identify("u1");
    l.track("e");
    l.page();
    expect(calls).toHaveLength(0);
    expect(storage.map.size).toBe(0);
    expect(l.isOptedOut()).toBe(true);
    expect(l.userId()).toBeNull();
    l.optIn();
    expect(l.isOptedOut()).toBe(false);
    expect(paths()).toEqual(["/v1/track"]); // the page the visitor is on, now that they agreed
    expect(calls[0]!.body.event).toBe("page_viewed");
    await tick(10);
    expect(calls).toHaveLength(1); // the first view that was waiting does not record it a second time
    l.stop();
  });

  it("forgets the visitor and stops sending when opted out", () => {
    const storage = memoryStorage();
    const l = createLoomail({ ...base, storage });
    l.identify("u1");
    calls = [];
    l.optOut();
    expect(storage.map.has("loomail:v1")).toBe(false);
    l.track("e");
    l.identify("u2");
    expect(calls).toHaveLength(0);
    expect(storage.map.size).toBe(0);
    l.optIn();
    expect(l.userId()).toBeNull(); // the earlier identity is gone
  });
});

describe("page views and route changes", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("records a page view on start with the page details, only when autoPage is on", async () => {
    document.title = "Pricing";
    window.history.replaceState(null, "", "/pricing?ref=nav");
    make();
    await tick(10);
    expect(calls).toHaveLength(0);
    const l = make({ autoPage: true, anonymousTracking: true });
    expect(calls).toHaveLength(0); // not yet: it waits for the title to settle
    await tick(10);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toMatchObject({ event: "page_viewed", properties: { path: "/pricing", search: "?ref=nav", title: "Pricing" } });
    expect(calls[0]!.body.properties.url).toContain("/pricing?ref=nav");
    l.stop();
  });

  it("records one page view per client-side route change, with the previous address as referrer", async () => {
    const l = make({ autoPage: true, anonymousTracking: true });
    await tick(10);
    expect(calls).toHaveLength(1);
    window.history.pushState(null, "", "/features");
    document.title = "Features";
    await tick(5);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.body.properties).toMatchObject({ path: "/features", title: "Features" });
    expect(calls[1]!.body.properties.referrer).toBe(calls[0]!.body.properties.url);
    // the same address again (or only a hash) is not a new page
    window.history.pushState(null, "", "/features");
    window.history.replaceState(null, "", "/features#top");
    await tick(5);
    expect(calls).toHaveLength(2);
    // forward, then back
    window.history.pushState(null, "", "/pricing");
    await tick(5);
    window.history.back();
    await tick(40);
    expect(calls.map((c) => c.body.properties.path)).toEqual(["/", "/features", "/pricing", "/features"]);
    l.stop();
  });

  it("waits for the title to stop changing, so the page view carries the new page's title, and records a redirect chain once", async () => {
    const l = make({ autoPage: true, anonymousTracking: true, routeSettleMs: 30 });
    await vi.advanceTimersByTimeAsync(80);
    calls = [];
    window.history.pushState(null, "", "/old");
    window.history.replaceState(null, "", "/redirected");
    window.history.replaceState(null, "", "/final");
    await vi.advanceTimersByTimeAsync(5);
    expect(calls).toHaveLength(0); // still settling
    document.title = "Final page"; // the app sets it after rendering
    await vi.advanceTimersByTimeAsync(90);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body.properties).toMatchObject({ path: "/final", title: "Final page" });
    expect(vi.getTimerCount()).toBe(0); // the three waits of the redirect chain left nothing running behind them
    l.stop();
  });

  it("starts its wait again every time the title changes, and records the page once the title has stopped", async () => {
    const l = make({ autoPage: true, anonymousTracking: true, routeSettleMs: 60 });
    await vi.advanceTimersByTimeAsync(200);
    calls = [];
    window.history.pushState(null, "", "/next");
    setTimeout(() => (document.title = "First"), 30);
    setTimeout(() => (document.title = "Second"), 80);
    await vi.advanceTimersByTimeAsync(140); // 60ms of quiet has not passed since the last change yet
    expect(calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(260);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body.properties).toMatchObject({ path: "/next", title: "Second" });
    l.stop();
  });

  it("the first page view also waits for the title (Angular sets it just after start)", async () => {
    document.title = "Demo"; // the HTML's default
    const l = make({ autoPage: true, anonymousTracking: true, routeSettleMs: 40 });
    setTimeout(() => (document.title = "Home"), 15); // the router sets the real one a moment later
    await tick(120);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body.properties.title).toBe("Home");
    l.stop();
  });

  it("copes with a title that is cleared and refilled during navigation (Next.js)", async () => {
    document.title = "Pricing";
    window.history.replaceState(null, "", "/pricing");
    const l = make({ autoPage: true, anonymousTracking: true, routeSettleMs: 40 });
    await vi.advanceTimersByTimeAsync(100);
    calls = [];
    window.history.pushState(null, "", "/");
    document.title = ""; // the framework clears it...
    setTimeout(() => (document.title = "Home"), 60); // ...and fills it in again later
    await vi.advanceTimersByTimeAsync(180);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body.properties).toMatchObject({ path: "/", title: "Home" });
    l.stop();
  });

  it("keeps waiting while the title is empty, and records a page that never gets one after the limit", async () => {
    document.title = "Pricing";
    window.history.replaceState(null, "", "/pricing");
    const l = make({ autoPage: true, anonymousTracking: true, routeSettleMs: 30 });
    await vi.advanceTimersByTimeAsync(100);
    calls = [];
    window.history.pushState(null, "", "/");
    document.title = ""; // empty for much longer than the settle time
    setTimeout(() => (document.title = "Home"), 200);
    await vi.advanceTimersByTimeAsync(320);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body.properties).toMatchObject({ path: "/", title: "Home" });
    l.stop();

    document.title = "";
    window.history.replaceState(null, "", "/untitled");
    calls = [];
    const m = make({ autoPage: true, anonymousTracking: true, routeSettleMs: 30 });
    await vi.advanceTimersByTimeAsync(500);
    expect(calls).toHaveLength(0); // still waiting for a title
    await vi.advanceTimersByTimeAsync(600);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body.properties).toMatchObject({ path: "/untitled", title: "" });
    m.stop();
  });

  it("does not wait forever for a title that never stops changing", async () => {
    vi.useFakeTimers();
    const l = make({ autoPage: true, anonymousTracking: true, routeSettleMs: 100 });
    for (let i = 0; i < 100; i++) {
      document.title = "t" + i;
      await vi.advanceTimersByTimeAsync(20);
    }
    expect(calls).toHaveLength(1); // gave up after a second
    l.stop();
  });

  it("does not follow route changes when trackRouteChanges is false, or after stop()", async () => {
    const a = make({ autoPage: true, anonymousTracking: true, trackRouteChanges: false });
    await tick(10);
    window.history.pushState(null, "", "/a");
    await tick(5);
    expect(calls).toHaveLength(1);
    a.stop();
    const b = make({ autoPage: true, anonymousTracking: true });
    b.stop();
    calls = [];
    window.history.pushState(null, "", "/b");
    await tick(5);
    expect(calls).toHaveLength(0);
  });

  it("puts history back the way it found it", () => {
    const push = window.history.pushState;
    const replace = window.history.replaceState;
    const l = make({ autoPage: true });
    expect(window.history.pushState).not.toBe(push);
    l.stop();
    expect(window.history.pushState).toBe(push);
    expect(window.history.replaceState).toBe(replace);
  });

  it("a repeated start (React strict mode) does not record the same page twice", async () => {
    const l = make({ autoPage: true, anonymousTracking: true, autoStart: false });
    l.start();
    l.stop();
    l.start();
    await tick(10);
    expect(calls).toHaveLength(1);
    l.stop();
  });

  it("page() takes a name, properties, or both, anytime", () => {
    const l = make({ anonymousTracking: true });
    l.page("Pricing", { plan: "pro" });
    l.page({ section: "docs" });
    l.page();
    expect(calls.map((c) => [c.body.properties.name, c.body.properties.plan, c.body.properties.section])).toEqual([
      ["Pricing", "pro", undefined],
      [undefined, undefined, "docs"],
      [undefined, undefined, undefined],
    ]);
  });
});

describe("safety", () => {
  it("refuses a secret key and says why", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const l = createLoomail({ ...base, key: "mf_live_secret" });
    expect(l.active).toBe(false);
    l.identify("u");
    l.track("e");
    expect(calls).toHaveLength(0);
    expect(err).toHaveBeenCalledWith(expect.stringContaining("secret key"));
    err.mockRestore();
  });

  it("returns a client that does nothing when the key or address is missing or wrong", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const o of [{ key: "", endpoint: "https://x.test" }, { key: "mf_pub_a", endpoint: "" }, { key: "mf_pub_a", endpoint: "javascript:alert(1)" }, { key: "mf_pub_a", endpoint: "loomail.test" }]) {
      const l = createLoomail({ ...o, transport });
      expect(l.active).toBe(false);
      l.track("e");
    }
    expect(calls).toHaveLength(0);
    warn.mockRestore();
  });

  it("never throws, even when the transport does", () => {
    const l = createLoomail({
      ...base,
      storage: memoryStorage(),
      transport: () => {
        throw new Error("offline");
      },
    });
    expect(() => {
      l.identify("u");
      l.track("e");
      l.page();
      l.reset();
    }).not.toThrow();
  });

  it("the no-op client is inert", () => {
    const n = createNoopClient();
    n.identify("u");
    n.track("e");
    n.page();
    n.reset();
    n.optIn();
    n.optOut();
    n.start();
    n.stop();
    expect([n.userId(), n.anonymousId(), n.active, n.isOptedOut()]).toEqual([null, null, false, true]);
  });

  it("sends with sendBeacon when it is there, and fetch with keepalive when it is not", () => {
    const beacon = vi.fn(() => true);
    const f = vi.fn(() => Promise.resolve(new Response("{}")));
    vi.stubGlobal("fetch", f);
    Object.defineProperty(navigator, "sendBeacon", { value: beacon, configurable: true });
    const l = createLoomail({ key: "mf_pub_a", endpoint: "https://loomail.test", storage: memoryStorage() });
    l.identify("u1");
    expect(beacon).toHaveBeenCalledWith("https://loomail.test/v1/identify", expect.stringContaining('"userId":"u1"'));
    expect(f).not.toHaveBeenCalled();
    Object.defineProperty(navigator, "sendBeacon", { value: () => false, configurable: true });
    l.track("e");
    expect(f).toHaveBeenCalledTimes(1);
    const init = (f.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init).toMatchObject({ method: "POST", keepalive: true, headers: { "Content-Type": "text/plain" } });
    vi.unstubAllGlobals();
    Reflect.deleteProperty(navigator, "sendBeacon");
  });
});
