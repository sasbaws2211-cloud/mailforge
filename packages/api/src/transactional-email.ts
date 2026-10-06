/**
 * Branded transactional email builder.
 *
 * All transactional emails (login link, invite, email-change verification)
 * go through the branded shell, just like lifecycle emails. This module
 * provides body-content builders for each transactional type; the caller
 * wraps the result in the shell via @mailforge/core email-shell.
 *
 * These emails are TRANSACTIONAL - they do not carry compliance footers
 * (no List-Unsubscribe, no postal address) because they are direct
 * responses to the recipient's own action. The shell's compliance slot
 * is filled with an empty string.
 *
 * Mirror side: PUBLIC (packages/api is mirrored).
 */
import { BUSINESS_MODEL_TEMPLATES, GOAL_INFO, ONBOARDING_GOALS, wrapInShell, wrapInTextShell, type BrandSettings, type OnboardingGoal } from "@mailforge/core";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeHtmlAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Button style shared across all transactional emails. */
const BUTTON_STYLE = "display:inline-block;padding:12px 24px;background:#26282e;color:#f7f7f9;text-decoration:none;border-radius:6px;font-size:14px;font-weight:500;";

export interface TransactionalEmailInput {
  brand: BrandSettings;
  tenantName: string;
}

// ---------------------------------------------------------------------------
// Login link email
// ---------------------------------------------------------------------------

export function buildLoginEmail(
  loginUrl: string,
  expiryMinutes: number,
  input: TransactionalEmailInput,
): { html: string; text: string } {
  const bodyHtml = [
    `<p style="margin:0 0 16px 0;">You requested a login link. Click below to sign in:</p>`,
    `<p style="margin:0 0 24px 0;"><a href="${escapeHtmlAttr(loginUrl)}" style="${BUTTON_STYLE}">Sign in to Mailforge</a></p>`,
    `<p style="margin:0 0 8px 0;font-size:13px;color:#585d68;">Or copy this URL:<br/><span style="word-break:break-all;">${escapeHtml(loginUrl)}</span></p>`,
    `<p style="margin:0;font-size:13px;color:#585d68;">This link expires in ${expiryMinutes} minutes and can only be used once.</p>`,
  ].join("\n");

  const bodyText = [
    "You requested a login link. Open this URL to sign in:",
    "",
    loginUrl,
    "",
    `This link expires in ${expiryMinutes} minutes and can only be used once.`,
  ].join("\n");

  const html = wrapInShell({
    bodyHtml,
    brand: input.brand,
    tenantName: input.tenantName,
    complianceFooterHtml: "",
  });

  const text = wrapInTextShell({
    bodyText,
    brand: input.brand,
    tenantName: input.tenantName,
    complianceFooterText: "",
  });

  return { html, text };
}

// ---------------------------------------------------------------------------
// Invite email
// ---------------------------------------------------------------------------

export function buildInviteEmail(
  inviteUrl: string,
  inviterName: string | null,
  expiryDays: number,
  input: TransactionalEmailInput,
): { html: string; text: string; subject: string } {
  const brandName = input.brand.brand_name || input.tenantName;
  const inviterLabel = inviterName || "A team member";

  const bodyHtml = [
    `<p style="margin:0 0 16px 0;">${escapeHtml(inviterLabel)} has invited you to join <strong>${escapeHtml(brandName)}</strong> on Mailforge.</p>`,
    `<p style="margin:0 0 24px 0;"><a href="${escapeHtmlAttr(inviteUrl)}" style="${BUTTON_STYLE}">Accept invitation</a></p>`,
    `<p style="margin:0 0 8px 0;font-size:13px;color:#585d68;">Or copy this URL:<br/><span style="word-break:break-all;">${escapeHtml(inviteUrl)}</span></p>`,
    `<p style="margin:0;font-size:13px;color:#585d68;">This invitation expires in ${expiryDays} days.</p>`,
  ].join("\n");

  const bodyText = [
    `${inviterLabel} has invited you to join ${brandName} on Mailforge.`,
    "",
    "Accept the invitation by opening this URL:",
    "",
    inviteUrl,
    "",
    `This invitation expires in ${expiryDays} days.`,
  ].join("\n");

  const html = wrapInShell({
    bodyHtml,
    brand: input.brand,
    tenantName: input.tenantName,
    complianceFooterHtml: "",
  });

  const text = wrapInTextShell({
    bodyText,
    brand: input.brand,
    tenantName: input.tenantName,
    complianceFooterText: "",
  });

  const subject = `You've been invited to ${brandName}`;

  return { html, text, subject };
}

