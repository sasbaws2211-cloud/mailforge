/**
 * @loomail/node - server-side client for Loomail's ingestion API.
 *
 * Zero dependencies (uses the global fetch of Node 18+). Sends identify and track
 * calls with a secret key (mf_live_...), retries what is safe to retry, and never
 * double-counts: every call carries a messageId, which Loomail uses to drop repeats.
 *
 *   const loomail = new Loomail({ secretKey: process.env.LOOMAIL_SECRET_KEY! });
 *   await loomail.identify("user_123", { email: "a@b.c", plan: "trial" });
 *   await loomail.track("user_123", "signed_up", { source: "ads" });
 *
 * Methods reject with a LoomailError when Loomail cannot be reached or refuses the
 * call. Awaiting them in a request path means a Loomail outage can fail that request,
 * so for fire-and-forget use attach a catch: `loomail.track(...).catch(log)`.
 */
import { randomUUID } from "node:crypto";

/** Where to send events when `host` / LOOMAIL_HOST is not given. */
export const DEFAULT_HOST = "https://loomail.site";

/** Loomail rejects a batch of more than 100 items or more than 512 KB. */
export const MAX_BATCH_ITEMS = 100;
const MAX_BATCH_BYTES = 400 * 1024; // headroom under the server's 512 KB body limit

export type Timestamp = Date | string;

export interface LoomailOptions {
  /** A secret key (mf_live_...). Never use this in a browser. Defaults to LOOMAIL_SECRET_KEY. */
  secretKey?: string;
  /** Base URL of your Loomail install. Defaults to LOOMAIL_HOST, then https://loomail.site. */
  host?: string;
  /** Per-attempt timeout in milliseconds. Default 10000. */
  timeoutMs?: number;
  /** Retries after the first attempt, on network errors, 429 and 5xx. Default 3. */
  maxRetries?: number;
  /** Replace the HTTP client (tests, proxies). Defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Replace the wait between retries (tests). */
  sleep?: (ms: number) => Promise<void>;
}

export interface CallOptions {
  /** When it happened. Loomail re-dates anything more than 72 hours from its own clock. */
  timestamp?: Timestamp;
  /** Your own idempotency key, e.g. `paid:${invoiceId}`. Generated when omitted. */
  messageId?: string;
  /** Extra context stored with the event (ip, userAgent, anything else). */
  context?: Record<string, unknown>;
}

export interface CallResult {
  /** True when Loomail had already seen this messageId and ignored the repeat. */
  deduplicated: boolean;
}

export type BatchItem =
  | ({ type: "identify"; userId: string; traits?: Record<string, unknown> } & CallOptions)
  | ({ type: "track"; userId: string; event: string; properties?: Record<string, unknown> } & CallOptions);

export interface BatchError {
  /** Position of the item in the array you passed. */
  index: number;
  message: string;
  /** Set to "plan_limit" when the item was refused because the workspace is at its contact limit. */
  code?: string;
}

export interface BatchResult {
  /** Items Loomail accepted (repeats of a messageId count as accepted). */
  received: number;
  /** Items Loomail refused. The rest of the batch is unaffected. */
  errors: BatchError[];
}

export type LoomailErrorCode =
  | "invalid_argument" // caught before any request was made
  | "unauthorized" // 401: key missing, wrong or revoked
  | "forbidden" // 403: key not allowed here
  | "plan_limit" // 402: workspace is at its contact limit
  | "validation" // 400 / 422: Loomail did not accept the payload
  | "rate_limited" // 429, still failing after retries
  | "server" // 5xx, still failing after retries
  | "network"; // could not reach Loomail, or it did not answer in time

export class LoomailError extends Error {
  readonly code: LoomailErrorCode;
  /** HTTP status, absent for invalid_argument and network errors. */
  readonly status?: number;
  /** Parsed response body when Loomail sent one. */
  readonly body?: unknown;

  constructor(code: LoomailErrorCode, message: string, extra: { status?: number; body?: unknown; cause?: unknown } = {}) {
    super(message, extra.cause !== undefined ? { cause: extra.cause } : undefined);
    this.name = "LoomailError";
    this.code = code;
    this.status = extra.status;
    this.body = extra.body;
  }
}

function toIso(ts: Timestamp | undefined): string | undefined {
  if (ts === undefined) return undefined;
  const d = ts instanceof Date ? ts : new Date(ts);
  if (Number.isNaN(d.getTime())) {
    throw new LoomailError("invalid_argument", `timestamp is not a valid date: ${String(ts)}`);
  }
  return d.toISOString();
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new LoomailError("invalid_argument", `${name} must be a non-empty string`);
  }
  return value;
}

function codeForStatus(status: number): LoomailErrorCode {
  if (status === 401) return "unauthorized";
  if (status === 402) return "plan_limit";
  if (status === 403) return "forbidden";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "server";
  return "validation";
}

function messageFor(status: number, body: unknown): string {
  const detail =
    body && typeof body === "object" && "error" in body && typeof (body as { error: unknown }).error === "string"
      ? `: ${(body as { error: string }).error}`
      : "";
  return `Loomail answered ${status}${detail}`;
}

/** Seconds from a Retry-After header, or null when absent or not a number of seconds. */
function retryAfterMs(res: Response): number | null {
  const raw = res.headers.get("retry-after");
  if (!raw) return null;
  const secs = Number(raw);
  return Number.isFinite(secs) && secs >= 0 ? secs * 1000 : null;
}

