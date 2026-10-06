/**
 * Emails to workspace owners about deletion: scheduled, cancelled, and (for an
 * immediate erase by a platform admin) done.
 *
 * Sent to every active owner (not just whoever clicked), so a second owner, or
 * an owner whose workspace a platform admin changed, always hears about it. The
 * "cancelled" notice matters for security as much as courtesy: if someone else
 * undoes a deletion you wanted, you find out.
 *
 * These are transactional account emails: no unsubscribe footer, no suppression
 * check (a suppressed address must still learn its data is about to be erased).
 *
 * Sender: the workspace's own email transport when it has one, then the
 * operator's platform sender. If neither exists, or every send fails, this
 * logs and returns: the change has already happened and must not fail because
 * of an email.
 *
 * An immediate erase destroys the owners, the transport and the workspace name,
 * so for that notice everything needed is captured BEFORE the erase
 * (loadNoticeContext) and used after it (deliverNotice).
 *
 * Mirror side: PUBLIC (packages/api is mirrored).
 */
import { and, eq, isNull } from "drizzle-orm";
import { tenants, users } from "@mailforge/db/schema";
import type { Db } from "../plugins/db.js";
import { getPlatformTransport, type PlatformTransport } from "../platform-mailer.js";
import { resolveAuthTransport } from "../routes/auth.js";
import type { TransactionalEmailInput } from "../transactional-email.js";
import { buildDeletionCancelledEmail, buildDeletionScheduledEmail, buildWorkspaceErasedEmail } from "./deletion-email.js";

export interface NoticeResult {
  /** Owners the email was accepted for. */
  sent: string[];
  /** Owners it could not be sent to. */
  failed: string[];
}

type Logger = { info: (o: object, m: string) => void; warn: (o: object, m: string) => void };

interface NoticeBase {
  tenantId: string;
  /** Email of whoever made the change. */
  requestedBy: string;
  /** True when a platform admin made it on the owner's behalf. */
  byAdmin: boolean;
  dashboardUrl: string;
  log?: Logger;
  /** Overrides how senders are found (tests pass a recording adapter). */
  transports?: PlatformTransport[];
}

export type ScheduledNoticeInput = NoticeBase & { scheduledAt: Date };
export type CancelledNoticeInput = NoticeBase & { at?: Date };

interface BuiltMail {
  subject: string;
  html: string;
  text: string;
}

/** Everything needed to email a workspace's owners, gathered while the workspace still exists. */
export interface NoticeContext {
  tenantId: string;
  workspaceName: string;
  email: TransactionalEmailInput;
  owners: string[];
  senders: PlatformTransport[];
}

/** Look up the owners, the sender(s) and the branding. Null if there is no such workspace. */
export async function loadNoticeContext(
  db: Db,
  input: { tenantId: string; transports?: PlatformTransport[] },
): Promise<NoticeContext | null> {
  const [t] = await db.select({ name: tenants.name, settings: tenants.settings }).from(tenants).where(eq(tenants.id, input.tenantId)).limit(1);
  if (!t) return null;
  const owners = await db
    .select({ email: users.email })
    .from(users)
    .where(and(eq(users.tenantId, input.tenantId), eq(users.role, "owner"), isNull(users.deactivatedAt)));

  let senders = input.transports;
  if (!senders) {
    senders = [];
    const own = await resolveAuthTransport(db, input.tenantId);
    if (own) senders.push(own);
    const platform = getPlatformTransport();
    if (platform) senders.push(platform);
  }
  const settings = (t.settings as Record<string, unknown> | null) ?? {};
  const brand = (settings.brand as Record<string, unknown> | undefined) ?? {};
  return {
    tenantId: input.tenantId,
    workspaceName: t.name,
    email: { brand: brand as never, tenantName: t.name },
    owners: owners.map((o) => o.email),
    senders,
  };
}

