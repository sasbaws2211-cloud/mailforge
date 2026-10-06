/**
 * Who runs the platform.
 *
 * A platform admin is a signed-in user whose email appears in
 * MAILFORGE_PLATFORM_ADMINS (comma separated, case-insensitive). It is an env
 * setting, not a database flag, on purpose: there is no screen, API or SQL path
 * inside the app through which a customer could grant it to themselves.
 *
 * Read on every call so tests and a restarted process see the current value.
 * Because sign-in is by emailed link, being listed is only as safe as control of
 * that mailbox: list only addresses you control.
 *
 * Mirror side: PUBLIC (packages/api is mirrored).
 */

export function platformAdminEmails(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.MAILFORGE_PLATFORM_ADMINS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.length > 0);
}

export function isPlatformAdmin(email: string | null | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!email) return false;
  return platformAdminEmails(env).includes(email.trim().toLowerCase());
}
