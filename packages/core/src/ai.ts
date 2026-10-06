/**
 * AI provider rules shared by the API, the worker and the dashboard.
 *
 * Where a workspace's AI calls are served from:
 *   byok      the customer's own key, saved in Settings. Used whenever it exists.
 *             Never counted against the plan allowance: the customer pays their
 *             provider directly.
 *   platform  the operator's provider ("Mailforge AI"), set in the admin console.
 *             Used when the customer has no key of their own. Counted against the
 *             plan's monthly token allowance when plan enforcement is on.
 *
 * Pure functions, no I/O.
 *
 * Mirror side: PUBLIC (packages/core is mirrored).
 */

export const LLM_SOURCES = ["byok", "platform"] as const;
export type LlmSource = (typeof LLM_SOURCES)[number];

/** The operator's provider has a main slot and an optional backup used when the main one fails. */
export const PLATFORM_LLM_SLOTS = ["primary", "fallback"] as const;
export type PlatformLlmSlot = (typeof PLATFORM_LLM_SLOTS)[number];

export function isPlatformLlmSlot(v: unknown): v is PlatformLlmSlot {
  return typeof v === "string" && (PLATFORM_LLM_SLOTS as readonly string[]).includes(v);
}

/** What each recorded AI call was for. */
export const LLM_FEATURES = ["compile", "content", "ai_draft", "embedding"] as const;
export type LlmFeature = (typeof LLM_FEATURES)[number];

/** The name customers see for the operator's provider. The real vendor and model are never shown. */
export const PLATFORM_AI_NAME = "Mailforge AI";

/** Rough token count for text, for calls whose provider does not report usage (about 4 characters a token). */
export function estimateTokens(text: string): number {
  return text.length === 0 ? 0 : Math.ceil(text.length / 4);
}

/** True when a monthly allowance is fully spent. null (unlimited) never is. */
export function aiAllowanceSpent(limit: number | null, used: number): boolean {
  return limit !== null && used >= limit;
}

/** Why AI is unavailable once the allowance is gone; safe to show to the customer. */
export function aiAllowanceMessage(planName: string, limit: number): string {
  return (
    `Your ${planName} plan's ${limit.toLocaleString("en-US")} Mailforge AI tokens for this month are used up. ` +
    "Upgrade your plan or add your own AI key in Settings to keep going."
  );
}

/** What a customer sees when neither their own key nor a platform provider exists. */
export const NO_AI_PROVIDER_MESSAGE =
  "No LLM configuration found. Add an LLM provider in Settings before compiling flows.";

// ---------------------------------------------------------------------------
// Cost
// ---------------------------------------------------------------------------

/** Highest price per million tokens an admin may enter, in US dollars. A typo guard, not a market limit. */
export const MAX_PRICE_USD_PER_MTOK = 1000;

/** A valid price: a finite number from 0 to MAX_PRICE_USD_PER_MTOK. */
export function isValidPriceUsdPerMtok(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= MAX_PRICE_USD_PER_MTOK;
}

/**
 * What a call cost, in millionths of a dollar. A price is dollars per million
 * tokens, so price x tokens is already in millionths of a dollar: no scaling.
 * Missing prices count as free (the admin has not said what the provider costs).
 */
export function costMicros(
  promptTokens: number,
  completionTokens: number,
  inputPriceUsdPerMtok: number | null | undefined,
  outputPriceUsdPerMtok: number | null | undefined,
): number {
  const input = Math.max(0, promptTokens) * (inputPriceUsdPerMtok ?? 0);
  const output = Math.max(0, completionTokens) * (outputPriceUsdPerMtok ?? 0);
  return Math.round(input + output);
}

/** Millionths of a dollar as dollars. */
export const microsToUsd = (micros: number): number => micros / 1_000_000;

// ---------------------------------------------------------------------------
// Failure-rate alert
// ---------------------------------------------------------------------------

/** How far back the failure rate looks. */
export const AI_ALERT_WINDOW_MINUTES = 15;
/** Fewest calls in the window before the rate means anything (three failures out of four is noise). */
export const AI_ALERT_MIN_CALLS = 10;
/** Share of failed calls at or above which the provider is considered unhealthy. */
export const AI_ALERT_FAIL_RATE = 0.5;
/** While a problem lasts, remind at most this often. */
export const AI_ALERT_COOLDOWN_MINUTES = 60;

export interface AiHealth {
  windowMinutes: number;
  calls: number;
  failed: number;
  /** 0..1; 0 when there were no calls. */
  rate: number;
  unhealthy: boolean;
}

/** Is the operator's AI failing? Judged only on the operator's provider, never on customers' own keys. */
export function aiHealth(
  calls: number,
  failed: number,
  opts: { minCalls?: number; failRate?: number; windowMinutes?: number } = {},
): AiHealth {
  const minCalls = opts.minCalls ?? AI_ALERT_MIN_CALLS;
  const failRate = opts.failRate ?? AI_ALERT_FAIL_RATE;
  const rate = calls > 0 ? failed / calls : 0;
  return {
    windowMinutes: opts.windowMinutes ?? AI_ALERT_WINDOW_MINUTES,
    calls,
    failed,
    rate,
    unhealthy: calls >= minCalls && rate >= failRate,
  };
}

/**
 * Should an email go out now? Yes when the problem is new (nothing sent since it
 * began), or it has lasted past the cooldown since the last email. Never while healthy.
 */
export function shouldSendAiAlert(
  health: Pick<AiHealth, "unhealthy">,
  state: { active: boolean; lastSentAt: Date | null } | null,
  now: Date,
  cooldownMinutes: number = AI_ALERT_COOLDOWN_MINUTES,
): boolean {
  if (!health.unhealthy) return false;
  if (!state || !state.active || !state.lastSentAt) return true;
  return now.getTime() - state.lastSentAt.getTime() >= cooldownMinutes * 60_000;
}

// ---------------------------------------------------------------------------
// Monthly dollar budget
// ---------------------------------------------------------------------------

/** Share of the budget at which the operator is warned. */
export const AI_BUDGET_NEAR_FRACTION = 0.8;
/** Largest budget an admin may enter (a typo guard). */
export const MAX_AI_BUDGET_USD = 10_000_000;

export type AiBudgetState = "none" | "ok" | "near" | "reached";

/** Valid budget: a positive number up to MAX_AI_BUDGET_USD. */
export function isValidAiBudgetUsd(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 && v <= MAX_AI_BUDGET_USD;
}

/** Where spending stands against the budget. No budget means no limit at all. */
export function aiBudgetState(budgetUsd: number | null, spentUsd: number): AiBudgetState {
  if (budgetUsd === null) return "none";
  if (spentUsd >= budgetUsd) return "reached";
  return spentUsd >= budgetUsd * AI_BUDGET_NEAR_FRACTION ? "near" : "ok";
}

/**
 * What a customer is told when the operator's budget is used up. It says
 * nothing about money, only what to do. Customers on their own key never see it.
 */
export const AI_UNAVAILABLE_MESSAGE =
  "Mailforge AI is temporarily unavailable. Add your own AI key in Settings to keep going, or try again later.";
