/**
 * The assistant's AI provider: the operator's own, always. A workspace's own key is never used (the operator pays for the assistant),
 * and the call is recorded as the "assistant" feature so it counts toward the operator's dollar budget but not a workspace allowance.
 *
 * Mirror side: PUBLIC (packages/api is mirrored).
 */
import { aiBudgetState, startOfMonthUtc } from "@loomail/core";
import { loadAiBudgetStatus, loadPlatformLlmCandidates, recordLlmUsage } from "@loomail/db/llm";
import { decrypt, parseEncryptionKey } from "@loomail/adapters";
import { buildProviderFromCandidates, type LlmProvider } from "@loomail/brain-oss";
import type { Db } from "../plugins/db.js";

export type AssistantProvider =
  | { ok: true; provider: LlmProvider; /** True when usage is recorded by the provider itself. False for a stand-in the caller meters. */ metered: boolean }
  | { ok: false; status: 500 | 503; error: string; code: "assistant_unavailable" | "assistant_error" };

export const ASSISTANT_UNAVAILABLE = "The assistant is not available right now. You can still send a request to Support.";

/** Is there an operator provider switched on, and is the monthly budget still open? Cheap: two small queries. */
export async function assistantAvailable(db: Db, now: Date = new Date()): Promise<boolean> {
  const found = await loadPlatformLlmCandidates(db);
  if (found.source === "none") return false;
  const budget = await loadAiBudgetStatus(db, startOfMonthUtc(now));
  return aiBudgetState(budget.budgetUsd, budget.spentUsd) !== "reached";
}

export async function resolveAssistantProvider(db: Db, tenantId: string, now: Date = new Date()): Promise<AssistantProvider> {
  const found = await loadPlatformLlmCandidates(db);
  if (found.source === "none") return { ok: false, status: 503, code: "assistant_unavailable", error: ASSISTANT_UNAVAILABLE };
  const budget = await loadAiBudgetStatus(db, startOfMonthUtc(now));
  if (aiBudgetState(budget.budgetUsd, budget.spentUsd) === "reached") {
    return { ok: false, status: 503, code: "assistant_unavailable", error: ASSISTANT_UNAVAILABLE };
  }
  const keyEnv = process.env.ENCRYPTION_KEY;
  if (!keyEnv) return { ok: false, status: 500, code: "assistant_error", error: ASSISTANT_UNAVAILABLE };
  let key: Buffer;
  try {
    key = parseEncryptionKey(keyEnv);
  } catch {
    return { ok: false, status: 500, code: "assistant_error", error: ASSISTANT_UNAVAILABLE };
  }
  const built = buildProviderFromCandidates(found.candidates, {
    decrypt: (envelope) => decrypt(envelope, key),
    onUsage: (meta, event) =>
      recordLlmUsage(db, {
        tenantId,
        feature: "assistant",
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
  if (!built.ok) return { ok: false, status: 500, code: "assistant_error", error: ASSISTANT_UNAVAILABLE };
  return { ok: true, provider: built.provider, metered: true };
}
