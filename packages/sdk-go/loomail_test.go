package loomail

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"
)

type seen struct {
	Path string
	Auth string
	CT   string
	Body map[string]any
	Raw  string
}

// fake is a real local HTTP server standing in for Loomail.
type fake struct {
	*httptest.Server
	mu      sync.Mutex
	seen    []seen
	respond func(n int, s seen, w http.ResponseWriter)
}

func newFake(t *testing.T) *fake {
	f := &fake{}
	f.respond = func(n int, s seen, w http.ResponseWriter) { writeJSON(w, 200, map[string]any{"success": true}) }
	f.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var body map[string]any
		_ = json.Unmarshal(raw, &body)
		s := seen{Path: r.URL.Path, Auth: r.Header.Get("Authorization"), CT: r.Header.Get("Content-Type"), Body: body, Raw: string(raw)}
		f.mu.Lock()
		f.seen = append(f.seen, s)
		n := len(f.seen)
		f.mu.Unlock()
		f.respond(n, s, w)
	}))
	t.Cleanup(f.Close)
	return f
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func (f *fake) client(t *testing.T, extra ...Option) *Client {
	c, err := New(append([]Option{WithSecretKey("mf_live_test"), WithHost(f.URL)}, extra...)...)
	if err != nil {
		t.Fatal(err)
	}
	c.sleep = func(ctx context.Context, d time.Duration) error { return nil }
	return c
}

func code(t *testing.T, err error) ErrorCode {
	t.Helper()
	var e *Error
	if !errors.As(err, &e) {
		t.Fatalf("expected *Error, got %T %v", err, err)
	}
	return e.Code
}

