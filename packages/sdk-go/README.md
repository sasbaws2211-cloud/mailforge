# loomail (Go)

Server-side client for [Loomail](https://loomail.site). Go 1.21+, standard library only.

```bash
go get github.com/sasbaws2211-cloud/mailforge/packages/sdk-go
```

```go
import loomail "github.com/sasbaws2211-cloud/mailforge/packages/sdk-go"

client, err := loomail.New(loomail.WithSecretKey(os.Getenv("LOOMAIL_SECRET_KEY"))) // mf_live_...
if err != nil { log.Fatal(err) }

_, err = client.Identify(ctx, "user_123", map[string]any{"email": "a@b.c", "plan": "trial"})
_, err = client.Track(ctx, "user_123", "signed_up", map[string]any{"source": "ads"})
```

Use a **secret** key (`mf_live_...`). A publishable key (`mf_pub_...`) belongs in the browser snippet, and `New` refuses it.

## Options

| Option | Default | |
|---|---|---|
| `WithSecretKey` | `LOOMAIL_SECRET_KEY` | Required. |
| `WithHost` | `LOOMAIL_HOST`, then `https://loomail.site` | Your Loomail install. |
| `WithTimeout` | 10 s | Per attempt. |
| `WithMaxRetries` | 3 | On network errors, 429 and 5xx, with backoff; `Retry-After` is honoured. `0` turns retries off. |
| `WithHTTPClient` | `&http.Client{}` | A proxy, custom transport, tracing. |

The client is safe for concurrent use. Every call takes a `context.Context`; cancelling it stops the call and any retry wait at once.

## Calls

- `Identify(ctx, userID, traits, opts...)` creates or updates a person. Traits merge; a `nil` trait value removes it. Put `email` here so the person can be mailed, and `payment_status` / `plan` to drive lifecycle flows.
- `Track(ctx, userID, event, properties, opts...)` records something a person did.
- `Batch(ctx, items)` sends many items, split into requests of 100 for you. Refused items come back in `Errors` with their position; the rest go through.

Options: `WithTimestamp(t)`, `WithMessageID(id)`, `WithContext(map)`.

```go
res, err := client.Batch(ctx, []loomail.BatchItem{
    loomail.IdentifyItem("u1", map[string]any{"plan": "pro"}),
    loomail.TrackItem("u1", "upgraded", map[string]any{"plan": "pro"}, loomail.WithMessageID("up:1")),
})
// res.Received == 2; res.Errors []loomail.BatchError{Index, Message, Code}
```

## Retries never double-count

Every call carries a `messageId` (generated if you don't give one), and Loomail drops a repeat. So a retried request, or the same request sent twice, records once. To make a repeat safe across restarts too, pass your own: `loomail.WithMessageID("paid:" + invoiceID)`. The result tells you when it was a repeat: `res.Deduplicated`.

## Errors

Failures are `*loomail.Error` (use `errors.As`) with `Code`, and `Status` and `Body` when Loomail answered:

`ErrInvalidArgument` (caught before any request) · `ErrUnauthorized` (401) · `ErrForbidden` (403) · `ErrPlanLimit` (402, the workspace is at its contact limit) · `ErrValidation` (400/422) · `ErrRateLimited` (429) · `ErrServer` (5xx) · `ErrNetwork`.

```go
var le *loomail.Error
if errors.As(err, &le) && le.Code == loomail.ErrPlanLimit { /* upgrade prompt */ }
```

Only 429, 5xx and network errors are retried; the others are mistakes that retrying cannot fix. A cancelled context returns `ErrNetwork` wrapping `context.Canceled` (`errors.Is(err, context.Canceled)` works). Calling in a request path lets a Loomail outage slow it, so for fire-and-forget run the call in a goroutine and log the error. Events more than 72 hours from Loomail's clock are re-dated to now by the server.
