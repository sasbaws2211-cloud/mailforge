/**
 * Support emails: a new request to the operator's support address, and an answer to the customer.
 *
 * Sent from the operator's platform sender (PLATFORM_FROM_EMAIL and its transport), which is the only sender that makes sense for
 * mail from the service itself. A request is always saved, so an unset sender or a failed send never loses a message: the console
 * shows it either way. Sending never throws.
 *
 * Mirror side: PUBLIC (packages/api is mirrored).
 */
import { getPlatformTransport, type PlatformTransport } from "../platform-mailer.js";
import { CATEGORY_LABEL, type TicketCategory } from "./logic.js";

type Logger = { info: (o: object, m: string) => void; warn: (o: object, m: string) => void };

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const htmlBody = (s: string) => escapeHtml(s).replace(/\n/g, "<br>");
const oneLine = (s: string) => s.replace(/[\r\n]+/g, " ").slice(0, 200);

export interface SupportMailDeps {
  /** Overrides how the sender is found (tests pass a recording adapter). */
  transports?: PlatformTransport[];
  log?: Logger;
}

async function deliver(
  deps: SupportMailDeps,
  mail: { to: string; replyTo?: string; subject: string; text: string; html: string; messageId: string },
): Promise<boolean> {
  const senders = deps.transports ?? (() => {
    const t = getPlatformTransport();
    return t ? [t] : [];
  })();
  if (senders.length === 0) {
    deps.log?.warn({ messageId: mail.messageId }, "Support email not sent: no platform email sender configured");
    return false;
  }
  for (const sender of senders) {
    try {
      const r = await sender.adapter.send({
        to: mail.to,
        from: sender.fromEmail,
        fromName: sender.fromName ?? undefined,
        subject: oneLine(mail.subject),
        bodyHtml: mail.html,
        bodyText: mail.text,
        headers: {},
        messageId: mail.messageId,
        ...(mail.replyTo ? { replyTo: mail.replyTo } : {}),
      });
      if (r.success) return true;
      deps.log?.warn({ messageId: mail.messageId, error: r.error }, "Support email send failed, trying the next sender");
    } catch (err) {
      deps.log?.warn({ messageId: mail.messageId, error: err instanceof Error ? err.message : String(err) }, "Support email send threw, trying the next sender");
    }
  }
  return false;
}

export interface NewTicketMail {
  ticketId: string;
  subject: string;
  category: TicketCategory;
  message: string;
  requesterEmail: string;
  workspaceName: string;
  pagePath: string | null;
  consoleUrl: string;
}

/** Tell the operator a request arrived. Returns false when nobody could be told (the request is saved regardless). */
export async function sendNewTicketNotice(deps: SupportMailDeps, t: NewTicketMail): Promise<boolean> {
  const to = process.env.LOOMAIL_SUPPORT_EMAIL?.trim();
  if (!to) return false;
  const text = [
    `New support request from ${t.workspaceName}`,
    "",
    `From: ${t.requesterEmail}`,
    `Type: ${CATEGORY_LABEL[t.category]}`,
    ...(t.pagePath ? [`Page: ${t.pagePath}`] : []),
    "",
    t.message,
    "",
    `Answer it in the admin console: ${t.consoleUrl}`,
  ].join("\n");
  const html = `<p><strong>New support request from ${escapeHtml(t.workspaceName)}</strong></p>
<p>From: ${escapeHtml(t.requesterEmail)}<br>Type: ${escapeHtml(CATEGORY_LABEL[t.category])}${t.pagePath ? `<br>Page: ${escapeHtml(t.pagePath)}` : ""}</p>
<blockquote style="margin:0 0 16px;padding:0 0 0 12px;border-left:3px solid #ccc">${htmlBody(t.message)}</blockquote>
<p><a href="${escapeHtml(t.consoleUrl)}">Answer it in the admin console</a></p>`;
  return deliver(deps, { to, replyTo: t.requesterEmail, subject: `[Support] ${t.subject} (${t.workspaceName})`, text, html, messageId: `support-new-${t.ticketId}` });
}

export interface ReplyMail {
  ticketId: string;
  messageId: string;
  subject: string;
  to: string;
  reply: string;
  closed: boolean;
  threadUrl: string;
}

/** Send the customer the answer, with a link to the thread in their dashboard. */
export async function sendReplyToCustomer(deps: SupportMailDeps, r: ReplyMail): Promise<boolean> {
  const text = [r.reply, "", r.closed ? "This request is now closed. Reply in your dashboard if you need more help." : "You can reply in your dashboard:", r.threadUrl].join("\n");
  const html = `<blockquote style="margin:0 0 16px;padding:0 0 0 12px;border-left:3px solid #ccc">${htmlBody(r.reply)}</blockquote>
<p>${r.closed ? "This request is now closed. Reply in your dashboard if you need more help." : "You can reply in your dashboard."}<br><a href="${escapeHtml(r.threadUrl)}">${escapeHtml(r.threadUrl)}</a></p>`;
  const to = r.to;
  const replyTo = process.env.LOOMAIL_SUPPORT_EMAIL?.trim();
  return deliver(deps, { to, ...(replyTo ? { replyTo } : {}), subject: `Re: ${r.subject}`, text, html, messageId: `support-reply-${r.ticketId}-${r.messageId}` });
}
