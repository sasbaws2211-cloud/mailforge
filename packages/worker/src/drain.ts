/**
 * Drain worker - picks up approved messages and hands them to transport.
 *
 * Scheduled every drain_interval_minutes (default 15 min) via pg-boss cron.
 * Selects approved messages ordered by flow_class (critical first), then
 * priority DESC, then FIFO. Uses FOR UPDATE SKIP LOCKED for safe concurrency
 * across multiple drain workers.
 *
 * Processing order per message:
 *   1. Resolve transport adapter for the tenant.
 *      - If null (no transport configured): skip, message stays approved.
 *   2. Claim the message (status = 'sending') via CAS.
 *   3. Evaluate the throttle gate.
 *      - allow: hand to transport.
 *      - suppress: mark as 'suppressed' (terminal).
 *      - defer_frequency / defer_window: revert to 'approved' with scheduled_send_at.
 *   4. On transport success: mark 'sent', record sent_at.
 *   5. On transport error: message stays at 'sending'.
 *
 * NOTE: After task 14, the drain sends nothing in any real deployment. The
 * transport resolver returns null until Phase 4 builds real adapters (tasks
 * 26-28). Messages that pass the throttle gate remain at 'approved' and are
 * re-evaluated each tick. "Drain implemented" means scheduling, batch
 * selection, throttle evaluation, and transport seam are wired - not
 * "email works."
 *
 * NOTE: message remains at 'sending' after transport error. Recovery is
 * handled by the reap worker (task 15), which finds messages stuck in
 * 'sending' for > REAP_STUCK_THRESHOLD_HOURS and either retries
 * (retry_count < MAX_RETRY_COUNT) or marks failed. Until task 15 is
 * implemented, errored messages are stranded.
 *
 * Per-tenant fairness (Cloud-only, EDITIONS.md):
 *   Community is single-tenant, so the simple batch query suffices.
 *   The fetchDrainBatch strategy parameter allows Cloud to substitute a
 *   round-robin implementation without forking this file. Cloud passes a
 *   different FetchDrainBatch function at startup via apps/server wiring.
 *
 * Mirror side: PUBLIC (packages/worker is mirrored).
 */
import { eq, and, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  tenants,
  contacts,
  flows,
  lifecycleMessages,
  suppressions,
} from "@claros/db/schema";
import {
  evaluateThrottleGate,
  resolveThrottleConfig,
  type ThrottleGateInput,
  type ThrottleVerdict,
} from "@claros/core";
import type { TransportAdapter, TransportResolver } from "./transport.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Db = NodePgDatabase<Record<string, never>>;

/** A candidate message selected from the drain batch query. */
export interface DrainCandidate {
  id: string;
  tenantId: string;
  contactId: string;
  flowId: string;
  flowStepOrder: number | null;
  subject: string | null;
  bodyHtml: string | null;
  bodyText: string | null;
  retryCount: number | null;
}

/** Strategy for fetching a batch of drain candidates. */
export type FetchDrainBatch = (
  db: Db,
  now: Date,
  globalLimit: number,
  tenantIds: string[],
) => Promise<DrainCandidate[]>;

/** Stats returned by processdrainTick for observability. */
export interface DrainTickResult {
  candidatesFetched: number;
  skippedNoTransport: number;
  skippedNoEmail: number;
  sent: number;
  suppressed: number;
  deferredFrequency: number;
  deferredWindow: number;
  transportErrors: number;
}

// ---------------------------------------------------------------------------
// Default batch fetcher (Community: simple priority + FIFO)
// ---------------------------------------------------------------------------

/**
 * Fetches a batch of approved messages ready to send, atomically claiming them.
 *
 * Uses a CTE with FOR UPDATE SKIP LOCKED to:
 *   1. Select eligible messages without blocking on rows another worker holds
 *   2. Atomically set their status to 'sending' in the same statement
 *
 * This guarantees two concurrent drain workers get completely disjoint sets.
 * The claim (status = 'sending') happens inside the same SQL statement as
 * the lock, so no window exists between fetch and claim.
 *
 * Sort order (from spec S7, explicit encoding):
 *   1. flow_class: critical before nurture (a nurture flow with priority 100
 *      never jumps ahead of a critical flow with priority 1).
 *   2. flow priority DESC (within the same class).
 *   3. created_at ASC (FIFO within same class + priority).
 *
 * Messages are eligible when:
 *   - status = 'approved'
 *   - scheduled_send_at is null (never deferred) or <= now (defer period elapsed)
 */