// ---------------------------------------------------------------------------
// Welcome email (first sign-in of a workspace created through public signup)
// ---------------------------------------------------------------------------

export interface WelcomeEmailInput extends TransactionalEmailInput {
  /** Where the dashboard lives; the button goes here (no token: they are already signed in). */
  dashboardUrl: string;
  /** Whole days left on the trial, or null when there is no trial. */
  trialDaysLeft: number | null;
  /** Where replies and questions go, when known. */
  supportEmail: string | null;
  /** What they said they wanted at signup. Omitted or null = the general welcome. */
  goal?: OnboardingGoal | null;
}

/**
 * The goal-specific part of the welcome: a line that shows we listened, and for the goals that
 * have ready-made flows, what to add once the Welcome flow is on. Null = the general welcome.
 * Flow names come from the real template, so the email can never promise flows that do not exist.
 */
export function goalWelcome(goal: OnboardingGoal | null | undefined): { intro: string; next: string | null } | null {
  if (!goal || goal === "explore" || !(ONBOARDING_GOALS as readonly string[]).includes(goal)) return null;
  if (goal === "welcome") {
    return {
      intro: "You said you want to welcome new signups. The Welcome flow in step 3 does exactly that: three short emails over three days, starting the moment someone signs up.",
      next: null,
    };
  }
  const templateId = GOAL_INFO[goal].template;
  const template = templateId ? BUSINESS_MODEL_TEMPLATES[templateId] : null;
  if (!template) return null;
  const sentence = goal === "convert_trials" ? "turn trial users into paying customers" : "move free users to a paid plan";
  return {
    intro: `You said you want to ${sentence}.`,
    next: `Once the Welcome flow is on, add the ${template.name} flows from your Home page: ${template.flows.map((f) => f.name).join(", ")}. They are created as drafts, so nothing sends until you switch each one on.`,
  };
}

/** The three things that get a new workspace to its first email, in the order to do them. */
const WELCOME_STEPS: ReadonlyArray<[title: string, why: string]> = [
  ["Add your business address", "It is required in every marketing email's footer, so sending stays switched off until it is set."],
  ["Choose how email is sent", "Use Mailforge Sending with your own domain, or connect Resend, SES or SMTP."],
  ["Turn on the Welcome flow and send an event", "Three ready-made emails that start when someone signs up. No AI setup needed."],
];

