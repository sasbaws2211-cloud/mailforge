/**
 * AI provider lookup and usage metering, shared by the API and the worker.
 *
 * Which provider serves a workspace (the one rule, in one place):
 *   1. The workspace's own key (llm_configs, is_active) when it has one. It is
 *      used on its own: a broken own key is reported to its owner, never
 *      silently replaced by the operator's provider.
 *   2. Otherwise the operator's providers (platform_llm_configs), primary first,
 *      then fallback, skipping any that are switched off.
 *   3. Otherwise nothing: the caller explains how to add a key.
 *
 * This module only reads rows and returns the still-encrypted configs. It has
 * no dependency on the crypto package; callers decrypt, build the provider and
 * apply the plan allowance.
 *
 * Mirror side: PUBLIC (drizzle/ is mirrored).
 */
import { and, eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { llmConfigs, llmUsage, platformLlmConfigs, platformSettings } from "../schema/index.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = NodePgDatabase<any>;

export interface LlmCandidate {
  source: "byok" | "platform";
  /** Which platform slot; null for a customer's own key. */
  slot: "primary" | "fallback" | null;
  provider: string;
  /** Encrypted envelope. */
  config: string;
}

export interface LlmCandidates {
  /** byok | platform | none */
  source: "byok" | "platform" | "none";
  /** In the order they should be tried. */
  candidates: LlmCandidate[];
}

export async function loadLlmCandidates(db: AnyDb, tenantId: string): Promise<LlmCandidates> {
  const own = await db
    .select({ provider: llmConfigs.provider, config: llmConfigs.config })
    .from(llmConfigs)
    .where(and(eq(llmConfigs.tenantId, tenantId), eq(llmConfigs.isActive, true)))
    .limit(1);
  if (own.length > 0) {
    return {
      source: "byok",
      candidates: [{ source: "byok", slot: null, provider: own[0]!.provider, config: own[0]!.config }],
    };
  }

  const shared = await db
    .select({ slot: platformLlmConfigs.slot, provider: platformLlmConfigs.provider, config: platformLlmConfigs.config })
    .from(platformLlmConfigs)
    .where(eq(platformLlmConfigs.enabled, true));
  if (shared.length === 0) return { source: "none", candidates: [] };
  // Primary first, whatever order the rows come back in.
  shared.sort((a, b) => (a.slot === b.slot ? 0 : a.slot === "primary" ? -1 : 1));
  return {
    source: "platform",
    candidates: shared.map((r) => ({
      source: "platform" as const,
      slot: r.slot === "fallback" ? ("fallback" as const) : ("primary" as const),
      provider: r.provider,
      config: r.config,
    })),
  };
}

/** Tokens a workspace has spent on the operator's provider since `since`. */
export async function platformTokensUsed(db: AnyDb, tenantId: string, since: Date): Promise<number> {
  const r = await db.execute<{ n: string }>(sql`
    SELECT COALESCE(sum(total_tokens), 0)::text AS n FROM llm_usage
    WHERE tenant_id = ${tenantId}::uuid AND source = 'platform'
      AND created_at >= ${since.toISOString()}::timestamptz`);
  return Number(r.rows[0]?.n ?? 0);
}

export interface LlmUsageRecord {
  tenantId: string;
  feature: string;
  source: "byok" | "platform";
  provider: string;
  model?: string | null;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  /** Millionths of a US dollar. Leave out for calls that cost the operator nothing. */
  costMicros?: number;
  ok: boolean;
}

/** Record one AI call. Never throws: a metering failure must not fail the work it measures. */
export async function recordLlmUsage(db: AnyDb, rec: LlmUsageRecord): Promise<void> {
  try {
    const prompt = Math.max(0, Math.trunc(rec.promptTokens ?? 0));
    const completion = Math.max(0, Math.trunc(rec.completionTokens ?? 0));
    const total = Math.max(0, Math.trunc(rec.totalTokens ?? prompt + completion));
    await db.insert(llmUsage).values({
      tenantId: rec.tenantId,
      feature: rec.feature,
      source: rec.source,
      provider: rec.provider,
      model: rec.model ?? null,
      promptTokens: prompt,
      completionTokens: completion,
      totalTokens: total,
      costMicros: Math.max(0, Math.round(rec.costMicros ?? 0)),
      ok: rec.ok,
    });
  } catch (err) {
    console.error(
      `[llm-usage] could not record usage for tenant ${rec.tenantId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** The settings key that holds the operator's monthly AI budget. */
export const AI_BUDGET_KEY = "ai_budget_usd";

export interface AiBudgetStatus {
  /** The monthly budget in US dollars, or null when none is set. */
  budgetUsd: number | null;
  /** What Mailforge AI has cost this calendar month so far (0 when no budget is set and spend was not asked for). */
  spentUsd: number;
}

/** The operator's monthly AI budget in dollars, or null. */
export async function loadAiBudgetUsd(db: AnyDb): Promise<number | null> {
  const [row] = await db.select({ value: platformSettings.value }).from(platformSettings).where(eq(platformSettings.key, AI_BUDGET_KEY)).limit(1);
  const v = (row?.value as { monthly_usd?: unknown } | undefined)?.monthly_usd;
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * The budget and this month's spend on the operator's provider. With no budget
 * set the spend query is skipped (nothing needs it) unless `alwaysSpend` is true.
 */
export async function loadAiBudgetStatus(db: AnyDb, since: Date, opts: { alwaysSpend?: boolean } = {}): Promise<AiBudgetStatus> {
  const budgetUsd = await loadAiBudgetUsd(db);
  if (budgetUsd === null && !opts.alwaysSpend) return { budgetUsd, spentUsd: 0 };
  const r = await db.execute<{ n: string }>(sql`
    SELECT COALESCE(sum(cost_micros), 0)::text AS n FROM llm_usage
    WHERE source = 'platform' AND created_at >= ${since.toISOString()}::timestamptz`);
  return { budgetUsd, spentUsd: Number(r.rows[0]?.n ?? 0) / 1_000_000 };
}
