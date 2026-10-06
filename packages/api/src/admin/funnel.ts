/**
 * Signup funnel for the platform admin console: of the workspaces created through public
 * signup in the last N days, how many got how far.
 *
 * Every stage is "reached", counted on its own from what is in the workspace (an address
 * saved, a flow active, an email sent), not from a chain of earlier stages. A customer who
 * sent an event before adding an address still counts in both, so the stages are not
 * guaranteed to shrink in order; the biggest drop only looks at actual drops.
 *
 * Counts only: no names, addresses or message content leave this file.
 *
 * Mirror side: PUBLIC (packages/api is mirrored).
 */
import { sql } from "drizzle-orm";
import { ONBOARDING_GOALS, type OnboardingGoal } from "@mailforge/core";
import type { Db } from "../plugins/db.js";

export const FUNNEL_WINDOWS = [7, 30, 90] as const;
export type FunnelWindow = (typeof FUNNEL_WINDOWS)[number];

export function parseFunnelWindow(v: unknown): FunnelWindow | null {
  if (v === undefined || v === "") return 30;
  const n = Number(v);
  return (FUNNEL_WINDOWS as readonly number[]).includes(n) ? (n as FunnelWindow) : null;
}

export const FUNNEL_STAGE_IDS = ["signed_up", "signed_in", "address", "sender", "flow", "event", "first_email", "paid"] as const;
export type FunnelStageId = (typeof FUNNEL_STAGE_IDS)[number];

const LABELS: Record<FunnelStageId, string> = {
  signed_up: "Signed up",
  signed_in: "Opened the link and signed in",
  address: "Added a business address",
  sender: "Can send (own transport or Mailforge Sending)",
  flow: "Turned on a flow",
  event: "Sent a first event",
  first_email: "First email delivered",
  paid: "Paying",
};

export interface FunnelStage {
  id: FunnelStageId;
  label: string;
  count: number;
  /** Share of the cohort, whole percent. 0 when the cohort is empty. */
  percent: number;
}

export interface OnboardingFunnel {
  days: FunnelWindow;
  /** Workspaces created through signup in the window. */
  cohort: number;
  stages: FunnelStage[];
  /** The stage where the most workspaces were lost compared with the one before it, or null. */
  biggest_drop: { from: FunnelStageId; to: FunnelStageId; lost: number } | null;
  /** Median hours from signup to first delivered email, among those that got one. */
  median_hours_to_first_email: number | null;
  /** Signed in, no first email yet, more than 24 hours after signup, and not set aside by the customer. */
  stalled: number;
  /** Got at least one stall reminder. */
  nudged: number;
  /** Chose "I will finish this later". */
  set_aside: number;
  /** What the cohort said they wanted at signup. `none` = skipped the question. */
  goals: Record<OnboardingGoal | "none", number>;
  generated_at: string;
}

/** Stages in order whose loss is meaningful (paying is a different question). */
const CHAIN: readonly FunnelStageId[] = ["signed_up", "signed_in", "address", "sender", "flow", "event", "first_email"];

/** Pure: the biggest real drop between neighbouring stages. Ties go to the earlier stage. */
export function biggestDrop(stages: Pick<FunnelStage, "id" | "count">[]): OnboardingFunnel["biggest_drop"] {
  const by = new Map(stages.map((s) => [s.id, s.count]));
  let best: OnboardingFunnel["biggest_drop"] = null;
  for (let i = 1; i < CHAIN.length; i++) {
    const prev = by.get(CHAIN[i - 1]!) ?? 0;
    const cur = by.get(CHAIN[i]!) ?? 0;
    const lost = prev - cur;
    if (lost > 0 && (best === null || lost > best.lost)) best = { from: CHAIN[i - 1]!, to: CHAIN[i]!, lost };
  }
  return best;
}

interface Row extends Record<string, string | null> {
  cohort: string;
  signed_in: string;
  address: string;
  sender: string;
  flow: string;
  event: string;
  first_email: string;
  paid: string;
  stalled: string;
  nudged: string;
  set_aside: string;
  median_hours: string | null;
  g_welcome: string;
  g_convert_trials: string;
  g_upgrade_free: string;
  g_explore: string;
}

/** Pure: goal counts plus `none` for everyone who skipped the question. */
export function goalCounts(cohort: number, byGoal: Record<OnboardingGoal, number>): Record<OnboardingGoal | "none", number> {
  const answered = ONBOARDING_GOALS.reduce((n, g) => n + byGoal[g], 0);
  return { ...byGoal, none: Math.max(0, cohort - answered) };
}