export const fetchDrainBatchSimple: FetchDrainBatch = async (
  db: Db,
  now: Date,
  globalLimit: number,
  tenantIds: string[],
): Promise<DrainCandidate[]> => {
  if (tenantIds.length === 0) return [];

  // Build tenant filter for the IN clause.
  const tenantFilter = sql.join(tenantIds.map((id) => sql`${id}`), sql`, `);

  // Two-step approach:
  //   1. CTE: select + lock + claim (atomically set to 'sending')
  //   2. Re-select the claimed rows joined with flows for ordering
  //
  // The CTE guarantees disjoint sets across concurrent workers (SKIP LOCKED).
  // The final SELECT re-orders by the spec-mandated sort (critical first, then
  // priority, then FIFO). UPDATE RETURNING does not preserve CTE order, so
  // we must re-sort.
  const rows = await db.execute<{
    id: string;
    tenant_id: string;
    contact_id: string;
    flow_id: string;
    flow_step_order: number | null;
    subject: string | null;
    body_html: string | null;
    body_text: string | null;
    retry_count: number | null;
    flow_class: string;
    priority: number | null;
    created_at: string | Date | null;
  }>(sql`
    WITH candidates AS (
      SELECT lm.id
      FROM lifecycle_messages lm
      JOIN flows f ON f.id = lm.flow_id
      WHERE lm.status = 'approved'
        AND lm.tenant_id IN (${tenantFilter})
        AND (lm.scheduled_send_at IS NULL OR lm.scheduled_send_at <= ${now})
      ORDER BY
        CASE WHEN f.flow_class = 'critical' THEN 0 ELSE 1 END ASC,
        f.priority DESC,
        lm.created_at ASC
      LIMIT ${globalLimit}
      FOR UPDATE OF lm SKIP LOCKED
    ),
    claimed AS (
      UPDATE lifecycle_messages
      SET status = 'sending', updated_at = ${now}
      WHERE id IN (SELECT id FROM candidates)
      RETURNING id, tenant_id, contact_id, flow_id, flow_step_order,
                subject, body_html, body_text, retry_count, created_at
    )
    SELECT
      c.id, c.tenant_id, c.contact_id, c.flow_id, c.flow_step_order,
      c.subject, c.body_html, c.body_text, c.retry_count,
      f.flow_class, f.priority, c.created_at
    FROM claimed c
    JOIN flows f ON f.id = c.flow_id
    ORDER BY
      CASE WHEN f.flow_class = 'critical' THEN 0 ELSE 1 END ASC,
      f.priority DESC,
      c.created_at ASC
  `);

  return rows.rows.map((row) => ({
    id: row.id,
    tenantId: row.tenant_id,
    contactId: row.contact_id,
    flowId: row.flow_id,
    flowStepOrder: row.flow_step_order,
    subject: row.subject,
    bodyHtml: row.body_html,
    bodyText: row.body_text,
    retryCount: row.retry_count,
  }));
};

// ---------------------------------------------------------------------------
// Drain tick processor
// ---------------------------------------------------------------------------

/**
 * Process a single drain tick. Called by the pg-boss handler.
 *
 * Transport resolution happens BEFORE any messages are claimed. If a tenant
 * has no transport configured, its messages are never touched - no claim,
 * no revert, zero writes. This means that today (before Phase 4), a drain
 * tick performs zero writes to lifecycle_messages.
 *
 * @param db - Drizzle database instance.
 * @param now - Current time (injected for testability).
 * @param resolveTransport - Resolves a TransportAdapter for a tenant.
 * @param fetchBatch - Strategy for selecting messages (default: simple priority+FIFO).
 * @param batchLimit - Max messages per tick (default from throttle config is per-tenant,
 *   but for Community single-tenant this is effectively global).
 */
