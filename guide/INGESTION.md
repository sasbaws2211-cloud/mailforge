# Ingestion: Sending Events to Mailforge

> Audience: anyone integrating a product with a Mailforge install. Everything on
> this page is copy-paste runnable. Replace `https://YOUR_MAILFORGE_HOST` with
> your install's base URL (`http://localhost:3000` in the default compose
> setup) and the example keys with your own.

## What "Segment-compatible" means here

Mailforge accepts the Segment wire format for `track` and `identify`, single
calls and `/v1/batch`, with `messageId` (server-side dedup), `timestamp`
(clamped to +/- 72 hours of server time), `traits` (shallow merge on
identify; explicit `null` clears a trait), and `properties`.

Not supported: `page`, `screen`, `group`, `alias`, and anonymous-only events
(every call needs a `userId`; items without one are rejected with a per-item
error in batches). This is a deliberate scope line: Mailforge acts on product
lifecycle events, not web analytics.

## Keys

Two kinds, created in the dashboard under **Integrate** (or via the API,
below):

- **Publishable** (`mf_pub_...`): safe to paste into a web page. It can write
  events and nothing else - there is no key-authenticated read endpoint at
  all. Optional origin allowlist; rate limited to 300 requests/minute.
- **Secret** (`mf_live_...`): your backend. Never put it in browser code,
  a mobile app, or a public repo. Rate limited to 3000 requests/minute.

Raw keys are shown once at creation. Only a SHA-256 hash is stored. Revoking
a key takes effect immediately.

## 1. curl

```bash
curl -X POST https://YOUR_MAILFORGE_HOST/v1/identify \
  -H "Authorization: Bearer mf_live_YOUR_SECRET_KEY" \
  -H "Content-Type: application/json" \
  -d '{"userId": "user_123", "traits": {"email": "user@example.com", "plan": "trial"}}'

curl -X POST https://YOUR_MAILFORGE_HOST/v1/track \
  -H "Authorization: Bearer mf_live_YOUR_SECRET_KEY" \
  -H "Content-Type: application/json" \
  -d '{"userId": "user_123", "event": "signed_up", "messageId": "optional-dedup-key"}'
```

## 2. The browser snippet

Served by your own install at `/mailforge.js`. Paste before `</body>`:

```html
<script>
  window.mailforge = window.mailforge || function () {
    (window.mailforge.q = window.mailforge.q || []).push(arguments);
  };
</script>
<script async src="https://YOUR_MAILFORGE_HOST/mailforge.js"></script>
<script>
  mailforge("init", "mf_pub_YOUR_PUBLISHABLE_KEY", { endpoint: "https://YOUR_MAILFORGE_HOST" });
  mailforge("identify", "user_123", { email: "user@example.com" });
  mailforge("track", "signed_up", { plan: "trial" });
</script>
```

Properties worth knowing:

- **No build step, no dependencies.** The file is ~2 KB minified (~1 KB gzipped).
- **Load-order independent.** The two-line stub queues calls made before
  `mailforge.js` arrives; the snippet replays them when it loads.
- **No CORS preflight.** Payloads go out as `text/plain` with the key in the
  body, which is a CORS-simple request. Nothing triggers an OPTIONS round
  trip. (`Authorization: Bearer` + `application/json` also works and is what
  server-side clients use; browsers just pay one preflight for it.)
- **Survives page unload.** Sends via `navigator.sendBeacon`, falling back
  to `fetch(..., { keepalive: true })`.
- **Never breaks your page.** Every code path is wrapped; a down or
  misconfigured Mailforge is invisible to your users.
- After `identify(userId)`, `track(event, properties)` reuses that user.
  The explicit form `track(userId, event, properties)` also works.

### Origin allowlist (optional)

On the Integrate screen, each publishable key can list allowed origins (one
per line, e.g. `https://app.example.com`). Browsers on other origins get 403
with no CORS headers, so the request fails closed. Leave the list empty to
allow any origin - still safe in the write-only sense; the allowlist is
abuse friction, not the trust boundary.

## 3. Server-side (Node, no SDK)

Any HTTP client works. Node 18+:

```javascript
const MAILFORGE = "https://YOUR_MAILFORGE_HOST";
const KEY = "mf_live_YOUR_SECRET_KEY";

async function track(userId, event, properties = {}) {
  const res = await fetch(`${MAILFORGE}/v1/track`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ userId, event, properties }),
  });
  if (!res.ok) throw new Error(`mailforge track failed: ${res.status}`);
}

await track("user_123", "invoice_paid", { amount: 4900 });
```

The same shape works from Python (`requests`), Go (`net/http`), Ruby, or
anything else that can POST JSON with a header. We deliberately do not ship
first-party server SDKs yet: the endpoint is the SDK.

## 4. Pointing an existing Segment SDK at Mailforge

If you already have Segment instrumentation, you can dual-send or migrate
without touching your event calls.

