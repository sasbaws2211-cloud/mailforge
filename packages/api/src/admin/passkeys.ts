/**
 * Passkeys (WebAuthn) for the standalone admin console.
 *
 * A passkey is a key pair made on the administrator's own device. The private half
 * never leaves it and is unlocked there (fingerprint, face, PIN or a hardware key);
 * the server keeps only the public half and a counter. Signing in proves possession of
 * the private key for THIS site's address, so it cannot be phished and a stolen
 * mailbox is not enough.
 *
 * No outside service is involved: the browser and operating system do their part and
 * the open-source @simplewebauthn/server library verifies the result in this process.
 * Attestation is "none", so no authenticator vendor needs to approve anything.
 *
 *   mode off        no passkey endpoints at all
 *   mode optional   passkeys and emailed links both work (default)
 *   mode enforced   an administrator who has a passkey must use it: the emailed link
 *                   is then only for administrators who have none yet (to enrol one)
 *
 * Routes (all under /admin-auth):
 *   GET    /config                       what the sign-in page may offer
 *   POST   /passkey/options              start a sign-in (no account name needed)
 *   POST   /passkey/verify               finish it and start a session
 *   GET    /passkeys                     the signed-in admin's passkeys
 *   POST   /passkeys/register/options    start adding one      (needs a session)
 *   POST   /passkeys/register/verify     finish adding it      (needs a session)
 *   DELETE /passkeys/:id                 remove one            (needs a session)
 *
 * Mirror side: PUBLIC (packages/api is mirrored).
 */
import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { and, eq, gt, lt, sql } from "drizzle-orm";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import { adminPasskeyChallenges, adminPasskeys } from "@mailforge/db/schema";
import type { Db } from "../plugins/db.js";
import { isPlatformAdmin } from "./platform-admins.js";
import { startAdminSession } from "./session.js";

export type PasskeyMode = "off" | "optional" | "enforced";

export const MAX_PASSKEYS_PER_ADMIN = 10;
const CHALLENGE_MINUTES = 5;
const NAME_MAX = 60;
const IP_LIMIT = 60;
const WINDOW_MS = 3_600_000;

/**
 * MAILFORGE_ADMIN_PASSKEYS: off | optional | enforced (default optional). An unknown
 * value stops the server rather than being read as something weaker than intended.
 */
export function passkeyModeFromEnv(raw: string | undefined): PasskeyMode {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "") return "optional";
  if (v === "off" || v === "optional" || v === "enforced") return v;
  throw new Error(`MAILFORGE_ADMIN_PASSKEYS "${raw}" is not valid: use off, optional or enforced.`);
}

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, "base64url"));

/** A stable, opaque id for an admin that is not their email (the authenticator stores it). */
const userHandle = (email: string) => new Uint8Array(createHash("sha256").update(`mailforge-admin:${email.toLowerCase()}`).digest());

export async function passkeyCount(db: Db, email: string): Promise<number> {
  const r = await db.select({ n: sql<string>`count(*)::text` }).from(adminPasskeys).where(eq(adminPasskeys.email, email.toLowerCase()));
  return Number(r[0]?.n ?? 0);
}

/** Does this admin have to use a passkey rather than an emailed link? */
export async function mustUsePasskey(db: Db, mode: PasskeyMode, email: string): Promise<boolean> {
  return mode === "enforced" && (await passkeyCount(db, email)) > 0;
}

function allow(buckets: Map<string, number[]>, key: string, limit: number, now: number): boolean {
  const recent = (buckets.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= limit) {
    buckets.set(key, recent);
    return false;
  }
  recent.push(now);
  buckets.set(key, recent);
  return true;
}

/** Take a challenge out of the table (single use) if it exists, is of this kind and has not expired. */
async function takeChallenge(db: Db, id: unknown, kind: "register" | "login") {
  if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) return null;
  const rows = await db
    .delete(adminPasskeyChallenges)
    .where(and(eq(adminPasskeyChallenges.id, id), eq(adminPasskeyChallenges.kind, kind), gt(adminPasskeyChallenges.expiresAt, new Date())))
    .returning();
  return rows[0] ?? null;
}

