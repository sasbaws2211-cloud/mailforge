// Package loomail is the server-side client for Loomail's ingestion API.
//
// It has no dependencies beyond the standard library. It sends identify and track calls with a secret key
// (mf_live_...), retries what is safe to retry, and never double-counts: every call carries a messageId, which Loomail
// uses to drop repeats.
//
//	client, err := loomail.New(loomail.WithSecretKey(os.Getenv("LOOMAIL_SECRET_KEY")))
//	if err != nil { ... }
//	_, err = client.Identify(ctx, "user_123", map[string]any{"email": "a@b.c", "plan": "trial"})
//	_, err = client.Track(ctx, "user_123", "signed_up", map[string]any{"source": "ads"})
//
// Calls return an *Error when Loomail cannot be reached or refuses the call. Calling in a request path means a Loomail
// outage can slow or fail that request, so for fire-and-forget run the call in a goroutine and log the error.
package loomail

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	mrand "math/rand"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
)

// DefaultHost is where events go when no host is given and LOOMAIL_HOST is not set.
const DefaultHost = "https://loomail.site"

// MaxBatchItems is the most items Loomail takes in one batch request. Batch splits longer lists for you.
const MaxBatchItems = 100

const maxBatchBytes = 400 * 1024 // headroom under the server's 512 KB body limit

// ErrorCode says what kind of failure an *Error is.
type ErrorCode string

const (
	// ErrInvalidArgument: caught before any request was made.
	ErrInvalidArgument ErrorCode = "invalid_argument"
	// ErrUnauthorized: 401, the key is missing, wrong or revoked.
	ErrUnauthorized ErrorCode = "unauthorized"
	// ErrForbidden: 403, the key is not allowed here.
	ErrForbidden ErrorCode = "forbidden"
	// ErrPlanLimit: 402, the workspace is at its contact limit.
	ErrPlanLimit ErrorCode = "plan_limit"
	// ErrValidation: 400 or 422, Loomail did not accept the payload.
	ErrValidation ErrorCode = "validation"
	// ErrRateLimited: 429, still failing after retries.
	ErrRateLimited ErrorCode = "rate_limited"
	// ErrServer: 5xx, still failing after retries.
	ErrServer ErrorCode = "server"
	// ErrNetwork: Loomail could not be reached, or did not answer in time.
	ErrNetwork ErrorCode = "network"
)

// Error is what every failing call returns.
type Error struct {
	Code ErrorCode
	// Message is safe to log.
	Message string
	// Status is the HTTP status; zero for invalid_argument and network errors.
	Status int
	// Body is the parsed response body when Loomail sent one.
	Body any
	// Err is the underlying cause, when there is one.
	Err error
}

func (e *Error) Error() string { return "loomail: " + e.Message }
func (e *Error) Unwrap() error { return e.Err }

func newErr(code ErrorCode, format string, args ...any) *Error {
	return &Error{Code: code, Message: fmt.Sprintf(format, args...)}
}

// Client sends events to Loomail. It is safe for concurrent use.
type Client struct {
	secretKey  string
	host       string
	timeout    time.Duration
	maxRetries int
	http       *http.Client
	sleep      func(ctx context.Context, d time.Duration) error
}

// Option configures a Client.
type Option func(*Client)

// WithSecretKey sets the secret key (mf_live_...). Defaults to the LOOMAIL_SECRET_KEY environment variable.
func WithSecretKey(key string) Option { return func(c *Client) { c.secretKey = key } }

// WithHost sets the base URL of your Loomail install. Defaults to LOOMAIL_HOST, then https://loomail.site.
func WithHost(host string) Option { return func(c *Client) { c.host = host } }

// WithTimeout sets the time allowed for each attempt. Default 10 seconds.
func WithTimeout(d time.Duration) Option { return func(c *Client) { c.timeout = d } }

// WithMaxRetries sets the retries after the first attempt, on network errors, 429 and 5xx. Default 3. Zero disables retries.
func WithMaxRetries(n int) Option { return func(c *Client) { c.maxRetries = n } }

