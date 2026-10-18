# loomail (Ruby and Rails)

Server-side client for [Loomail](https://loomail.site). Ruby 3.0+, no dependencies (Net::HTTP), with a Rails integration.

```bash
gem install loomail      # or: bundle add loomail
```

```ruby
loomail = Loomail::Client.new(secret_key: ENV["LOOMAIL_SECRET_KEY"])   # mf_live_...

loomail.identify("user_123", { email: "a@b.c", plan: "trial" })
loomail.track("user_123", "signed_up", { source: "ads" })
```

Use a **secret** key (`mf_live_...`). A publishable key (`mf_pub_...`) belongs in the browser snippet, and the client refuses it.

## Rails

The gem is picked up automatically. Give it the key in any one of these:

```ruby
# config/application.rb or an environment file
config.loomail.secret_key = ENV["LOOMAIL_SECRET_KEY"]
config.loomail.host = "https://loomail.example.com"   # only for a self-hosted install
```

```yaml
# rails credentials:edit
loomail:
  secret_key: mf_live_...
  host: https://loomail.example.com
```

or just set `LOOMAIL_SECRET_KEY` (and `LOOMAIL_HOST`) in the environment. Then, anywhere:

```ruby
Loomail.identify(user.id, email: user.email, plan: "trial")
Loomail.track(user.id, "signed_up")

# on a background job (ActiveJob), so a Loomail outage never slows the request:
Loomail.track_later(user.id, "invoice_paid", { amount: 4900 }, message_id: "paid:#{invoice.id}")
Loomail.identify_later(user.id, email: user.email)
```

`track_later` fixes the `message_id` when it queues the job, so a retried job is recognised and not counted twice. An outage or rate limit is retried with a growing wait (5 attempts); a refusal that retrying cannot fix (a bad key, a plan limit) is logged and dropped.

Outside Rails, `Loomail.configure { |c| c.secret_key = "..." }` sets the shared client the same way.

## Options

| Option | Default | |
|---|---|---|
| `secret_key:` | `LOOMAIL_SECRET_KEY` | Required. |
| `host:` | `LOOMAIL_HOST`, then `https://loomail.site` | Your Loomail install. |
| `timeout:` | `10` | Seconds per attempt. |
| `max_retries:` | `3` | On network errors, 429 and 5xx, with backoff; `Retry-After` is honoured. |

## Calls

- `identify(user_id, traits = {}, timestamp:, message_id:, context:)` creates or updates a person. Traits merge; a `nil` trait removes it. Put `email` here so the person can be mailed, and `payment_status` / `plan` to drive lifecycle flows.
- `track(user_id, event, properties = {}, timestamp:, message_id:, context:)` records something a person did.
- `batch(items)` sends many items, split into requests of 100 for you. Refused items come back in `errors` with their position; the rest go through.

Traits and properties can be a Hash or plain keywords (`identify("u1", email: "a@b.c")`). The names `timestamp`, `message_id` and `context` are the options; a trait with one of those names has to go in a Hash.

```ruby
result = loomail.batch([
  { type: :identify, user_id: "u1", traits: { plan: "pro" } },
  { type: :track, user_id: "u1", event: "upgraded", properties: { plan: "pro" }, message_id: "up:1" }
])
result.received   # 2
result.errors     # [{ index: 0, message: "...", code: "plan_limit" }, ...]
```

## Retries never double-count

Every call carries a `messageId` (generated if you don't give one), and Loomail drops a repeat. So a retried request, or the same request sent twice, records once. To make a repeat safe across restarts too, pass your own: `message_id: "paid:#{invoice.id}"`. The result tells you when it was a repeat: `result.deduplicated?`.

## Errors

Calls raise `Loomail::Error` with `#code`, plus `#status` and `#body` when Loomail answered:

`:invalid_argument` (caught before any request) · `:unauthorized` (401) · `:forbidden` (403) · `:plan_limit` (402, the workspace is at its contact limit) · `:validation` (400/422) · `:rate_limited` (429) · `:server` (5xx) · `:network`.

Only 429, 5xx and network errors are retried; the others are mistakes that retrying cannot fix. Events more than 72 hours from Loomail's clock are re-dated to now by the server.
