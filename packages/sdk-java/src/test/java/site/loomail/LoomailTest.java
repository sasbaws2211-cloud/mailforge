package site.loomail;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.ZonedDateTime;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletionException;
import java.util.concurrent.CopyOnWriteArrayList;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import site.loomail.LoomailException.Code;

/** A real local HTTP server stands in for Loomail, so the whole path is exercised: headers, bodies, retries, timeouts. */
class LoomailTest {
    record Seen(String path, String auth, String contentType, String userAgent, String raw, Map<String, Object> json) {
    }

    @FunctionalInterface
    interface Responder {
        void respond(int n, Seen seen, Reply reply) throws Exception;
    }

    static final class Reply {
        int status = 200;
        String body = "{\"success\":true}";
        final Map<String, String> headers = new LinkedHashMap<>();
        long delayMs = 0;

        Reply json(int status, String body) {
            this.status = status;
            this.body = body;
            return this;
        }
    }

    HttpServer server;
    String host;
    final List<Seen> seen = new CopyOnWriteArrayList<>();
    volatile Responder responder = (n, s, r) -> {
    };
    final List<Long> waited = Collections.synchronizedList(new ArrayList<>());

    @BeforeEach
    @SuppressWarnings("unchecked")
    void start() throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", exchange -> {
            String raw = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
            Map<String, Object> json = null;
            try {
                json = raw.isEmpty() ? null : (Map<String, Object>) Json.parse(raw);
            } catch (RuntimeException ignored) {
                // keep raw
            }
            Seen s = new Seen(exchange.getRequestURI().getPath(), exchange.getRequestHeaders().getFirst("Authorization"),
                    exchange.getRequestHeaders().getFirst("Content-Type"), exchange.getRequestHeaders().getFirst("User-Agent"), raw, json);
            seen.add(s);
            Reply reply = new Reply();
            try {
                responder.respond(seen.size(), s, reply);
                if (reply.delayMs > 0) {
                    Thread.sleep(reply.delayMs);
                }
            } catch (Exception e) {
                reply.json(500, "{\"error\":\"test responder failed\"}");
            }
            byte[] out = reply.body.getBytes(StandardCharsets.UTF_8);
            reply.headers.forEach((k, v) -> exchange.getResponseHeaders().add(k, v));
            exchange.getResponseHeaders().add("Content-Type", "application/json");
            exchange.sendResponseHeaders(reply.status, out.length == 0 ? -1 : out.length);
            if (out.length > 0) {
                exchange.getResponseBody().write(out);
            }
            exchange.close();
        });
        server.start();
        host = "http://127.0.0.1:" + server.getAddress().getPort();
        waited.clear();
    }

    @AfterEach
    void stop() {
        server.stop(0);
    }

    Loomail.Builder builder() {
        return Loomail.builder().secretKey("mf_live_test").host(host).sleeper(waited::add);
    }

    Loomail client() {
        return builder().build();
    }

    static LoomailException thrown(Runnable r) {
        return assertThrows(LoomailException.class, r::run);
    }

    // ---------------------------------------------------------------------

    @Test
    void identifySendsBearerKeyTraitsAndAGeneratedMessageId() {
        client().identify("u1", Map.of("email", "a@b.c", "plan", "trial"));
        Seen s = seen.get(0);
        assertEquals("/v1/identify", s.path());
        assertEquals("Bearer mf_live_test", s.auth());
        assertEquals("application/json", s.contentType());
        assertTrue(s.userAgent().startsWith("loomail-java/"));
        assertEquals("u1", s.json().get("userId"));
        assertEquals(Map.of("email", "a@b.c", "plan", "trial"), s.json().get("traits"));
        assertTrue(((String) s.json().get("messageId")).matches("[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"));
        assertFalse(s.json().containsKey("timestamp"));
        assertFalse(s.json().containsKey("context"));
    }

    @Test
    void emptyAndNullTraitsAndPropertiesAreObjects() {
        Loomail c = client();
        c.identify("u1", null);
        c.track("u1", "e", Map.of());
        assertTrue(seen.get(0).raw().contains("\"traits\":{}"));
        assertTrue(seen.get(1).raw().contains("\"properties\":{}"));
    }

    @Test
    void trackSendsPropertiesContextAndAUtcTimestampFromAnyZone() {
        Instant when = ZonedDateTime.of(2026, 5, 1, 12, 0, 0, 0, ZoneOffset.ofHours(2)).toInstant(); // 10:00 UTC
        Map<String, Object> props = new LinkedHashMap<>();
        props.put("amount", 4900);
        props.put("tax", 0.5);
        props.put("paid", true);
        props.put("note", null);
        client().track("u1", "paid", props, CallOptions.builder().timestamp(when).context(Map.of("ip", "1.2.3.4")).build());
        Map<String, Object> j = seen.get(0).json();
        assertEquals("2026-05-01T10:00:00.000Z", j.get("timestamp"));
        assertEquals("paid", j.get("event"));
        Map<?, ?> p = (Map<?, ?>) j.get("properties");
        assertEquals(4900L, p.get("amount"));
        assertEquals(0.5, p.get("tax"));
        assertEquals(true, p.get("paid"));
        assertTrue(p.containsKey("note") && p.get("note") == null);
        assertEquals(Map.of("ip", "1.2.3.4"), j.get("context"));
    }

    @Test
    void unicodeSurvivesTheRoundTrip() {
        client().track("u1", "e", Map.of("name", "Zoë 日本 😀 \"q\" \\ /\n\t"));
        assertEquals("Zoë 日本 😀 \"q\" \\ /\n\t", ((Map<?, ?>) seen.get(0).json().get("properties")).get("name"));
    }

    @Test
    void ownMessageIdAndDeduplicatedRepeat() {
        responder = (n, s, r) -> r.json(200, "{\"success\":true,\"deduplicated\":true}");
        CallResult r = client().track("u1", "paid", Map.of(), CallOptions.builder().messageId("paid:inv_9").build());
        assertEquals("paid:inv_9", seen.get(0).json().get("messageId"));
        assertTrue(r.deduplicated());
        responder = (n, s, rr) -> {
        };
        assertFalse(client().track("u1", "e", Map.of()).deduplicated());
    }

    @Test
    void rejectsBadArgumentsBeforeAnyRequest() {
        Loomail c = client();
        assertEquals(Code.INVALID_ARGUMENT, thrown(() -> c.identify("  ", Map.of())).code());
        assertEquals(Code.INVALID_ARGUMENT, thrown(() -> c.identify(null, Map.of())).code());
        assertEquals(Code.INVALID_ARGUMENT, thrown(() -> c.track("u1", "", Map.of())).code());
        assertEquals(Code.INVALID_ARGUMENT, thrown(() -> c.track("u1", "e", Map.of("n", Double.NaN))).code());
        assertEquals(Code.INVALID_ARGUMENT, thrown(() -> c.track("u1", "e", Map.of("bad", new Object()))).code());
        assertEquals(Code.INVALID_ARGUMENT, thrown(() -> c.track("u1", "e", Map.of("s", "\uD800"))).code());
        assertTrue(seen.isEmpty());
    }

    @Test
    void refusesAMissingPublishableOrBadHostConfiguration() {
        assertEquals(Code.INVALID_ARGUMENT, thrown(() -> Loomail.builder().secretKey("").build()).code());
        LoomailException e = thrown(() -> Loomail.builder().secretKey("mf_pub_abc").build());
        assertEquals(Code.INVALID_ARGUMENT, e.code());
        assertTrue(e.getMessage().contains("publishable"));
        assertEquals(Code.INVALID_ARGUMENT, thrown(() -> Loomail.builder().secretKey("mf_live_x").host("ftp://x").build()).code());
        assertEquals(Code.INVALID_ARGUMENT, thrown(() -> Loomail.builder().secretKey("mf_live_x").host("not a url").build()).code());
    }

    @Test
    void trailingSlashesOnTheHostAreIgnored() {
        builder().host(host + "///").build().track("u1", "e", Map.of());
        assertEquals("/v1/track", seen.get(0).path());
    }

    @Test
    void retriesA503WithTheSameMessageIdThenSucceeds() {
        responder = (n, s, r) -> {
            if (n < 3) {
                r.json(503, n == 1 ? "{\"error\":\"busy\"}" : "<html>");
            }
        };
        client().track("u1", "e", Map.of());
        assertEquals(3, seen.size());
        Set<Object> ids = new HashSet<>();
        seen.forEach(s -> ids.add(s.json().get("messageId")));
        assertEquals(1, ids.size());
        assertEquals(2, waited.size());
        assertTrue(waited.get(0) >= 500 && waited.get(1) >= 1000);
    }

    @Test
    void honoursRetryAfter() {
        responder = (n, s, r) -> {
            if (n == 1) {
                r.headers.put("Retry-After", "7");
                r.json(429, "{\"error\":\"slow\"}");
            }
        };
        client().track("u1", "e", Map.of());
        assertEquals(List.of(7000L), waited);
    }

    @Test
    void givesUpAfterMaxRetriesAndSaysWhy() {
        responder = (n, s, r) -> r.json(429, "{\"error\":\"too many\"}");
        LoomailException e = thrown(() -> builder().maxRetries(2).build().track("u1", "e", Map.of()));
        assertEquals(Code.RATE_LIMITED, e.code());
        assertEquals(429, e.status());
        assertEquals(Map.of("error", "too many"), e.body());
        assertTrue(e.getMessage().contains("too many"));
        assertEquals(3, seen.size());

        seen.clear();
        responder = (n, s, r) -> r.json(500, "");
        assertEquals(Code.SERVER, thrown(() -> builder().maxRetries(0).build().track("u1", "e", Map.of())).code());
        assertEquals(1, seen.size());
    }

    @Test
    void doesNotRetryAMistake() {
        int[] statuses = {401, 402, 403, 400, 422};
        Code[] codes = {Code.UNAUTHORIZED, Code.PLAN_LIMIT, Code.FORBIDDEN, Code.VALIDATION, Code.VALIDATION};
        for (int i = 0; i < statuses.length; i++) {
            seen.clear();
            int status = statuses[i];
            responder = (n, s, r) -> r.json(status, "{\"error\":\"no\"}");
            LoomailException e = thrown(() -> client().track("u1", "e", Map.of()));
            assertEquals(codes[i], e.code(), "status " + status);
            assertEquals(status, e.status());
            assertEquals(1, seen.size(), "status " + status);
        }
    }

    @Test
    void aTimeoutIsANetworkErrorAndIsRetried() {
        responder = (n, s, r) -> r.delayMs = 400;
        LoomailException e = thrown(() -> builder().timeout(Duration.ofMillis(100)).maxRetries(1).build().track("u1", "e", Map.of()));
        assertEquals(Code.NETWORK, e.code());
        assertNotNull(e.getCause());
        assertEquals(0, e.status());
    }

    @Test
    void aDeadPortIsANetworkError() throws IOException {
        int port;
        try (ServerSocket s = new ServerSocket(0)) {
            port = s.getLocalPort();
        }
        LoomailException e = thrown(() -> Loomail.builder().secretKey("mf_live_x").host("http://127.0.0.1:" + port).maxRetries(1).sleeper(waited::add).build()
                .track("u1", "e", Map.of()));
        assertEquals(Code.NETWORK, e.code());
        assertEquals(1, waited.size());
    }

    @Test
    void redirectsAreNotFollowed() {
        responder = (n, s, r) -> {
            r.headers.put("Location", "http://127.0.0.1:9/elsewhere");
            r.json(302, "");
        };
        LoomailException e = thrown(() -> client().track("u1", "e", Map.of()));
        assertEquals(302, e.status());
        assertEquals(1, seen.size());
    }

    @Test
    void asyncCallsCompleteOrFailWithALoomailException() {
        assertFalse(client().trackAsync("u1", "e", Map.of()).join().deduplicated());
        responder = (n, s, r) -> r.json(401, "{\"error\":\"bad key\"}");
        CompletionException ce = assertThrows(CompletionException.class, () -> client().identifyAsync("u1", Map.of()).join());
        assertEquals(Code.UNAUTHORIZED, assertInstanceOf(LoomailException.class, ce.getCause()).code());
    }

    @Test
    void batchSplitsIntoRequestsOf100AndOffsetsErrorIndexes() {
        responder = (n, s, r) -> {
            int items = ((List<?>) s.json().get("batch")).size();
            r.json(200, n == 2 ? "{\"received\":" + (items - 1) + ",\"errors\":[{\"index\":3,\"message\":\"at limit\",\"code\":\"plan_limit\"}]}" : "{\"received\":" + items + "}");
        };
        List<BatchItem> items = new ArrayList<>();
        for (int i = 0; i < 250; i++) {
            items.add(i % 2 == 0 ? BatchItem.identify("u" + i, Map.of("n", i)) : BatchItem.track("u" + i, "e", null));
        }
        BatchResult res = client().batch(items);
        assertEquals(3, seen.size());
        assertEquals("/v1/batch", seen.get(0).path());
        assertEquals(List.of(100, 100, 50), seen.stream().map(s -> ((List<?>) s.json().get("batch")).size()).toList());
        Map<?, ?> first = (Map<?, ?>) ((List<?>) seen.get(0).json().get("batch")).get(0);
        assertEquals("identify", first.get("type"));
        assertEquals("u0", first.get("userId"));
        assertEquals(249, res.received());
        assertEquals(1, res.errors().size());
        assertEquals(103, res.errors().get(0).index());
        assertEquals("plan_limit", res.errors().get(0).code());
        assertEquals("at limit", res.errors().get(0).message());
    }

    @Test
    void batchRejectsABadItemBeforeSendingAnything() {
        LoomailException e = thrown(() -> client().batch(List.of(BatchItem.identify("u1", null), BatchItem.track("u2", "", null))));
        assertEquals(Code.INVALID_ARGUMENT, e.code());
        assertTrue(e.getMessage().contains("batch[1]"));
        assertTrue(seen.isEmpty());
    }

    @Test
    void batchSplitsOnSizeTooAndAnEmptyBatchSendsNothing() {
        responder = (n, s, r) -> r.json(200, "{\"received\":1}");
        String big = "x".repeat(120 * 1024);
        List<BatchItem> items = new ArrayList<>();
        for (String u : new String[] {"a", "b", "c", "d"}) {
            items.add(BatchItem.track(u, "e", Map.of("p", big)));
        }
        client().batch(items);
        assertTrue(seen.size() >= 2);
        seen.forEach(s -> assertTrue(s.raw().length() < 512 * 1024));
        seen.clear();
        assertEquals(0, client().batch(List.of()).received());
        assertTrue(seen.isEmpty());
    }

    @Test
    void anInterruptedThreadStopsTheCallAndKeepsTheInterruptFlag() {
        responder = (n, s, r) -> r.json(503, "");
        Loomail c = builder().sleeper(ms -> {
            throw new InterruptedException();
        }).build();
        LoomailException e = thrown(() -> c.track("u1", "e", Map.of()));
        assertEquals(Code.NETWORK, e.code());
        assertTrue(Thread.interrupted(), "the interrupt flag is restored (and cleared here)");
        assertNull(e.body());
    }
}
