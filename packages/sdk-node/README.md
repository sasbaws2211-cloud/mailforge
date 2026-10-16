# @loomail/node

Server-side client for [Loomail](https://loomail.site). Zero dependencies, Node 18+, ESM and CommonJS.

```bash
npm install @loomail/node
```

```ts
import { Loomail } from "@loomail/node";

const loomail = new Loomail({ secretKey: process.env.LOOMAIL_SECRET_KEY });   // mf_live_...

await loomail.identify("user_123", { email: "a@b.c", plan: "trial" });
await loomail.track("user_123", "signed_up", { source: "ads" });
```

Use a **secret** key (`mf_live_...`). A publishable key (`mf_pub_...`) belongs in the browser snippet, and the client refuses it.

## Options

| Option | Default | |
|---|---|---|
| `secretKey` | `LOOMAIL_SECRET_KEY` | Required. |
| `host` | `LOOMAIL_HOST`, then `https://loomail.site` | Your Loomail install. |
| `timeoutMs` | `10000` | Per attempt. |
| `maxRetries` | `3` | On network errors, 429 and 5xx, with backoff; `Retry-After` is honoured. |

## Calls

- `identify(userId, traits?, options?)` creates or updates a person. Traits merge; a `null` trait removes it. Put `email` here so the person can be mailed, and `payment_status` / `plan` to drive lifecycle flows.
- `track(userId, event, properties?, options?)` records something a person did.
- `batch(items)` sends many `{ type: "identify" | "track", ... }` items, split into requests of 100 for you. Refused items come back in `errors` with their position; the rest go through.

`options` is `{ timestamp?, messageId?, context? }`.

## Retries never double-count

Every call carries a `messageId` (generated if you don't give one), and Loomail drops a repeat. So a retried request, or the same request sent twice, records once. To make a repeat safe across restarts too, pass your own id: `track(id, "paid", {}, { messageId: "paid:" + invoiceId })`. The result tells you when it was a repeat: `{ deduplicated: true }`.

## Errors

Calls reject with a `LoomailError` that has a `code`, plus `status` and `body` when Loomail answered:

`invalid_argument` (caught before any request) · `unauthorized` (401) · `forbidden` (403) · `plan_limit` (402, the workspace is at its contact limit) · `validation` (400/422) · `rate_limited` (429) · `server` (5xx) · `network`.

Awaiting a call in a request path lets a Loomail outage fail that request. For fire-and-forget, catch it:

```ts
loomail.track(user.id, "viewed_pricing").catch((e) => logger.warn(e));
```

Only 429, 5xx and network errors are retried; the others are mistakes that retrying cannot fix.

Events older or newer than 72 hours from Loomail's clock are re-dated to now by the server.
