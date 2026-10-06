/**
 * The "your workspace is scheduled for deletion" email body.
 *
 * Mirror side: PUBLIC (packages/api is mirrored).
 */
import { wrapInShell, wrapInTextShell } from "@mailforge/core";
import type { TransactionalEmailInput } from "../transactional-email.js";

export interface DeletionNoticeInput {
  /** Name of the workspace being deleted. */
  workspaceName: string;
  /** When everything will be erased. */
  erasureDate: Date;
  /** Email of whoever asked. */
  requestedBy: string;
  /** True when a platform admin asked on the owner's behalf. */
  byAdmin: boolean;
  /** Where the owner signs in to cancel or export. */
  dashboardUrl: string;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escAttr = (s: string) => esc(s).replace(/"/g, "&quot;");

const BUTTON_STYLE = "display:inline-block;padding:12px 24px;background:#26282e;color:#f7f7f9;text-decoration:none;border-radius:6px;font-size:14px;font-weight:500;";

/** "Oct 11, 2026" in UTC, so the email and the dashboard name the same day. */
export function utcDay(d: Date): string {
  return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
}

export function buildDeletionScheduledEmail(
  n: DeletionNoticeInput,
  input: TransactionalEmailInput,
): { html: string; text: string; subject: string } {
  const day = utcDay(n.erasureDate);
  const who = n.byAdmin ? `A Mailforge administrator (${n.requestedBy}) asked for` : `${n.requestedBy} asked for`;
  // Header-injection guard: a workspace name is user text and goes into a subject line.
  const subject = `Your workspace "${n.workspaceName.replace(/[\r\n]+/g, " ")}" is scheduled for deletion`;

  const bodyHtml = [
    `<p style="margin:0 0 16px 0;">${esc(who)} the workspace <strong>${esc(n.workspaceName)}</strong> to be deleted.</p>`,
    `<p style="margin:0 0 16px 0;">Everything in it will be erased for good on <strong>${esc(day)}</strong>: contacts, events, flows, messages, templates and settings. Sending and the API have already stopped.</p>`,
    `<p style="margin:0 0 24px 0;">Until then you can sign in to download your data, or cancel the deletion and carry on as before.</p>`,
    `<p style="margin:0 0 24px 0;"><a href="${escAttr(n.dashboardUrl)}" style="${BUTTON_STYLE}">Sign in to cancel or export</a></p>`,
    `<p style="margin:0;font-size:13px;color:#585d68;">If you did not expect this, sign in and cancel the deletion now, and tell us. After ${esc(day)} it cannot be undone.</p>`,
  ].join("\n");

  const bodyText = [
    `${who} the workspace "${n.workspaceName}" to be deleted.`,
    "",
    `Everything in it will be erased for good on ${day}: contacts, events, flows, messages, templates and settings. Sending and the API have already stopped.`,
    "",
    "Until then you can sign in to download your data, or cancel the deletion and carry on as before:",
    "",
    n.dashboardUrl,
    "",
    `If you did not expect this, sign in and cancel the deletion now, and tell us. After ${day} it cannot be undone.`,
  ].join("\n");

  const html = wrapInShell({ bodyHtml, brand: input.brand, tenantName: input.tenantName, complianceFooterHtml: "" });
  const text = wrapInTextShell({ bodyText, brand: input.brand, tenantName: input.tenantName, complianceFooterText: "" });
  return { html, text, subject };
}

export interface CancelledNoticeEmailInput {
  workspaceName: string;
  /** Email of whoever cancelled. */
  cancelledBy: string;
  /** True when a platform admin cancelled on the owner's behalf. */
  byAdmin: boolean;
  dashboardUrl: string;
}

export function buildDeletionCancelledEmail(
  n: CancelledNoticeEmailInput,
  input: TransactionalEmailInput,
): { html: string; text: string; subject: string } {
  const who = n.byAdmin ? `A Mailforge administrator (${n.cancelledBy})` : n.cancelledBy;
  const subject = `Deletion of your workspace "${n.workspaceName.replace(/[\r\n]+/g, " ")}" was cancelled`;

  const bodyHtml = [
    `<p style="margin:0 0 16px 0;">${esc(who)} cancelled the scheduled deletion of the workspace <strong>${esc(n.workspaceName)}</strong>.</p>`,
    `<p style="margin:0 0 16px 0;">Nothing was erased and it will not be. The pause on sending and the API that came with the deletion request has ended.</p>`,
    `<p style="margin:0 0 24px 0;"><a href="${escAttr(n.dashboardUrl)}" style="${BUTTON_STYLE}">Open Mailforge</a></p>`,
    `<p style="margin:0;font-size:13px;color:#585d68;">If you did not expect this, someone with access to the account did it. Sign in and review who is on your team.</p>`,
  ].join("\n");

  const bodyText = [
    `${who} cancelled the scheduled deletion of the workspace "${n.workspaceName}".`,
    "",
    "Nothing was erased and it will not be. The pause on sending and the API that came with the deletion request has ended.",
    "",
    n.dashboardUrl,
    "",
    "If you did not expect this, someone with access to the account did it. Sign in and review who is on your team.",
  ].join("\n");

  const html = wrapInShell({ bodyHtml, brand: input.brand, tenantName: input.tenantName, complianceFooterHtml: "" });
  const text = wrapInTextShell({ bodyText, brand: input.brand, tenantName: input.tenantName, complianceFooterText: "" });
  return { html, text, subject };
}

export interface ErasedNoticeInput {
  workspaceName: string;
  /** Email of the platform admin who erased it. */
  erasedBy: string;
  erasedAt: Date;
  /** Where to write with questions, when the operator has set one. */
  supportEmail: string | null;
}

export function buildWorkspaceErasedEmail(
  n: ErasedNoticeInput,
  input: TransactionalEmailInput,
): { html: string; text: string; subject: string } {
  const day = utcDay(n.erasedAt);
  const subject = `Your workspace "${n.workspaceName.replace(/[\r\n]+/g, " ")}" has been deleted`;
  const help = n.supportEmail ? `If you have questions, write to ${n.supportEmail}.` : "If you have questions, contact the service operator.";

  const bodyHtml = [
    `<p style="margin:0 0 16px 0;">A Mailforge administrator (${esc(n.erasedBy)}) permanently deleted the workspace <strong>${esc(n.workspaceName)}</strong> on <strong>${esc(day)}</strong>.</p>`,
    `<p style="margin:0 0 16px 0;">Everything in it has been erased and cannot be recovered: contacts, events, flows, messages, templates and settings. Sending and the API have stopped, and nobody can sign in to it any more.</p>`,
    `<p style="margin:0;font-size:13px;color:#585d68;">${esc(help)}</p>`,
  ].join("\n");

  const bodyText = [
    `A Mailforge administrator (${n.erasedBy}) permanently deleted the workspace "${n.workspaceName}" on ${day}.`,
    "",
    "Everything in it has been erased and cannot be recovered: contacts, events, flows, messages, templates and settings. Sending and the API have stopped, and nobody can sign in to it any more.",
    "",
    help,
  ].join("\n");

  const html = wrapInShell({ bodyHtml, brand: input.brand, tenantName: input.tenantName, complianceFooterHtml: "" });
  const text = wrapInTextShell({ bodyText, brand: input.brand, tenantName: input.tenantName, complianceFooterText: "" });
  return { html, text, subject };
}
