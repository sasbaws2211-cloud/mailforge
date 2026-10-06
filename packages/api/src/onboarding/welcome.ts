/**
 * The welcome email: sent once, the first time the owner of a workspace created through
 * public signup signs in.
 *
 * Why at first sign-in and not at signup: the signup email already carries the sign-in
 * link, and a second email in the same minute is noise. Waiting for the first sign-in means
 * the person has arrived, so the email lands as "here is what to do next", and it is only
 * ever sent to an address that proved it can receive mail.
 *
 * Rules:
 *   - Only workspaces that came through signup (settings.signup exists). Self-hosted and
 *     hand-made workspaces never get one.
 *   - Once. The claim is one UPDATE that fails if welcome_sent_at is already set, so two
 *     fast sign-ins cannot both send. If sending fails the claim is released, so the next
 *     sign-in tries again.
 *   - Sent through the operator's platform sender. With none configured nothing is sent
 *     and nothing is claimed.
 *   - Never throws and never delays sign-in: the caller does not await it.
 *
 * Mirror side: PUBLIC (packages/api is mirrored).
 */
import { sql } from "drizzle-orm";
import { parseGoal, trialDaysLeft } from "@mailforge/core";
import type { Db } from "../plugins/db.js";
import { getPlatformTransport, type PlatformTransport } from "../platform-mailer.js";
import { buildWelcomeEmail, type TransactionalEmailInput } from "../transactional-email.js";

export type WelcomeResult = "sent" | "skipped" | "failed";

export interface WelcomeOptions {
  dashboardUrl: string;
  /** Test seam: defaults to the platform transport from the environment. */
  transport?: PlatformTransport | null;
  now?: Date;
  log?: { warn: (obj: object, msg: string) => void };
}

interface ClaimRow extends Record<string, unknown> {
  name: string;
  settings: Record<string, unknown> | null;
  trial_ends_at: Date | string | null;
}

export async function sendWelcomeEmailOnce(
  db: Db,
  tenantId: string,
  userId: string,
  opts: WelcomeOptions,
): Promise<WelcomeResult> {
  const transport = opts.transport === undefined ? getPlatformTransport() : opts.transport;
  if (!transport) return "skipped";
  const now = opts.now ?? new Date();

  try {
    // Claim. Only signup-created workspaces, only if not claimed before.
    const claimed = await db.execute<ClaimRow>(sql`
      UPDATE tenants
      SET settings = jsonb_set(
        settings,
        '{onboarding}',
        COALESCE(settings->'onboarding', '{}'::jsonb) || ${JSON.stringify({ welcome_sent_at: now.toISOString() })}::jsonb
      )
      WHERE id = ${tenantId}::uuid
        AND settings ? 'signup'
        AND (settings->'onboarding'->>'welcome_sent_at') IS NULL
      RETURNING name, settings, trial_ends_at
    `);
    const tenant = claimed.rows[0];
    if (!tenant) return "skipped";

    const who = await db.execute<{ email: string }>(sql`SELECT email FROM users WHERE id = ${userId}::uuid LIMIT 1`);
    const to = who.rows[0]?.email;
    if (!to) {
      await release(db, tenantId);
      return "skipped";
    }

    const brand = ((tenant.settings ?? {}).brand as TransactionalEmailInput["brand"] | undefined) ?? {};
    const trialEndsAt = tenant.trial_ends_at ? new Date(tenant.trial_ends_at) : null;
    const email = buildWelcomeEmail({
      brand,
      tenantName: tenant.name,
      dashboardUrl: opts.dashboardUrl,
      trialDaysLeft: trialEndsAt ? trialDaysLeft(trialEndsAt, now) : null,
      supportEmail: process.env.MAILFORGE_SUPPORT_EMAIL?.trim() || null,
      goal: parseGoal(((tenant.settings ?? {}).signup as { goal?: unknown } | undefined)?.goal),
    });

    const result = await transport.adapter.send({
      to,
      from: transport.fromEmail,
      fromName: transport.fromName ?? undefined,
      subject: email.subject,
      bodyHtml: email.html,
      bodyText: email.text,
      headers: {},
      messageId: `welcome-${tenantId}`,
    });
    if (!result.success) {
      await release(db, tenantId);
      opts.log?.warn({ error: result.error }, "welcome email not sent; will retry at next sign-in");
      return "failed";
    }
    return "sent";
  } catch (err) {
    try {
      await release(db, tenantId);
    } catch {
      /* the claim stays; one missed welcome email is better than an error at sign-in */
    }
    opts.log?.warn({ err: err instanceof Error ? err.message : String(err) }, "welcome email failed");
    return "failed";
  }
}

/** Give the claim back so the next sign-in retries. */
async function release(db: Db, tenantId: string): Promise<void> {
  await db.execute(sql`
    UPDATE tenants
    SET settings = jsonb_set(settings, '{onboarding}', (settings->'onboarding') - 'welcome_sent_at')
    WHERE id = ${tenantId}::uuid AND settings->'onboarding' IS NOT NULL
  `);
}