export async function processDrainTick(
  db: Db,
  now: Date,
  resolveTransport: TransportResolver,
  fetchBatch: FetchDrainBatch = fetchDrainBatchSimple,
  batchLimit: number = 50,
): Promise<DrainTickResult> {
  const stats: DrainTickResult = {
    candidatesFetched: 0,
    skippedNoTransport: 0,
    skippedNoEmail: 0,
    sent: 0,
    suppressed: 0,
    deferredFrequency: 0,
    deferredWindow: 0,
    transportErrors: 0,
  };

  // Step 1: Find tenants that have approved messages ready to drain.
  // This is a cheap read-only query (no locks, no writes).
  const tenantRows = await db.execute<{ tenant_id: string }>(sql`
    SELECT DISTINCT tenant_id
    FROM lifecycle_messages
    WHERE status = 'approved'
      AND (scheduled_send_at IS NULL OR scheduled_send_at <= ${now})
  `);

  if (tenantRows.rows.length === 0) return stats;

  // Step 2: Resolve transport for each tenant. Only proceed with tenants
  // that have a configured adapter. This is the gate that ensures zero
  // writes when no transport exists (the normal state before Phase 4).
  const tenantsWithTransport = new Map<string, TransportAdapter>();
  for (const row of tenantRows.rows) {
    const adapter = await resolveTransport(row.tenant_id);
    if (adapter !== null) {
      tenantsWithTransport.set(row.tenant_id, adapter);
    } else {
      stats.skippedNoTransport++;
    }
  }

  if (tenantsWithTransport.size === 0) return stats;

  // Step 3: Fetch and claim messages only for tenants with transport.
  // The batch query atomically sets status = 'sending' (FOR UPDATE SKIP LOCKED).
  const tenantIds = Array.from(tenantsWithTransport.keys());
  const candidates = await fetchBatch(db, now, batchLimit, tenantIds);
  stats.candidatesFetched = candidates.length;

  if (candidates.length === 0) return stats;

  // Step 4: Process each claimed message.
  for (const candidate of candidates) {
    const adapter = tenantsWithTransport.get(candidate.tenantId)!;
    const result = await processOneMessage(db, candidate, now, adapter);
    switch (result) {
      case "no_email":
        stats.skippedNoEmail++;
        break;
      case "sent":
        stats.sent++;
        break;
      case "suppressed":
        stats.suppressed++;
        break;
      case "deferred_frequency":
        stats.deferredFrequency++;
        break;
      case "deferred_window":
        stats.deferredWindow++;
        break;
      case "transport_error":
        stats.transportErrors++;
        break;
    }
  }

  return stats;
}

// ---------------------------------------------------------------------------
// Per-message processing
// ---------------------------------------------------------------------------

type MessageOutcome =
  | "no_email"
  | "sent"
  | "suppressed"
  | "deferred_frequency"
  | "deferred_window"
  | "transport_error";