// WithHTTPClient replaces the HTTP client (proxies, tests).
func WithHTTPClient(h *http.Client) Option { return func(c *Client) { c.http = h } }

// New makes a Client. It fails with an *Error (ErrInvalidArgument) when the key is missing or is a publishable key.
func New(opts ...Option) (*Client, error) {
	c := &Client{timeout: 10 * time.Second, maxRetries: 3, http: &http.Client{}, sleep: sleepCtx}
	for _, o := range opts {
		o(c)
	}
	if c.secretKey == "" {
		c.secretKey = os.Getenv("LOOMAIL_SECRET_KEY")
	}
	if c.secretKey == "" {
		return nil, newErr(ErrInvalidArgument, "a secret key is required (WithSecretKey, or set LOOMAIL_SECRET_KEY)")
	}
	if strings.HasPrefix(c.secretKey, "mf_pub_") {
		return nil, newErr(ErrInvalidArgument, "that is a publishable key (mf_pub_...), meant for browsers; server code needs a secret key (mf_live_...)")
	}
	if c.host == "" {
		c.host = os.Getenv("LOOMAIL_HOST")
	}
	if c.host == "" {
		c.host = DefaultHost
	}
	c.host = strings.TrimRight(c.host, "/")
	if c.maxRetries < 0 {
		c.maxRetries = 0
	}
	return c, nil
}

// CallOptions are the optional parts of a call. Build them with CallOption functions.
type CallOptions struct {
	// Timestamp is when it happened. Loomail re-dates anything more than 72 hours from its own clock.
	Timestamp time.Time
	// MessageID is your own idempotency key, such as "paid:"+invoiceID. Generated when empty.
	MessageID string
	// Context is extra data stored with the event (ip, userAgent, anything else).
	Context map[string]any
}

// CallOption sets one optional part of a call.
type CallOption func(*CallOptions)

// WithTimestamp says when the thing happened.
func WithTimestamp(t time.Time) CallOption { return func(o *CallOptions) { o.Timestamp = t } }

// WithMessageID sets your own idempotency key.
func WithMessageID(id string) CallOption { return func(o *CallOptions) { o.MessageID = id } }

// WithContext adds context stored with the event.
func WithContext(ctx map[string]any) CallOption { return func(o *CallOptions) { o.Context = ctx } }

func collect(opts []CallOption) CallOptions {
	var o CallOptions
	for _, f := range opts {
		f(&o)
	}
	return o
}

// Result is what Identify and Track return.
type Result struct {
	// Deduplicated is true when Loomail had already seen this messageId and ignored the repeat.
	Deduplicated bool
}

// BatchItem is one identify or track in a Batch. Make them with IdentifyItem and TrackItem.
type BatchItem struct {
	Type       string // "identify" or "track"
	UserID     string
	Event      string         // track only
	Traits     map[string]any // identify only
	Properties map[string]any // track only
	Options    CallOptions
}

// IdentifyItem makes an identify item for Batch.
func IdentifyItem(userID string, traits map[string]any, opts ...CallOption) BatchItem {
	return BatchItem{Type: "identify", UserID: userID, Traits: traits, Options: collect(opts)}
}

// TrackItem makes a track item for Batch.
func TrackItem(userID, event string, properties map[string]any, opts ...CallOption) BatchItem {
	return BatchItem{Type: "track", UserID: userID, Event: event, Properties: properties, Options: collect(opts)}
}

// BatchError is an item Loomail refused. The rest of the batch is unaffected.
type BatchError struct {
	// Index is the item's position in the slice you passed.
	Index   int    `json:"index"`
	Message string `json:"message"`
	// Code is "plan_limit" when the item was refused because the workspace is at its contact limit.
	Code string `json:"code,omitempty"`
}

// BatchResult is what Batch returns.
type BatchResult struct {
	// Received is the items Loomail accepted (a repeat of a messageId counts as accepted).
	Received int
	Errors   []BatchError
}

// Identify creates or updates a person. Traits merge into what Loomail already knows; a nil trait value removes it.
func (c *Client) Identify(ctx context.Context, userID string, traits map[string]any, opts ...CallOption) (Result, error) {
	body, err := identifyBody(userID, traits, collect(opts))
	if err != nil {
		return Result{}, err
	}
	return c.send(ctx, "/v1/identify", body)
}

