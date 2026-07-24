/**
 * Auth routes - magic link login, verify, logout, session info.
 *
 * These routes are PUBLIC (registered outside the /v1 authenticated scope)
 * because the user is not yet authenticated when requesting or verifying a link.
 * Exception: /auth/logout and /auth/me require an active session.
 *
 * Security model:
 * - Token: 32 cryptographically random bytes, URL-safe base64.
 * - DB stores SHA-256(token); link carries the raw token.
 * - Single-use: atomic CAS (UPDATE WHERE consumed_at IS NULL).
 * - 10-minute TTL.
 * - Session: UUID in HTTP-only Secure SameSite=Lax cookie, 30-day fixed expiry.
 *
 * Console fallback: when no transport is configured and NODE_ENV is not production
 * (and is not absent), the login link is printed to the server console instead of
 * being sent via email.
 *
 * Mirror side: PUBLIC (packages/api is mirrored).
 */
import { randomBytes, createHash } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import { eq, and, isNull } from "drizzle-orm";
import {
  users,
  sessions,
  magicLinkTokens,
  transportConfigs,
} from "@claros/db/schema";
import type { Db } from "../plugins/db.js";

/** Token TTL in minutes. */
const TOKEN_TTL_MINUTES = 10;

/** Session TTL in days. */
const SESSION_TTL_DAYS = 30;

/** Cookie name for session ID. */
export const SESSION_COOKIE_NAME = "claros_session";

/**
 * Generate a cryptographically random token (URL-safe base64).
 * Returns { raw, hash } where raw goes in the link, hash goes in the DB.
 */
export function generateToken(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString("base64url");
  const hash = createHash("sha256").update(raw).digest("hex");
  return { raw, hash };
}

/**
 * Hash a raw token for DB lookup.
 */
export function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/**
 * Whether the console login fallback is allowed in this environment.
 *
 * Rules:
 * - NODE_ENV must be defined and not "production". Absence = closed.
 * - If NODE_ENV is "production", unconditionally OFF.
 * - If NODE_ENV is anything else ("development", "test"), ON.
 */
export function isConsoleLoginAllowed(): boolean {
  const env = process.env.NODE_ENV;
  if (env === undefined || env === "production") {
    return false;
  }
  return true;
}

export interface AuthRouteOptions {
  baseUrl: string;
}

