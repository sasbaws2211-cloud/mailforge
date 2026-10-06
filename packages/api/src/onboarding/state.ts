/**
 * Onboarding data for a workspace: the facts that say how far along it is, and the
 * small amount of state stored per workspace (tenants.settings.onboarding).
 *
 * The rules that turn facts into steps live in @mailforge/core (onboarding.ts).
 * This file only reads the database, and writes with jsonb merges so a change here
 * can never overwrite settings another request saved at the same moment.
 *
 * Mirror side: PUBLIC (packages/api is mirrored).
 */
import { sql } from "drizzle-orm";
import {
  computeOnboarding,
  managedSendingConfigFromEnv,
  waitingReason,
  parseGoal,
  GOAL_INFO,
  BUSINESS_MODEL_TEMPLATES,
  type OnboardingGoal,
  type WaitingReason,
  type OnboardingFacts,
  type OnboardingProgress,
  type OnboardingState,
} from "@mailforge/core";
import type { Db } from "../plugins/db.js";

interface FactsRow extends Record<string, unknown> {
  postal: string | null;
  onboarding: OnboardingState | null;
  own_transport: boolean;
  managed_enabled: boolean;
  managed_usable: boolean;
  managed_paused: boolean;
  waiting: string | number;
  active_flow: boolean;
  has_events: boolean;
  has_sent: boolean;
  has_key: boolean;
  goal: string | null;
  business_model: string | null;
}

export interface OnboardingSnapshot {
  facts: OnboardingFacts;
  /** True once a secret or publishable ingest key exists (a sub-hint for the events step). */
  hasIngestKey: boolean;
  state: OnboardingState;
  progress: OnboardingProgress;
  /** Approved emails that cannot go out yet (counted up to 100), and why. Reason null = nothing wrong. */
  waiting: { count: number; reason: WaitingReason | null };
  /** What they said they wanted at signup, or null. */
  goal: OnboardingGoal | null;
  /** The template that fits that goal, with whether it has already been applied. Null when none fits. */
  goalSuggestion: { templateId: string; name: string; flowCount: number; applied: boolean } | null;
}

/** Read everything in one round trip. Every probe is an EXISTS, so it stops at the first row. */
export async function loadOnboarding(db: Db, tenantId: string): Promise<OnboardingSnapshot | null> {
  const shared = managedSendingConfigFromEnv().sharedFrom !== null;
  const r = await db.execute<FactsRow>(sql`
    SELECT
      t.settings->>'postal_address' AS postal,
      t.settings->'onboarding' AS onboarding,
      t.settings->'signup'->>'goal' AS goal,
      t.business_model AS business_model,
      EXISTS (SELECT 1 FROM transport_configs WHERE tenant_id = t.id AND is_active) AS own_transport,
      EXISTS (SELECT 1 FROM managed_sending WHERE tenant_id = t.id AND enabled) AS managed_enabled,
      EXISTS (
        SELECT 1 FROM managed_sending
        WHERE tenant_id = t.id AND enabled
          AND (${shared}::boolean OR (domain IS NOT NULL AND domain_status = 'verified'))
      ) AS managed_usable,
      EXISTS (SELECT 1 FROM managed_sending WHERE tenant_id = t.id AND enabled AND paused_at IS NOT NULL) AS managed_paused,
      (SELECT count(*) FROM (SELECT 1 FROM lifecycle_messages WHERE tenant_id = t.id AND status = 'approved' LIMIT 100) w) AS waiting,
      EXISTS (SELECT 1 FROM flows WHERE tenant_id = t.id AND status = 'active') AS active_flow,
      EXISTS (SELECT 1 FROM events WHERE tenant_id = t.id) AS has_events,
      EXISTS (SELECT 1 FROM lifecycle_messages WHERE tenant_id = t.id AND status = 'sent') AS has_sent,
      EXISTS (SELECT 1 FROM api_keys WHERE tenant_id = t.id AND revoked_at IS NULL) AS has_key
    FROM tenants t
    WHERE t.id = ${tenantId}::uuid
    LIMIT 1
  `);
  const row = r.rows[0];
  if (!row) return null;

  const facts: OnboardingFacts = {
    hasPostalAddress: (row.postal ?? "").trim() !== "",
    // "Can mail go out": a transport of their own, or Mailforge Sending with somewhere to send from.
    hasSender: row.own_transport === true || row.managed_usable === true,
    hasActiveFlow: row.active_flow === true,
    hasEvents: row.has_events === true,
    hasSentEmail: row.has_sent === true,
  };
  const state: OnboardingState = row.onboarding && typeof row.onboarding === "object" ? row.onboarding : {};
  const count = Number(row.waiting ?? 0);
  const reason = waitingReason({
    hasOwnTransport: row.own_transport === true,
    managedEnabled: row.managed_enabled === true,
    managedUsable: row.managed_usable === true,
    managedPaused: row.managed_paused === true,
    hasPostalAddress: facts.hasPostalAddress,
  });
  const goal = parseGoal(row.goal);
  const templateId = goal ? GOAL_INFO[goal].template : null;
  const template = templateId ? BUSINESS_MODEL_TEMPLATES[templateId] : null;
  return {
    facts,
    goal,
    goalSuggestion: template
      ? { templateId: template.id, name: template.name, flowCount: template.flows.length, applied: row.business_model !== null }
      : null,
    hasIngestKey: row.has_key === true,
    state,
    progress: computeOnboarding(facts),
    waiting: { count, reason: count > 0 ? reason : null },
  };
}

/**
 * Merge `patch` into settings.onboarding in one statement. A key whose value is null is
 * removed. Safe against concurrent writers of other settings keys.
 */
export async function mergeOnboardingState(
  db: Db,
  tenantId: string,
  patch: Record<string, string | null>,
): Promise<void> {
  const set: Record<string, string> = {};
  const unset: string[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) unset.push(k);
    else set[k] = v;
  }
  // One `- key` per removed key. (Passing a JS array would be expanded into separate
  // parameters by the query builder, not sent as one text[].)
  let merged = sql`(COALESCE(settings->'onboarding', '{}'::jsonb) || ${JSON.stringify(set)}::jsonb)`;
  for (const k of unset) merged = sql`(${merged} - ${k}::text)`;
  await db.execute(sql`
    UPDATE tenants
    SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{onboarding}', ${merged})
    WHERE id = ${tenantId}::uuid
  `);
}

/**
 * Record the first time every step was done. Set once, in one statement, so two
 * dashboards open at once cannot move the date. Returns true when this call set it.
 */
export async function markOnboardingCompleted(db: Db, tenantId: string, now: Date = new Date()): Promise<boolean> {
  const r = await db.execute(sql`
    UPDATE tenants
    SET settings = jsonb_set(
      COALESCE(settings, '{}'::jsonb),
      '{onboarding}',
      COALESCE(settings->'onboarding', '{}'::jsonb) || ${JSON.stringify({ completed_at: now.toISOString() })}::jsonb
    )
    WHERE id = ${tenantId}::uuid
      AND (settings->'onboarding'->>'completed_at') IS NULL
    RETURNING id
  `);
  return r.rows.length > 0;
}
