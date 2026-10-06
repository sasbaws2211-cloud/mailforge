/**
 * Stall nudges: a short email to the owner of a hosted workspace that signed in, then stopped
 * before finishing onboarding. At most two (24 and 72 hours after the welcome email), each
 * pointing at the one step that is next.
 *
 * Who is left alone: workspaces that finished, that chose "I will finish this later" (that
 * button is the opt-out and the email says so), that are suspended or being deleted, whose
 * trial has ended, that did not come through signup, and that never signed in.
 *
 * Safety:
 *   - Each nudge is claimed with one UPDATE that only succeeds if the count is still what the
 *     sweep read, so two servers (or two overlapping sweeps) cannot both send the same one.
 *   - If delivery fails the claim is put back, so the next sweep tries again.
 *   - Sent through the platform sender; with none configured nothing is sent or claimed.
 *   - One workspace's failure never stops the sweep.
 *
 * Mirror side: PUBLIC (packages/api is mirrored).
 */
import { sql } from "drizzle-orm";
import { nudgeDue, plansEnforced, trialDaysLeft } from "@mailforge/core";
import type { Db } from "../plugins/db.js";
import { getPlatformTransport, type PlatformTransport } from "../platform-mailer.js";
import { buildNudgeEmail, type TransactionalEmailInput } from "../transactional-email.js";
import { loadOnboarding } from "./state.js";

export interface NudgeOptions {
  dashboardUrl: string;
  /** Test seam: defaults to the platform transport from the environment. */
  transport?: PlatformTransport | null;
  now?: Date;
  /** Most workspaces looked at per sweep. */
  batch?: number;
  /** Test seam: runs after the state is read and before it is claimed, to simulate another server winning the race. */
  beforeClaim?: (tenantId: string) => Promise<void>;
  log?: { warn: (obj: object, msg: string) => void; info?: (obj: object, msg: string) => void };
}

export interface NudgeSweepResult {
  considered: number;
  sent: number;
  failed: number;
}

interface CandidateRow extends Record<string, unknown> {
  id: string;
  name: string;
  settings: Record<string, unknown> | null;
  trial_ends_at: Date | string | null;
}

export async function sweepOnboardingNudges(db: Db, opts: NudgeOptions): Promise<NudgeSweepResult> {
  const result: NudgeSweepResult = { considered: 0, sent: 0, failed: 0 };
  const transport = opts.transport === undefined ? getPlatformTransport() : opts.transport;
  if (!transport) return result;
  const now = opts.now ?? new Date();

  // Cheap filter in SQL; the exact timing rule (nudgeDue) is applied below in one place.
  const candidates = await db.execute<CandidateRow>(sql`
    SELECT id, name, settings, trial_ends_at
    FROM tenants
    WHERE settings ? 'signup'
      AND settings->'onboarding'->>'welcome_sent_at' IS NOT NULL
      AND settings->'onboarding'->>'completed_at' IS NULL
      AND settings->'onboarding'->>'dismissed_at' IS NULL
      AND COALESCE((settings->'onboarding'->>'nudge_count')::int, 0) < 2
      AND (settings->'onboarding'->>'welcome_sent_at')::timestamptz < ${new Date(now.getTime() - 24 * 3_600_000).toISOString()}::timestamptz
      AND suspended_at IS NULL
      AND deletion_scheduled_at IS NULL
      AND (plan IS DISTINCT FROM 'trial' OR trial_ends_at > ${now.toISOString()}::timestamptz)
    ORDER BY created_at
    LIMIT ${opts.batch ?? 50}
  `);

  for (const t of candidates.rows) {
    result.considered++;
    try {
      const outcome = await nudgeOne(db, t, transport, now, opts);
      if (outcome === "sent") result.sent++;
      else if (outcome === "failed") result.failed++;
    } catch (err) {
      result.failed++;
      opts.log?.warn({ tenantId: t.id, err: err instanceof Error ? err.message : String(err) }, "onboarding nudge failed");
    }
  }
  return result;
}

