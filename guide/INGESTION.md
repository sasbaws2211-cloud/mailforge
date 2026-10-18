# Ingestion: Sending Events to Loomail

> Audience: anyone integrating a product with a Loomail install. Everything on
> this page is copy-paste runnable. Replace `https://YOUR_LOOMAIL_HOST` with
> your install's base URL (`http://localhost:3000` in the default compose
> setup) and the example keys with your own.

## What "Segment-compatible" means here

Loomail accepts the Segment wire format for `track` and `identify`, single
calls and `/v1/batch`, with `messageId` (server-side dedup), `timestamp`
(clamped to +/- 72 hours of server time), `traits` (shallow merge on
identify; explicit `null` clears a trait), and `properties`.

Not supported: `page`, `screen`, `group` and `alias`. A `track` call may have
an `anonymousId` instead of a `userId` (see "Anonymous visitors" below);
`identify` always needs a `userId`. Loomail acts on product lifecycle events,
not web analytics.

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
curl -X POST https://YOUR_LOOMAIL_HOST/v1/identify \
  -H "Authorization: Bearer mf_live_YOUR_SECRET_KEY" \
  -H "Content-Type: application/json" \
  -d '{"userId": "user_123", "traits": {"email": "user@example.com", "plan": "trial"}}'

curl -X POST https://YOUR_LOOMAIL_HOST/v1/track \
  -H "Authorization: Bearer mf_live_YOUR_SECRET_KEY" \
  -H "Content-Type: application/json" \
  -d '{"userId": "user_123", "event": "signed_up", "messageId": "optional-dedup-key"}'
```

## 2. The browser snippet

Served by your own install at `/loomail.js`. Paste before `</body>`:

```html
<script>
  window.loomail = window.loomail || function () {
    (window.loomail.q = window.loomail.q || []).push(arguments);
  };
</script>
<script async src="https://YOUR_LOOMAIL_HOST/loomail.js"></script>
<script>
  loomail("init", "mf_pub_YOUR_PUBLISHABLE_KEY", { endpoint: "https://YOUR_LOOMAIL_HOST", autoPage: true });
  // when someone signs up or logs in:
  loomail("identify", "user_123", { email: "user@example.com" });
  loomail("track", "signed_up", { plan: "trial" });
  // when they log out:
  // loomail("reset");
</script>
```

Calls: `init`, `identify(userId, traits)`, `track(event, properties)`, `page([name], [properties])`
(sends a `page_viewed` event; `autoPage: true` does one on load, call it yourself on
route changes in a single-page app), and `reset()`.

### Anonymous visitors and remembering people

By default an anonymous visitor is never sent to the server.
The snippet keeps their `track`/`page` calls in the browser's localStorage (up to
50 events, up to 48 hours old) and, the moment you call `identify`, sends them under the
real `userId` with their original timestamps. Visitors who never sign up cost nothing and
create no contacts. The snippet also remembers the identified user across page loads, so
`identify` does not have to run on every page; call `reset()` on logout so the next person
on that browser starts clean.

Limits: this is per browser. A visitor who browses on one device and signs up on another
is not stitched, and events older than 48 hours are dropped rather than re-dated by the
server's clock-skew clamp. If localStorage is blocked, the snippet works for the life of
the page only. Every call also carries a stable `context.anonymousId`.

#### Server-side anonymous tracking (opt-in)

To lift those limits, turn on `anonymousTracking`:

```js
loomail("init", "mf_pub_YOUR_PUBLISHABLE_KEY", { endpoint: "https://YOUR_LOOMAIL_HOST", anonymousTracking: true });
```

The snippet then sends `track` and `page` calls from a visitor who has not been identified straight to
Loomail, keyed by the visitor's `anonymousId`. No contact is created. When you call
`loomail("identify", userId, traits)`, the identify carries the same `anonymousId`, and everything stored for that
visitor moves onto the contact with its original timestamps, with no 48-hour or 50-event limit. After that,
calls from the same browser go straight to the contact until `reset()` starts a new anonymous visitor.

You can do the same from any client with the HTTP API:

```bash
# before sign-up: a visitor you cannot name yet
curl -X POST https://YOUR_LOOMAIL_HOST/v1/track   -H "Authorization: Bearer mf_live_YOUR_SECRET_KEY" -H "Content-Type: application/json"   -d '{"anonymousId": "a1b2c3", "event": "viewed_pricing", "properties": {"plan": "pro"}}'

