package site.loomail;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Executor;

import site.loomail.LoomailException.Code;

/**
 * Server-side client for Loomail's ingestion API.
 *
 * <p>Sends identify and track calls with a secret key ({@code mf_live_...}), retries what is safe to retry, and never
 * double-counts: every call carries a messageId, which Loomail uses to drop repeats. No dependencies; Java 11+.
 *
 * <pre>{@code
 * Loomail loomail = Loomail.builder().secretKey(System.getenv("LOOMAIL_SECRET_KEY")).build();
 * loomail.identify("user_123", Map.of("email", "a@b.c", "plan", "trial"));
 * loomail.track("user_123", "signed_up", Map.of("source", "ads"));
 * }</pre>
 *
 * <p>Calls throw {@link LoomailException} when Loomail cannot be reached or refuses the call, so in a request path a
 * Loomail outage can fail the request. For fire-and-forget use {@link #trackAsync} and handle the result. The client is
 * thread-safe.
 */
public final class Loomail {
    /** Where events go when no host is given and LOOMAIL_HOST is not set. */
    public static final String DEFAULT_HOST = "https://loomail.site";
    /** Loomail rejects a batch of more than 100 items or more than 512 KB. */
    public static final int MAX_BATCH_ITEMS = 100;
    private static final int MAX_BATCH_BYTES = 400 * 1024; // headroom under the server's 512 KB body limit
    private static final String VERSION = "0.1.0";
    private static final DateTimeFormatter ISO = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(ZoneOffset.UTC);

    /** What happens between retries. Replace it in tests. */
    @FunctionalInterface
    public interface Sleeper {
        void sleep(long millis) throws InterruptedException;
    }

    private final String secretKey;
    private final String host;
    private final Duration timeout;
    private final int maxRetries;
    private final HttpClient http;
    private final Sleeper sleeper;
    private final Executor executor;

    private Loomail(Builder b) {
        String key = b.secretKey != null ? b.secretKey : System.getenv("LOOMAIL_SECRET_KEY");
        if (key == null || key.isEmpty()) {
            throw new LoomailException(Code.INVALID_ARGUMENT, "secretKey is required (or set LOOMAIL_SECRET_KEY)");
        }
        if (key.startsWith("mf_pub_")) {
            throw new LoomailException(Code.INVALID_ARGUMENT,
                    "That is a publishable key (mf_pub_...), meant for browsers. Server code needs a secret key (mf_live_...).");
        }
        String h = b.host != null ? b.host : System.getenv("LOOMAIL_HOST");
        if (h == null || h.isEmpty()) {
            h = DEFAULT_HOST;
        }
        h = h.replaceAll("/+$", "");
        try {
            URI u = URI.create(h);
            if (u.getHost() == null || !("http".equals(u.getScheme()) || "https".equals(u.getScheme()))) {
                throw new IllegalArgumentException("not an http(s) address");
            }
        } catch (IllegalArgumentException e) {
            throw new LoomailException(Code.INVALID_ARGUMENT, "host is not a valid http(s) address: " + h);
        }
        this.secretKey = key;
        this.host = h;
        this.timeout = b.timeout;
        this.maxRetries = Math.max(0, b.maxRetries);
        this.http = b.httpClient != null ? b.httpClient
                : HttpClient.newBuilder().connectTimeout(b.timeout).followRedirects(HttpClient.Redirect.NEVER).version(HttpClient.Version.HTTP_1_1).build();
        this.sleeper = b.sleeper != null ? b.sleeper : Thread::sleep;
        this.executor = b.executor;
    }

    /** A builder. Only the secret key matters; everything else has a default. */
    public static Builder builder() {
        return new Builder();
    }

    /** A client configured from LOOMAIL_SECRET_KEY and LOOMAIL_HOST. */
    public static Loomail fromEnvironment() {
        return builder().build();
    }

    /** Builds a {@link Loomail}. */
    public static final class Builder {
        private String secretKey;
        private String host;
        private Duration timeout = Duration.ofSeconds(10);
        private int maxRetries = 3;
        private HttpClient httpClient;
        private Sleeper sleeper;
        private Executor executor;

        private Builder() {
        }

        /** A secret key (mf_live_...). Never use it in a browser. Defaults to LOOMAIL_SECRET_KEY. */
        public Builder secretKey(String secretKey) {
            this.secretKey = secretKey;
            return this;
        }

        /** Base URL of your Loomail install. Defaults to LOOMAIL_HOST, then https://loomail.site. */
        public Builder host(String host) {
            this.host = host;
            return this;
        }

        /** Time allowed for each attempt. Default 10 seconds. */
        public Builder timeout(Duration timeout) {
            this.timeout = timeout;
            return this;
        }

        /** Retries after the first attempt, on network errors, 429 and 5xx. Default 3; 0 turns retries off. */
        public Builder maxRetries(int maxRetries) {
            this.maxRetries = maxRetries;
            return this;
        }

        /** Replace the HTTP client (proxy, custom TLS). Its redirect policy should stay NEVER. */
        public Builder httpClient(HttpClient httpClient) {
            this.httpClient = httpClient;
            return this;
        }

