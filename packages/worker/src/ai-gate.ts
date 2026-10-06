/**
 * AI allowance gate for the worker.
 *
 * When a workspace has no AI key of its own it uses the operator's provider
 * (Mailforge AI), and that use is capped per plan per calendar month (UTC).
 * The cap only applies when plan enforcement is on; with it off (the default,
 * and every self-hosted install) nothing here touches the database.
 *
 * A workspace on its own key is never capped: the customer pays their provider.
 *
 * Policy at the cap, like emails: nothing is dropped. Content generation waits
 * (messages stay queued, untouched) and resumes when the month rolls over, the
 * plan is upgraded, or the customer adds their own key.
 *
 * Mirror side: PUBLIC (packages/worker is mirrored).
 */
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { aiAllowanceSpent, aiBudgetState, plansEnforced, startOfMonthUtc, PLANS } from "@mailforge/core";
import { loadAiBudgetStatus, loadLlmCandidates, platformTokensUsed } from "@mailforge/db/llm";
import { loadTenantEntitlements } from "./plan-gate.js";

type Db = NodePgDatabase<Record<string, never>>;

export interface AiAllowance {
  /** Tokens allowed this month; null = no cap. */
  limit: number | null;
  /** Tokens already spent on the operator's provider this month. */
  used: number;
  planName: string;
}

/** A workspace's AI allowance right now. Cheap when enforcement is off. */
export async function aiAllowanceFor(db: Db, tenantId: string, now: Date): Promise<AiAllowance> {
  if (!plansEnforced()) return { limit: null, used: 0, planName: "" };
  const ent = await loadTenantEntitlements(db, tenantId, now);
  const limit = ent.limits.aiTokensPerMonth;
  const planName = PLANS[ent.plan].name;
  if (limit === null) return { limit, used: 0, planName };
  return { limit, used: await platformTokensUsed(db, tenantId, startOfMonthUtc(now)), planName };
}

/**
 * Has Mailforge AI used up the operator's monthly dollar budget? False when no
 * budget is set (one cheap query then). Applies to workspaces on the operator's
 * provider only; a customer's own key never runs through this.
 */
export async function aiBudgetReached(db: Db, now: Date): Promise<boolean> {
  const s = await loadAiBudgetStatus(db, startOfMonthUtc(now));
  return aiBudgetState(s.budgetUsd, s.spentUsd) === "reached";
}

/**
 * Which of these workspaces are on the operator's provider with the month's
 * allowance spent. Used before a batch is claimed, so their messages are left
 * exactly as they were.
 */
export async function tenantsOutOfAiAllowance(db: Db, tenantIds: string[], now: Date): Promise<Set<string>> {
  const out = new Set<string>();
  const budgetHit = await aiBudgetReached(db, now);
  if (!plansEnforced() && !budgetHit) return out;
  for (const id of tenantIds) {
    const { source } = await loadLlmCandidates(db, id);
    if (source !== "platform") continue;
    if (budgetHit) {
      out.add(id);
      continue;
    }
    const a = await aiAllowanceFor(db, id, now);
    if (aiAllowanceSpent(a.limit, a.used)) out.add(id);
  }
  return out;
}
