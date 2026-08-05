/*
 * Claros browser snippet.
 *
 * Dependency-free event sender. Paste-safe: designed to be dropped into a
 * plain HTML page with no build step.
 *
 * Guarantees:
 * - Load order independent. Calls made before this file executes are queued
 *   by the two-line stub (window.claros function with a .q array) and
 *   replayed here once the real implementation loads.
 * - Survives page unload. Sends use navigator.sendBeacon when available,
 *   falling back to fetch with keepalive.
 * - Never breaks the host page. Every public path is wrapped in try/catch
 *   and network failures are swallowed.
 * - No preflight. Payloads POST as text/plain with the key in the body,
 *   which is a CORS-simple request, so browsers send no OPTIONS preflight.
 *
 * Usage:
 *   <script>
 *     window.claros = window.claros || function () {
 *       (window.claros.q = window.claros.q || []).push(arguments);
 *     };
 *   </script>
 *   <script async src="https://YOUR_CLAROS_HOST/claros.js"></script>
 *   <script>
 *     claros("init", "cl_pub_...", { endpoint: "https://YOUR_CLAROS_HOST" });
 *     claros("identify", "user_123", { email: "user@example.com" });
 *     claros("track", "signed_up", { plan: "trial" });
 *   </script>
 *
 * After identify(userId), track(event, properties) reuses that userId.
 * The explicit form track(userId, event, properties) is also accepted.
 */
(function () {
  "use strict";

  var state = {
    key: null,
    endpoint: null,
    userId: null,
    ready: false,
  };

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

  function handle(args) {
    try {
      var method = args[0];
      if (method === "init") {
        state.key = args[1] || null;
        var opts = args[2] || {};
        state.endpoint = String(opts.endpoint || "").replace(/\/+$/, "");
        state.ready = !!(state.key && state.endpoint);
      } else if (method === "identify") {
        var userId = args[1];
        if (typeof userId !== "string" || !userId) return;
        state.userId = userId;
        send("/v1/identify", { userId: userId, traits: args[2] || {} });
      } else if (method === "track") {
        var event, properties;
        if (typeof args[2] === "string") {
          // track(userId, event, properties)
          state.userId = args[1];
          event = args[2];
          properties = args[3];
        } else {
          // track(event, properties) - reuses the identified user
          event = args[1];
          properties = args[2];
        }
        if (typeof state.userId !== "string" || !state.userId) return;
        if (typeof event !== "string" || !event) return;
        send("/v1/track", {
          userId: state.userId,
          event: event,
          properties: properties || {},
        });
      }
    } catch (e) {
      /* never break the host page */
    }
  }

  function claros() {
    handle(arguments);
  }

  // Replay anything queued by the pre-load stub.
  var prior = window.claros;
  var queued = prior && prior.q ? prior.q : [];
  claros.q = [];
  window.claros = claros;
  for (var i = 0; i < queued.length; i++) {
    handle(queued[i]);
  }
})();
