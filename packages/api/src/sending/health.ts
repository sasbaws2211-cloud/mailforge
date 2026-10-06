/**
 * Sender health for managed sending: protect the operator's shared Resend account from
 * a workspace whose mail is hurting it.
 *
 * Everyone on managed sending sends through one Resend account, and providers judge an
 * account by its worst traffic. A workspace that mails a stale list (lots of addresses
 * that do not exist) or mails people who did not ask (spam complaints) can get the whole
 * account throttled or suspended. So every few minutes this looks at each workspace's last
 * seven days:
 *
 *   warn   about half of a pause threshold: the owner is told, once every few days
 *   pause  at a pause threshold: managed sending stops for that workspace at once (its
 *          messages wait, untouched), the owner is told why, and the operator is told
 *
 * The thresholds and the "too little volume to judge" rule are in @mailforge/core
 * (senderHealth). Only a platform admin can resume a paused workspace.
 *
 * Mirror side: PUBLIC (packages/api is mirrored).
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { SENDER_HEALTH_WINDOW_DAYS, senderHealth, type SenderHealth } from "@mailforge/core";
import { adminAuditLog, managedSending } from "@mailforge/db/schema";
import type { Db } from "../plugins/db.js";
import { getPlatformTransport, type PlatformTransport } from "../platform-mailer.js";
import { platformAdminEmails } from "../admin/platform-admins.js";

/** A workspace that stays in the warning zone is reminded at most this often. */
export const WARN_REPEAT_MS = 3 * 86_400_000;

type Mail = { subject: string; text: string; html: string };
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const wrap = (paragraphs: string[], url?: string): Pick<Mail, "text" | "html"> => ({
  text: [...paragraphs, ...(url ? ["", url] : [])].join("\n\n"),
  html: paragraphs.map((p) => `<p>${esc(p)}</p>`).join("") + (url ? `<p><a href="${esc(url)}">${esc(url)}</a></p>` : ""),
});

const FIX_STEPS = [
  "To get back to sending: remove addresses that bounced, and stop mailing anyone who did not ask to hear from you. Then ask support to resume your sending and tell us what you changed.",
];

/** Told to the workspace owner when sending is paused. Plain words; no thresholds or account details. */
export function buildSenderPausedEmail(workspace: string, reasons: string[], automatic: boolean): Mail {
  const lead = automatic
    ? `We paused email sending for ${workspace} because of how recent emails performed: ${reasons.join("; ")}.`
    : `Email sending for ${workspace} has been paused by the service operator.${reasons.length ? ` Reason: ${reasons.join("; ")}.` : ""}`;
  const body = wrap([
    lead,
    "Your emails are safe: nothing was deleted, and everything waiting to go out will send once sending resumes.",
    "We do this to protect delivery for everyone. Email providers watch the share of messages that bounce or get reported as spam, and too many puts all senders at risk.",
    ...FIX_STEPS,
  ]);
  return { subject: `Email sending paused for ${workspace}`, ...body };
}

export function buildSenderWarningEmail(workspace: string, reasons: string[]): Mail {
  const body = wrap([
    `Heads up about ${workspace}: your recent emails are close to a level that would pause your sending. ${reasons.join("; ")}.`,
    "Nothing has been paused. To stay clear of it: remove addresses that bounced, and only email people who asked to hear from you.",
  ]);
  return { subject: `Your email sending needs attention: ${workspace}`, ...body };
}

export function buildSenderResumedEmail(workspace: string): Mail {
  const body = wrap([`Email sending for ${workspace} has been resumed. Anything that was waiting is now going out.`, "If bounces or spam reports build up again, sending will pause again, so keep your list clean."]);
  return { subject: `Email sending resumed for ${workspace}`, ...body };
}

/** Told to the operator when a workspace is paused automatically. */
export function buildAdminPauseNotice(workspace: string, h: Pick<SenderHealth, "sent" | "hardBounces" | "complaints" | "reasons">, consoleUrl: string): Mail {
  const body = wrap(
    [
      `Managed sending was paused automatically for "${workspace}": ${h.reasons.join("; ")}.`,
      `Last ${SENDER_HEALTH_WINDOW_DAYS} days: ${h.sent} sent, ${h.hardBounces} permanent bounces, ${h.complaints} complaints. The workspace's owner has been told. Its mail is waiting, not lost. Resume it from the admin console once it has cleaned up.`,
    ],
    consoleUrl,
  );
  return { subject: `Managed sending paused: ${workspace}`, ...body };
}

export interface HealthOptions {
  transport?: PlatformTransport | null;
  admins?: string[];
  env?: NodeJS.ProcessEnv;
  log?: { warn: (o: unknown, m?: string) => void; info: (o: unknown, m?: string) => void };
}

export interface HealthResult {
  checked: number;
  paused: string[];
  warned: string[];
}

interface Counts extends Record<string, unknown> {
  tenant_id: string;
  name: string;
  warned_at: Date | string | null;
  sent: string;
  hard: string;
  complaints: string;
}

/** Send one email to each address with the platform sender; returns how many arrived. Never throws. */
export async function mailEach(transport: PlatformTransport | null, to: string[], mail: Mail, idBase: string, log?: HealthOptions["log"]): Promise<number> {
  if (!transport) return 0;
  let sent = 0;
  for (const addr of to) {
    try {
      const r = await transport.adapter.send({
        to: addr,
        from: transport.fromEmail,
        fromName: transport.fromName ?? undefined,
        subject: mail.subject,
        bodyHtml: mail.html,
        bodyText: mail.text,
        headers: {},
        messageId: `${idBase}-${addr}`,
      });
      if (r.success) sent++;
      else log?.warn({ error: r.error }, "Sender health email not delivered");
    } catch (err) {
      log?.warn({ error: err instanceof Error ? err.message : String(err) }, "Sender health email not delivered");
    }
  }
  return sent;
}