# at sign-up: say who that visitor turned out to be
curl -X POST https://YOUR_LOOMAIL_HOST/v1/identify   -H "Authorization: Bearer mf_live_YOUR_SECRET_KEY" -H "Content-Type: application/json"   -d '{"userId": "user_123", "anonymousId": "a1b2c3", "traits": {"email": "user@example.com"}}'
```

`anonymousId` may be sent at the top level or as `context.anonymousId`. Limits and behaviour:

- At most 100 events are kept per visitor; later ones are dropped until they identify.
- Events from visitors who never identify are deleted after 30 days. The link from an anonymous id to a contact
  is kept 90 days.
- Moved events behave like any other event: they can move the contact's lifecycle state and trigger flows.
- Merging is by `anonymousId` per workspace and happens on `identify` only. A visitor on two devices has two
  anonymous ids and is joined when each device identifies.
- If the same browser identifies as a second person without `reset()`, later events belong to the second person;
  history already moved stays with the first.
- This stores data about visitors who never sign up. Turn it on only where your privacy notice and consent setup
  allow it.

Properties worth knowing:

- **No build step, no dependencies.** Roughly 3 KB gzipped as served.
- **Load-order independent.** The two-line stub queues calls made before
  `loomail.js` arrives; the snippet replays them when it loads.
- **No CORS preflight.** Payloads go out as `text/plain` with the key in the
  body, which is a CORS-simple request. Nothing triggers an OPTIONS round
  trip. (`Authorization: Bearer` + `application/json` also works and is what
  server-side clients use; browsers just pay one preflight for it.)
- **Survives page unload.** Sends via `navigator.sendBeacon`, falling back
  to `fetch(..., { keepalive: true })`.
- **Never breaks your page.** Every code path is wrapped; a down or
  misconfigured Loomail is invisible to your users.
- After `identify(userId)`, `track(event, properties)` reuses that user.
  The explicit form `track(userId, event, properties)` also works.

### Origin allowlist (optional)

On the Integrate screen, each publishable key can list allowed origins (one
per line, e.g. `https://app.example.com`). Browsers on other origins get 403
with no CORS headers, so the request fails closed. Leave the list empty to
allow any origin - still safe in the write-only sense; the allowlist is
abuse friction, not the trust boundary.

## 2b. React, Next.js, Vue and other frameworks

For an app built with a bundler, use the `@loomail/browser` package instead of the script tag. It does what the snippet does (anonymous visitors, `identify`, `reset`, the same storage, a publishable key) and adds:

- **Page views on route changes.** A single-page app never reloads, so `autoPage` in the snippet records only the first page. The package follows the History API, which every client-side router uses (React Router, Next.js, Vue Router, Nuxt, SvelteKit, Angular), and records one page view per new address with the page title set after the route has rendered.
- **A React provider and hook**, a **Vue plugin**, and a plain `createLoomail()` for everything else. Next.js is supported in the app and pages routers; rendering on the server does nothing.
- **Consent:** `startOptedOut` and `optIn()` / `optOut()` for cookie banners.
- **A guard:** a secret key (`mf_live_...`) is refused, with a console error.

The **Integrate** page has a tab for each framework (HTML, React, Next.js, Vue, Nuxt, SvelteKit, Angular, plain JavaScript, Tag Manager) with your address and key already in the code. The package README ([packages/sdk-browser](../packages/sdk-browser/README.md)) has the full option and call reference.

```tsx
import { LoomailProvider } from "@loomail/browser/react";

<LoomailProvider publishableKey={process.env.NEXT_PUBLIC_LOOMAIL_KEY!} endpoint="https://YOUR_LOOMAIL_HOST" autoPage
  user={user ? { id: user.id, traits: { email: user.email } } : null}>
  {children}
</LoomailProvider>
```