export function buildWelcomeEmail(input: WelcomeEmailInput): { html: string; text: string; subject: string } {
  const name = input.brand.brand_name || input.tenantName;
  const trialLine =
    input.trialDaysLeft !== null && input.trialDaysLeft > 0
      ? `Your free trial runs for ${input.trialDaysLeft} more day${input.trialDaysLeft === 1 ? "" : "s"}. No card is needed and nothing is charged.`
      : null;
  const url = input.dashboardUrl;
  const goal = goalWelcome(input.goal);

  const stepsHtml = WELCOME_STEPS.map(
    ([title, why], i) =>
      `<tr><td valign="top" style="padding:0 12px 14px 0;font-weight:600;color:#26282e;">${i + 1}.</td>` +
      `<td style="padding:0 0 14px 0;"><strong>${escapeHtml(title)}</strong><br/><span style="font-size:13px;color:#585d68;">${escapeHtml(why)}</span></td></tr>`,
  ).join("\n");

  const bodyHtml = [
    `<p style="margin:0 0 16px 0;">Welcome. <strong>${escapeHtml(name)}</strong> is ready, and it takes about 20 minutes to send your first email.</p>`,
    goal ? `<p style="margin:0 0 16px 0;">${escapeHtml(goal.intro)}</p>` : "",
    trialLine ? `<p style="margin:0 0 20px 0;font-size:14px;color:#585d68;">${escapeHtml(trialLine)}</p>` : "",
    `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 12px 0;">${stepsHtml}</table>`,
    goal?.next ? `<p style="margin:0 0 12px 0;font-size:14px;color:#585d68;"><strong style="color:#26282e;">After that.</strong> ${escapeHtml(goal.next)}</p>` : "",
    `<p style="margin:12px 0 24px 0;"><a href="${escapeHtmlAttr(url)}" style="${BUTTON_STYLE}">Open your workspace</a></p>`,
    input.supportEmail
      ? `<p style="margin:0;font-size:13px;color:#585d68;">Stuck on anything? Reply to <a href="mailto:${escapeHtmlAttr(input.supportEmail)}">${escapeHtml(input.supportEmail)}</a> and a person will help.</p>`
      : "",
  ]
    .filter((s) => s !== "")
    .join("\n");

  const bodyText = [
    `Welcome. ${name} is ready, and it takes about 20 minutes to send your first email.`,
    ...(goal ? ["", goal.intro] : []),
    ...(trialLine ? ["", trialLine] : []),
    "",
    ...WELCOME_STEPS.flatMap(([title, why], i) => [`${i + 1}. ${title}`, `   ${why}`]),
    ...(goal?.next ? ["", `After that. ${goal.next}`] : []),
    "",
    `Open your workspace: ${url}`,
    ...(input.supportEmail ? ["", `Stuck on anything? Write to ${input.supportEmail} and a person will help.`] : []),
  ].join("\n");

  return {
    subject: `Welcome to Mailforge: your first email in 20 minutes`,
    html: wrapInShell({ bodyHtml, brand: input.brand, tenantName: input.tenantName, complianceFooterHtml: "" }),
    text: wrapInTextShell({ bodyText, brand: input.brand, tenantName: input.tenantName, complianceFooterText: "" }),
  };
}

// ---------------------------------------------------------------------------
// Onboarding nudge (a workspace that has not finished setting up)
// ---------------------------------------------------------------------------

export interface NudgeEmailInput extends TransactionalEmailInput {
  /** Absolute link to the page where the next step is done. */
  stepUrl: string;
  stepTitle: string;
  stepDescription: string;
  stepMinutes: number;
  stepCta: string;
  done: number;
  total: number;
  /** 1 for the first nudge, 2 for the last. */
  nth: number;
  trialDaysLeft: number | null;
  supportEmail: string | null;
}

