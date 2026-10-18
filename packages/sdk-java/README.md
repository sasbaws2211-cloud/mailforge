# site.loomail:loomail (Java)

Server-side client for [Loomail](https://loomail.site). Java 11+, no dependencies (it uses the JDK's `java.net.http.HttpClient`).

```xml
<dependency>
  <groupId>site.loomail</groupId>
  <artifactId>loomail</artifactId>
  <version>0.1.0</version>
</dependency>
```

```gradle
implementation("site.loomail:loomail:0.1.0")
```

```java
import site.loomail.Loomail;
import java.util.Map;

Loomail loomail = Loomail.builder().secretKey(System.getenv("LOOMAIL_SECRET_KEY")).build();   // mf_live_...

loomail.identify("user_123", Map.of("email", "a@b.c", "plan", "trial"));
loomail.track("user_123", "signed_up", Map.of("source", "ads"));
```

Use a **secret** key (`mf_live_...`). A publishable key (`mf_pub_...`) belongs in the browser snippet, and the builder refuses it. The client is thread-safe: make one and share it (a Spring `@Bean`, a Guice singleton).

## Builder

| Method | Default | |
|---|---|---|
| `secretKey` | `LOOMAIL_SECRET_KEY` | Required. |
| `host` | `LOOMAIL_HOST`, then `https://loomail.site` | Your Loomail install. |
| `timeout` | 10 s | Per attempt. |
| `maxRetries` | 3 | On network errors, 429 and 5xx, with backoff; `Retry-After` is honoured. `0` turns retries off. |
| `httpClient` | JDK client, redirects off | A proxy or custom TLS. Keep redirects off. |
| `executor` | common pool | Where the `*Async` methods run. |

`Loomail.fromEnvironment()` reads the key and host from the environment.

## Calls

- `identify(userId, traits[, options])` creates or updates a person. Traits merge; a `null` value removes a trait. Put `email` here so the person can be mailed, and `payment_status` / `plan` to drive lifecycle flows.
- `track(userId, event, properties[, options])` records something a person did.
- `identifyAsync` / `trackAsync` do the same on another thread and return a `CompletableFuture`: use them to keep a Loomail outage out of a request.
- `batch(items)` sends many `BatchItem`s, split into requests of 100 for you. Refused items come back in `errors()` with their position; the rest go through.

```java
CallOptions options = CallOptions.builder()
    .messageId("paid:" + invoice.id())
    .timestamp(invoice.paidAt())          // an Instant
    .context(Map.of("ip", request.ip()))
    .build();
loomail.track("user_123", "invoice_paid", Map.of("amount", 4900), options);

BatchResult res = loomail.batch(List.of(
    BatchItem.identify("u1", Map.of("plan", "pro")),
    BatchItem.track("u1", "upgraded", Map.of("plan", "pro"))));
res.received();   // 2
res.errors();     // each has index(), message(), code()
```

Traits and properties are `Map`s of strings, numbers, booleans, `null`, nested maps and lists, and `Instant`s. Anything else is refused with `INVALID_ARGUMENT` before any request.

## Retries never double-count

Every call carries a `messageId` (generated if you don't give one), and Loomail drops a repeat. So a retried request, or the same request sent twice, records once. To make a repeat safe across restarts too, pass your own in `CallOptions`. The result tells you when it was a repeat: `result.deduplicated()`.

## Errors

Calls throw `LoomailException` (unchecked) with `code()`, plus `status()` and `body()` when Loomail answered:

`INVALID_ARGUMENT` (caught before any request) · `UNAUTHORIZED` (401) · `FORBIDDEN` (403) · `PLAN_LIMIT` (402, the workspace is at its contact limit) · `VALIDATION` (400/422) · `RATE_LIMITED` (429) · `SERVER` (5xx) · `NETWORK`.

```java
try { loomail.track(user.id(), "viewed_pricing", Map.of()); }
catch (LoomailException e) { if (e.code() == LoomailException.Code.PLAN_LIMIT) { /* ... */ } }
```

Only 429, 5xx and network errors are retried; the others are mistakes that retrying cannot fix. An interrupted thread stops the call with `NETWORK` and keeps its interrupt flag. Events more than 72 hours from Loomail's clock are re-dated to now by the server.