/** Send one copy per owner, trying each sender in turn. Never throws. */
export async function deliverNotice(
  ctx: NoticeContext | null,
  kind: string,
  idStamp: number,
  mail: (c: NoticeContext) => BuiltMail,
  log?: Logger,
): Promise<NoticeResult> {
  const result: NoticeResult = { sent: [], failed: [] };
  if (!ctx || ctx.owners.length === 0) return result;
  try {
    if (ctx.senders.length === 0) {
      log?.warn({ tenantId: ctx.tenantId, kind }, "Deletion notice not sent: no email transport configured");
      result.failed.push(...ctx.owners);
      return result;
    }
    const built = mail(ctx);
    for (const owner of ctx.owners) {
      let ok = false;
      for (const sender of ctx.senders) {
        try {
          const r = await sender.adapter.send({
            to: owner,
            from: sender.fromEmail,
            fromName: sender.fromName ?? undefined,
            subject: built.subject,
            bodyHtml: built.html,
            bodyText: built.text,
            headers: {},
            messageId: `deletion-${kind}-${ctx.tenantId}-${idStamp}-${owner}`,
          });
          if (r.success) {
            ok = true;
            break;
          }
          log?.warn({ tenantId: ctx.tenantId, kind, error: r.error }, "Deletion notice send failed, trying next sender");
        } catch (err) {
          log?.warn({ tenantId: ctx.tenantId, kind, error: err instanceof Error ? err.message : String(err) }, "Deletion notice send threw, trying next sender");
        }
      }
      (ok ? result.sent : result.failed).push(owner);
    }
    if (result.sent.length > 0) log?.info({ tenantId: ctx.tenantId, kind, recipients: result.sent.length }, "Deletion notice sent");
  } catch (err) {
    log?.warn({ tenantId: ctx.tenantId, kind, error: err instanceof Error ? err.message : String(err) }, "Deletion notice failed");
  }
  return result;
}

async function sendNow(db: Db, input: NoticeBase, kind: string, idStamp: number, mail: (c: NoticeContext) => BuiltMail): Promise<NoticeResult> {
  try {
    return await deliverNotice(await loadNoticeContext(db, input), kind, idStamp, mail, input.log);
  } catch (err) {
    input.log?.warn({ tenantId: input.tenantId, kind, error: err instanceof Error ? err.message : String(err) }, "Deletion notice failed");
    return { sent: [], failed: [] };
  }
}

export function sendDeletionScheduledNotice(db: Db, input: ScheduledNoticeInput): Promise<NoticeResult> {
  return sendNow(db, input, "scheduled", input.scheduledAt.getTime(), (c) =>
    buildDeletionScheduledEmail(
      { workspaceName: c.workspaceName, erasureDate: input.scheduledAt, requestedBy: input.requestedBy, byAdmin: input.byAdmin, dashboardUrl: input.dashboardUrl },
      c.email,
    ),
  );
}

export function sendDeletionCancelledNotice(db: Db, input: CancelledNoticeInput): Promise<NoticeResult> {
  return sendNow(db, input, "cancelled", (input.at ?? new Date()).getTime(), (c) =>
    buildDeletionCancelledEmail(
      { workspaceName: c.workspaceName, cancelledBy: input.requestedBy, byAdmin: input.byAdmin, dashboardUrl: input.dashboardUrl },
      c.email,
    ),
  );
}

/**
 * After an immediate erase. `ctx` must have been loaded before the erase.
 * No sign-in link: there is nothing left to sign in to.
 */
export function sendWorkspaceErasedNotice(
  ctx: NoticeContext | null,
  input: { erasedBy: string; at?: Date; supportEmail?: string | null; log?: Logger },
): Promise<NoticeResult> {
  const at = input.at ?? new Date();
  return deliverNotice(
    ctx,
    "erased",
    at.getTime(),
    (c) => buildWorkspaceErasedEmail({ workspaceName: c.workspaceName, erasedBy: input.erasedBy, erasedAt: at, supportEmail: input.supportEmail ?? null }, c.email),
    input.log,
  );
}

/** Longest the request waits for the mail server before answering anyway. */
const NOTICE_TIMEOUT_MS = 8000;

function withTimeout(work: Promise<NoticeResult>): Promise<NoticeResult> {
  const slow: NoticeResult = { sent: [], failed: [] };
  return Promise.race([work, new Promise<NoticeResult>((resolve) => setTimeout(() => resolve(slow), NOTICE_TIMEOUT_MS).unref()), ]);
}

/** Send the notice, but never make the caller wait longer than a few seconds or fail. */
export function notifyDeletionScheduled(db: Db, input: ScheduledNoticeInput): Promise<NoticeResult> {
  return withTimeout(sendDeletionScheduledNotice(db, input));
}

export function notifyDeletionCancelled(db: Db, input: CancelledNoticeInput): Promise<NoticeResult> {
  return withTimeout(sendDeletionCancelledNotice(db, input));
}

export function notifyWorkspaceErased(ctx: NoticeContext | null, input: Parameters<typeof sendWorkspaceErasedNotice>[1]): Promise<NoticeResult> {
  return withTimeout(sendWorkspaceErasedNotice(ctx, input));
}
