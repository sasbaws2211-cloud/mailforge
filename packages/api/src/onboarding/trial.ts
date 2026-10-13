/**
 * The trial clock restarts once, on the first real event.
 *
 * A trial starts at signup, but getting to a first event takes real time (wiring the app,
 * verifying a domain). When the first event from the customer's own app arrives, the trial
 * becomes a fresh TRIAL_DAYS from that moment, never ending earlier than it already did and
 * never later than TRIAL_MAX_DAYS after signup. It happens at most once per workspace.
 *
 * The "send me a sample" event does not count: it is a demo, not the product being wired up.
 *
 * Mirror side: PUBLIC (packages/api is mirrored).
 */
import { sql } from "drizzle-orm";
import { TRIAL_DAYS, TRIAL_MAX_DAYS } from "@loomail/core";
import type { Db } from "../plugins/db.js";

/** The contact id used by the dashboard's sample event (see routes/onboarding.ts). */
export const SAMPLE_EVENT_USER_ID = "sample-event-user";

/** Workspaces already handled by this process, so the ingest hot path does one query at most. */
const handled = new Set<string>();

/** For tests: forget which workspaces were handled. */
export function resetTrialRebaseCache(): void {
  handled.clear();
}

/**
 * Restart the trial clock for a workspace whose first real event just arrived. Safe to call on
 * every event: it does one UPDATE the first time per process and nothing afterwards, and the
 * UPDATE itself only matches a running trial that has not been restarted. Never throws.
 */
export async function rebaseTrialOnFirstEvent(db: Db, tenantId: string, userId: string, now: Date = new Date()): Promise<boolean> {
  if (userId === SAMPLE_EVENT_USER_ID || handled.has(tenantId)) return false;
  handled.add(tenantId);
  if (handled.size > 5000) handled.clear();
  try {
    const r = await db.execute(sql`
      UPDATE tenants
      SET trial_ends_at = LEAST(
            created_at + make_interval(days => ${TRIAL_MAX_DAYS}),
            GREATEST(trial_ends_at, ${now.toISOString()}::timestamptz + make_interval(days => ${TRIAL_DAYS}))
          ),
          settings = jsonb_set(
            COALESCE(settings, '{}'::jsonb), '{onboarding}',
            COALESCE(settings->'onboarding', '{}'::jsonb) || ${JSON.stringify({ trial_rebased_at: now.toISOString() })}::jsonb
          )
      WHERE id = ${tenantId}::uuid
        AND plan = 'trial'
        AND trial_ends_at > ${now.toISOString()}::timestamptz
        AND settings->'onboarding'->>'trial_rebased_at' IS NULL
      RETURNING id`);
    return r.rows.length > 0;
  } catch {
    handled.delete(tenantId); // try again on the next event
    return false;
  }
}