        /** Replace the wait between retries (tests). */
        public Builder sleeper(Sleeper sleeper) {
            this.sleeper = sleeper;
            return this;
        }

        /** The executor the *Async methods run on. Defaults to the common fork-join pool. */
        public Builder executor(Executor executor) {
            this.executor = executor;
            return this;
        }

        public Loomail build() {
            return new Loomail(this);
        }
    }

    // -- calls ------------------------------------------------------------

    /** Create or update a person. Traits merge into what Loomail already knows; a null trait value removes it. */
    public CallResult identify(String userId, Map<String, ?> traits) {
        return identify(userId, traits, CallOptions.none());
    }

    public CallResult identify(String userId, Map<String, ?> traits, CallOptions options) {
        return send("/v1/identify", identifyBody(userId, traits, options));
    }

    /** Record something a person did. */
    public CallResult track(String userId, String event, Map<String, ?> properties) {
        return track(userId, event, properties, CallOptions.none());
    }

    public CallResult track(String userId, String event, Map<String, ?> properties, CallOptions options) {
        return send("/v1/track", trackBody(userId, event, properties, options));
    }

    /** Like {@link #identify(String, Map, CallOptions)}, on another thread. The future fails with a {@link LoomailException}. */
    public CompletableFuture<CallResult> identifyAsync(String userId, Map<String, ?> traits, CallOptions options) {
        return async(() -> identify(userId, traits, options));
    }

    /** Like {@link #track(String, String, Map, CallOptions)}, on another thread. The future fails with a {@link LoomailException}. */
    public CompletableFuture<CallResult> trackAsync(String userId, String event, Map<String, ?> properties, CallOptions options) {
        return async(() -> track(userId, event, properties, options));
    }

    public CompletableFuture<CallResult> trackAsync(String userId, String event, Map<String, ?> properties) {
        return trackAsync(userId, event, properties, CallOptions.none());
    }

    public CompletableFuture<CallResult> identifyAsync(String userId, Map<String, ?> traits) {
        return identifyAsync(userId, traits, CallOptions.none());
    }

    private <T> CompletableFuture<T> async(java.util.function.Supplier<T> work) {
        return executor != null ? CompletableFuture.supplyAsync(work, executor) : CompletableFuture.supplyAsync(work);
    }

    /**
     * Send many identify/track items. Splits them into requests of at most 100 items (and under the size limit), so any
     * length is fine. A refused item lands in the result's errors and does not stop the rest; a request that fails
     * outright (bad key, an outage after retries) throws.
     */
    public BatchResult batch(List<BatchItem> items) {
        List<Map<String, Object>> prepared = new ArrayList<>(items.size());
        for (int i = 0; i < items.size(); i++) {
            BatchItem it = items.get(i);
            try {
                Map<String, Object> body = it.isIdentify()
                        ? identifyBody(it.userId(), it.data(), it.options())
                        : trackBody(it.userId(), it.event(), it.data(), it.options());
                body.put("type", it.isIdentify() ? "identify" : "track");
                prepared.add(body);
            } catch (LoomailException e) {
                throw new LoomailException(Code.INVALID_ARGUMENT, "batch[" + i + "]: " + e.getMessage());
            }
        }

        int received = 0;
        List<BatchResult.Error> errors = new ArrayList<>();
        List<Map<String, Object>> chunk = new ArrayList<>();
        int chunkBytes = 0;
        int chunkStart = 0;
        for (int n = 0; n <= prepared.size(); n++) {
            Map<String, Object> item = n < prepared.size() ? prepared.get(n) : null;
            int size = item == null ? 0 : encode(item).length() + 1;
            boolean full = item != null && (chunk.size() >= MAX_BATCH_ITEMS || (!chunk.isEmpty() && chunkBytes + size > MAX_BATCH_BYTES));
            if ((item == null || full) && !chunk.isEmpty()) {
                Map<String, Object> request = new LinkedHashMap<>();
                request.put("batch", chunk);
                Object res = post("/v1/batch", request);
                if (res instanceof Map) {
                    Map<?, ?> m = (Map<?, ?>) res;
                    received += m.get("received") instanceof Number ? ((Number) m.get("received")).intValue() : 0;
                    if (m.get("errors") instanceof List) {
                        for (Object e : (List<?>) m.get("errors")) {
                            if (e instanceof Map) {
                                Map<?, ?> em = (Map<?, ?>) e;
                                int idx = em.get("index") instanceof Number ? ((Number) em.get("index")).intValue() : 0;
                                errors.add(new BatchResult.Error(idx + chunkStart, String.valueOf(em.get("message")),
                                        em.get("code") == null ? null : String.valueOf(em.get("code"))));
                            }
                        }
                    }
                }
                chunkStart += chunk.size();
                chunk = new ArrayList<>();
                chunkBytes = 0;
            }
            if (item != null) {
                chunk.add(item);
                chunkBytes += size;
            }
        }
        return new BatchResult(received, Collections.unmodifiableList(errors));
    }

    // -- internals --------------------------------------------------------

