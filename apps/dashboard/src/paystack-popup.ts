/**
 * Paystack's inline payment popup, and the polling that notices when the payment is done.
 *
 * The popup is Paystack's own script (js.paystack.co), loaded only when a customer actually starts
 * a payment. It is opened with the access code the server got from Paystack, so card details never
 * touch this page or this server. If the script cannot be loaded (blocked, offline) the caller
 * falls back to sending the browser to the hosted checkout page.
 *
 * Whether the popup reports success or not, the page does not trust it: it polls the server, which
 * asks Paystack, and only the server's answer changes the plan.
 *
 * Mirror side: PUBLIC (apps/dashboard is mirrored).
 */

export const PAYSTACK_INLINE_SRC = "https://js.paystack.co/v2/inline.js";

export interface PaystackPopCallbacks {
  onSuccess?: (transaction: unknown) => void;
  onCancel?: () => void;
  onError?: (error: unknown) => void;
}

export interface PaystackPopInstance {
  resumeTransaction(accessCode: string, callbacks?: PaystackPopCallbacks): unknown;
}

export type PaystackPopConstructor = new () => PaystackPopInstance;

declare global {
  interface Window {
    PaystackPop?: PaystackPopConstructor;
  }
}

let loading: Promise<PaystackPopConstructor> | null = null;

/** Load Paystack's inline script once, and resolve with its constructor. Rejects on failure or timeout. */
export function loadPaystackInline(timeoutMs = 10_000): Promise<PaystackPopConstructor> {
  if (typeof window !== "undefined" && window.PaystackPop) return Promise.resolve(window.PaystackPop);
  if (loading) return loading;
  loading = new Promise<PaystackPopConstructor>((resolve, reject) => {
    const script = document.createElement("script");
    const timer = window.setTimeout(() => fail(new Error("Paystack's script took too long to load.")), timeoutMs);
    function fail(err: Error) {
      window.clearTimeout(timer);
      script.remove();
      loading = null; // a later attempt may work
      reject(err);
    }
    script.src = PAYSTACK_INLINE_SRC;
    script.async = true;
    script.onload = () => {
      window.clearTimeout(timer);
      if (window.PaystackPop) resolve(window.PaystackPop);
      else fail(new Error("Paystack's script loaded but did not provide the payment popup."));
    };
    script.onerror = () => fail(new Error("Could not load Paystack's script."));
    document.head.appendChild(script);
  });
  return loading;
}

export type CheckoutPollStatus = "pending" | "paid" | "failed" | "cancelled";

/** How a poll ended: a final answer from the server, the page giving up, or the caller stopping it. */
export type PollOutcome = "paid" | "failed" | "cancelled" | "timeout" | "stopped";

export interface PollOptions {
  /** Time between checks. */
  intervalMs?: number;
  /** Give up after this long without a final answer. */
  timeoutMs?: number;
  /** Checked before every request; true ends the poll with "stopped". */
  shouldStop?: () => boolean;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Ask `fetchStatus` until the checkout is paid, failed or cancelled. A failed request (network
 * blip, server restart) is not a verdict: it is simply tried again at the next tick.
 */
export async function pollCheckoutUntilDone(fetchStatus: () => Promise<{ status: string }>, opts: PollOptions = {}): Promise<PollOutcome> {
  const intervalMs = opts.intervalMs ?? 2_500;
  const timeoutMs = opts.timeoutMs ?? 10 * 60_000;
  const sleep = opts.sleep ?? realSleep;
  const now = opts.now ?? Date.now;
  const started = now();

  for (;;) {
    if (opts.shouldStop?.()) return "stopped";
    try {
      const { status } = await fetchStatus();
      if (status === "paid" || status === "failed" || status === "cancelled") return status;
    } catch {
      /* try again */
    }
    if (now() - started >= timeoutMs) return "timeout";
    await sleep(intervalMs);
  }
}
