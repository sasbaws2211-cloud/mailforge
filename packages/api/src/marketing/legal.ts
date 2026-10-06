/**
 * Legal pages: Terms of Service and Privacy Policy.
 *
 * These are a starting template written to match how the product actually
 * handles data today. They are NOT legal advice. Have a lawyer review and
 * adapt them to your jurisdiction and business before you launch, and update
 * the "last updated" date when you change them.
 *
 * Operator-specific values (legal entity, support address) come from
 * SiteContext, which reads MAILFORGE_LEGAL_NAME and MAILFORGE_SUPPORT_EMAIL.
 *
 * Mirror side: PUBLIC (packages/api is mirrored).
 */
import { esc, renderPage, SITE_NAME, type SiteContext } from "./layout.js";

/** Bump when the text changes in substance. */
export const LEGAL_UPDATED = "4 October 2026";

function legalPage(ctx: SiteContext, path: string, title: string, intro: string, sections: Array<[string, string]>): string {
  const body = `
<div class="wrap"><article class="legal">
  <h1>${esc(title)}</h1>
  <p class="upd">Last updated ${esc(LEGAL_UPDATED)}</p>
  <p>${intro}</p>
  ${sections.map(([h, html]) => `<h2>${esc(h)}</h2>${html}`).join("\n")}
</article></div>`;
  return renderPage(
    ctx,
    { title: `${title}: ${SITE_NAME}`, description: `${title} for ${SITE_NAME}.`, path },
    body,
  );
}

export function termsPage(ctx: SiteContext): string {
  const who = esc(ctx.legalName);
  const mail = `<a href="mailto:${esc(ctx.supportEmail)}">${esc(ctx.supportEmail)}</a>`;
  return legalPage(
    ctx,
    "/terms",
    "Terms of Service",
    `These terms govern your use of ${SITE_NAME}, operated by ${who} (&ldquo;we&rdquo;, &ldquo;us&rdquo;). By creating a workspace or using the service you agree to them.`,
    [
      [
        "The service",
        `<p>${SITE_NAME} is software that receives events about your users, decides when to email them, and sends those emails through an email provider that you connect. You are responsible for the content of your emails, the lists you send to, and your own provider account.</p>`,
      ],
      [
        "Your account",
        `<p>You must give accurate information when you sign up and keep access to your email address secure. You are responsible for activity in your workspace, including by teammates you invite. Tell us promptly at ${mail} if you think your account has been misused.</p>`,
      ],
      [
        "Acceptable use",
        `<p>You may use ${SITE_NAME} only to email people who have a relationship with you and who have not asked you to stop. You must not send unsolicited bulk email, deceptive or illegal content, or anything that breaks the law that applies to you or your recipients, including anti-spam rules such as CAN-SPAM and equivalent laws elsewhere. Every message must include a working unsubscribe link and your postal address, and you must honor unsubscribe requests. We may suspend a workspace that is used to send spam or abuse, or that damages the reputation of our systems.</p>`,
      ],
      [
        "Your data",
        `<p>You keep ownership of the contacts, events and content you put into ${SITE_NAME}. You give us permission to process them only to provide the service to you. You promise that you have the right to share that data with us and to email those people.</p>`,
      ],
      [
        "Plans, trials and payment",
        `<p>A new workspace starts with a free trial of a paid plan, with no card required. When the trial ends the workspace moves to the Free plan unless you choose a paid plan. Paid plans are billed in advance, monthly or yearly, at the price shown on our pricing page when you subscribe. We will tell you before we change prices, and a change applies from your next billing period. You can cancel at any time and your plan stays active until the end of the period you paid for.</p>`,
      ],
      [
        "Availability and changes",
        `<p>We work to keep ${SITE_NAME} available but do not promise uninterrupted service. We may improve, change or remove features, and we will give reasonable notice of changes that significantly affect you.</p>`,
      ],
      [
        "Ending the relationship",
        `<p>You may stop using ${SITE_NAME} and ask us to delete your workspace at any time by writing to ${mail}. We may suspend or end access if you break these terms. After a workspace is closed we delete its data within a reasonable period, except where the law requires us to keep it.</p>`,
      ],
      [
        "Liability",
        `<p>The service is provided &ldquo;as is&rdquo;. To the extent the law allows, we are not liable for indirect or consequential loss, lost profit, or lost data, and our total liability for any claim is limited to the amount you paid us in the twelve months before the claim. Nothing in these terms limits liability that cannot be limited by law.</p>`,
      ],
      [
        "Changes to these terms",
        `<p>We may update these terms. If a change is material we will tell you by email or in the product before it takes effect. Continuing to use the service after that means you accept the new terms.</p>`,
      ],
      ["Contact", `<p>Questions about these terms: ${mail}.</p>`],
    ],
  );
}

export function privacyPage(ctx: SiteContext): string {
  const who = esc(ctx.legalName);
  const mail = `<a href="mailto:${esc(ctx.supportEmail)}">${esc(ctx.supportEmail)}</a>`;
  return legalPage(
    ctx,
    "/privacy",
    "Privacy Policy",
    `This policy explains what ${who} collects when you use ${SITE_NAME}, why, and the choices you have.`,
    [
      [
        "Two kinds of data",
        `<p><b>Account data</b> is what you give us to use the service: your name or workspace name, your email address and your team members. For this we are the controller.</p>
         <p><b>Customer data</b> is what you send into ${SITE_NAME}: your contacts, their email addresses and traits, and the events they trigger. For this you are the controller and we act as your processor, handling it only on your instructions to run your flows and show you your own reports.</p>`,
      ],
      [
        "What we collect",
        `<ul><li>Account data: workspace name, email addresses of team members, sign-in times.</li>
         <li>Customer data you choose to send: contact details, traits and events.</li>
         <li>Email sending records: which message went to which contact and when, and unsubscribe or suppression status.</li>
         <li>Technical data: IP address, browser type and basic request logs, used to run and secure the service.</li></ul>`,
      ],
      [
        "Cookies",
        `<p>We use one essential cookie to keep you signed in. We do not use advertising or cross-site tracking cookies on this site.</p>`,
      ],
      [
        "How we use data",
        `<p>To provide and secure the service, to send you account emails such as sign-in links, to answer support requests, to prevent abuse, and to meet legal obligations. We do not sell personal data.</p>`,
      ],
      [
        "Who we share it with",
        `<p>Only with providers that help us run the service, under contract: hosting and database providers, an email provider for account emails, and a payment provider when you subscribe. Emails to your contacts are sent through the email provider that you connect, so that provider also handles those messages under your own agreement with them.</p>`,
      ],
      [
        "How long we keep it",
        `<p>We keep data while your workspace is active. When a workspace is deleted we remove its customer data within a reasonable period, except for records the law requires us to keep.</p>`,
      ],
      [
        "Your rights",
        `<p>Depending on where you live you may have the right to access, correct, export or delete your personal data, and to object to some processing. Write to ${mail} and we will respond within a reasonable time. If you are a contact of one of our customers, please contact that customer first, because they decide how your data is used.</p>`,
      ],
      [
        "Security",
        `<p>We protect data with access controls, encryption of stored credentials and encrypted connections. No system is perfectly secure, and we will notify affected customers of a breach as required by law.</p>`,
      ],
      [
        "Changes and contact",
        `<p>We will update this page when our practices change and note the date at the top. Questions: ${mail}.</p>`,
      ],
    ],
  );
}
