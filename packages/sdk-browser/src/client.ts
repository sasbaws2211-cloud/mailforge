/**
 * Loomail browser client.
 *
 * The same behaviour as the hosted /loomail.js snippet, as an importable module for apps built with a bundler
 * (React, Next.js, Vue, Nuxt, Svelte, Angular, plain TypeScript):
 *
 * - Never breaks the host app. Every public call is wrapped; network failures are swallowed.
 * - Safe to import and create on the server (server-side rendering): without a browser it does nothing.
 * - No preflight. Payloads POST as text/plain with the publishable key in the body (a CORS-simple request), using
 *   navigator.sendBeacon when it can and fetch with keepalive otherwise, so events survive a page unload.
 * - Remembers the visitor in localStorage (in memory when storage is blocked). Same storage key and shape as the
 *   snippet, so a page may use both and they agree about who the visitor is.
 * - Anonymous visitors are held in the browser (up to 50 events, 48 hours) and sent under the real user id, with their
 *   original times, when identify() runs. With anonymousTracking they are sent to the server instead.
 * - Single-page apps: with autoPage it records a page view on start and on every client-side route change (history
 *   pushState / replaceState and back/forward), once per address.
 * - Consent: startOptedOut keeps everything off (nothing sent, nothing stored) until optIn(); optOut() forgets the visitor.
 * - A secret key (mf_live_...) is refused: it must never be in browser code.
 *
 * Mirror side: PUBLIC (packages/sdk-browser is mirrored).
 */

export type TraitValue = string | number | boolean | null;
export type Traits = Record<string, TraitValue>;
export type Properties = Record<string, unknown>;

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** How a payload leaves the page. Replace it in tests; the default uses sendBeacon, then fetch. */
export type Transport = (url: string, body: string) => void;

export interface LoomailOptions {
  /** Publishable key (mf_pub_...). Safe in a web page: it can write events and nothing else. */
  key: string;
  /** Your Loomail host, such as https://loomail.example.com */
  endpoint: string;
  /** Record a page view when the client starts and on every client-side route change. Default false. */
  autoPage?: boolean;
  /** With autoPage: follow client-side route changes (single-page apps). Default true. */
  trackRouteChanges?: boolean;
  /**
   * How long (ms) the page title must stop changing before a page view is recorded. Most apps set the title after the
   * route renders (Angular, React effects, Next.js clear and refill it), so recording at once would carry the previous
   * page's title. This applies to the first page view and to every route change; a redirect chain is recorded once, at
   * its end. Gives up waiting after one second. Default 100.
   */
  routeSettleMs?: number;
  /** Send events from visitors who have not identified to the server instead of holding them in the browser. Default false. */
  anonymousTracking?: boolean;
  /** Send and store nothing until optIn() is called. Use with a consent banner. Default false. */
  startOptedOut?: boolean;
  /** Where the visitor is remembered. Default window.localStorage; null keeps it in memory only. */
  storage?: StorageLike | null;
  /** Begin autoPage tracking as soon as the client is created. Default true. The React and Vue helpers turn it off and start the client from their own lifecycle. */
  autoStart?: boolean;
  /** Replaces the network call (tests). */
  transport?: Transport;
}

export interface LoomailClient {
  /** Say who this visitor is. Events held while they were anonymous are sent with it. Call it when they sign up or log in. */
  identify(userId: string, traits?: Traits): void;
  /** Record something the visitor did. Uses the identified user, or holds the event while anonymous. */
  track(event: string, properties?: Properties): void;
  /** Record a page view: page(), page(name), page(properties) or page(name, properties). */
  page(nameOrProperties?: string | Properties, properties?: Properties): void;
  /** Forget the person (on logout): the next visitor on this browser starts anonymous. */
  reset(): void;
  /** Start sending again after startOptedOut or optOut(). */
  optIn(): void;
  /** Stop sending, and forget the stored visitor and anything held. */
  optOut(): void;
  isOptedOut(): boolean;
  /** Begin autoPage tracking (done for you by createLoomail in a browser). Safe to call twice. */
  start(): void;
  /** Stop listening for route changes. The client can be started again. */
  stop(): void;
  /** The identified user id, or null. */
  userId(): string | null;
  /** The anonymous id of this browser. */
  anonymousId(): string | null;
  /** False for the do-nothing client returned on the server or when the options were unusable. */
  readonly active: boolean;
}