export async function loadOnboardingFunnel(db: Db, days: FunnelWindow, now: Date = new Date()): Promise<OnboardingFunnel> {
  const t = now.toISOString();
  const r = await db.execute<Row>(sql`
    WITH c AS (
      SELECT t.*,
        EXISTS (SELECT 1 FROM users u WHERE u.tenant_id = t.id AND u.last_login_at IS NOT NULL) AS signed_in,
        coalesce(t.settings->>'postal_address', '') <> '' AS has_address,
        (EXISTS (SELECT 1 FROM transport_configs x WHERE x.tenant_id = t.id AND x.is_active)
          OR EXISTS (SELECT 1 FROM managed_sending m WHERE m.tenant_id = t.id AND m.enabled)) AS has_sender,
        EXISTS (SELECT 1 FROM flows f WHERE f.tenant_id = t.id AND f.status = 'active') AS has_flow,
        EXISTS (SELECT 1 FROM events e WHERE e.tenant_id = t.id) AS has_event,
        (SELECT min(m.sent_at) FROM lifecycle_messages m WHERE m.tenant_id = t.id AND m.status = 'sent') AS first_sent
      FROM tenants t
      WHERE t.settings ? 'signup' AND t.created_at >= ${t}::timestamptz - (${days} * interval '1 day')
    )
    SELECT
      count(*)::text AS cohort,
      count(*) FILTER (WHERE signed_in)::text AS signed_in,
      count(*) FILTER (WHERE has_address)::text AS address,
      count(*) FILTER (WHERE has_sender)::text AS sender,
      count(*) FILTER (WHERE has_flow)::text AS flow,
      count(*) FILTER (WHERE has_event)::text AS event,
      count(*) FILTER (WHERE first_sent IS NOT NULL)::text AS first_email,
      count(*) FILTER (WHERE plan IN ('starter','growth','scale'))::text AS paid,
      count(*) FILTER (WHERE signed_in AND first_sent IS NULL
                         AND created_at < ${t}::timestamptz - interval '24 hours'
                         AND settings->'onboarding'->>'dismissed_at' IS NULL)::text AS stalled,
      count(*) FILTER (WHERE coalesce((settings->'onboarding'->>'nudge_count')::int, 0) > 0)::text AS nudged,
      count(*) FILTER (WHERE settings->'onboarding'->>'dismissed_at' IS NOT NULL)::text AS set_aside,
      count(*) FILTER (WHERE settings->'signup'->>'goal' = 'welcome')::text AS g_welcome,
      count(*) FILTER (WHERE settings->'signup'->>'goal' = 'convert_trials')::text AS g_convert_trials,
      count(*) FILTER (WHERE settings->'signup'->>'goal' = 'upgrade_free')::text AS g_upgrade_free,
      count(*) FILTER (WHERE settings->'signup'->>'goal' = 'explore')::text AS g_explore,
      (percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (first_sent - created_at)) / 3600.0)
         FILTER (WHERE first_sent IS NOT NULL AND first_sent >= created_at))::text AS median_hours
    FROM c
  `);
  const row = r.rows[0]!;
  const n = (v: string | null | undefined) => Number(v ?? 0);
  const cohort = n(row.cohort);
  const counts: Record<FunnelStageId, number> = {
    signed_up: cohort,
    signed_in: n(row.signed_in),
    address: n(row.address),
    sender: n(row.sender),
    flow: n(row.flow),
    event: n(row.event),
    first_email: n(row.first_email),
    paid: n(row.paid),
  };
  const stages: FunnelStage[] = FUNNEL_STAGE_IDS.map((id) => ({
    id,
    label: LABELS[id],
    count: counts[id],
    percent: cohort === 0 ? 0 : Math.round((counts[id] / cohort) * 100),
  }));
  const median = row.median_hours === null ? null : Math.round(Number(row.median_hours) * 10) / 10;
  return {
    days,
    cohort,
    stages,
    biggest_drop: biggestDrop(stages),
    median_hours_to_first_email: median !== null && Number.isFinite(median) ? median : null,
    stalled: n(row.stalled),
    nudged: n(row.nudged),
    set_aside: n(row.set_aside),
    goals: goalCounts(cohort, { welcome: n(row.g_welcome), convert_trials: n(row.g_convert_trials), upgrade_free: n(row.g_upgrade_free), explore: n(row.g_explore) }),
    generated_at: t,
  };
}
