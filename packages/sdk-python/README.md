# loomail (Python)

Server-side client for [Loomail](https://loomail.site). No dependencies, Python 3.9+.

```bash
pip install loomail
```

```python
from loomail import Loomail

loomail = Loomail(secret_key="mf_live_...")      # or set LOOMAIL_SECRET_KEY

loomail.identify("user_123", {"email": "a@b.c", "plan": "trial"})
loomail.track("user_123", "signed_up", {"source": "ads"})
```

Use a **secret** key (`mf_live_...`). A publishable key (`mf_pub_...`) belongs in the browser snippet, and the client refuses it.

## Options

| Option | Default | |
|---|---|---|
| `secret_key` | `LOOMAIL_SECRET_KEY` | Required. |
| `host` | `LOOMAIL_HOST`, then `https://loomail.site` | Your Loomail install. |
| `timeout` | `10.0` | Seconds, per attempt. |
| `max_retries` | `3` | On network errors, 429 and 5xx, with backoff; `Retry-After` is honoured. |

## Calls

- `identify(user_id, traits=None, *, timestamp, message_id, context)` creates or updates a person. Traits merge; `None` removes one. Put `email` here so the person can be mailed, and `payment_status` / `plan` to drive lifecycle flows.
- `track(user_id, event, properties=None, *, timestamp, message_id, context)` records something a person did.
- `batch([Identify(...), Track(...)])` sends many items, split into requests of 100 for you. Refused items come back in `result.errors` with their position; the rest go through.

A naive `datetime` is taken to be UTC.

## Retries never double-count

Every call carries a `message_id` (generated if you don't give one), and Loomail drops a repeat. So a retried request, or the same request sent twice, records once. To make a repeat safe across restarts too, pass your own: `track(id, "paid", message_id=f"paid:{invoice_id}")`. The result's `deduplicated` is `True` for a repeat.

## Async

```python
from loomail import AsyncLoomail

loomail = AsyncLoomail()
await loomail.track("user_123", "signed_up")
```

Same methods, awaited. They run on a worker thread, so a slow Loomail never blocks the event loop.

## Errors

Calls raise `LoomailError` with `.code`, and `.status` / `.body` when Loomail answered:

`invalid_argument` (caught before any request) · `unauthorized` (401) · `forbidden` (403) · `plan_limit` (402, the workspace is at its contact limit) · `validation` (400/422) · `rate_limited` (429) · `server` (5xx) · `network`.

In a request path, a Loomail outage will raise. For fire-and-forget, catch it:

```python
try:
    loomail.track(user.id, "viewed_pricing")
except LoomailError:
    logger.warning("loomail down", exc_info=True)
```

Only 429, 5xx and network errors are retried; the others are mistakes that retrying cannot fix.

Events more than 72 hours from Loomail's clock are re-dated to now by the server.