const FAIL = { error: "That passkey could not be verified." } as const;

export async function registerAdminPasskeyRoutes(
  app: FastifyInstance,
  opts: { db: Db; adminOrigin: string; rpId: string; mode: PasskeyMode; secureCookies: boolean },
): Promise<void> {
  const { db, adminOrigin, rpId, mode } = opts;
  const ipBuckets = new Map<string, number[]>();

  app.get("/admin-auth/config", async () => ({ passkeys: mode !== "off", passkey_mode: mode }));
  if (mode === "off") return;

  const sweep = () => db.delete(adminPasskeyChallenges).where(lt(adminPasskeyChallenges.expiresAt, new Date()));
  const newChallenge = async (kind: "register" | "login", email: string | null, challenge: string) => {
    const [row] = await db
      .insert(adminPasskeyChallenges)
      .values({ kind, email, challenge, expiresAt: new Date(Date.now() + CHALLENGE_MINUTES * 60_000) })
      .returning({ id: adminPasskeyChallenges.id });
    return row!.id;
  };

  // ---- sign in ---------------------------------------------------------------------
  app.post("/admin-auth/passkey/options", async (request, reply) => {
    if (!allow(ipBuckets, request.ip, IP_LIMIT, Date.now())) return reply.status(429).send({ error: "Too many attempts. Try again later." });
    await sweep();
    // No account name is asked for: the passkey says who it belongs to. So there is nothing to probe.
    const options = await generateAuthenticationOptions({ rpID: rpId, userVerification: "required" });
    return { challenge_id: await newChallenge("login", null, options.challenge), options };
  });

  app.post<{ Body: { challenge_id?: unknown; response?: AuthenticationResponseJSON } }>("/admin-auth/passkey/verify", async (request, reply) => {
    if (!allow(ipBuckets, request.ip, IP_LIMIT, Date.now())) return reply.status(429).send({ error: "Too many attempts. Try again later." });
    const challenge = await takeChallenge(db, request.body?.challenge_id, "login");
    const response = request.body?.response;
    if (!challenge || !response || typeof response.id !== "string") return reply.status(400).send(FAIL);

    const [pk] = await db.select().from(adminPasskeys).where(eq(adminPasskeys.id, response.id)).limit(1);
    // Taken off the administrator list since registering: the passkey stops working too.
    if (!pk || !isPlatformAdmin(pk.email)) return reply.status(400).send(FAIL);

    let newCounter: number;
    try {
      const verified = await verifyAuthenticationResponse({
        response,
        expectedChallenge: challenge.challenge,
        expectedOrigin: adminOrigin,
        expectedRPID: rpId,
        credential: { id: pk.id, publicKey: unb64(pk.publicKey), counter: pk.counter, transports: pk.transports ? pk.transports.split(",") : undefined },
        requireUserVerification: true,
      });
      if (!verified.verified) return reply.status(400).send(FAIL);
      newCounter = verified.authenticationInfo.newCounter;
    } catch (err) {
      request.log.warn({ error: err instanceof Error ? err.message : String(err) }, "Admin passkey sign-in refused");
      return reply.status(400).send(FAIL);
    }

    await db.update(adminPasskeys).set({ counter: newCounter, lastUsedAt: new Date() }).where(eq(adminPasskeys.id, pk.id));
    await startAdminSession(db, reply, { email: pk.email, method: "passkey", secureCookies: opts.secureCookies });
    return { ok: true };
  });

  // ---- managing passkeys (signed in) -----------------------------------------------
  const needSession = (request: { adminSession: { email: string } | null }, reply: { status: (n: number) => { send: (b: unknown) => unknown } }) => {
    if (!request.adminSession) {
      reply.status(401).send({ error: "Authentication required." });
      return null;
    }
    return request.adminSession.email;
  };

  app.get("/admin-auth/passkeys", async (request, reply) => {
    const email = needSession(request, reply);
    if (!email) return;
    const rows = await db.select().from(adminPasskeys).where(eq(adminPasskeys.email, email)).orderBy(adminPasskeys.createdAt);
    return {
      passkeys: rows.map((r) => ({
        id: r.id,
        name: r.name,
        created_at: r.createdAt.toISOString(),
        last_used_at: r.lastUsedAt ? r.lastUsedAt.toISOString() : null,
        device_type: r.deviceType,
        backed_up: r.backedUp,
      })),
    };
  });

  app.post("/admin-auth/passkeys/register/options", async (request, reply) => {
    const email = needSession(request, reply);
    if (!email) return;
    if ((await passkeyCount(db, email)) >= MAX_PASSKEYS_PER_ADMIN) {
      return reply.status(409).send({ error: `You can register up to ${MAX_PASSKEYS_PER_ADMIN} passkeys. Remove one first.`, code: "too_many" });
    }
    await sweep();
    const existing = await db.select({ id: adminPasskeys.id, transports: adminPasskeys.transports }).from(adminPasskeys).where(eq(adminPasskeys.email, email));
    const options = await generateRegistrationOptions({
      rpName: "Mailforge admin console",
      rpID: rpId,
      userName: email,
      userID: userHandle(email),
      attestationType: "none",
      // A discoverable credential (so sign-in needs no typing) that must be unlocked by the person.
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
      excludeCredentials: existing.map((e) => ({ id: e.id, transports: e.transports ? e.transports.split(",") : undefined })),
    });
    return { challenge_id: await newChallenge("register", email, options.challenge), options };
  });

  app.post<{ Body: { challenge_id?: unknown; response?: RegistrationResponseJSON; name?: unknown } }>("/admin-auth/passkeys/register/verify", async (request, reply) => {
    const email = needSession(request, reply);
    if (!email) return;
    const challenge = await takeChallenge(db, request.body?.challenge_id, "register");
    const response = request.body?.response;
    // A challenge issued to someone else is as good as none.
    if (!challenge || challenge.email !== email || !response) return reply.status(400).send({ error: "That passkey could not be added. Start again." });

    const rawName = typeof request.body?.name === "string" ? request.body.name.trim() : "";
    const name = (rawName || "Passkey").slice(0, NAME_MAX);

    let info;
    try {
      const verified = await verifyRegistrationResponse({
        response,
        expectedChallenge: challenge.challenge,
        expectedOrigin: adminOrigin,
        expectedRPID: rpId,
        requireUserVerification: true,
      });
      if (!verified.verified || !verified.registrationInfo) return reply.status(400).send({ error: "That passkey could not be added. Start again." });
      info = verified.registrationInfo;
    } catch (err) {
      request.log.warn({ error: err instanceof Error ? err.message : String(err) }, "Admin passkey registration refused");
      return reply.status(400).send({ error: "That passkey could not be added. Start again." });
    }

    const cred = info.credential;
    const inserted = await db
      .insert(adminPasskeys)
      .values({
        id: cred.id,
        email,
        publicKey: b64(cred.publicKey),
        counter: cred.counter,
        transports: cred.transports && cred.transports.length > 0 ? cred.transports.join(",") : null,
        deviceType: info.credentialDeviceType,
        backedUp: info.credentialBackedUp,
        name,
      })
      .onConflictDoNothing()
      .returning({ id: adminPasskeys.id });
    if (inserted.length === 0) return reply.status(409).send({ error: "That passkey is already registered.", code: "duplicate" });
    return { ok: true, id: cred.id, name };
  });

  app.delete<{ Params: { id: string } }>("/admin-auth/passkeys/:id", async (request, reply) => {
    const email = needSession(request, reply);
    if (!email) return;
    const mine = await db.select({ id: adminPasskeys.id }).from(adminPasskeys).where(eq(adminPasskeys.email, email));
    if (!mine.some((p) => p.id === request.params.id)) return reply.status(404).send({ error: "Passkey not found." });
    // In enforced mode the last passkey is what stands between this account and a plain emailed link.
    if (mode === "enforced" && mine.length === 1) {
      return reply.status(409).send({ error: "This is your only passkey. Add another before removing it.", code: "last_passkey" });
    }
    await db.delete(adminPasskeys).where(and(eq(adminPasskeys.id, request.params.id), eq(adminPasskeys.email, email)));
    return { ok: true };
  });
}
