import { pgTable, uuid, text, jsonb, timestamp, index, bigint, boolean } from "drizzle-orm/pg-core";
import { tenants } from "./tenants.js";

/**
 * Record of every change a platform admin makes to a customer workspace.
 * Append-only: nothing in the app updates or deletes these rows. The actor's
 * email is copied in so the trail survives the user being removed.
 *
 * Mirror side: PUBLIC (drizzle/ is mirrored).
 */
export const adminAuditLog = pgTable(
  "admin_audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Platform admin's user id when they acted from a workspace login; null from the standalone console. No foreign key: the trail must outlive the user. */
    actorUserId: uuid("actor_user_id"),
    actorEmail: text("actor_email").notNull(),
    /** set_plan | extend_trial | suspend | unsuspend | cancel_subscription */
    action: text("action").notNull(),
    tenantId: uuid("tenant_id").references(() => tenants.id),
    /** Before/after values and the reason given. */
    detail: jsonb("detail"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("idx_admin_audit_tenant").on(t.tenantId, t.createdAt),
    index("idx_admin_audit_created").on(t.createdAt),
  ],
);

/**
 * What remains after a workspace is erased: enough to answer "was this deleted,
 * when, and how", and nothing more. The owner's email is stored only as a hash.
 * Not linked to tenants: the tenant row is gone.
 */
export const deletedWorkspaces = pgTable("deleted_workspaces", {
  /** The id the workspace had. */
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  /** SHA-256 of the lower-cased owner email. */
  ownerEmailHash: text("owner_email_hash"),
  plan: text("plan"),
  createdAt: timestamp("created_at", { withTimezone: true }),
  requestedAt: timestamp("requested_at", { withTimezone: true }),
  deletedAt: timestamp("deleted_at", { withTimezone: true }).defaultNow().notNull(),
  /** grace_expired | admin_immediate */
  how: text("how").notNull(),
  /** Rows erased per table. */
  rowCounts: jsonb("row_counts"),
});

/**
 * Sign-in for the standalone admin console (its own origin). Platform admins are
 * people, not members of any workspace, so these tables have no tenant.
 *
 * A login token is the link emailed to an admin: hashed at rest, single use,
 * short-lived. A session is what the link turns into: an opaque id in an
 * HttpOnly cookie that only the admin origin ever sees.
 *
 * Mirror side: PUBLIC (drizzle/ is mirrored).
 */
export const adminLoginTokens = pgTable(
  "admin_login_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    /** SHA-256 of the raw token that was emailed. */
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("idx_admin_login_tokens_email").on(t.email, t.createdAt)],
);

export const adminSessions = pgTable(
  "admin_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    /** How this session was started: email (a sign-in link) or passkey. */
    method: text("method").notNull().default("email"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("idx_admin_sessions_email").on(t.email)],
);

/**
 * A passkey (WebAuthn credential) registered by a platform admin for the standalone
 * console. Only the PUBLIC key is stored; the private key never leaves the person's
 * device. The id is the credential id the browser reports, base64url.
 *
 * Mirror side: PUBLIC (drizzle/ is mirrored).
 */
export const adminPasskeys = pgTable(
  "admin_passkeys",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    /** COSE public key bytes, base64url. */
    publicKey: text("public_key").notNull(),
    /** Signature counter last seen; a replayed or cloned credential shows up as a counter that does not advance. */
    counter: bigint("counter", { mode: "number" }).notNull().default(0),
    /** Comma-separated transports the browser reported (internal, usb, hybrid, ...). */
    transports: text("transports"),
    /** singleDevice | multiDevice (synced passkey). */
    deviceType: text("device_type"),
    backedUp: boolean("backed_up").notNull().default(false),
    /** A label the admin chose, so they can tell their devices apart. */
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  },
  (t) => [index("idx_admin_passkeys_email").on(t.email)],
);

/**
 * The random challenge handed to the browser for one passkey ceremony. Single use,
 * minutes of life: it is deleted when used, and expired ones are swept.
 */
export const adminPasskeyChallenges = pgTable("admin_passkey_challenges", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** register | login */
  kind: text("kind").notNull(),
  /** Who is registering. Null for sign-in, where the passkey itself says who it is. */
  email: text("email"),
  challenge: text("challenge").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