// Track records something a person did.
func (c *Client) Track(ctx context.Context, userID, event string, properties map[string]any, opts ...CallOption) (Result, error) {
	body, err := trackBody(userID, event, properties, collect(opts))
	if err != nil {
		return Result{}, err
	}
	return c.send(ctx, "/v1/track", body)
}

// Batch sends many identify and track items. It splits them into requests of at most 100 items (and under the size
// limit), so any length is fine. A refused item lands in the result's Errors and does not stop the rest; a request that
// fails outright (bad key, an outage after retries) returns an error.
func (c *Client) Batch(ctx context.Context, items []BatchItem) (BatchResult, error) {
	prepared := make([]map[string]any, len(items))
	for i, it := range items {
		var (
			body map[string]any
			err  error
		)
		switch it.Type {
		case "identify":
			body, err = identifyBody(it.UserID, it.Traits, it.Options)
		case "track":
			body, err = trackBody(it.UserID, it.Event, it.Properties, it.Options)
		default:
			err = newErr(ErrInvalidArgument, "type must be \"identify\" or \"track\"")
		}
		if err != nil {
			var le *Error
			if errors.As(err, &le) {
				return BatchResult{}, newErr(ErrInvalidArgument, "batch[%d]: %s", i, le.Message)
			}
			return BatchResult{}, err
		}
		body["type"] = it.Type
		prepared[i] = body
	}

	var result BatchResult
	var chunk []map[string]any
	chunkBytes, chunkStart := 0, 0
	flush := func() error {
		if len(chunk) == 0 {
			return nil
		}
		raw, err := c.post(ctx, "/v1/batch", map[string]any{"batch": chunk})
		if err != nil {
			return err
		}
		var res struct {
			Received int          `json:"received"`
			Errors   []BatchError `json:"errors"`
		}
		_ = json.Unmarshal(raw, &res)
		result.Received += res.Received
		for _, e := range res.Errors {
			e.Index += chunkStart
			result.Errors = append(result.Errors, e)
		}
		chunkStart += len(chunk)
		chunk, chunkBytes = nil, 0
		return nil
	}
	for _, item := range prepared {
		b, _ := json.Marshal(item)
		size := len(b) + 1
		if len(chunk) >= MaxBatchItems || (len(chunk) > 0 && chunkBytes+size > maxBatchBytes) {
			if err := flush(); err != nil {
				return result, err
			}
		}
		chunk = append(chunk, item)
		chunkBytes += size
	}
	if err := flush(); err != nil {
		return result, err
	}
	return result, nil
}

// ---------------------------------------------------------------------------

func requireString(v, name string) error {
	if strings.TrimSpace(v) == "" {
		return newErr(ErrInvalidArgument, "%s must be a non-empty string", name)
	}
	return nil
}

func base(userID string, o CallOptions) (map[string]any, error) {
	if err := requireString(userID, "userId"); err != nil {
		return nil, err
	}
	body := map[string]any{"userId": userID, "messageId": o.MessageID}
	if o.MessageID == "" {
		body["messageId"] = uuid()
	}
	if !o.Timestamp.IsZero() {
		body["timestamp"] = o.Timestamp.UTC().Format("2006-01-02T15:04:05.000Z")
	}
	if o.Context != nil {
		body["context"] = o.Context
	}
	return body, nil
}

func identifyBody(userID string, traits map[string]any, o CallOptions) (map[string]any, error) {
	body, err := base(userID, o)
	if err != nil {
		return nil, err
	}
	if traits == nil {
		traits = map[string]any{}
	}
	body["traits"] = traits
	return body, nil
}

func trackBody(userID, event string, props map[string]any, o CallOptions) (map[string]any, error) {
	body, err := base(userID, o)
	if err != nil {
		return nil, err
	}
	if err := requireString(event, "event"); err != nil {
		return nil, err
	}
	if props == nil {
		props = map[string]any{}
	}
	body["event"] = event
	body["properties"] = props
	return body, nil
}

