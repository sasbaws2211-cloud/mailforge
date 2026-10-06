/**
 * Platform mailer: the operator's own email sender for account emails
 * (login links and signup confirmation).
 *
 * A tenant normally sends login links through its own email transport. A
 * brand-new workspace created through public signup has none yet, so it could
 * never receive its first login link. When these variables are set, login
 * mail falls back to this sender for any tenant without a transport of its
 * own. With nothing set this returns null and behavior is unchanged
 * (self-hosted installs).
 *
 * Configure ONE of:
 *   PLATFORM_RESEND_API_KEY                      Resend HTTP API
 *   PLATFORM_SMTP_HOST (+ _PORT, _SECURE,        any SMTP relay
 *     _USER, _PASSWORD, _REJECT_UNAUTHORIZED)
 * and always:
 *   PLATFORM_FROM_EMAIL                          e.g. no-reply@yourdomain.com
 *   PLATFORM_FROM_NAME                           optional display name
 *
 * Account email is transactional: it bypasses throttle, suppression and
 * compliance footers, exactly like login links sent through a tenant transport.
 *
 * Mirror side: PUBLIC (packages/api is mirrored).
 */
import {
  ResendTransportAdapter,
  SmtpTransportAdapter,
  type TransportAdapter,
} from "@mailforge/adapters";

export interface PlatformTransport {
  adapter: TransportAdapter;
  fromEmail: string;
  fromName: string | null;
}

type Env = Record<string, string | undefined>;

function flag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback;
  return value.toLowerCase() === "true" || value === "1";
}

/**
 * Build the platform transport from environment variables, or null when it is
 * not configured (or incompletely configured: a missing from-address means we
 * would not know who to send as, so we do not guess).
 */
export function getPlatformTransport(env: Env = process.env): PlatformTransport | null {
  const fromEmail = env.PLATFORM_FROM_EMAIL?.trim();
  if (!fromEmail) return null;
  const fromName = env.PLATFORM_FROM_NAME?.trim() || null;

  const resendKey = env.PLATFORM_RESEND_API_KEY?.trim();
  if (resendKey) {
    return { adapter: new ResendTransportAdapter({ apiKey: resendKey }), fromEmail, fromName };
  }

  const host = env.PLATFORM_SMTP_HOST?.trim();
  if (host) {
    const port = Number.parseInt(env.PLATFORM_SMTP_PORT ?? "587", 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    const adapter = new SmtpTransportAdapter({
      host,
      port,
      secure: flag(env.PLATFORM_SMTP_SECURE, port === 465),
      username: env.PLATFORM_SMTP_USER || undefined,
      password: env.PLATFORM_SMTP_PASSWORD || undefined,
      rejectUnauthorized: flag(env.PLATFORM_SMTP_REJECT_UNAUTHORIZED, true),
    });
    return { adapter, fromEmail, fromName };
  }

  return null;
}
