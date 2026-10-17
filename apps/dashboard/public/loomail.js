/*
 * Loomail browser snippet.
 *
 * Dependency-free event sender. Paste-safe: designed to be dropped into a
 * plain HTML page with no build step.
 *
 * Guarantees:
 * - Load order independent. Calls made before this file executes are queued
 *   by the two-line stub (window.loomail function with a .q array) and
 *   replayed here once the real implementation loads.
 * - Survives page unload. Sends use navigator.sendBeacon when available,
 *   falling back to fetch with keepalive.
 * - Never breaks the host page. Every public path is wrapped in try/catch
 *   and network failures are swallowed.
 * - No preflight. Payloads POST as text/plain with the key in the body,
 *   which is a CORS-simple request, so browsers send no OPTIONS preflight.
 * - Remembers the visitor. The identified user and an anonymous id live in
 *   localStorage (in memory when storage is blocked), so identify() does not
 *   have to run on every page load.
 *
 * Anonymous visitors:
 *   Loomail contacts need a userId, so an anonymous visitor is NOT sent to the
 *   server. track() and page() before identify() are held in the browser (up
 *   to MAX_BUFFER events, for MAX_AGE_MS) and sent under the real userId, with
 *   their original timestamps, the moment identify() runs. Visitors who never
 *   identify cost nothing and create no contacts. Events older than the
 *   server's clock-skew window would be re-dated, so they are dropped here.
 *
 *   Opt in with init(..., { anonymousTracking: true }) to send them to the server instead: they are stored
 *   against the anonymous id (capped per visitor, deleted after 30 days if the visitor never identifies) and
 *   moved onto the contact when identify() runs, with no 48-hour or 50-event limit. This keeps data about
 *   visitors who never sign up, so turn it on only where your privacy notice and consent setup allow it.
 *
 * Usage:
 *   <script>
 *     window.loomail = window.loomail || function () {
 *       (window.loomail.q = window.loomail.q || []).push(arguments);
 *     };
 *   </script>
 *   <script async src="https://YOUR_LOOMAIL_HOST/loomail.js"></script>
 *   <script>
 *     loomail("init", "mf_pub_...", { endpoint: "https://YOUR_LOOMAIL_HOST", autoPage: true });
 *     loomail("identify", "user_123", { email: "user@example.com" });   // when the person signs up or logs in
 *     loomail("track", "signed_up", { plan: "trial" });
 *     loomail("page");                                                  // a page view (autoPage does this on load)
 *     loomail("reset");                                                 // on logout
 *   </script>
 *
 * After identify(userId), track(event, properties) reuses that userId, also on
 * later page loads. The explicit form track(userId, event, properties) is also
 * accepted.
 */