func uuid() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

func (c *Client) send(ctx context.Context, path string, body map[string]any) (Result, error) {
	raw, err := c.post(ctx, path, body)
	if err != nil {
		return Result{}, err
	}
	var res struct {
		Deduplicated bool `json:"deduplicated"`
	}
	_ = json.Unmarshal(raw, &res)
	return Result{Deduplicated: res.Deduplicated}, nil
}

func codeForStatus(status int) ErrorCode {
	switch {
	case status == 401:
		return ErrUnauthorized
	case status == 402:
		return ErrPlanLimit
	case status == 403:
		return ErrForbidden
	case status == 429:
		return ErrRateLimited
	case status >= 500:
		return ErrServer
	}
	return ErrValidation
}

func messageFor(status int, body any) string {
	if m, ok := body.(map[string]any); ok {
		if s, ok := m["error"].(string); ok {
			return fmt.Sprintf("Loomail answered %d: %s", status, s)
		}
	}
	return fmt.Sprintf("Loomail answered %d", status)
}

// retryAfter reads a Retry-After header given in seconds.
func retryAfter(h http.Header) (time.Duration, bool) {
	raw := h.Get("Retry-After")
	if raw == "" {
		return 0, false
	}
	secs, err := strconv.ParseFloat(raw, 64)
	if err != nil || secs < 0 {
		return 0, false
	}
	return time.Duration(secs * float64(time.Second)), true
}

// backoff is 0.5s, 1s, 2s... with up to 25% jitter.
func backoff(attempt int) time.Duration {
	base := 500 * math.Pow(2, float64(attempt))
	return time.Duration((base + mrand.Float64()*base*0.25) * float64(time.Millisecond))
}

func sleepCtx(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

// post sends one request with retries. Every body here carries a messageId, so repeating it is safe.
func (c *Client) post(ctx context.Context, path string, body any) ([]byte, error) {
	payload, err := json.Marshal(body)
	if err != nil {
		return nil, newErr(ErrInvalidArgument, "the data could not be encoded as JSON: %v", err)
	}
	for attempt := 0; ; attempt++ {
		var wait time.Duration
		raw, status, header, reqErr := c.once(ctx, path, payload)
		switch {
		case reqErr != nil:
			if ctx.Err() != nil { // the caller gave up: do not retry
				return nil, &Error{Code: ErrNetwork, Message: fmt.Sprintf("the call was cancelled: %v", ctx.Err()), Err: ctx.Err()}
			}
			if attempt >= c.maxRetries {
				return nil, &Error{Code: ErrNetwork, Message: fmt.Sprintf("could not reach Loomail at %s: %v", c.host, reqErr), Err: reqErr}
			}
			wait = backoff(attempt)
		case status >= 200 && status < 300:
			return raw, nil
		default:
			var parsed any
			if err := json.Unmarshal(raw, &parsed); err != nil {
				parsed = string(raw)
			}
			retryable := status == 429 || status >= 500
			if !retryable || attempt >= c.maxRetries {
				return nil, &Error{Code: codeForStatus(status), Message: messageFor(status, parsed), Status: status, Body: parsed}
			}
			if d, ok := retryAfter(header); ok {
				wait = d
			} else {
				wait = backoff(attempt)
			}
		}
		if wait > 30*time.Second {
			wait = 30 * time.Second
		}
		if err := c.sleep(ctx, wait); err != nil {
			return nil, &Error{Code: ErrNetwork, Message: fmt.Sprintf("the call was cancelled: %v", err), Err: err}
		}
	}
}

func (c *Client) once(ctx context.Context, path string, payload []byte) ([]byte, int, http.Header, error) {
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.host+path, bytes.NewReader(payload))
	if err != nil {
		return nil, 0, nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.secretKey)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "loomail-go/0.1.0")
	res, err := c.http.Do(req)
	if err != nil {
		return nil, 0, nil, err
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(res.Body, 4<<20))
	if err != nil {
		return nil, 0, nil, err
	}
	return raw, res.StatusCode, res.Header, nil
}