Pass the signed-in person as `user` and Loomail identifies them; pass `null` and it resets on logout. Use the key in your framework's public environment variables (`NEXT_PUBLIC_`, `VITE_`, `PUBLIC_`, `NUXT_PUBLIC_`), not in the source. A site on a different origin needs that origin in the key's allowlist if you set one (see below).

## 3. Server-side

### Official SDKs

Zero dependencies; they use a secret key, retry what is safe to retry, and give every call a
`messageId` so a retry never double-counts. See each README for the full API.

```bash
npm install @loomail/node                  # packages/sdk-node
pip install loomail                        # packages/sdk-python (sync and asyncio)
composer require loomail/loomail           # packages/sdk-php (with a Laravel provider and facade)
gem install loomail                        # packages/sdk-ruby (with a Rails integration and ActiveJob helpers)
go get github.com/sasbaws2211-cloud/mailforge/packages/sdk-go   # packages/sdk-go
```

```xml
<!-- packages/sdk-java: Java 11+, no dependencies -->
<dependency><groupId>site.loomail</groupId><artifactId>loomail</artifactId><version>0.1.0</version></dependency>
```

```javascript
import { Loomail } from "@loomail/node";
const loomail = new Loomail({ secretKey: process.env.LOOMAIL_SECRET_KEY, host: "https://YOUR_LOOMAIL_HOST" });
await loomail.identify("user_123", { email: "user@example.com", plan: "trial" });
await loomail.track("user_123", "signed_up");
```

```python
from loomail import Loomail
loomail = Loomail(secret_key="mf_live_...", host="https://YOUR_LOOMAIL_HOST")
loomail.identify("user_123", {"email": "user@example.com", "plan": "trial"})
loomail.track("user_123", "signed_up")
```

```php
$loomail = new \Loomail\Client(['secret_key' => 'mf_live_...', 'host' => 'https://YOUR_LOOMAIL_HOST']);
$loomail->identify('user_123', ['email' => 'user@example.com', 'plan' => 'trial']);
$loomail->track('user_123', 'signed_up');
// Laravel: set LOOMAIL_SECRET_KEY and call Loomail::track(...) through the facade.
```

```ruby
loomail = Loomail::Client.new(secret_key: "mf_live_...", host: "https://YOUR_LOOMAIL_HOST")
loomail.identify("user_123", email: "user@example.com", plan: "trial")
loomail.track("user_123", "signed_up")
# Rails: set LOOMAIL_SECRET_KEY, then Loomail.track(...) or Loomail.track_later(...) on ActiveJob.
```

```go
client, _ := loomail.New(loomail.WithSecretKey("mf_live_..."), loomail.WithHost("https://YOUR_LOOMAIL_HOST"))
client.Identify(ctx, "user_123", map[string]any{"email": "user@example.com", "plan": "trial"})
client.Track(ctx, "user_123", "signed_up", nil)
```

```java
Loomail loomail = Loomail.builder().secretKey("mf_live_...").host("https://YOUR_LOOMAIL_HOST").build();
loomail.identify("user_123", Map.of("email", "user@example.com", "plan", "trial"));
loomail.track("user_123", "signed_up", Map.of());
```

### Plain HTTP (any language)

Any HTTP client works. Node 18+:

```javascript
const LOOMAIL = "https://YOUR_LOOMAIL_HOST";
const KEY = "mf_live_YOUR_SECRET_KEY";

async function track(userId, event, properties = {}) {
  const res = await fetch(`${LOOMAIL}/v1/track`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ userId, event, properties }),
  });
  if (!res.ok) throw new Error(`loomail track failed: ${res.status}`);
}

await track("user_123", "invoice_paid", { amount: 4900 });
```

The same shape works from Go (`net/http`), Ruby, or anything else that can POST
JSON with a header. We ship SDKs for Node and Python only; for other languages
the endpoint is the SDK. Send a `messageId` with each call so that retrying a
failed request cannot double-count it.

