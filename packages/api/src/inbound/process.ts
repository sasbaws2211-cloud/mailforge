/**
 * Applying a mapped inbound request: find the person it is about, then record the traits and the event exactly as
 * POST /v1/identify and /v1/track would (same plan limits, email-conflict handling and lifecycle rules).
 *
 * Finding the person, in order:
 *   1. the user id the sender gave (a metadata value, or a path in a generic payload)
 *   2. a second id the sender uses for "my user" (Stripe's client_reference_id)
 *   3. a contact that already carries this Stripe customer id (set the first time one was seen)
 *   4. a contact with this email address
 *   5. a new contact keyed by the email address
 * Nothing found: the request is acknowledged but not applied, and the log says why.
 *
 * Mirror side: PUBLIC (packages/api is mirrored).
 */
import { and, eq, sql } from "drizzle-orm";
import { contacts } from "@loomail/db/schema";
import type { Db } from "../plugins/db.js";
import type { Actor, Mapped } from "./mapping.js";
import { processIdentifyEvent, processTrackEvent } from "../routes/ingest.js";

type Enqueue = Parameters<typeof processTrackEvent>[1];

export async function resolveUserId(db: Db, tenantId: string, actor: Actor): Promise<string | null> {
  if (actor.userId) return actor.userId;
  if (actor.clientRef) return actor.clientRef;
  if (actor.customerId) {
    const r = (
      await db.execute<{ external_id: string }>(sql`
        SELECT external_id FROM contacts
        WHERE tenant_id = ${tenantId}::uuid AND properties ->> 'stripe_customer_id' = ${actor.customerId}
        ORDER BY created_at LIMIT 1`)
    ).rows;
    if (r[0]) return r[0].external_id;
  }
  if (actor.email) {
    const r = await db.select({ externalId: contacts.externalId }).from(contacts).where(and(eq(contacts.tenantId, tenantId), eq(contacts.email, actor.email))).limit(1);
    if (r[0]) return r[0].externalId;
    return actor.email.slice(0, 255);
  }
  return null;
}

export type ApplyResult = { applied: true; summary: string } | { applied: false; reason: string };

export async function applyMapped(db: Db, enqueue: Enqueue, tenantId: string, sourceId: string, mapped: Mapped): Promise<ApplyResult> {
  const userId = await resolveUserId(db, tenantId, mapped.actor);
  if (!userId) return { applied: false, reason: "Could not tell who this is about: no user id, customer id or email." };

  const context = { source: `inbound:${sourceId}` };
  const traits: Record<string, string | number | boolean> = { ...mapped.traits };

  // Stripe does not deliver events in order. When this one would set the payment status or plan, only let it if no newer
  // event has already set them: the time of the latest one applied is kept on the person as stripe_status_at.
  let staleNote = "";
  if (mapped.statusAt !== undefined && ("payment_status" in traits || "plan" in traits)) {
    const row = (
      await db.execute<{ at: string | null }>(sql`
        SELECT properties ->> 'stripe_status_at' AS at FROM contacts
        WHERE tenant_id = ${tenantId}::uuid AND external_id = ${userId} LIMIT 1`)
    ).rows[0];
    const current = row?.at != null ? Number(row.at) : null;
    if (current !== null && Number.isFinite(current) && current > mapped.statusAt) {
      delete traits.payment_status;
      delete traits.plan;
      staleNote = " (older than the current billing status, so the status was left as it is)";
    } else {
      traits.stripe_status_at = mapped.statusAt;
    }
  }

  // Give a person their email if they have none; never overwrite the one they have with whatever the sender knows.
  if (mapped.actor.email) {
    const existing = (await db.select({ email: contacts.email }).from(contacts).where(and(eq(contacts.tenantId, tenantId), eq(contacts.externalId, userId))).limit(1))[0];
    if (!existing || !existing.email) traits.email = mapped.actor.email;
  }

  const did: string[] = [];
  if (Object.keys(traits).length > 0) {
    await processIdentifyEvent(db, tenantId, { userId, traits, context }, enqueue);
    did.push("traits");
  }
  if (mapped.track) {
    const { deduplicated } = await processTrackEvent(
      db,
      enqueue,
      tenantId,
      {
        userId,
        event: mapped.track.event,
        properties: mapped.track.properties,
        context,
        ...(mapped.track.timestamp ? { timestamp: mapped.track.timestamp } : {}),
        ...(mapped.track.messageId ? { messageId: mapped.track.messageId } : {}),
      },
    );
    did.push(deduplicated ? `event ${mapped.track.event} (already recorded)` : `event ${mapped.track.event}`);
  }
  return { applied: true, summary: `${did.join(" and ")} for ${userId}${staleNote}` };
}
