
import {
  PLANS,
  AI_UNAVAILABLE_MESSAGE,
  aiAllowanceMessage,
  aiAllowanceSpent,
  aiBudgetState,
  plansEnforced,
  startOfMonthUtc,
  NO_AI_PROVIDER_MESSAGE,
  type LlmFeature,
  type LlmSource,
} from "@loomail/core";
import { loadAiBudgetStatus, loadLlmCandidates, platformTokensUsed, recordLlmUsage } from "@loomail/db/llm";
import { decrypt, parseEncryptionKey } from "@loomail/adapters";
import { buildProviderFromCandidates, type LlmProvider } from "@loomail/brain-oss";
import type { Db } from "../plugins/db.js";
import { loadEntitlements } from "../plan/usage.js";

export interface AiStatus {
  /** byok: the workspace's own key. platform: Loomail AI. none: nothing is set up. */
  source: LlmSource | "none";
  /** Loomail AI tokens this month; only meaningful when source is platform. */
  allowance: { limit: number | null; used: number; planName: string };
  /** True when the workspace is on Loomail AI and has used up the month's tokens. */
  spent: boolean;
  /** The operator's monthly dollar budget is used up: Loomail AI is paused for everyone on it. */
  unavailable: boolean;
}

/** Where the workspace's AI comes from right now, and how much of the allowance is left. */
export async function loadAiStatus(db: Db, tenantId: string, now: Date = new Date()): Promise<AiStatus> {
  const found = await loadLlmCandidates(db, tenantId);
  const ent = await loadEntitlements(db, tenantId, now);
  const planName = PLANS[ent.plan].name;
  const limit = ent.limits.aiTokensPerMonth;
  // Tokens spent on the operator's provider count whatever the source is today:
  // a customer who added their own key mid-month still sees what they used.
  const used = plansEnforced() ? await platformTokensUsed(db, tenantId, startOfMonthUtc(now)) : 0;
  const budget = found.source === "platform" ? await loadAiBudgetStatus(db, startOfMonthUtc(now)) : { budgetUsd: null, spentUsd: 0 };
  return {
    source: found.source,
    allowance: { limit, used, planName },
    spent: found.source === "platform" && aiAllowanceSpent(limit, used),
    unavailable: aiBudgetState(budget.budgetUsd, budget.spentUsd) === "reached",
  };
}

export type ApiProviderResult =
  | { ok: true; provider: LlmProvider; source: LlmSource }
  | { ok: false; status: 402 | 422 | 500 | 503; error: string; code?: "ai_allowance" | "ai_unavailable" };

/** Build the provider for a synchronous AI call made from an API route. */
export async function resolveProviderForRequest(
  db: Db,
  tenantId: string,
  feature: LlmFeature,
  now: Date = new Date(),
): Promise<ApiProviderResult> {
  const status = await loadAiStatus(db, tenantId, now);
  if (status.source === "none") {
    return { ok: false, status: 422, error: NO_AI_PROVIDER_MESSAGE };
  }
  if (status.unavailable) {
    return { ok: false, status: 503, code: "ai_unavailable", error: AI_UNAVAILABLE_MESSAGE };
  }
  if (status.spent && status.allowance.limit !== null) {
    return {
      ok: false,
      status: 402,
      code: "ai_allowance",
      error: aiAllowanceMessage(status.allowance.planName, status.allowance.limit),
    };
  }

  const encryptionKeyEnv = process.env.ENCRYPTION_KEY;
  if (!encryptionKeyEnv) return { ok: false, status: 500, error: "ENCRYPTION_KEY not configured." };
  let key: Buffer;
  try {
    key = parseEncryptionKey(encryptionKeyEnv);
  } catch (err) {
    return {
      ok: false,
      status: 500,
      error: `Failed to resolve LLM provider: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const found = await loadLlmCandidates(db, tenantId);
  const built = buildProviderFromCandidates(found.candidates, {
    decrypt: (envelope) => decrypt(envelope, key),
    onUsage: (meta, event) =>
      recordLlmUsage(db, {
        tenantId,
        feature,
        source: meta.source,
        provider: meta.provider,
        model: meta.model,
        promptTokens: event.promptTokens,
        completionTokens: event.completionTokens,
        totalTokens: event.totalTokens,
        costMicros: event.costMicros,
        ok: event.ok,
      }),
  });
  if (!built.ok) return { ok: false, status: 500, error: `Failed to resolve LLM provider: ${built.reason}` };
  return { ok: true, provider: built.provider, source: built.source };
}