const STORAGE_KEY = "loomail:v1";
const MAX_BUFFER = 50;
// The server re-dates events more than 72h from its own clock; stay well inside that.
const MAX_AGE_MS = 48 * 60 * 60 * 1000;
const PAGE_EVENT = "page_viewed";

interface Stored {
  aid: string;
  uid: string | null;
  buf: Array<{ e: string; p: Properties; t: number; m: string }>;
}

const inBrowser = () => typeof window !== "undefined" && typeof window.document !== "undefined";

function newId(): string {
  try {
    const c = typeof crypto !== "undefined" ? crypto : undefined;
    if (c && typeof c.randomUUID === "function") return c.randomUUID();
    if (c && typeof c.getRandomValues === "function") {
      const a = new Uint8Array(16);
      c.getRandomValues(a);
      return Array.from(a, (b) => (b < 16 ? "0" : "") + b.toString(16)).join("");
    }
  } catch {
    /* fall through */
  }
  return Date.now().toString(16) + Math.random().toString(16).slice(2) + Math.random().toString(16).slice(2);
}

function defaultTransport(url: string, body: string): void {
  try {
    // A plain string posts as text/plain, which keeps the request CORS-simple (no preflight).
    if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function" && navigator.sendBeacon(url, body)) return;
    if (typeof fetch === "function") {
      void fetch(url, { method: "POST", headers: { "Content-Type": "text/plain" }, body, keepalive: true }).catch(() => {});
    }
  } catch {
    /* never break the host app */
  }
}

/** A client that does nothing, for the server and for unusable options. */
export function createNoopClient(): LoomailClient {
  return {
    identify() {},
    track() {},
    page() {},
    reset() {},
    optIn() {},
    optOut() {},
    isOptedOut: () => true,
    start() {},
    stop() {},
    userId: () => null,
    anonymousId: () => null,
    active: false,
  };
}