func TestIdentifySendsBearerKeyTraitsAndGeneratedMessageID(t *testing.T) {
	f := newFake(t)
	if _, err := f.client(t).Identify(context.Background(), "u1", map[string]any{"email": "a@b.c", "plan": "trial"}); err != nil {
		t.Fatal(err)
	}
	s := f.seen[0]
	if s.Path != "/v1/identify" || s.Auth != "Bearer mf_live_test" || s.CT != "application/json" {
		t.Fatalf("bad request: %+v", s)
	}
	if s.Body["userId"] != "u1" || s.Body["traits"].(map[string]any)["email"] != "a@b.c" {
		t.Fatalf("bad body: %v", s.Body)
	}
	if !regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`).MatchString(s.Body["messageId"].(string)) {
		t.Fatalf("messageId is not a v4 uuid: %v", s.Body["messageId"])
	}
	if _, ok := s.Body["timestamp"]; ok {
		t.Fatal("timestamp should be omitted when not given")
	}
	if _, ok := s.Body["context"]; ok {
		t.Fatal("context should be omitted when not given")
	}
}

func TestEmptyTraitsAndPropertiesAreObjectsNotNull(t *testing.T) {
	f := newFake(t)
	c := f.client(t)
	_, _ = c.Identify(context.Background(), "u1", nil)
	_, _ = c.Track(context.Background(), "u1", "e", nil)
	if !strings.Contains(f.seen[0].Raw, `"traits":{}`) || !strings.Contains(f.seen[1].Raw, `"properties":{}`) {
		t.Fatalf("expected empty objects: %s | %s", f.seen[0].Raw, f.seen[1].Raw)
	}
}

func TestTrackSendsPropertiesContextAndUTCTimestamp(t *testing.T) {
	f := newFake(t)
	when := time.Date(2026, 5, 1, 12, 0, 0, 0, time.FixedZone("x", 2*3600)) // 10:00 UTC
	_, err := f.client(t).Track(context.Background(), "u1", "paid", map[string]any{"amount": 4900},
		WithTimestamp(when), WithContext(map[string]any{"ip": "1.2.3.4"}))
	if err != nil {
		t.Fatal(err)
	}
	b := f.seen[0].Body
	if b["timestamp"] != "2026-05-01T10:00:00.000Z" || b["event"] != "paid" || b["properties"].(map[string]any)["amount"] != float64(4900) || b["context"].(map[string]any)["ip"] != "1.2.3.4" {
		t.Fatalf("bad body: %v", b)
	}
}

func TestOwnMessageIDAndDeduplicatedRepeat(t *testing.T) {
	f := newFake(t)
	f.respond = func(n int, s seen, w http.ResponseWriter) {
		writeJSON(w, 200, map[string]any{"success": true, "deduplicated": true})
	}
	r, err := f.client(t).Track(context.Background(), "u1", "paid", nil, WithMessageID("paid:inv_9"))
	if err != nil || !r.Deduplicated || f.seen[0].Body["messageId"] != "paid:inv_9" {
		t.Fatalf("r=%+v err=%v body=%v", r, err, f.seen[0].Body)
	}
}

func TestEmptyArgumentsAreRejectedBeforeAnyRequest(t *testing.T) {
	f := newFake(t)
	c := f.client(t)
	_, e1 := c.Identify(context.Background(), "  ", nil)
	_, e2 := c.Track(context.Background(), "u1", "", nil)
	if code(t, e1) != ErrInvalidArgument || code(t, e2) != ErrInvalidArgument || len(f.seen) != 0 {
		t.Fatalf("e1=%v e2=%v requests=%d", e1, e2, len(f.seen))
	}
}

func TestNewRefusesAMissingOrPublishableKey(t *testing.T) {
	t.Setenv("LOOMAIL_SECRET_KEY", "")
	if _, err := New(); err == nil || code(t, err) != ErrInvalidArgument {
		t.Fatalf("missing key: %v", err)
	}
	_, err := New(WithSecretKey("mf_pub_abc"))
	if err == nil || code(t, err) != ErrInvalidArgument || !strings.Contains(err.Error(), "publishable") {
		t.Fatalf("publishable key: %v", err)
	}
}

func TestHostAndKeyFromEnvironmentAndTrailingSlash(t *testing.T) {
	t.Setenv("LOOMAIL_SECRET_KEY", "mf_live_env")
	t.Setenv("LOOMAIL_HOST", "https://loomail.example.com///")
	c, err := New()
	if err != nil || c.secretKey != "mf_live_env" || c.host != "https://loomail.example.com" {
		t.Fatalf("c=%+v err=%v", c, err)
	}
	t.Setenv("LOOMAIL_HOST", "")
	c, _ = New()
	if c.host != DefaultHost {
		t.Fatalf("default host: %s", c.host)
	}
}

func TestRetriesA503WithTheSameMessageIDThenSucceeds(t *testing.T) {
	f := newFake(t)
	f.respond = func(n int, s seen, w http.ResponseWriter) {
		if n < 3 {
			writeJSON(w, 503, map[string]any{"error": "busy"})
			return
		}
		writeJSON(w, 200, map[string]any{"success": true})
	}
	if _, err := f.client(t).Track(context.Background(), "u1", "e", nil); err != nil {
		t.Fatal(err)
	}
	if len(f.seen) != 3 || f.seen[0].Body["messageId"] != f.seen[1].Body["messageId"] || f.seen[1].Body["messageId"] != f.seen[2].Body["messageId"] {
		t.Fatalf("expected 3 attempts with one messageId: %v", f.seen)
	}
}

func TestHonoursRetryAfter(t *testing.T) {
	f := newFake(t)
	f.respond = func(n int, s seen, w http.ResponseWriter) {
		if n == 1 {
			w.Header().Set("Retry-After", "7")
			writeJSON(w, 429, map[string]any{"error": "slow down"})
			return
		}
		writeJSON(w, 200, map[string]any{"success": true})
	}
	var waited []time.Duration
	c := f.client(t)
	c.sleep = func(ctx context.Context, d time.Duration) error { waited = append(waited, d); return nil }
	if _, err := c.Track(context.Background(), "u1", "e", nil); err != nil {
		t.Fatal(err)
	}
	if len(waited) != 1 || waited[0] != 7*time.Second {
		t.Fatalf("waited %v", waited)
	}
}

func TestGivesUpAfterMaxRetriesAndSaysWhy(t *testing.T) {
	f := newFake(t)
	f.respond = func(n int, s seen, w http.ResponseWriter) { writeJSON(w, 429, map[string]any{"error": "too many"}) }
	_, err := f.client(t, WithMaxRetries(2)).Track(context.Background(), "u1", "e", nil)
	var e *Error
	if !errors.As(err, &e) || e.Code != ErrRateLimited || e.Status != 429 || len(f.seen) != 3 || !strings.Contains(e.Message, "too many") {
		t.Fatalf("err=%v attempts=%d", err, len(f.seen))
	}
	f2 := newFake(t)
	f2.respond = func(n int, s seen, w http.ResponseWriter) { writeJSON(w, 500, nil) }
	_, err = f2.client(t, WithMaxRetries(0)).Track(context.Background(), "u1", "e", nil)
	if code(t, err) != ErrServer || len(f2.seen) != 1 {
		t.Fatalf("no retries: %v attempts=%d", err, len(f2.seen))
	}
}

func TestDoesNotRetryAMistake(t *testing.T) {
	for status, want := range map[int]ErrorCode{401: ErrUnauthorized, 402: ErrPlanLimit, 403: ErrForbidden, 400: ErrValidation, 422: ErrValidation} {
		f := newFake(t)
		f.respond = func(n int, s seen, w http.ResponseWriter) { writeJSON(w, status, map[string]any{"error": "no"}) }
		_, err := f.client(t).Track(context.Background(), "u1", "e", nil)
		if code(t, err) != want || len(f.seen) != 1 {
			t.Fatalf("status %d: err=%v attempts=%d", status, err, len(f.seen))
		}
	}
}

func TestNetworkFailureAndTimeoutAreNetworkErrors(t *testing.T) {
	f := newFake(t)
	url := f.URL
	f.Close()
	c, _ := New(WithSecretKey("mf_live_t"), WithHost(url), WithMaxRetries(1))
	c.sleep = func(ctx context.Context, d time.Duration) error { return nil }
	if _, err := c.Track(context.Background(), "u1", "e", nil); code(t, err) != ErrNetwork {
		t.Fatalf("dead port: %v", err)
	}
	slow := newFake(t)
	slow.respond = func(n int, s seen, w http.ResponseWriter) { time.Sleep(300 * time.Millisecond); writeJSON(w, 200, nil) }
	c2 := slow.client(t, WithTimeout(40*time.Millisecond), WithMaxRetries(0))
	if _, err := c2.Track(context.Background(), "u1", "e", nil); code(t, err) != ErrNetwork {
		t.Fatalf("timeout: %v", err)
	}
}

func TestACancelledContextStopsAtOnceWithoutRetrying(t *testing.T) {
	f := newFake(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := f.client(t).Track(ctx, "u1", "e", nil)
	if code(t, err) != ErrNetwork || len(f.seen) != 0 || !errors.Is(err, context.Canceled) {
		t.Fatalf("err=%v attempts=%d", err, len(f.seen))
	}
}

func TestBatchSplitsIntoRequestsOf100AndOffsetsErrorIndexes(t *testing.T) {
	f := newFake(t)
	f.respond = func(n int, s seen, w http.ResponseWriter) {
		items := s.Body["batch"].([]any)
		res := map[string]any{"received": len(items)}
		if n == 2 {
			res["received"] = len(items) - 1
			res["errors"] = []any{map[string]any{"index": 3, "message": "at limit", "code": "plan_limit"}}
		}
		writeJSON(w, 200, res)
	}
	items := make([]BatchItem, 250)
	for i := range items {
		if i%2 == 0 {
			items[i] = IdentifyItem(fmt.Sprintf("u%d", i), map[string]any{"n": i})
		} else {
			items[i] = TrackItem(fmt.Sprintf("u%d", i), "e", nil)
		}
	}
	res, err := f.client(t).Batch(context.Background(), items)
	if err != nil {
		t.Fatal(err)
	}
	if len(f.seen) != 3 || f.seen[0].Path != "/v1/batch" {
		t.Fatalf("requests: %d", len(f.seen))
	}
	sizes := []int{len(f.seen[0].Body["batch"].([]any)), len(f.seen[1].Body["batch"].([]any)), len(f.seen[2].Body["batch"].([]any))}
	if sizes[0] != 100 || sizes[1] != 100 || sizes[2] != 50 {
		t.Fatalf("chunk sizes %v", sizes)
	}
	first := f.seen[0].Body["batch"].([]any)[0].(map[string]any)
	if first["type"] != "identify" || first["userId"] != "u0" {
		t.Fatalf("first item %v", first)
	}
	if res.Received != 249 || len(res.Errors) != 1 || res.Errors[0].Index != 103 || res.Errors[0].Code != "plan_limit" {
		t.Fatalf("result %+v", res)
	}
}

func TestBatchRejectsABadItemBeforeSendingAnything(t *testing.T) {
	f := newFake(t)
	_, err := f.client(t).Batch(context.Background(), []BatchItem{IdentifyItem("u1", nil), TrackItem("u2", "", nil)})
	if code(t, err) != ErrInvalidArgument || !strings.Contains(err.Error(), "batch[1]") || len(f.seen) != 0 {
		t.Fatalf("err=%v requests=%d", err, len(f.seen))
	}
}

func TestBatchSplitsOnSizeToo(t *testing.T) {
	f := newFake(t)
	f.respond = func(n int, s seen, w http.ResponseWriter) {
		writeJSON(w, 200, map[string]any{"received": len(s.Body["batch"].([]any))})
	}
	big := strings.Repeat("x", 120*1024)
	items := []BatchItem{TrackItem("a", "e", map[string]any{"p": big}), TrackItem("b", "e", map[string]any{"p": big}), TrackItem("c", "e", map[string]any{"p": big}), TrackItem("d", "e", map[string]any{"p": big})}
	res, err := f.client(t).Batch(context.Background(), items)
	if err != nil || res.Received != 4 || len(f.seen) < 2 {
		t.Fatalf("res=%+v err=%v requests=%d", res, err, len(f.seen))
	}
}