async function processOneMessage(
  db: Db,
  candidate: DrainCandidate,
  now: Date,
  adapter: TransportAdapter,
): Promise<MessageOutcome> {
  // Messages arrive here already at status = 'sending' (claimed by fetchBatch).
  // Transport is already resolved (per-tenant, before claiming).

  // Step 1: Fetch contact email. If no email, revert to approved.
  const contactRow = await db
    .select({
      email: contacts.email,
      properties: contacts.properties,
    })
    .from(contacts)
    .where(eq(contacts.id, candidate.contactId))
    .limit(1);

  if (contactRow.length === 0 || !contactRow[0]!.email) {
    await revertToApproved(db, candidate.id, now);
    return "no_email";
  }

  const contactEmail = contactRow[0]!.email;
  const contactProps = contactRow[0]!.properties as Record<string, unknown> | null;
  const contactTimezone = (contactProps?.timezone as string) ?? null;

  // Step 2: Gather throttle gate inputs and evaluate.
  const gateInput = await buildThrottleGateInput(
    db,
    candidate,
    contactEmail,
    contactTimezone,
    now,
  );

  const verdict = evaluateThrottleGate(gateInput);

  // Step 3: Act on verdict.
  switch (verdict.outcome) {
    case "suppress":
      // CAS: only write if the row is still at 'sending'. If reap concurrently
      // reverted it to 'approved' or 'failed', this update hits 0 rows and the
      // reap outcome wins (correct: reap ran first, drain was too slow).
      await db
        .update(lifecycleMessages)
        .set({ status: "suppressed", updatedAt: now })
        .where(and(eq(lifecycleMessages.id, candidate.id), eq(lifecycleMessages.status, "sending")));
      return "suppressed";

    case "defer_frequency":
      // CAS: same guard as suppress. See comment above.
      await db
        .update(lifecycleMessages)
        .set({
          status: "approved",
          scheduledSendAt: verdict.retryAfter,
          updatedAt: now,
        })
        .where(and(eq(lifecycleMessages.id, candidate.id), eq(lifecycleMessages.status, "sending")));
      return "deferred_frequency";

    case "defer_window":
      // CAS: same guard as suppress. See comment above.
      await db
        .update(lifecycleMessages)
        .set({
          status: "approved",
          scheduledSendAt: verdict.retryAfter,
          updatedAt: now,
        })
        .where(and(eq(lifecycleMessages.id, candidate.id), eq(lifecycleMessages.status, "sending")));
      return "deferred_window";

    case "allow":
      break; // Fall through to transport
  }

  // Step 4: Resolve sender info.
  const senderInfo = await resolveSenderInfo(db, candidate.tenantId);

  // Step 5: Send via transport.
  try {
    const sendResult = await adapter.send({
      to: contactEmail,
      from: senderInfo.fromEmail,
      fromName: senderInfo.fromName ?? undefined,
      subject: candidate.subject ?? "(no subject)",
      bodyHtml: candidate.bodyHtml ?? "",
      bodyText: candidate.bodyText ?? undefined,
      messageId: candidate.id,
    });

    if (sendResult.success) {
      // CAS: only mark sent if the row is still at 'sending'. If reap reverted
      // it to 'approved' (or 'failed') while a slow transport call was in flight,
      // this update hits 0 rows. The reap outcome wins; the contact gets a retry.
      await db
        .update(lifecycleMessages)
        .set({ status: "sent", sentAt: now, updatedAt: now })
        .where(and(eq(lifecycleMessages.id, candidate.id), eq(lifecycleMessages.status, "sending")));
      return "sent";
    } else {
      // Transport returned failure but did not throw.
      // NOTE: message remains at 'sending' after transport error.
      // Recovery is handled by the reap worker (task 15), which finds messages
      // stuck in 'sending' for > REAP_STUCK_THRESHOLD_HOURS and either retries
      // (retry_count < MAX_RETRY_COUNT) or marks failed.
      // Until task 15 is implemented, errored messages are stranded.
      return "transport_error";
    }
  } catch {
    // Transport threw. Same as above: message stays at 'sending'.
    // NOTE: message remains at 'sending' after transport error.
    // Recovery is handled by the reap worker (task 15).
    // Until task 15 is implemented, errored messages are stranded.
    return "transport_error";
  }
}

// ---------------------------------------------------------------------------
// Revert helper
// ---------------------------------------------------------------------------

/**
 * Reverts a message from 'sending' back to 'approved'. Used when the drain
 * cannot proceed (no transport, no email) after the atomic batch claim.
 *
 * CAS: includes status = 'sending' in the WHERE clause so that if reap has
 * already moved the row to 'failed' (or another terminal state) while drain
 * held it, this revert hits 0 rows and the reap outcome wins.
 */
async function revertToApproved(db: Db, messageId: string, now: Date): Promise<void> {
  await db
    .update(lifecycleMessages)
    .set({ status: "approved", updatedAt: now })
    .where(and(eq(lifecycleMessages.id, messageId), eq(lifecycleMessages.status, "sending")));
}

// ---------------------------------------------------------------------------
// Throttle gate input builder
// ---------------------------------------------------------------------------