## 4. Pointing an existing Segment SDK at Loomail

If you already have Segment instrumentation, you can dual-send or migrate
without touching your event calls.

**@segment/analytics-node** posts batches to `{host}{path}` and
authenticates with the write key as the HTTP Basic username, both of which
Loomail understands:

```javascript
const { Analytics } = require("@segment/analytics-node");

const analytics = new Analytics({
  writeKey: "mf_live_YOUR_SECRET_KEY",
  host: "https://YOUR_LOOMAIL_HOST",  // path defaults to /v1/batch
  flushAt: 20,                        // batching works; /v1/batch is supported
  maxRetries: 3,
});

analytics.identify({ userId: "user_123", traits: { email: "user@example.com" } });
analytics.track({ userId: "user_123", event: "signed_up" });
await analytics.flush({ close: true });
```

Notes:

- A `track` item with only an `anonymousId` is accepted as an anonymous visitor's event. An item with neither id,
  or an `identify` with no `userId`, appears as a per-item error in the batch response, not as a silent drop.
- `page`/`screen`/`group`/`alias` calls have no endpoint here. Do not set
  `path` to anything but `/v1/batch`.
- Payload caps: 100 items and 512 KB per batch request. Segment's own limits
  (32 KB per call, 500 KB per batch) are tighter than ours, so traffic that
  Segment accepted fits.

Other Segment server SDKs (Python, Go, Java, Ruby) expose the same
host/base-URL override and use the same Basic-auth convention; the same two
settings port them.

## 5. Google Tag Manager

GTM has no native Loomail destination; use a Custom HTML tag:

1. In GTM: **Tags > New > Custom HTML**.
2. Paste the browser snippet from section 2 (the whole block, stubs and
   all), with your publishable key.
3. Trigger: **All Pages** (plus any event triggers you want `track` calls
   bound to).
4. For event-level calls, fire additional Custom HTML tags on your GTM
   events, e.g. `<script>loomail("track", "signup_completed")</script>`.

Because the snippet queues calls made before `loomail.js` loads, GTM's async
container loading cannot race it.

## 6. Dual-sending alongside an existing Segment install

Keep Segment exactly as it is and add Loomail as a second sink:

- **Server-side:** instantiate a second `Analytics` client pointed at
  Loomail (section 4) next to your existing one, and call both. Or add a
  three-line forwarder in front of your current `analytics.track` call
  sites using the plain-fetch helper in section 3.
- **Browser:** load the Loomail snippet (section 2) next to Segment's
  analytics.js and call both. There is no conflict; the two libraries share
  nothing.
- **Via Segment itself:** in the Segment dashboard, add a **Webhook
  destination** on your source pointing at
  `https://YOUR_LOOMAIL_HOST/v1/batch` with the secret key as an
  `Authorization: Bearer` header. Every event Segment receives is forwarded
  to Loomail. (This is the zero-code option; it depends on Segment's webhook
  retry behavior for delivery guarantees.)

## 7a. Receiving events from other tools (Stripe, forms, Zapier)

When a tool can post a webhook but you do not want to write code against `/v1/track`, add a **source** on the
**Integrate** page (**Connect other tools**). Each source has its own address, `https://YOUR_LOOMAIL_HOST/webhooks/in/<id>`,
and a log of what it received (kept 30 days). Up to 20 sources per workspace.

### Any JSON webhook

Choose **Any JSON webhook** and say where things are in the payload, using dotted paths such as `data.user.email` or
`answers.0.text`:

- **The person**: a user id field, an email field, or both. With only an email, the person is matched to an existing
  contact with that email, or created keyed by it (like the CSV import).
- **The event**: a fixed name, a name read from a field, or none (the request then only sets traits).
- **Traits**: any number of `trait name` from `field` pairs (up to 20). Empty or missing fields are skipped, so a request
  never clears a trait. `company`, `name`, `email`, `plan` and `payment_status` set the built-in fields, as in `identify`.
- **Payload**: by default the whole JSON body is kept on the event, so flows and segments can use any of it.

