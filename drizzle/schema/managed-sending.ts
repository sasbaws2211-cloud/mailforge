import { pgTable, uuid, text, boolean, integer, jsonb, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { tenants } from "./tenants.js";

/**
 * A workspace's managed sending: Mailforge sends its email through the operator's
 * Resend account. One row per workspace that turned it on. A workspace with a
 * transport of its own (transport_configs) uses that instead; this row waits.
 *
 * `domain` is the workspace's own sending domain, registered in the operator's
 * Resend account (resend_domain_id). Until it is verified the shared operator
 * address is used, at a low daily volume. `paused_*` is set when sending is
 * stopped for this workspace, by an admin or automatically when bounces or spam
 * complaints get too high; the workspace's messages then wait untouched.
 *
 * Mirror side: PUBLIC (drizzle/ is mirrored).
 */
export const managedSending = pgTable(
  "managed_sending",
  {
    tenantId: uuid("tenant_id")
      .primaryKey()
      .references(() => tenants.id),
    enabled: boolean("enabled").notNull().default(true),
    /** The workspace's sending domain, lower case. Null = using the shared address. */
    domain: text("domain"),
    resendDomainId: text("resend_domain_id"),
    /** none | not_started | pending | verified | failed | temporary_failure */
    domainStatus: text("domain_status").notNull().default("none"),
    /** The DNS records the customer must create, as Resend gave them. */
    dnsRecords: jsonb("dns_records"),
    /** Part before the @ on the workspace's domain. */
    fromLocal: text("from_local").notNull().default("hello"),
    /** Display name; null = the workspace's brand or name. */
    fromName: text("from_name"),
    /** Where replies go; null = the workspace's reply address, else its owner. */
    replyTo: text("reply_to"),
    domainAddedAt: timestamp("domain_added_at", { withTimezone: true }),
    domainVerifiedAt: timestamp("domain_verified_at", { withTimezone: true }),
    domainCheckedAt: timestamp("domain_checked_at", { withTimezone: true }),
    pausedAt: timestamp("paused_at", { withTimezone: true }),
    pausedReason: text("paused_reason"),
    /** An admin's email, or "auto" when sender health paused it. */
    pausedBy: text("paused_by"),
    /** When the workspace was last warned that its bounce or complaint rate is getting high. */
    warnedAt: timestamp("warned_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("uq_managed_sending_domain").on(sql`lower(${t.domain})`).where(sql`${t.domain} is not null`)],
);

/**
 * Domains to remove from the operator's Resend account. Filled when a workspace
 * is erased (its managed_sending row goes with it, but the domain lives at Resend)
 * and when a removal could not reach Resend. No tenant_id on purpose, so erasing a
 * workspace never deletes it. A sweeper removes each and drops the row.
 */
export const managedDomainCleanup = pgTable("managed_domain_cleanup", {
  resendDomainId: text("resend_domain_id").primaryKey(),
  domain: text("domain"),
  queuedAt: timestamp("queued_at", { withTimezone: true }).defaultNow().notNull(),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
});
