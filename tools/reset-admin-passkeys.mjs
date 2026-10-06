#!/usr/bin/env node
/**
 * Recovery for a lost device: remove every passkey registered by one platform admin
 * (or by all of them), and end their console sessions. They can then sign in with an
 * emailed link and register a new passkey.
 *
 * This is deliberately a command run by someone with access to the server, not
 * something the console can do for you: whoever can run it already controls the
 * database, so it adds no power, and it keeps "I lost my phone" from becoming a
 * way around the passkey.
 *
 *   docker compose exec -T -e ADMIN_EMAIL=you@yourdomain.com app sh -c \
 *     "cd /app/packages/worker && node --input-type=module" < tools/reset-admin-passkeys.mjs
 *
 *   ADMIN_EMAIL=all  removes everyone's passkeys.
 *
 * Needs DATABASE_URL, which the compose app container already has.
 */
import pg from "pg";

const email = (process.env.ADMIN_EMAIL ?? "").trim().toLowerCase();
if (!email) {
  console.error("Set ADMIN_EMAIL to the administrator's address (or to 'all').");
  process.exit(2);
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
try {
  const everyone = email === "all";
  const keys = everyone
    ? await pool.query("DELETE FROM admin_passkeys")
    : await pool.query("DELETE FROM admin_passkeys WHERE email = $1", [email]);
  const sessions = everyone
    ? await pool.query("DELETE FROM admin_sessions")
    : await pool.query("DELETE FROM admin_sessions WHERE email = $1", [email]);
  console.log(`removed ${keys.rowCount} passkey(s) and ${sessions.rowCount} session(s) for ${everyone ? "all administrators" : email}`);
  if ((keys.rowCount ?? 0) === 0 && !everyone) console.log("(that address had no passkeys)");
} finally {
  await pool.end();
}