(function () {
  "use strict";

  var STORAGE_KEY = "loomail:v1";
  var MAX_BUFFER = 50;
  // The server re-dates events more than 72h from its own clock; stay well inside that.
  var MAX_AGE_MS = 48 * 60 * 60 * 1000;
  var PAGE_EVENT = "page_viewed";

  var state = {
    key: null,
    endpoint: null,
    ready: false,
    anonymousTracking: false,
  };

  // ---------------------------------------------------------------------
  // Persistence: { aid: anonymousId, uid: userId|null, buf: [events] }
  // ---------------------------------------------------------------------

  var memory = null; // used when localStorage is unavailable or throws

  function newId() {
    try {
      var c = window.crypto;
      if (c && typeof c.randomUUID === "function") return c.randomUUID();
      if (c && typeof c.getRandomValues === "function") {
        var a = new Uint8Array(16);
        c.getRandomValues(a);
        var s = "";
        for (var i = 0; i < a.length; i++) s += (a[i] < 16 ? "0" : "") + a[i].toString(16);
        return s;
      }
    } catch (e) {
      /* fall through */
    }
    return (
      Date.now().toString(16) +
      Math.random().toString(16).slice(2) +
      Math.random().toString(16).slice(2)
    );
  }

  function load() {
    var raw = null;
    try {
      raw = window.localStorage.getItem(STORAGE_KEY);
    } catch (e) {
      raw = null;
    }
    var data = null;
    try {
      data = raw ? JSON.parse(raw) : memory;
    } catch (e) {
      data = null;
    }
    if (!data || typeof data !== "object") data = {};
    if (typeof data.aid !== "string" || !data.aid) data.aid = newId();
    if (typeof data.uid !== "string" || !data.uid) data.uid = null;
    if (!Array.isArray(data.buf)) data.buf = [];
    return data;
  }

  function save(data) {
    memory = data;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (e) {
      /* storage blocked or full: the in-memory copy still works for this page */
    }
  }

  // ---------------------------------------------------------------------
  // Transport
  // ---------------------------------------------------------------------

  function send(path, payload) {
    if (!state.ready) return;
    try {
      payload.key = state.key;
      var body = JSON.stringify(payload);
      var url = state.endpoint + path;
      // sendBeacon with a plain string posts Content-Type: text/plain,
      // which keeps the request CORS-simple (no preflight).
      if (
        typeof navigator !== "undefined" &&
        typeof navigator.sendBeacon === "function" &&
        navigator.sendBeacon(url, body)
      ) {
        return;
      }
      if (typeof fetch === "function") {
        fetch(url, {
          method: "POST",
          headers: { "Content-Type": "text/plain" },
          body: body,
          keepalive: true,
        }).catch(function () {});
      }
    } catch (e) {
      /* never break the host page */
    }
  }

  function sendTrack(userId, anonymousId, event, properties, timestamp, messageId) {
    var payload = {
      userId: userId,
      event: event,
      properties: properties || {},
      context: { anonymousId: anonymousId },
    };
    if (timestamp) payload.timestamp = timestamp;
    if (messageId) payload.messageId = messageId;
    send("/v1/track", payload);
  }

  function sendAnonymous(anonymousId, event, properties) {
    send("/v1/track", {
      anonymousId: anonymousId,
      event: event,
      properties: properties || {},
      context: { anonymousId: anonymousId },
      timestamp: new Date().toISOString(),
      messageId: "anon:" + newId(),
    });
  }

  // ---------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------

  function record(data, event, properties) {
    if (typeof event !== "string" || !event) return;
    if (data.uid) {
      sendTrack(data.uid, data.aid, event, properties);
      return;
    }
    // Anonymous, server mode: the server keeps it until identify() says who this is.
    if (state.anonymousTracking) {
      save(data); // keeps the anonymous id: load() makes a new one if it was never stored
      sendAnonymous(data.aid, event, properties);
      return;
    }
    // Anonymous: hold it until identify() tells us who this is.
    var now = Date.now();
    data.buf = data.buf.filter(function (e) {
      return now - e.t < MAX_AGE_MS;
    });
    data.buf.push({ e: event, p: properties || {}, t: now, m: "anon:" + newId() });
    if (data.buf.length > MAX_BUFFER) data.buf = data.buf.slice(-MAX_BUFFER);
    save(data);
  }

  function pageProperties(extra) {
    var props = {};
    try {
      var loc = window.location;
      var doc = window.document;
      if (loc) {
        props.url = String(loc.href || "");
        props.path = String(loc.pathname || "");
        props.search = String(loc.search || "");
      }
      if (doc) {
        props.title = String(doc.title || "");
        props.referrer = String(doc.referrer || "");
      }
    } catch (e) {
      /* page details are best effort */
    }
    if (extra && typeof extra === "object") {
      for (var k in extra) {
        if (Object.prototype.hasOwnProperty.call(extra, k)) props[k] = extra[k];
      }
    }
    return props;
  }

  function identify(userId, traits) {
    if (typeof userId !== "string" || !userId) return;
    var data = load();
    data.uid = userId;
    var held = data.buf;
    data.buf = [];
    save(data);
    send("/v1/identify", { userId: userId, traits: traits || {}, context: { anonymousId: data.aid } });
    // Everything this browser did before it had a name now belongs to the person.
    var now = Date.now();
    for (var i = 0; i < held.length; i++) {
      var h = held[i];
      if (now - h.t >= MAX_AGE_MS) continue;
      sendTrack(userId, data.aid, h.e, h.p, new Date(h.t).toISOString(), h.m);
    }
  }

  function reset() {
    // On logout: forget the person and become a new anonymous visitor.
    save({ aid: newId(), uid: null, buf: [] });
  }

  function handle(args) {
    try {
      var method = args[0];
      if (method === "init") {
        state.key = args[1] || null;
        var opts = args[2] || {};
        state.endpoint = String(opts.endpoint || "").replace(/\/+$/, "");
        state.ready = !!(state.key && state.endpoint);
        state.anonymousTracking = opts.anonymousTracking === true;
        if (state.ready && opts.autoPage) record(load(), PAGE_EVENT, pageProperties());
        return;
      }
      if (!state.ready) return;
      if (method === "identify") {
        identify(args[1], args[2]);
      } else if (method === "track") {
        var data = load();
        var event, properties;
        if (typeof args[2] === "string") {
          // track(userId, event, properties)
          if (typeof args[1] !== "string" || !args[1]) return;
          if (data.uid !== args[1]) {
            data.uid = args[1];
            save(data);
          }
          event = args[2];
          properties = args[3];
        } else {
          // track(event, properties) - reuses the identified user, or holds the event while anonymous
          event = args[1];
          properties = args[2];
        }
        record(data, event, properties);
      } else if (method === "page") {
        // page(), page(name), page(properties) or page(name, properties)
        var name = typeof args[1] === "string" ? args[1] : null;
        var extra = name !== null ? args[2] : args[1];
        var pageProps = pageProperties(extra);
        if (name) pageProps.name = name;
        record(load(), PAGE_EVENT, pageProps);
      } else if (method === "reset") {
        reset();
      }
    } catch (e) {
      /* never break the host page */
    }
  }

  function loomail() {
    handle(arguments);
  }

  // Replay anything queued by the pre-load stub.
  var prior = window.loomail;
  var queued = prior && prior.q ? prior.q : [];
  loomail.q = [];
  window.loomail = loomail;
  for (var i = 0; i < queued.length; i++) {
    handle(queued[i]);
  }
})();
