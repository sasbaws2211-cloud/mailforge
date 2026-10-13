/**
 * Flow health: a one-word answer to "is this flow doing its job?", with the reason, for the
 * flows list. Pure rules, no I/O: the API gathers the counts.
 *
 *   draft      not running yet (nothing to judge)
 *   paused     the customer paused it
 *   waiting    running for under 3 days: too early to judge
 *   quiet      running, but nothing sent in the last 7 days
 *   attention  bounces or complaints are high enough to risk the sender's reputation
 *   ok         running and sending normally
 *
 * Mirror side: PUBLIC (packages/core is mirrored).
 */

export type FlowHealthState = "draft" | "paused" | "waiting" | "quiet" | "attention" | "ok";

export interface FlowHealthInput {
  status: string;
  /** Emails sent in the last 30 days. */
  sent30: number;
  /** Emails sent in the last 7 days. */
  sent7: number;
  /** Of the last 30 days: how many bounced and how many were reported as spam. */
  bounced30: number;
  complained30: number;
  /** When the flow was last switched on or created, for the "too early to judge" window. */
  activeSince: Date | null;
  now?: Date;
}

export interface FlowHealth {
  state: FlowHealthState;
  /** One sentence a customer can read, or null when there is nothing to say. */
  note: string | null;
}

/** Bounce rate at which a flow needs a look (5%), with enough sends to mean something. */
export const BOUNCE_ATTENTION_RATE = 0.05;
/** Spam-complaint rate at which a flow needs a look (0.3%). */
export const COMPLAINT_ATTENTION_RATE = 0.003;
/** Fewest sends before a rate is trusted. */
export const MIN_SENDS_FOR_RATES = 20;

const DAY = 86_400_000;

export function flowHealth(i: FlowHealthInput): FlowHealth {
  const now = i.now ?? new Date();
  if (i.status === "draft") return { state: "draft", note: null };
  if (i.status === "paused") return { state: "paused", note: null };
  if (i.status !== "active") return { state: "draft", note: null };

  if (i.sent30 >= MIN_SENDS_FOR_RATES) {
    const bounce = i.bounced30 / i.sent30;
    const complaint = i.complained30 / i.sent30;
    if (complaint >= COMPLAINT_ATTENTION_RATE) {
      return {
        state: "attention",
        note: `${(complaint * 100).toFixed(1)}% of recent emails were reported as spam. Pause it and check who it is reaching.`,
      };
    }
    if (bounce >= BOUNCE_ATTENTION_RATE) {
      return {
        state: "attention",
        note: `${Math.round(bounce * 100)}% of recent emails bounced. Check the addresses reaching this flow.`,
      };
    }
  }

  const ageDays = i.activeSince ? (now.getTime() - i.activeSince.getTime()) / DAY : Infinity;
  if (i.sent7 === 0) {
    if (ageDays < 3) return { state: "waiting", note: "Just switched on. Nothing has matched its trigger yet." };
    return { state: "quiet", note: "Active, but nothing sent in the last 7 days. Check that your app is sending the event that starts it." };
  }
  return { state: "ok", note: null };
}