export async function ownerEmails(db: Db, tenantId: string): Promise<string[]> {
  const r = await db.execute<{ email: string }>(sql`SELECT email FROM users WHERE tenant_id = ${tenantId}::uuid AND role = 'owner' AND deactivated_at IS NULL ORDER BY created_at`);
  return r.rows.map((x) => x.email);
}

/**
 * Pause a workspace's managed sending for its sender health, and record it. Safe to run from more than
 * one process at once: the update matches only while the workspace is not yet paused, so exactly one
 * caller gets `true` (and so exactly one audit row and one set of emails). Returns whether this call paused it.
 */
export async function pauseForHealth(db: Db, tenantId: string, h: SenderHealth, now: Date): Promise<boolean> {
  const reason = h.reasons.join("; ");
  return db.transaction(async (tx) => {
    const u = await tx
      .update(managedSending)
      .set({ pausedAt: now, pausedReason: reason, pausedBy: "auto", updatedAt: now })
      .where(and(eq(managedSending.tenantId, tenantId), isNull(managedSending.pausedAt)))
      .returning({ id: managedSending.tenantId });
    if (u.length === 0) return false;
    await tx.insert(adminAuditLog).values({
      actorUserId: null,
      actorEmail: "system (sender health)",
      action: "managed_sending_auto_pause",
      tenantId,
      detail: { reason, sent: h.sent, hard_bounces: h.hardBounces, complaints: h.complaints, window_days: SENDER_HEALTH_WINDOW_DAYS },
    });
    return true;
  });
}

/**
 * Look at every workspace on managed sending, pause the ones that are hurting the shared account and
 * warn the ones heading there. Never throws.
 */
export async function checkSenderHealth(db: Db, now: Date = new Date(), opts: HealthOptions = {}): Promise<HealthResult> {
  const env = opts.env ?? process.env;
  const result: HealthResult = { checked: 0, paused: [], warned: [] };
  try {
    const since = new Date(now.getTime() - SENDER_HEALTH_WINDOW_DAYS * 86_400_000).toISOString();
    const rows = await db.execute<Counts>(sql`
      SELECT ms.tenant_id, t.name, ms.warned_at,
        (SELECT count(*) FROM lifecycle_messages m WHERE m.tenant_id = ms.tenant_id AND m.status = 'sent' AND m.sent_at >= ${since}::timestamptz)::text AS sent,
        (SELECT count(DISTINCT e.message_id) FROM message_events e
           WHERE e.tenant_id = ms.tenant_id AND e.event_type = 'bounced' AND e.metadata ->> 'bounce_type' = 'Permanent'
             AND e.occurred_at >= ${since}::timestamptz)::text AS hard,
        (SELECT count(DISTINCT e.message_id) FROM message_events e
           WHERE e.tenant_id = ms.tenant_id AND e.event_type = 'complained' AND e.occurred_at >= ${since}::timestamptz)::text AS complaints
      FROM managed_sending ms JOIN tenants t ON t.id = ms.tenant_id
      WHERE ms.enabled AND ms.paused_at IS NULL`);

    const transport = opts.transport === undefined ? getPlatformTransport(env) : opts.transport;
    const admins = opts.admins ?? platformAdminEmails(env);
    const base = (env.MAILFORGE_ADMIN_URL || env.BASE_URL || "").replace(/\/+$/, "");

    for (const r of rows.rows) {
      result.checked++;
      const h = senderHealth(Number(r.sent), Number(r.hard), Number(r.complaints));
      if (h.state === "pause") {
        const reason = h.reasons.join("; ");
        const updated = await pauseForHealth(db, r.tenant_id, h, now);
        if (!updated) continue;
        result.paused.push(r.tenant_id);
        opts.log?.info({ tenantId: r.tenant_id, reason }, "Managed sending paused automatically");
        await mailEach(transport, await ownerEmails(db, r.tenant_id), buildSenderPausedEmail(r.name, h.reasons, true), `sender-paused-${r.tenant_id}-${now.getTime()}`, opts.log);
        await mailEach(transport, admins, buildAdminPauseNotice(r.name, h, `${base}/admin/tenants/${r.tenant_id}`), `sender-paused-admin-${r.tenant_id}-${now.getTime()}`, opts.log);
      } else if (h.state === "warn") {
        const last = r.warned_at ? new Date(r.warned_at).getTime() : 0;
        if (now.getTime() - last < WARN_REPEAT_MS) continue;
        const n = await mailEach(transport, await ownerEmails(db, r.tenant_id), buildSenderWarningEmail(r.name, h.reasons), `sender-warn-${r.tenant_id}-${now.getTime()}`, opts.log);
        // Only count it as told when someone was; otherwise try again at the next check.
        if (n > 0) {
          await db.update(managedSending).set({ warnedAt: now, updatedAt: now }).where(eq(managedSending.tenantId, r.tenant_id));
          result.warned.push(r.tenant_id);
        }
      }
    }
  } catch (err) {
    opts.log?.warn({ error: err instanceof Error ? err.message : String(err) }, "Sender health check failed");
  }
  return result;
}