async function buildThrottleGateInput(
  db: Db,
  candidate: DrainCandidate,
  contactEmail: string,
  contactTimezone: string | null,
  now: Date,
): Promise<ThrottleGateInput> {
  // Check suppression (case-insensitive via functional index on lower(email)).
  // The index uq_suppressions_tenant_email_lower is keyed on lower(email), so
  // the query must use lower() on both sides to hit the index.
  const suppressionRow = await db
    .select({ id: suppressions.id })
    .from(suppressions)
    .where(
      and(
        eq(suppressions.tenantId, candidate.tenantId),
        sql`lower(${suppressions.email}) = lower(${contactEmail})`,
      ),
    )
    .limit(1);

  const isSuppressed = suppressionRow.length > 0;

  // Get flow class and step window_policy
  const flowRow = await db
    .select({
      flowClass: flows.flowClass,
      compiledPlan: flows.compiledPlan,
    })
    .from(flows)
    .where(eq(flows.id, candidate.flowId))
    .limit(1);

  let flowClass: "critical" | "nurture" = "nurture";
  let windowPolicy: "immediate" | "respect_window" = "respect_window";

  if (flowRow.length > 0) {
    flowClass = flowRow[0]!.flowClass === "critical" ? "critical" : "nurture";

    // Extract window_policy from the compiled step
    if (candidate.flowStepOrder !== null && flowRow[0]!.compiledPlan) {
      const plan = flowRow[0]!.compiledPlan as { steps?: Array<{ order: number; window_policy?: string }> };
      if (Array.isArray(plan.steps)) {
        const step = plan.steps.find((s) => s.order === candidate.flowStepOrder);
        if (step?.window_policy === "immediate") {
          windowPolicy = "immediate";
        }
      }
    }
  }

  // Get tenant throttle config
  const tenantRow = await db
    .select({ settings: tenants.settings })
    .from(tenants)
    .where(eq(tenants.id, candidate.tenantId))
    .limit(1);

  const tenantSettings = tenantRow.length > 0
    ? (tenantRow[0]!.settings as Record<string, unknown> | null)
    : null;
  const config = resolveThrottleConfig(tenantSettings?.throttle ?? null);

  // Get recent send history for this contact
  const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const last7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  const recentSendsResult = await db.execute<{
    count_24h: string;
    count_7d: string;
    last_sent: string | Date | null;
  }>(sql`
    SELECT
      COUNT(*) FILTER (WHERE sent_at >= ${last24h})::text AS count_24h,
      COUNT(*)::text AS count_7d,
      MAX(sent_at) AS last_sent
    FROM lifecycle_messages
    WHERE contact_id = ${candidate.contactId}
      AND status IN ('sending', 'sent')
      AND sent_at >= ${last7d}
  `);

  const rawLastSent = recentSendsResult.rows[0]?.last_sent ?? null;
  const recentSends = {
    countLast24h: parseInt(recentSendsResult.rows[0]?.count_24h ?? "0", 10),
    countLast7d: parseInt(recentSendsResult.rows[0]?.count_7d ?? "0", 10),
    lastSentAt: rawLastSent !== null
      ? (rawLastSent instanceof Date ? rawLastSent : new Date(rawLastSent))
      : null,
  };

  return {
    isSuppressed,
    flowClass,
    windowPolicy,
    config,
    recentSends,
    contactTimezone,
    now,
  };
}

// ---------------------------------------------------------------------------
// Sender info resolver
// ---------------------------------------------------------------------------

interface SenderInfo {
  fromEmail: string;
  fromName: string | null;
}

/**
 * Resolves the sender email/name for a tenant. Phase 4 implements real
 * transport_config lookup. For now, returns a placeholder that will never
 * be reached in production (transport resolver returns null first).
 */
async function resolveSenderInfo(db: Db, tenantId: string): Promise<SenderInfo> {
  // Look up the active transport config for from address.
  // This query is meaningful once Phase 4 populates transport_configs.
  const configRow = await db.execute<{
    from_email: string;
    from_name: string | null;
  }>(sql`
    SELECT from_email, from_name
    FROM transport_configs
    WHERE tenant_id = ${tenantId}
      AND is_active = true
    LIMIT 1
  `);

  if (configRow.rows.length > 0) {
    return {
      fromEmail: configRow.rows[0]!.from_email,
      fromName: configRow.rows[0]!.from_name,
    };
  }

  // Fallback: should not be reached in production (transport resolver
  // would have returned null). Tests may reach here if they provide an
  // adapter but no transport_configs row.
  return { fromEmail: "noreply@localhost", fromName: null };
}
