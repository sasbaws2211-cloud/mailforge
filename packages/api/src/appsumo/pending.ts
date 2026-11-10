/**
 * The "code waiting" cookie.
 *
 * A buyer who lands on /redeem or the AppSumo activation redirect before they have an account cannot claim
 * their licence yet. We keep it for an hour, encrypted (AES-256-GCM, the same key as email credentials) in an
 * HttpOnly cookie, so that after they sign up the Plan page can finish the job with one click. Without an
 * ENCRYPTION_KEY nothing is remembered and the buyer is told to paste the code once they are signed in.
 *
 * Mirror side: PUBLIC (packages/api is mirrored).
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import { decrypt, encrypt, parseEncryptionKey } from "@loomail/adapters";

export const PENDING_COOKIE = "loomail_appsumo_license";
const TTL_SECONDS = 3600;

function key(): Buffer | null {
  const env = process.env.ENCRYPTION_KEY;
  if (!env) return null;
  try {
    return parseEncryptionKey(env);
  } catch {
    return null;
  }
}

/** Remember a licence key for an hour. Returns false when it could not be kept. */
export function rememberPending(reply: FastifyReply, licenseKey: string, secure: boolean, nowMs: number = Date.now()): boolean {
  const k = key();
  if (!k) return false;
  const value = encrypt(JSON.stringify({ k: licenseKey, exp: nowMs + TTL_SECONDS * 1000 }), k);
  reply.setCookie(PENDING_COOKIE, value, { httpOnly: true, sameSite: "lax", secure, path: "/", maxAge: TTL_SECONDS });
  return true;
}

/** The licence key waiting for this browser, or "". */
export function readPending(request: FastifyRequest, nowMs: number = Date.now()): string {
  const raw = (request.cookies as Record<string, string | undefined> | undefined)?.[PENDING_COOKIE];
  const k = key();
  if (!raw || !k) return "";
  try {
    const data = JSON.parse(decrypt(raw, k)) as { k?: unknown; exp?: unknown };
    return typeof data.k === "string" && typeof data.exp === "number" && data.exp > nowMs ? data.k : "";
  } catch {
    return "";
  }
}

export function clearPending(reply: FastifyReply): void {
  reply.clearCookie(PENDING_COOKIE, { path: "/" });
}
