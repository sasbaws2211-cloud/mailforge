/**
 * Provider resolution helper - tenant lookup through the stored configs, decrypt,
 * metering and failover, down to one ready-to-call LlmProvider.
 *
 * Lives in packages/worker because it touches the database and the crypto
 * envelope (@mailforge/adapters decrypt). brain-oss must not gain any
 * knowledge of tenants, llm_configs, or encryption; it receives an
 * already-constructed LlmProvider as a parameter.
 *
 * Which provider serves a workspace (rule lives in @mailforge/db/llm):
 *   the workspace's own key if it has one, otherwise the operator's providers
 *   (Mailforge AI): primary, then fallback. Calls on the operator's provider
 *   are counted against the plan's monthly AI allowance; calls on the
 *   customer's own key are recorded but never capped.
 *
 * Mirror side: PUBLIC (packages/worker is mirrored).
 */
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { AI_UNAVAILABLE_MESSAGE, aiAllowanceMessage, aiAllowanceSpent, NO_AI_PROVIDER_MESSAGE, type LlmFeature, type LlmSource } from "@mailforge/core";
import { loadLlmCandidates, recordLlmUsage } from "@mailforge/db/llm";
import { decrypt, parseEncryptionKey } from "@mailforge/adapters";
import { buildProviderFromCandidates, type LlmProvider } from "@mailforge/brain-oss";
import { aiAllowanceFor, aiBudgetReached } from "./ai-gate.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Db = NodePgDatabase<Record<string, never>>;

/** Successful provider resolution */
export interface ProviderResolved {
  ok: true;
  provider: LlmProvider;
  /** Where the calls will be served from. */
  source: LlmSource;
}

/** Failed provider resolution with a human-readable reason */
export interface ProviderResolutionFailure {
  ok: false;
  reason: string;
  /**
   * "allowance": the workspace's Mailforge AI tokens for the month are used up.
   * "budget": the operator's monthly dollar budget is used up.
   * Neither is a fault: work should wait, not fail.
   */
  code?: "allowance" | "budget";
}

export type ProviderResolutionResult = ProviderResolved | ProviderResolutionFailure;

// ---------------------------------------------------------------------------
// resolveTenantProvider()
// ---------------------------------------------------------------------------

/**
 * Resolve the provider for a tenant's AI work.
 *
 * Returns a ProviderResolutionFailure with a descriptive reason on any failure.
 * The caller (compile worker, content worker) writes the reason to the
 * relevant error field and returns early.
 */
export async function resolveTenantProvider(
  db: Db,
  tenantId: string,
  feature: LlmFeature = "content",
  now: Date = new Date(),
): Promise<ProviderResolutionResult> {
  // 1. Which providers could serve this tenant
  const found = await loadLlmCandidates(db, tenantId);
  if (found.source === "none") {
    return { ok: false, reason: NO_AI_PROVIDER_MESSAGE };
  }

  // 2. Read ENCRYPTION_KEY
  const encryptionKeyEnv = process.env.ENCRYPTION_KEY;
  if (!encryptionKeyEnv) {
    return {
      ok: false,
      reason:
        "ENCRYPTION_KEY environment variable is not set. Required for decrypting LLM credentials.",
    };
  }
  let key: Buffer;
  try {
    key = parseEncryptionKey(encryptionKeyEnv);
  } catch (err) {
    return {
      ok: false,
      reason: `Failed to decrypt LLM configuration: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // 3. The operator's provider is capped per plan; a customer's own key is not.
  if (found.source === "platform") {
    if (await aiBudgetReached(db, now)) {
      return { ok: false, code: "budget", reason: AI_UNAVAILABLE_MESSAGE };
    }
    const allowance = await aiAllowanceFor(db, tenantId, now);
    if (allowance.limit !== null && aiAllowanceSpent(allowance.limit, allowance.used)) {
      return { ok: false, code: "allowance", reason: aiAllowanceMessage(allowance.planName, allowance.limit) };
    }
  }

  // 4. Decrypt, meter, chain
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
    onFailover: (meta, err) =>
      console.warn(
        `[ai] platform ${meta.slot ?? "provider"} failed for tenant ${tenantId}, trying the next one: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      ),
  });
  if (!built.ok) return { ok: false, reason: built.reason };
  return { ok: true, provider: built.provider, source: built.source };
}