    private Map<String, Object> base(String userId, CallOptions options) {
        if (userId == null || userId.trim().isEmpty()) {
            throw new LoomailException(Code.INVALID_ARGUMENT, "userId must be a non-empty string");
        }
        CallOptions o = options == null ? CallOptions.none() : options;
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("userId", userId);
        body.put("messageId", o.messageId() != null ? o.messageId() : UUID.randomUUID().toString());
        if (o.timestamp() != null) {
            body.put("timestamp", ISO.format(o.timestamp()));
        }
        if (o.context() != null) {
            body.put("context", o.context());
        }
        return body;
    }

    private Map<String, Object> identifyBody(String userId, Map<String, ?> traits, CallOptions options) {
        Map<String, Object> body = base(userId, options);
        body.put("traits", traits == null ? Collections.emptyMap() : traits);
        return body;
    }

    private Map<String, Object> trackBody(String userId, String event, Map<String, ?> properties, CallOptions options) {
        Map<String, Object> body = base(userId, options);
        if (event == null || event.trim().isEmpty()) {
            throw new LoomailException(Code.INVALID_ARGUMENT, "event must be a non-empty string");
        }
        body.put("event", event);
        body.put("properties", properties == null ? Collections.emptyMap() : properties);
        return body;
    }

    private static String encode(Object body) {
        try {
            return Json.write(body);
        } catch (IllegalArgumentException e) {
            throw new LoomailException(Code.INVALID_ARGUMENT, "The data could not be encoded as JSON: " + e.getMessage());
        }
    }

    private CallResult send(String path, Map<String, Object> body) {
        Object res = post(path, body);
        return new CallResult(res instanceof Map && Boolean.TRUE.equals(((Map<?, ?>) res).get("deduplicated")));
    }

    private static Code codeForStatus(int status) {
        if (status == 401) {
            return Code.UNAUTHORIZED;
        }
        if (status == 402) {
            return Code.PLAN_LIMIT;
        }
        if (status == 403) {
            return Code.FORBIDDEN;
        }
        if (status == 429) {
            return Code.RATE_LIMITED;
        }
        return status >= 500 ? Code.SERVER : Code.VALIDATION;
    }

    private static Object parseBody(String raw) {
        if (raw == null || raw.isEmpty()) {
            return null;
        }
        try {
            return Json.parse(raw);
        } catch (RuntimeException e) {
            return raw;
        }
    }

    /** One POST with retries. Every body here carries a messageId, so repeating it is safe. */
    private Object post(String path, Object body) {
        String payload = encode(body);
        for (int attempt = 0;; attempt++) {
            long waitMs;
            try {
                HttpRequest request = HttpRequest.newBuilder(URI.create(host + path))
                        .timeout(timeout)
                        .header("Authorization", "Bearer " + secretKey)
                        .header("Content-Type", "application/json")
                        .header("User-Agent", "loomail-java/" + VERSION)
                        .POST(HttpRequest.BodyPublishers.ofString(payload, StandardCharsets.UTF_8))
                        .build();
                HttpResponse<String> res = http.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
                int status = res.statusCode();
                Object parsed = parseBody(res.body());
                if (status >= 200 && status < 300) {
                    return parsed;
                }
                boolean retryable = status == 429 || status >= 500;
                if (!retryable || attempt >= maxRetries) {
                    String detail = parsed instanceof Map && ((Map<?, ?>) parsed).get("error") instanceof String
                            ? ": " + ((Map<?, ?>) parsed).get("error") : "";
                    throw new LoomailException(codeForStatus(status), "Loomail answered " + status + detail, status, parsed, null);
                }
                waitMs = retryAfterMs(res).orElse(backoffMs(attempt));
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new LoomailException(Code.NETWORK, "The call was interrupted", 0, null, e);
            } catch (IOException e) {
                if (attempt >= maxRetries) {
                    throw new LoomailException(Code.NETWORK, "Could not reach Loomail at " + host + ": " + describe(e), 0, null, e);
                }
                waitMs = backoffMs(attempt);
            }
            try {
                sleeper.sleep(Math.min(waitMs, 30_000L));
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new LoomailException(Code.NETWORK, "The call was interrupted", 0, null, e);
            }
        }
    }

    private static String describe(IOException e) {
        String m = e.getMessage();
        return e.getClass().getSimpleName() + (m == null || m.isEmpty() ? "" : " (" + m + ")");
    }

    /** Seconds from a Retry-After header, or empty when absent or not a number of seconds. */
    private static Optional<Long> retryAfterMs(HttpResponse<?> res) {
        return res.headers().firstValue("retry-after").flatMap(v -> {
            try {
                double secs = Double.parseDouble(v.trim());
                return secs >= 0 ? Optional.of((long) (secs * 1000)) : Optional.<Long>empty();
            } catch (NumberFormatException e) {
                return Optional.<Long>empty();
            }
        });
    }

    /** 0.5s, 1s, 2s... with up to 25% jitter. */
    private static long backoffMs(int attempt) {
        double base = 500.0 * Math.pow(2, attempt);
        return (long) (base + Math.random() * base * 0.25);
    }
}