export class Loomail {
  private readonly secretKey: string;
  private readonly host: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: LoomailOptions = {}) {
    const key = options.secretKey ?? process.env.LOOMAIL_SECRET_KEY;
    if (!key) {
      throw new LoomailError("invalid_argument", "secretKey is required (or set LOOMAIL_SECRET_KEY)");
    }
    if (key.startsWith("mf_pub_")) {
      throw new LoomailError(
        "invalid_argument",
        "That is a publishable key (mf_pub_...), meant for browsers. Server code needs a secret key (mf_live_...).",
      );
    }
    this.secretKey = key;
    this.host = (options.host ?? process.env.LOOMAIL_HOST ?? DEFAULT_HOST).replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.maxRetries = options.maxRetries ?? 3;
    this.fetchFn = options.fetch ?? globalThis.fetch;
    if (typeof this.fetchFn !== "function") {
      throw new LoomailError("invalid_argument", "No fetch available: use Node 18+ or pass options.fetch");
    }
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Create or update a person. Traits merge into what Loomail already knows; a null trait removes it. */
  async identify(userId: string, traits: Record<string, unknown> = {}, options: CallOptions = {}): Promise<CallResult> {
    return this.send("/v1/identify", this.identifyBody(userId, traits, options));
  }

  /** Record something a person did. */
  async track(
    userId: string,
    event: string,
    properties: Record<string, unknown> = {},
    options: CallOptions = {},
  ): Promise<CallResult> {
    return this.send("/v1/track", this.trackBody(userId, event, properties, options));
  }

  /**
   * Send many identify/track items. Splits into requests of at most 100 items (and under the
   * size limit), so any length is fine. A refused item lands in `errors` and does not stop
   * the rest; a request that fails outright (bad key, outage after retries) rejects.
   */
  async batch(items: BatchItem[]): Promise<BatchResult> {
    const prepared = items.map((item, i) => {
      try {
        return item.type === "identify"
          ? { type: "identify" as const, ...this.identifyBody(item.userId, item.traits ?? {}, item) }
          : { type: "track" as const, ...this.trackBody(item.userId, item.event, item.properties ?? {}, item) };
      } catch (e) {
        if (e instanceof LoomailError) {
          throw new LoomailError("invalid_argument", `batch[${i}]: ${e.message}`);
        }
        throw e;
      }
    });

    const result: BatchResult = { received: 0, errors: [] };
    let chunk: typeof prepared = [];
    let chunkBytes = 0;
    let chunkStart = 0;

    const flush = async () => {
      if (chunk.length === 0) return;
      const res = (await this.post("/v1/batch", { batch: chunk })) as Partial<BatchResult>;
      result.received += res.received ?? 0;
      for (const err of res.errors ?? []) {
        result.errors.push({ ...err, index: err.index + chunkStart });
      }
      chunkStart += chunk.length;
      chunk = [];
      chunkBytes = 0;
    };

    for (const item of prepared) {
      const size = JSON.stringify(item).length + 1;
      if (chunk.length >= MAX_BATCH_ITEMS || (chunk.length > 0 && chunkBytes + size > MAX_BATCH_BYTES)) {
        await flush();
      }
      chunk.push(item);
      chunkBytes += size;
    }
    await flush();
    return result;
  }

  // ---------------------------------------------------------------------

  private identifyBody(userId: string, traits: Record<string, unknown>, options: CallOptions) {
    return {
      userId: requireString(userId, "userId"),
      traits,
      timestamp: toIso(options.timestamp),
      context: options.context,
      messageId: options.messageId ?? randomUUID(),
    };
  }

  private trackBody(userId: string, event: string, properties: Record<string, unknown>, options: CallOptions) {
    return {
      userId: requireString(userId, "userId"),
      event: requireString(event, "event"),
      properties,
      timestamp: toIso(options.timestamp),
      context: options.context,
      messageId: options.messageId ?? randomUUID(),
    };
  }

  private async send(path: string, body: object): Promise<CallResult> {
    const res = (await this.post(path, body)) as { deduplicated?: boolean } | null;
    return { deduplicated: res?.deduplicated === true };
  }

  /** One POST with retries. Every body here carries a messageId, so repeating it is safe. */
  private async post(path: string, body: object): Promise<unknown> {
    const payload = JSON.stringify(body);
    for (let attempt = 0; ; attempt++) {
      let waitMs: number;
      try {
        const res = await this.fetchFn(this.host + path, {
          method: "POST",
          headers: { Authorization: `Bearer ${this.secretKey}`, "Content-Type": "application/json" },
          body: payload,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        const text = await res.text();
        let parsed: unknown = null;
        try {
          parsed = text ? JSON.parse(text) : null;
        } catch {
          parsed = text;
        }
        if (res.ok) return parsed;

        const retryable = res.status === 429 || res.status >= 500;
        if (!retryable || attempt >= this.maxRetries) {
          throw new LoomailError(codeForStatus(res.status), messageFor(res.status, parsed), {
            status: res.status,
            body: parsed,
          });
        }
        waitMs = retryAfterMs(res) ?? backoffMs(attempt);
      } catch (e) {
        if (e instanceof LoomailError) throw e;
        if (attempt >= this.maxRetries) {
          throw new LoomailError("network", `Could not reach Loomail at ${this.host}: ${(e as Error).message}`, {
            cause: e,
          });
        }
        waitMs = backoffMs(attempt);
      }
      await this.sleep(Math.min(waitMs, 30_000));
    }
  }
}

/** 0.5s, 1s, 2s... with up to 25% jitter. */
function backoffMs(attempt: number): number {
  const base = 500 * 2 ** attempt;
  return base + Math.random() * base * 0.25;
}