The source gives you a token, shown once. Send it as `Authorization: Bearer <token>`, as `X-Loomail-Token: <token>`, or
as `?token=<token>` on the address for tools that cannot set headers (the address then is a secret; do not share it).
An optional `X-Loomail-Event-Id` header makes a repeat of the same request harmless.

```bash
curl -X POST 'https://YOUR_LOOMAIL_HOST/webhooks/in/SOURCE_ID' \
  -H 'Authorization: Bearer mf_in_YOUR_TOKEN' -H 'Content-Type: application/json' \
  -d '{"event_type":"form_response","user":{"id":"u_1","email":"ada@example.com"}}'
```

Answers: `200` when handled, or deliberately ignored (nothing to record); `400` for a body that is not a JSON object or has no
person at the configured paths; `401` for a wrong token, a disabled source or an unknown address (all the same answer, so
the address cannot be used to find out which sources exist); `402` when your plan's contact limit stopped a new person;
`429` past 600 requests a minute for one source.

### Stripe

Choose **Stripe**, then in Stripe (Developers, Webhooks) create an event destination of type **Webhook endpoint** at the address
shown. Set its payload to **Snapshot**, not Thin: thin events carry only ids, and Loomail needs the details. A thin event is
acknowledged (so Stripe stops retrying) and noted in the log with this instruction. Select these events, and paste the
endpoint's signing secret (`whsec_...`) into Loomail. Test mode and live mode have different secrets, so add one source for
each mode you use.

| Stripe event | What Loomail records |
|---|---|
| `checkout.session.completed` | event `checkout_completed`; the Stripe customer id is remembered on the person |
| `customer.subscription.created` | event `subscription_started`; payment status and plan |
| `customer.subscription.updated` | event `subscription_updated`; payment status and plan |
| `customer.subscription.deleted` | event `subscription_cancelled`; payment status `cancelled` |
| `invoice.paid` | event `payment_succeeded`; payment status `paid` (not for a zero-amount invoice) |
| `invoice.payment_failed` | event `payment_failed`; payment status `past_due` |

Payment status comes from the subscription: `trialing` is `trial`, `active` is `paid`, `past_due` and `unpaid` are `past_due`,
`canceled` is `cancelled`; an incomplete or paused subscription leaves it alone. The plan is the price's nickname, else its
lookup key, else its id. Other event types are acknowledged and ignored.

**Matching people.** Loomail uses, in order: your own user id in a Stripe metadata field (the key is configurable, default
`user_id`; set it on customers, subscriptions or checkout sessions), the checkout's `client_reference_id`, a person who already
carries this Stripe customer id, a person with this email, and otherwise creates one keyed by the email. Subscription events carry
no email, which is why the customer id is remembered the first time Loomail sees it (usually at checkout). Events Loomail cannot
match to anyone are acknowledged and noted in the log, not retried. A person's own email is never overwritten.

**Order and repeats.** Stripe does not deliver events in order, and sends some events more than once (occasionally as two
different events for one occurrence). So: each event is recorded once, and for things that happen once per object (a
checkout, a subscription starting or ending, an invoice being paid) once per object; and an event that arrives late cannot
overwrite a newer payment status or plan. Loomail keeps the time of the latest billing event it applied on the person
(the `stripe_status_at` trait) and ignores an older one, while still recording the event itself.

Calls are verified with Stripe's signature (`Stripe-Signature`, HMAC-SHA256 over the exact body, five-minute window) before
anything is read. Each Stripe event is recorded once, whatever number of times Stripe sends it. The dashboard stores the signing
secret encrypted with `ENCRYPTION_KEY` when the install has one, and never shows it again.

### Paystack

Choose **Paystack** on the Integrate page, save, and paste the address it shows into Paystack (Settings, API Keys &
Webhooks, webhook URL). Paystack has a separate webhook URL for test mode and for live mode, so add one source for each.

**How calls are checked.** Choose one when you add the source (it cannot be changed afterwards):

