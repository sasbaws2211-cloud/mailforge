# loomail/loomail (PHP and Laravel)

Server-side client for [Loomail](https://loomail.site). PHP 8.1+, needs only the curl and json extensions, no other dependencies. Includes a Laravel service provider and facade.

```bash
composer require loomail/loomail
```

```php
$loomail = new \Loomail\Client(['secret_key' => getenv('LOOMAIL_SECRET_KEY')]);   // mf_live_...

$loomail->identify('user_123', ['email' => 'a@b.c', 'plan' => 'trial']);
$loomail->track('user_123', 'signed_up', ['source' => 'ads']);
```

Use a **secret** key (`mf_live_...`). A publishable key (`mf_pub_...`) belongs in the browser snippet, and the client refuses it.

## Laravel

The package is auto-discovered. Put the key in `.env`:

```
LOOMAIL_SECRET_KEY=mf_live_...
LOOMAIL_HOST=https://loomail.example.com    # only for a self-hosted install
```

```php
use Loomail\Laravel\Facades\Loomail;

Loomail::identify($user->id, ['email' => $user->email, 'plan' => 'trial']);
Loomail::track($user->id, 'signed_up');
```

or type-hint `\Loomail\Client` in a controller or job and the container supplies it. Publish the config with `php artisan vendor:publish --tag=loomail-config` (`timeout`, `max_retries`).

To keep a Loomail outage out of the request, send from a queued job or listener:

```php
dispatch(fn () => Loomail::track($user->id, 'invoice_paid', ['amount' => 4900], ['message_id' => "paid:{$invoice->id}"]));
```

## Options

| Option | Default | |
|---|---|---|
| `secret_key` | `LOOMAIL_SECRET_KEY` | Required. |
| `host` | `LOOMAIL_HOST`, then `https://loomail.site` | Your Loomail install. |
| `timeout` | `10` | Seconds per attempt. |
| `max_retries` | `3` | On network errors, 429 and 5xx, with backoff; `Retry-After` is honoured. |
| `transport` | curl | Anything implementing `Loomail\Transport` (a proxy, tests). |

## Calls

- `identify($userId, $traits = [], $options = [])` creates or updates a person. Traits merge; a `null` trait removes it. Put `email` here so the person can be mailed, and `payment_status` / `plan` to drive lifecycle flows.
- `track($userId, $event, $properties = [], $options = [])` records something a person did.
- `batch($items)` sends many items, split into requests of 100 for you. Refused items come back in `->errors` with their position; the rest go through.

```php
$result = $loomail->batch([
    ['type' => 'identify', 'user_id' => 'u1', 'traits' => ['plan' => 'pro']],
    ['type' => 'track', 'user_id' => 'u1', 'event' => 'upgraded', 'properties' => ['plan' => 'pro'], 'message_id' => 'up:1'],
]);
$result->received;   // 2
$result->errors;     // [['index' => 0, 'message' => '...', 'code' => 'plan_limit'], ...]
```

`$options` is `['timestamp' => DateTimeInterface|string, 'message_id' => string, 'context' => array]`. An empty `$traits` or `$properties` is sent as an object (`{}`), not a list.

## Retries never double-count

Every call carries a `messageId` (generated if you don't give one), and Loomail drops a repeat. So a retried request, or the same request sent twice, records once. To make a repeat safe across restarts too, pass your own: `['message_id' => 'paid:' . $invoice->id]`. The result tells you when it was a repeat: `$result->deduplicated`.

## Errors

Calls throw `Loomail\LoomailException` with `$e->errorCode`, plus `$e->status` and `$e->body` when Loomail answered:

`invalid_argument` (caught before any request) · `unauthorized` (401) · `forbidden` (403) · `plan_limit` (402, the workspace is at its contact limit) · `validation` (400/422) · `rate_limited` (429) · `server` (5xx) · `network`.

Calling in a request path lets a Loomail outage fail that request. For fire-and-forget, catch it:

```php
try { $loomail->track($user->id, 'viewed_pricing'); } catch (\Loomail\LoomailException $e) { report($e); }
```

Only 429, 5xx and network errors are retried; the others are mistakes that retrying cannot fix. Events more than 72 hours from Loomail's clock are re-dated to now by the server.