export function buildNudgeEmail(input: NudgeEmailInput): { html: string; text: string; subject: string } {
  const name = input.brand.brand_name || input.tenantName;
  const last = input.nth >= 2;
  const left = input.total - input.done;
  const subject = last
    ? `Last reminder: ${name} is ${left === 1 ? "one step" : `${left} steps`} from its first email`
    : `${name} is ${left === 1 ? "one step" : `${left} steps`} from sending its first email`;
  const progress = `${input.done} of ${input.total} steps done.`;
  const mins = input.stepMinutes > 0 ? ` It takes about ${input.stepMinutes} minute${input.stepMinutes === 1 ? "" : "s"}.` : "";
  const trial =
    input.trialDaysLeft !== null && input.trialDaysLeft > 0
      ? `Your free trial has ${input.trialDaysLeft} day${input.trialDaysLeft === 1 ? "" : "s"} left.`
      : null;
  const stop = last
    ? "This is the last reminder we will send."
    : "We will send at most one more reminder.";
  const how = 'To stop these now, open your workspace and choose "I will finish this later".';

  const bodyHtml = [
    `<p style="margin:0 0 16px 0;">${escapeHtml(progress)} The next step is <strong>${escapeHtml(input.stepTitle)}</strong>.</p>`,
    `<p style="margin:0 0 20px 0;font-size:14px;color:#585d68;">${escapeHtml(input.stepDescription)}${escapeHtml(mins)}</p>`,
    `<p style="margin:0 0 24px 0;"><a href="${escapeHtmlAttr(input.stepUrl)}" style="${BUTTON_STYLE}">${escapeHtml(input.stepCta)}</a></p>`,
    trial ? `<p style="margin:0 0 8px 0;font-size:13px;color:#585d68;">${escapeHtml(trial)}</p>` : "",
    input.supportEmail
      ? `<p style="margin:0 0 8px 0;font-size:13px;color:#585d68;">Stuck? Reply to <a href="mailto:${escapeHtmlAttr(input.supportEmail)}">${escapeHtml(input.supportEmail)}</a> and a person will help.</p>`
      : "",
    `<p style="margin:0;font-size:12px;color:#585d68;">${escapeHtml(stop)} ${escapeHtml(how)}</p>`,
  ]
    .filter((x) => x !== "")
    .join("\n");

  const bodyText = [
    `${progress} The next step is ${input.stepTitle}.`,
    "",
    `${input.stepDescription}${mins}`,
    "",
    `${input.stepCta}: ${input.stepUrl}`,
    ...(trial ? ["", trial] : []),
    ...(input.supportEmail ? ["", `Stuck? Write to ${input.supportEmail} and a person will help.`] : []),
    "",
    `${stop} ${how}`,
  ].join("\n");

  return {
    subject,
    html: wrapInShell({ bodyHtml, brand: input.brand, tenantName: input.tenantName, complianceFooterHtml: "" }),
    text: wrapInTextShell({ bodyText, brand: input.brand, tenantName: input.tenantName, complianceFooterText: "" }),
  };
}

// ---------------------------------------------------------------------------
// Email change verification
// ---------------------------------------------------------------------------

export function buildEmailChangeEmail(
  verifyUrl: string,
  newEmail: string,
  expiryHours: number,
  input: TransactionalEmailInput,
): { html: string; text: string; subject: string } {
  const brandName = input.brand.brand_name || input.tenantName;

  const bodyHtml = [
    `<p style="margin:0 0 16px 0;">You requested to change your email address on ${escapeHtml(brandName)} to <strong>${escapeHtml(newEmail)}</strong>.</p>`,
    `<p style="margin:0 0 16px 0;">Click below to confirm this change:</p>`,
    `<p style="margin:0 0 24px 0;"><a href="${escapeHtmlAttr(verifyUrl)}" style="${BUTTON_STYLE}">Confirm email change</a></p>`,
    `<p style="margin:0 0 8px 0;font-size:13px;color:#585d68;">Or copy this URL:<br/><span style="word-break:break-all;">${escapeHtml(verifyUrl)}</span></p>`,
    `<p style="margin:0;font-size:13px;color:#585d68;">This link expires in ${expiryHours} hours. If you did not request this change, ignore this email.</p>`,
  ].join("\n");

  const bodyText = [
    `You requested to change your email address on ${brandName} to ${newEmail}.`,
    "",
    "Confirm this change by opening this URL:",
    "",
    verifyUrl,
    "",
    `This link expires in ${expiryHours} hours. If you did not request this change, ignore this email.`,
  ].join("\n");

  const html = wrapInShell({
    bodyHtml,
    brand: input.brand,
    tenantName: input.tenantName,
    complianceFooterHtml: "",
  });

  const text = wrapInTextShell({
    bodyText,
    brand: input.brand,
    tenantName: input.tenantName,
    complianceFooterText: "",
  });

  const subject = `Confirm your new email address`;

  return { html, text, subject };
}