const authRoutes: FastifyPluginAsync<AuthRouteOptions> = async (app, opts) => {
  const { baseUrl } = opts;
  const db: Db = app.db;

  /**
   * POST /auth/login
   * Request a magic link. Body: { email: string }
   *
   * Always returns 200 with a generic message regardless of whether the email
   * exists (prevents user enumeration). If the user does not exist, no token
   * is created and no link is sent/printed.
   */
  app.post<{ Body: { email: string } }>(
    "/login",
    {
      schema: {
        body: {
          type: "object",
          properties: { email: { type: "string", format: "email" } },
          required: ["email"],
        },
        response: {
          200: {
            type: "object",
            properties: {
              message: { type: "string" },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { email } = request.body;
      const normalizedEmail = email.toLowerCase().trim();

      // Look up user by email (across all tenants for login - user belongs to exactly one tenant)
      const userRows = await db
        .select({
          id: users.id,
          tenantId: users.tenantId,
          email: users.email,
        })
        .from(users)
        .where(eq(users.email, normalizedEmail))
        .limit(1);

      if (userRows.length === 0) {
        // User not found - return generic response to prevent enumeration.
        // Log for debugging but do not reveal to client.
        request.log.debug({ email: normalizedEmail }, "Login attempt for unknown email");
        return { message: "If that email is registered, a login link has been sent." };
      }

      const user = userRows[0]!;

      // Generate token
      const { raw, hash } = generateToken();
      const expiresAt = new Date(Date.now() + TOKEN_TTL_MINUTES * 60 * 1000);

      // Store token hash in DB
      await db.insert(magicLinkTokens).values({
        tenantId: user.tenantId,
        userId: user.id,
        tokenHash: hash,
        expiresAt,
      });

      const loginUrl = `${baseUrl}/auth/verify?token=${raw}`;

      // Check if tenant has a configured transport
      const transports = await db
        .select({ id: transportConfigs.id })
        .from(transportConfigs)
        .where(
          and(
            eq(transportConfigs.tenantId, user.tenantId),
            eq(transportConfigs.isActive, true),
          ),
        )
        .limit(1);

      const hasTransport = transports.length > 0;

      if (!hasTransport && isConsoleLoginAllowed()) {
        // Console fallback: print the login URL to server logs.
        // This path only fires in non-production environments.
        request.log.info(
          { loginUrl, email: normalizedEmail },
          "CONSOLE LOGIN LINK (no transport configured)",
        );
        // Also print to stdout directly for docker compose logs visibility
        console.log("");
        console.log("========================================");
        console.log("  MAGIC LINK LOGIN (no email transport)");
        console.log("========================================");
        console.log(`  Email: ${normalizedEmail}`);
        console.log(`  URL:   ${loginUrl}`);
        console.log(`  Expires: ${TOKEN_TTL_MINUTES} minutes`);
        console.log("========================================");
        console.log("");

        return { message: "Login link printed to server console." };
      }

      if (!hasTransport && !isConsoleLoginAllowed()) {
        // Production with no transport: cannot send or print the link.
        // This should not happen in Cloud (transport always exists).
        // Log as error for operator visibility.
        request.log.error(
          { email: normalizedEmail, tenantId: user.tenantId },
          "Cannot send login link: no transport configured and console fallback is disabled",
        );
        return { message: "If that email is registered, a login link has been sent." };
      }

      // Has transport: send the link via email.
      // TODO(task-26-transport): actually send the email via the configured transport.
      // For now, log a warning. The transport layer is task 26 (Phase 4).
      request.log.warn(
        { loginUrl, email: normalizedEmail },
        "Transport send not yet implemented - login link logged here for development",
      );
      // In development, also print to console since transport is not implemented
      if (isConsoleLoginAllowed()) {
        console.log("");
        console.log("========================================");
        console.log("  MAGIC LINK LOGIN (transport TODO)");
        console.log("========================================");
        console.log(`  Email: ${normalizedEmail}`);
        console.log(`  URL:   ${loginUrl}`);
        console.log(`  Expires: ${TOKEN_TTL_MINUTES} minutes`);
        console.log("========================================");
        console.log("");
        return { message: "Login link printed to server console." };
      }

      return { message: "If that email is registered, a login link has been sent." };
    },
  );

  /**
   * GET /auth/verify?token=xxx
   * Verify a magic link token, create a session, set the cookie.
   */
  app.get<{ Querystring: { token: string } }>(
    "/verify",
    {
      schema: {
        querystring: {
          type: "object",
          properties: { token: { type: "string" } },
          required: ["token"],
        },
        response: {
          200: {
            type: "object",
            properties: {
              message: { type: "string" },
              user: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  email: { type: "string" },
                  name: { type: "string" },
                  role: { type: "string" },
                },
              },
            },
          },
          401: {
            type: "object",
            properties: { error: { type: "string" } },
          },
        },
      },
    },
    async (request, reply) => {
      const { token } = request.query;

      if (!token || token.length === 0) {
        reply.status(401);
        return { error: "Invalid or expired login link." };
      }

      const tokenHash = hashToken(token);

      // Atomic CAS: consume the token only if it has not been consumed yet.
      // This ensures single-use even under concurrent requests.
      const now = new Date();
      const consumed = await db
        .update(magicLinkTokens)
        .set({ consumedAt: now })
        .where(
          and(
            eq(magicLinkTokens.tokenHash, tokenHash),
            isNull(magicLinkTokens.consumedAt),
          ),
        )
        .returning({
          id: magicLinkTokens.id,
          userId: magicLinkTokens.userId,
          tenantId: magicLinkTokens.tenantId,
          expiresAt: magicLinkTokens.expiresAt,
        });

      if (consumed.length === 0) {
        // Token not found, already consumed, or tampered.
        reply.status(401);
        return { error: "Invalid or expired login link." };
      }

      const tokenRow = consumed[0]!;

      // Check expiry
      if (tokenRow.expiresAt < now) {
        // Token was consumed but is expired. Already marked consumed so it
        // cannot be reused regardless.
        reply.status(401);
        return { error: "Invalid or expired login link." };
      }

      // Create session
      const sessionExpiresAt = new Date(
        Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000,
      );
      const sessionRows = await db
        .insert(sessions)
        .values({
          tenantId: tokenRow.tenantId,
          userId: tokenRow.userId,
          expiresAt: sessionExpiresAt,
        })
        .returning({ id: sessions.id });

      const sessionId = sessionRows[0]!.id;

      // Set session cookie
      reply.setCookie(SESSION_COOKIE_NAME, sessionId, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        path: "/",
        maxAge: SESSION_TTL_DAYS * 24 * 60 * 60, // seconds
      });

      // Update user's last_login_at
      await db
        .update(users)
        .set({ lastLoginAt: now })
        .where(eq(users.id, tokenRow.userId));

      // Fetch user info for response
      const userRows = await db
        .select({
          id: users.id,
          email: users.email,
          name: users.name,
          role: users.role,
        })
        .from(users)
        .where(eq(users.id, tokenRow.userId))
        .limit(1);

      const user = userRows[0]!;

      return {
        message: "Login successful.",
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
        },
      };
    },
  );

  /**
   * POST /auth/logout
   * Destroy the current session.
   */
  app.post("/logout", async (request, reply) => {
    const sessionId = request.cookies[SESSION_COOKIE_NAME];
    if (sessionId) {
      await db.delete(sessions).where(eq(sessions.id, sessionId));
    }

    reply.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
    return { message: "Logged out." };
  });

  /**
   * GET /auth/me
   * Get the current authenticated user. Returns 401 if not logged in.
   */
  app.get("/me", async (request, reply) => {
    const sessionId = request.cookies[SESSION_COOKIE_NAME];
    if (!sessionId) {
      reply.status(401);
      return { error: "Not authenticated." };
    }

    const sessionRows = await db
      .select({
        userId: sessions.userId,
        tenantId: sessions.tenantId,
        expiresAt: sessions.expiresAt,
      })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);

    if (sessionRows.length === 0 || sessionRows[0]!.expiresAt < new Date()) {
      reply.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
      reply.status(401);
      return { error: "Not authenticated." };
    }

    const session = sessionRows[0]!;
    const userRows = await db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        role: users.role,
      })
      .from(users)
      .where(eq(users.id, session.userId))
      .limit(1);

    if (userRows.length === 0) {
      reply.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
      reply.status(401);
      return { error: "Not authenticated." };
    }

    const user = userRows[0]!;
    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        tenantId: session.tenantId,
      },
    };
  });
};

export default authRoutes;