async function nudgeOne(
  db: Db,
  t: CandidateRow,
  transport: PlatformTransport,
  now: Date,
  opts: NudgeOptions,
): Promise<"sent" | "skipped" | "failed"> {
  const snap = await loadOnboarding(db, t.id);
  if (!snap || snap.progress.complete || !snap.progress.next) return "skipped";
  const state = snap.state;
  if (!nudgeDue(state, now)) return "skipped";

  const prevCount = state.nudge_count ?? 0;
  const prevLast = state.last_nudge_at ?? null;

  await opts.beforeClaim?.(t.id);

  // Claim: only if nothing changed since we read it.
  const claimed = await db.execute(sql`
    UPDATE tenants
    SET settings = jsonb_set(
      settings, '{onboarding}',
      COALESCE(settings->'onboarding', '{}'::jsonb) || ${JSON.stringify({ nudge_count: prevCount + 1, last_nudge_at: now.toISOString() })}::jsonb
    )
    WHERE id = ${t.id}::uuid
      AND COALESCE((settings->'onboarding'->>'nudge_count')::int, 0) = ${prevCount}
      AND settings->'onboarding'->>'dismissed_at' IS NULL
      AND settings->'onboarding'->>'completed_at' IS NULL
      AND suspended_at IS NULL
      AND deletion_scheduled_at IS NULL
    RETURNING id
  `);
  if (claimed.rows.length === 0) return "skipped";

  try {
    const owners = await db.execute<{ email: string }>(sql`
      SELECT email FROM users WHERE tenant_id = ${t.id}::uuid AND role = 'owner' AND deactivated_at IS NULL ORDER BY created_at
    `);
    if (owners.rows.length === 0) {
      await release(db, t.id, prevCount, prevLast);
      return "skipped";
    }

    const step = snap.progress.steps.find((s) => s.id === snap.progress.next)!;
    const brand = ((t.settings ?? {}).brand as TransactionalEmailInput["brand"] | undefined) ?? {};
    const trialEnds = t.trial_ends_at ? new Date(t.trial_ends_at) : null;
    const email = buildNudgeEmail({
      brand,
      tenantName: t.name,
      stepUrl: `${opts.dashboardUrl}${step.href}`,
      stepTitle: step.title,
      stepDescription: step.description,
      stepMinutes: step.minutes,
      stepCta: step.cta,
      done: snap.progress.done,
      total: snap.progress.total,
      nth: prevCount + 1,
      trialDaysLeft: trialEnds ? trialDaysLeft(trialEnds, now) : null,
      supportEmail: process.env.MAILFORGE_SUPPORT_EMAIL?.trim() || null,
    });

    let delivered = 0;
    for (const o of owners.rows) {
      const r = await transport.adapter.send({
        to: o.email,
        from: transport.fromEmail,
        fromName: transport.fromName ?? undefined,
        subject: email.subject,
        bodyHtml: email.html,
        bodyText: email.text,
        headers: {},
        messageId: `nudge-${t.id}-${prevCount + 1}-${o.email}`,
      });
      if (r.success) delivered++;
      else opts.log?.warn({ tenantId: t.id, error: r.error }, "onboarding nudge not delivered");
    }
    if (delivered === 0) {
      await release(db, t.id, prevCount, prevLast);
      return "failed";
    }
    return "sent";
  } catch (err) {
    try {
      await release(db, t.id, prevCount, prevLast);
    } catch {
      /* keep the claim: a missed reminder beats a repeated one */
    }
    throw err;
  }
}

/** Put the counters back so the next sweep tries again. */
async function release(db: Db, tenantId: string, prevCount: number, prevLast: string | null): Promise<void> {
  const base = sql`(COALESCE(settings->'onboarding', '{}'::jsonb) || ${JSON.stringify({ nudge_count: prevCount })}::jsonb)`;
  const next = prevLast
    ? sql`(${base} || ${JSON.stringify({ last_nudge_at: prevLast })}::jsonb)`
    : sql`(${base} - 'last_nudge_at')`;
  await db.execute(sql`
    UPDATE tenants SET settings = jsonb_set(settings, '{onboarding}', ${next}) WHERE id = ${tenantId}::uuid
  `);
}

/**
 * Run the sweep once an hour inside the server. Does nothing unless the product is hosted
 * (plans enforced) and a platform sender is configured.
 */
export function startOnboardingNudgeMonitor(
  db: Db,
  opts: Omit<NudgeOptions, "dashboardUrl"> & { dashboardUrl?: string; intervalMs?: number; firstCheckMs?: number } = {},
): () => void {
  const tick = () => {
    if (!plansEnforced()) return;
    const dashboardUrl = (opts.dashboardUrl ?? process.env.DASHBOARD_URL ?? process.env.BASE_URL ?? "").replace(/\/+$/, "");
    if (!dashboardUrl) return;
    sweepOnboardingNudges(db, { ...opts, dashboardUrl })
      .then((r) => {
        if (r.sent > 0) opts.log?.info?.(r, "onboarding nudges sent");
      })
      .catch((err) => opts.log?.warn({ err: err instanceof Error ? err.message : String(err) }, "onboarding nudge sweep failed"));
  };
  const first = setTimeout(tick, opts.firstCheckMs ?? 120_000);
  const every = setInterval(tick, opts.intervalMs ?? 3_600_000);
  first.unref();
  every.unref();
  return () => {
    clearTimeout(first);
    clearInterval(every);
  };
}