- **A secret in the address** (the default). Loomail makes a token and puts it in the address you give Paystack
  (`...?token=mf_in_...`). Loomail holds no Paystack key. Anyone who has the address can send events, so keep it private. You can
  also turn on **only accept Paystack's published addresses** (52.31.139.75, 52.49.173.169, 52.214.14.220), but only if Loomail sees
  the real sender address: behind a proxy that hides it, every call would be refused.
- **Paystack's signature.** Paystack signs each call (`x-paystack-signature`, HMAC-SHA512 of the body) **with your secret key**,
  so checking it means giving Loomail that key (`sk_test_...` or `sk_live_...`). It is stored encrypted and never shown again, but it
  is the key that can move money, so choose this only if you are comfortable with that.

| Paystack event | What Loomail records |
|---|---|
| `charge.success` | event `payment_succeeded`; payment status `paid` (not for a zero amount); the plan name if the charge is for a plan |
| `subscription.create` | event `subscription_started`; `paid`, plan |
| `subscription.not_renew` | event `subscription_not_renewing`; the status is left alone (still paid until the period ends) |
| `subscription.disable` | event `subscription_cancelled`; status `cancelled` |
| `invoice.payment_failed` | event `payment_failed`; status `past_due` |
| `invoice.update` | when paid: event `invoice_paid`; status `paid` |

Other events (refunds, transfers, disputes, `invoice.create`) are acknowledged and ignored. A renewal sends both a
`charge.success` and an `invoice.update`, so it records both a `payment_succeeded` and an `invoice_paid` event: use whichever suits
your flow. Amounts are in the smallest unit (kobo for NGN), as Paystack sends them.

**Matching people.** Your own user id if you pass one in the payment's metadata (key configurable, default `user_id`), otherwise a
person who already carries this Paystack customer code, otherwise the customer's email, otherwise a new person keyed by the email.
Paystack puts the email and customer code on every event Loomail uses.

**Order and repeats.** Paystack events carry no id and no dependable event time, and retries (every 3 minutes four times, then
hourly for 72 hours) can arrive late. So: an identical redelivery is recorded once and never re-applies the status; a late event that
carries its own time (a payment's paid time, an invoice's created time) cannot overwrite a newer payment status; and events with no
time of their own (a subscription starting or being disabled) count from when they arrive. A subscription disabled, re-enabled and
disabled again is recorded as two cancellations. A one-off purchase also sets `paid`: Paystack does not say whether a charge belongs
to a subscription.

### Flutterwave

Choose **Flutterwave**, save, and Loomail shows an address and a **secret hash**. In Flutterwave (Settings, Webhooks) paste the address as
the URL and the secret hash as the secret hash, and turn on webhook retries. Flutterwave sends the hash back unchanged in the
`verif-hash` header of every call, and Loomail refuses any call whose header does not match. (Flutterwave offers no payload
signature, so this shared secret is the whole check; Loomail makes it random and keeps only its hash.)

| Flutterwave event | What Loomail records |
|---|---|
| `charge.completed`, `status: successful` | event `payment_succeeded`; payment status `paid` (not for a zero amount) |
| `charge.completed`, `status: failed` | event `payment_failed`; the status is **not** changed |
| `subscription.cancelled` | event `subscription_cancelled`; status `cancelled` |

Flutterwave does not send an event when a subscription starts or renews, and a charge carries nothing that names its plan, so there is
no plan name and no `past_due` status from Flutterwave. A failed charge is an event only because it could equally be a stranger's
abandoned checkout or a declined renewal. Other events (transfers, bill payments, refunds) are acknowledged and ignored. Amounts are
in whole units (100 means 100 NGN), unlike Stripe and Paystack.

**Matching people.** Your own user id if you put one in the charge's `meta` (key configurable, default `user_id`), otherwise a person
who already carries this Flutterwave customer id, otherwise the customer's email, otherwise a new person keyed by the email. A
cancellation carries only the email. A charge is recorded once per Flutterwave transaction and status, however many times it is sent
(Flutterwave may send the same event more than once), and, as with Stripe, a late event cannot overwrite a newer payment status.

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
