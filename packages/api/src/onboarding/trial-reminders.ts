/**
 * Trial reminders: two emails to the owner of a hosted workspace that has not subscribed.
 *   ending  when 2 days or fewer are left (day 5 of a 7-day trial)
 *   ended   within 3 days after the trial ran out ("paused, data safe, subscribe to resume")
 *
 * Each goes at most once per workspace. It is claimed with one UPDATE that only succeeds while
 * the flag is still empty, so two servers cannot both send it; if delivery fails the claim is
 * released and the next sweep tries again. Workspaces that are suspended or being deleted, that
 * did not come through signup, or that already subscribed are left alone. Sent through the
 * platform sender; with none configured nothing is sent or claimed.
 *
 * Mirror side: PUBLIC (packages/api is mirrored).
 */
import { sql } from "drizzle-orm";
import { plansEnforced, trialDaysLeft } from "@loomail/core";
import type { Db } from "../plugins/db.js";
import { getPlatformTransport, type PlatformTransport } from "../platform-mailer.js";
import { buildTrialEmail, type TransactionalEmailInput } from "../transactional-email.js";

export type TrialReminderKind = "ending" | "ended";

export interface TrialReminderOptions {
  dashboardUrl: string;
  transport?: PlatformTransport | null;
  now?: Date;
  batch?: number;
  log?: { warn: (obj: object, msg: string) => void; info?: (obj: object, msg: string) => void };
}

export interface TrialReminderResult {
  considered: number;
  sent: number;
  failed: number;
}

interface Row extends Record<string, unknown> {
  id: string;
  name: string;
  settings: Record<string, unknown> | null;
  trial_ends_at: Date | string;
}

const DAY = 86_400_000;
const FLAG: Record<TrialReminderKind, string> = { ending: "trial_ending_sent_at", ended: "trial_ended_sent_at" };

export async function sweepTrialReminders(db: Db, opts: TrialReminderOptions): Promise<TrialReminderResult> {
  const result: TrialReminderResult = { considered: 0, sent: 0, failed: 0 };
  const transport = opts.transport === undefined ? getPlatformTransport() : opts.transport;
  if (!transport) return result;
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();

  for (const kind of ["ending", "ended"] as const) {
    const window =
      kind === "ending"
        ? sql`trial_ends_at > ${nowIso}::timestamptz AND trial_ends_at <= ${new Date(now.getTime() + 2 * DAY).toISOString()}::timestamptz`
        : sql`trial_ends_at <= ${nowIso}::timestamptz AND trial_ends_at > ${new Date(now.getTime() - 3 * DAY).toISOString()}::timestamptz`;
    const rows = await db.execute<Row>(sql`
      SELECT id, name, settings, trial_ends_at FROM tenants
      WHERE plan = 'trial'
        AND settings ? 'signup'
        AND ${window}
        AND settings->'onboarding'->>${FLAG[kind]} IS NULL
        AND suspended_at IS NULL
        AND deletion_scheduled_at IS NULL
      ORDER BY trial_ends_at
      LIMIT ${opts.batch ?? 50}`);
    for (const t of rows.rows) {
      result.considered++;
      try {
        const outcome = await remindOne(db, t, kind, transport, now, opts);
        if (outcome === "sent") result.sent++;
        else if (outcome === "failed") result.failed++;
      } catch (err) {
        result.failed++;
        opts.log?.warn({ tenantId: t.id, err: err instanceof Error ? err.message : String(err) }, "trial reminder failed");
      }
    }
  }
  return result;
}

async function remindOne(
  db: Db,
  t: Row,
  kind: TrialReminderKind,
  transport: PlatformTransport,
  now: Date,
  opts: TrialReminderOptions,
): Promise<"sent" | "skipped" | "failed"> {
  const flag = FLAG[kind];
  const claimed = await db.execute(sql`
    UPDATE tenants
    SET settings = jsonb_set(
      settings, '{onboarding}',
      COALESCE(settings->'onboarding', '{}'::jsonb) || ${JSON.stringify({ [flag]: now.toISOString() })}::jsonb
    )
    WHERE id = ${t.id}::uuid
      AND plan = 'trial'
      AND settings->'onboarding'->>${flag} IS NULL
      AND suspended_at IS NULL
      AND deletion_scheduled_at IS NULL
    RETURNING id`);
  if (claimed.rows.length === 0) return "skipped";

  const release = () =>
    db.execute(sql`
      UPDATE tenants SET settings = jsonb_set(settings, '{onboarding}', (settings->'onboarding') - ${flag})
      WHERE id = ${t.id}::uuid`);

  try {
    const owners = await db.execute<{ email: string }>(sql`
      SELECT email FROM users WHERE tenant_id = ${t.id}::uuid AND role = 'owner' AND deactivated_at IS NULL ORDER BY created_at`);
    if (owners.rows.length === 0) {
      await release();
      return "skipped";
    }
    const brand = ((t.settings ?? {}).brand as TransactionalEmailInput["brand"] | undefined) ?? {};
    const email = buildTrialEmail({
      brand,
      tenantName: t.name,
      kind,
      daysLeft: Math.max(1, trialDaysLeft(new Date(t.trial_ends_at), now)),
      planUrl: `${opts.dashboardUrl}/settings/plan`,
      supportEmail: process.env.LOOMAIL_SUPPORT_EMAIL?.trim() || null,
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
        messageId: `trial-${kind}-${t.id}-${o.email}`,
      });
      if (r.success) delivered++;
      else opts.log?.warn({ tenantId: t.id, error: r.error }, "trial reminder not delivered");
    }
    if (delivered === 0) {
      await release();
      return "failed";
    }
    return "sent";
  } catch (err) {
    try {
      await release();
    } catch {
      /* keep the claim: a missed reminder beats a repeated one */
    }
    throw err;
  }
}

/** Run the sweep every 30 minutes inside the server. Does nothing unless plans are enforced and a platform sender exists. */
export function startTrialReminderMonitor(
  db: Db,
  opts: Omit<TrialReminderOptions, "dashboardUrl"> & { dashboardUrl?: string; intervalMs?: number; firstCheckMs?: number } = {},
): () => void {
  const tick = () => {
    if (!plansEnforced()) return;
    const dashboardUrl = (opts.dashboardUrl ?? process.env.DASHBOARD_URL ?? process.env.BASE_URL ?? "").replace(/\/+$/, "");
    if (!dashboardUrl) return;
    sweepTrialReminders(db, { ...opts, dashboardUrl })
      .then((r) => {
        if (r.sent > 0) opts.log?.info?.(r, "trial reminders sent");
      })
      .catch((err) => opts.log?.warn({ err: err instanceof Error ? err.message : String(err) }, "trial reminder sweep failed"));
  };
  const first = setTimeout(tick, opts.firstCheckMs ?? 150_000);
  const every = setInterval(tick, opts.intervalMs ?? 1_800_000);
  first.unref();
  every.unref();
  return () => {
    clearTimeout(first);
    clearInterval(every);
  };
}