export function createLoomail(options: LoomailOptions): LoomailClient {
  const key = typeof options?.key === "string" ? options.key.trim() : "";
  const endpoint = typeof options?.endpoint === "string" ? options.endpoint.trim().replace(/\/+$/, "") : "";

  if (key.startsWith("mf_live_")) {
    // eslint-disable-next-line no-console
    console.error("[loomail] That is a secret key (mf_live_...). It must never be in browser code. Use a publishable key (mf_pub_...). Nothing will be sent.");
    return createNoopClient();
  }
  if (!key || !/^https?:\/\//i.test(endpoint)) {
    if (inBrowser()) {
      // eslint-disable-next-line no-console
      console.warn("[loomail] Needs a publishable key and your Loomail address (https://...). Nothing will be sent.");
    }
    return createNoopClient();
  }
  // Server-side rendering: nothing to remember, nothing to send. The client is created again in the browser.
  if (!inBrowser() && !options.transport) return createNoopClient();

  const send = options.transport ?? defaultTransport;
  let optedOut = options.startOptedOut === true;
  let memory: Stored | null = null; // used when storage is unavailable or throws

  const storage = (): StorageLike | null => {
    if (options.storage !== undefined) return options.storage;
    try {
      return window.localStorage;
    } catch {
      return null;
    }
  };

  function load(): Stored {
    let raw: string | null = null;
    try {
      raw = storage()?.getItem(STORAGE_KEY) ?? null;
    } catch {
      raw = null; // storage blocked: fall back to the copy kept in memory
    }
    let data: unknown = null;
    try {
      data = raw ? JSON.parse(raw) : memory;
    } catch {
      data = null;
    }
    const d = (data && typeof data === "object" ? data : {}) as Partial<Stored>;
    return {
      aid: typeof d.aid === "string" && d.aid ? d.aid : newId(),
      uid: typeof d.uid === "string" && d.uid ? d.uid : null,
      buf: Array.isArray(d.buf) ? d.buf : [],
    };
  }

  function save(data: Stored): void {
    if (optedOut) return;
    memory = data;
    try {
      storage()?.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch {
      /* storage blocked or full: the in-memory copy still works for this page */
    }
  }

  function post(path: string, payload: Record<string, unknown>): void {
    if (optedOut) return;
    try {
      payload.key = key;
      send(endpoint + path, JSON.stringify(payload));
    } catch {
      /* never break the host app */
    }
  }

  function sendTrack(userId: string, anonymousId: string, event: string, properties: Properties | undefined, timestamp?: string, messageId?: string): void {
    post("/v1/track", {
      userId,
      event,
      properties: properties ?? {},
      context: { anonymousId },
      ...(timestamp ? { timestamp } : {}),
      ...(messageId ? { messageId } : {}),
    });
  }

  function record(data: Stored, event: string, properties?: Properties): void {
    if (typeof event !== "string" || !event) return;
    if (data.uid) {
      sendTrack(data.uid, data.aid, event, properties);
      return;
    }
    if (options.anonymousTracking === true) {
      save(data); // keeps the anonymous id
      post("/v1/track", {
        anonymousId: data.aid,
        event,
        properties: properties ?? {},
        context: { anonymousId: data.aid },
        timestamp: new Date().toISOString(),
        messageId: "anon:" + newId(),
      });
      return;
    }
    // Anonymous: hold it until identify() says who this is.
    const now = Date.now();
    data.buf = data.buf.filter((e) => now - e.t < MAX_AGE_MS);
    data.buf.push({ e: event, p: properties ?? {}, t: now, m: "anon:" + newId() });
    if (data.buf.length > MAX_BUFFER) data.buf = data.buf.slice(-MAX_BUFFER);
    save(data);
  }

  // ---------------------------------------------------------------------
  // Page views, including client-side route changes
  // ---------------------------------------------------------------------

  let lastPageKey: string | null = null;
  let lastPageUrl: string | null = null;
  let running = false;
  let teardown: Array<() => void> = [];

  function pageProps(extra?: Properties): Properties {
    const props: Properties = {};
    try {
      props.url = String(window.location.href || "");
      props.path = String(window.location.pathname || "");
      props.search = String(window.location.search || "");
      props.title = String(document.title || "");
      // After a client-side navigation document.referrer still names the first page; the previous address is the truth.
      props.referrer = lastPageUrl ?? String(document.referrer || "");
    } catch {
      /* page details are best effort */
    }
    if (extra && typeof extra === "object") Object.assign(props, extra);
    return props;
  }

  function pageView(extra?: Properties, name?: string | null): void {
    if (optedOut) return;
    const props = pageProps(extra);
    if (name) props.name = name;
    try {
      lastPageKey = window.location.pathname + window.location.search;
      lastPageUrl = window.location.href;
    } catch {
      /* ignore */
    }
    record(load(), PAGE_EVENT, props);
  }

  // Wait for the title to settle, then run fn. A new call replaces a pending one, so a redirect chain is one page view.
  const MAX_SETTLE_MS = 1000;
  let settleTimer: ReturnType<typeof setInterval> | null = null;
  const clearSettle = (): void => {
    if (settleTimer !== null) {
      clearInterval(settleTimer);
      settleTimer = null;
    }
  };
  const titleNow = (): string => {
    try {
      return String(document.title || "");
    } catch {
      return "";
    }
  };
  function whenSettled(fn: () => void): void {
    clearSettle();
    const settle = Math.max(0, options.routeSettleMs ?? 100);
    const step = Math.max(1, Math.min(25, settle));
    let last = titleNow();
    let stable = 0;
    let waited = 0;
    settleTimer = setInterval(() => {
      const now = titleNow();
      if (now !== last) {
        last = now;
        stable = 0;
      } else {
        stable += step;
      }
      waited += step;
      // An empty title is not a settled one (Next.js leaves it empty while it renders the next page), so keep waiting for
      // a real one, up to the limit. A page that really has no title costs one second.
      if ((stable >= settle && now !== "") || waited >= MAX_SETTLE_MS) {
        clearSettle();
        fn();
      }
    }, step);
  }

  const currentKey = (): string => {
    try {
      return window.location.pathname + window.location.search;
    } catch {
      return "";
    }
  };

  function routeChanged(): void {
    if (!running || optedOut) return;
    if (currentKey() !== lastPageKey) pageView();
  }

  function start(): void {
    if (running || !inBrowser() || options.autoPage !== true) return;
    running = true;
    // The first page view waits for the title to settle too (a repeat start, as in React strict mode, must not record the
    // same page twice, which the address check below also guards).
    whenSettled(() => {
      if (running && !optedOut && lastPageKey !== currentKey()) pageView();
    });
    if (options.trackRouteChanges === false) return;

    const later = () => whenSettled(routeChanged);
    const push = history.pushState;
    const replace = history.replaceState;
    const wrap = (orig: History["pushState"]): History["pushState"] =>
      function (this: History, ...args: Parameters<History["pushState"]>) {
        const r = orig.apply(this, args);
        if (running) later();
        return r;
      };
    const wrappedPush = wrap(push);
    const wrappedReplace = wrap(replace);
    history.pushState = wrappedPush;
    history.replaceState = wrappedReplace;
    window.addEventListener("popstate", later);
    teardown = [
      () => {
        // Only put the originals back if nobody patched on top of us; otherwise our wrappers simply go quiet.
        if (history.pushState === wrappedPush) history.pushState = push;
        if (history.replaceState === wrappedReplace) history.replaceState = replace;
        window.removeEventListener("popstate", later);
      },
    ];
  }

  function stop(): void {
    running = false;
    clearSettle();
    for (const t of teardown) t();
    teardown = [];
  }

  const client: LoomailClient = {
    identify(userId, traits) {
      try {
        if (optedOut || typeof userId !== "string" || !userId) return;
        const data = load();
        data.uid = userId;
        const held = data.buf;
        data.buf = [];
        save(data);
        post("/v1/identify", { userId, traits: traits ?? {}, context: { anonymousId: data.aid } });
        // Everything this browser did before it had a name now belongs to the person.
        const now = Date.now();
        for (const h of held) {
          if (now - h.t >= MAX_AGE_MS) continue;
          sendTrack(userId, data.aid, h.e, h.p, new Date(h.t).toISOString(), h.m);
        }
      } catch {
        /* never break the host app */
      }
    },
    track(event, properties) {
      try {
        if (optedOut) return;
        record(load(), event, properties);
      } catch {
        /* never break the host app */
      }
    },
    page(nameOrProperties, properties) {
      try {
        const name = typeof nameOrProperties === "string" ? nameOrProperties : null;
        const extra = name !== null ? properties : nameOrProperties;
        pageView(extra && typeof extra === "object" ? extra : undefined, name);
      } catch {
        /* never break the host app */
      }
    },
    reset() {
      try {
        if (optedOut) return;
        save({ aid: newId(), uid: null, buf: [] });
      } catch {
        /* never break the host app */
      }
    },
    optIn() {
      if (!optedOut) return;
      optedOut = false;
      if (running) {
        // Started while opted out: the page the visitor is on has not been recorded yet.
        if (options.autoPage === true && lastPageKey === null) pageView();
      } else if (options.autoStart !== false) {
        start();
      }
    },
    optOut() {
      optedOut = true;
      clearSettle();
      memory = null;
      lastPageKey = null;
      lastPageUrl = null;
      try {
        storage()?.removeItem(STORAGE_KEY);
      } catch {
        /* ignore */
      }
    },
    isOptedOut: () => optedOut,
    start,
    stop,
    userId: () => (optedOut ? null : load().uid),
    anonymousId: () => (optedOut ? null : load().aid),
    active: true,
  };

  // In a plain app, creating the client is enough. React and Vue helpers start it from their own lifecycle instead.
  if (inBrowser() && options.autoStart !== false) start();
  return client;
}
