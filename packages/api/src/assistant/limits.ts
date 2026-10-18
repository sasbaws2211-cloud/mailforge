/**
 * Who may ask the assistant how often. The operator pays for it, so there is no allowance to run out of, with two guards:
 *
 *   everyone           a short-burst limit per person, so a script cannot hammer it
 *
 * Nobody has a daily cap by default, trial workspaces included. An operator who sees abuse can set LOOMAIL_ASSISTANT_TRIAL_DAILY and/or
 * LOOMAIL_ASSISTANT_FREE_DAILY to cap those workspaces per UTC day. The operator's monthly dollar budget (admin console) still pauses the assistant for everyone when it is reached.
 *
 * Mirror side: PUBLIC (packages/api is mirrored).
 */
import { sql } from "drizzle-orm";
import { TRIAL_PLAN_VALUE, effectivePlan } from "@loomail/core";
import type { Db } from "../plugins/db.js";

export type PlanKind = "trial" | "free" | "paid";

export interface AssistantLimits {
  /** Questions a trial workspace may ask per UTC day; null = unlimited. */
  trialDaily: number | null;
  /** Questions a free (post-trial) workspace may ask per UTC day; null = unlimited. */
  freeDaily: number | null;
  /** Questions one person may ask in `burstWindowMs`. */
  burstMax: number;
  burstWindowMs: number;
}

const wholeNumber = (v: string | undefined): number | null => {
  if (v === undefined || v.trim() === "") return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : null;
};

export function limitsFromEnv(env: Record<string, string | undefined> = process.env): AssistantLimits {
  return {
    trialDaily: wholeNumber(env.LOOMAIL_ASSISTANT_TRIAL_DAILY),
    freeDaily: wholeNumber(env.LOOMAIL_ASSISTANT_FREE_DAILY),
    burstMax: 12,
    burstWindowMs: 60_000,
  };
}

/** Which kind of workspace this is, for limits: a running trial, a finished or never-paid one, or one on a paid plan. */
export function planKind(
  tenant: { plan: string | null; trialEndsAt: Date | null; paidThrough: Date | null },
  now: Date = new Date(),
): PlanKind {
  if (tenant.plan === TRIAL_PLAN_VALUE && tenant.trialEndsAt && tenant.trialEndsAt.getTime() > now.getTime()) return "trial";
  return effectivePlan(tenant.plan, tenant.trialEndsAt, now, tenant.paidThrough) === "free" ? "free" : "paid";
}

export interface DailyDecision {
  allowed: boolean;
  /** The daily number for this workspace, or null when there is none. */
  limit: number | null;
  /** Questions left today, or null when there is no daily number. */
  remaining: number | null;
}

/** May a workspace of this kind ask another question, having asked `used` today? */
export function dailyDecision(kind: PlanKind, used: number, limits: AssistantLimits): DailyDecision {
  const limit = kind === "trial" ? limits.trialDaily : kind === "free" ? limits.freeDaily : null;
  if (limit === null) return { allowed: true, limit: null, remaining: null };
  return { allowed: used < limit, limit, remaining: Math.max(0, limit - used) };
}

export const startOfUtcDay = (now: Date): Date => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
export const startOfNextUtcDay = (now: Date): Date => new Date(startOfUtcDay(now).getTime() + 86_400_000);

/**
 * Questions a workspace has asked today (UTC). Counted from the usage log: one row per answered question. A question the provider
 * failed to answer is not counted, so an outage does not eat a trial's day.
 */
export async function questionsToday(db: Db, tenantId: string, now: Date = new Date()): Promise<number> {
  const r = await db.execute<{ n: string }>(sql`
    SELECT count(*)::text AS n FROM llm_usage
    WHERE tenant_id = ${tenantId}::uuid AND feature = 'assistant' AND ok
      AND created_at >= ${startOfUtcDay(now).toISOString()}::timestamptz`);
  return Number(r.rows[0]?.n ?? 0);
}
