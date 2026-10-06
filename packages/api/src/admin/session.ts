/**
 * Admin console sessions: what both sign-in methods (emailed link, passkey) end up
 * creating. One place, so the cookie rules cannot drift apart between them.
 *
 * Mirror side: PUBLIC (packages/api is mirrored).
 */
import type { FastifyReply } from "fastify";
import { adminSessions } from "@mailforge/db/schema";
import type { Db } from "../plugins/db.js";

export const ADMIN_SESSION_COOKIE = "mailforge_admin_session";
export const SESSION_HOURS = 8;

export type SignInMethod = "email" | "passkey";

export interface AdminSession {
  id: string;
  email: string;
  /** How this session was started. */
  method: SignInMethod;
}

/** Create a session row and set its cookie (HttpOnly, SameSite=Lax, Secure over https). */
export async function startAdminSession(
  db: Db,
  reply: FastifyReply,
  input: { email: string; method: SignInMethod; secureCookies: boolean },
): Promise<void> {
  const expiresAt = new Date(Date.now() + SESSION_HOURS * 3_600_000);
  const [session] = await db
    .insert(adminSessions)
    .values({ email: input.email, expiresAt, method: input.method })
    .returning({ id: adminSessions.id });
  reply.setCookie(ADMIN_SESSION_COOKIE, session!.id, {
    httpOnly: true,
    sameSite: "lax",
    secure: input.secureCookies,
    path: "/",
    expires: expiresAt,
  });
}