**@segment/analytics-node** posts batches to `{host}{path}` and
authenticates with the write key as the HTTP Basic username, both of which
Mailforge understands:

```javascript
const { Analytics } = require("@segment/analytics-node");

const analytics = new Analytics({
  writeKey: "mf_live_YOUR_SECRET_KEY",
  host: "https://YOUR_MAILFORGE_HOST",  // path defaults to /v1/batch
  flushAt: 20,                        // batching works; /v1/batch is supported
  maxRetries: 3,
});

analytics.identify({ userId: "user_123", traits: { email: "user@example.com" } });
analytics.track({ userId: "user_123", event: "signed_up" });
await analytics.flush({ close: true });
```

Notes:

- Events with only an `anonymousId` are rejected (`userId` required); they
  appear as per-item errors in the batch response, not as silent drops.
- `page`/`screen`/`group`/`alias` calls have no endpoint here. Do not set
  `path` to anything but `/v1/batch`.
- Payload caps: 100 items and 512 KB per batch request. Segment's own limits
  (32 KB per call, 500 KB per batch) are tighter than ours, so traffic that
  Segment accepted fits.

Other Segment server SDKs (Python, Go, Java, Ruby) expose the same
host/base-URL override and use the same Basic-auth convention; the same two
settings port them.

## 5. Google Tag Manager

GTM has no native Mailforge destination; use a Custom HTML tag:

1. In GTM: **Tags > New > Custom HTML**.
2. Paste the browser snippet from section 2 (the whole block, stubs and
   all), with your publishable key.
3. Trigger: **All Pages** (plus any event triggers you want `track` calls
   bound to).
4. For event-level calls, fire additional Custom HTML tags on your GTM
   events, e.g. `<script>mailforge("track", "signup_completed")</script>`.

Because the snippet queues calls made before `mailforge.js` loads, GTM's async
container loading cannot race it.

## 6. Dual-sending alongside an existing Segment install

Keep Segment exactly as it is and add Mailforge as a second sink:

- **Server-side:** instantiate a second `Analytics` client pointed at
  Mailforge (section 4) next to your existing one, and call both. Or add a
  three-line forwarder in front of your current `analytics.track` call
  sites using the plain-fetch helper in section 3.
- **Browser:** load the Mailforge snippet (section 2) next to Segment's
  analytics.js and call both. There is no conflict; the two libraries share
  nothing.
- **Via Segment itself:** in the Segment dashboard, add a **Webhook
  destination** on your source pointing at
  `https://YOUR_MAILFORGE_HOST/v1/batch` with the secret key as an
  `Authorization: Bearer` header. Every event Segment receives is forwarded
  to Mailforge. (This is the zero-code option; it depends on Segment's webhook
  retry behavior for delivery guarantees.)

## What the AI sees of the data you send

AI-drafted emails use only a few of the things you send, so it pays to send them in the right fields:

- `identify` with `traits.email`, `traits.name` (the full name), and `traits.company`. These are stored on the contact and shown to the AI. A trait called `first_name` is kept on the contact but the AI does not see it.
- `traits.plan` is the **name of the plan**, for example `"Growth"`. It is stored on the contact and shown to the AI as the contact's plan. The five payment-status words are the exception: `plan: "paid"` (or `free`, `trial`, `past_due`, `cancelled`) sets the contact's payment status, as `traits.payment_status` does, and is not kept as a plan name. To set both, send both: `{ "payment_status": "paid", "plan": "Growth" }`. Send `plan: null` to remove the plan name (the payment status is left as it is).
- `traits.payment_status` is only ever a **status**, one of `free`, `trial`, `paid`, `past_due`, `cancelled`. Any other value (a plan name, say) is refused and recorded as a conflict, and the status is left unchanged.
- Every other trait is stored on the contact, but only used by your own fixed templates.
- **Event properties are not shown to the AI**, only the event name. Use properties for your own analytics and for fixed templates.

How to write prompts around this is in [FLOW-PROMPTS.md](./FLOW-PROMPTS.md#what-the-ai-can-see-when-it-writes-each-email).

## 7. Verifying your integration

Open **Integrate** in the dashboard. The "Your first event" panel polls
every few seconds: it shows a waiting state until the first event lands,
then flips to the event type, event name, user, and receipt time, plus a
count of the last 24 hours. If it does not flip within a few seconds of
sending, check (in order): the key is not revoked, the origin is allowlisted
(if you set one), you are within the rate limit, and the host URL is
reachable from where the event was sent.

## Rate limits and error responses

| Limit | Value |
|---|---|
| Publishable key | 300 requests/minute |
| Secret key | 3000 requests/minute |
| Batch size | 100 items / 512 KB |

Over-limit requests get `429` with a `Retry-After` (seconds) header. The
limiter is a fixed one-minute window per key, enforced per API process; in
the default single-container community install that is the whole system.
