/**
 * Scan phase 2b: flow enrollment for segment triggers.
 *
 * Runs after phase 2 (lifecycle-transition enrollment). For each tenant,
 * loads active, compiled flows with trigger_type = 'segment'. Each such
 * flow targets one retention-grid cell (tenure_bucket x recency_bucket).
 * Contacts currently inside that cell are enrolled through the standard
 * enrollment sequence (suppression, class concurrency, re-entry policy,
 * race backstop), so segment flows obey exactly the same guards as every
 * other trigger type.
 *
 * Re-running is safe: contacts already actively enrolled are excluded in
 * SQL, and re-entry policy decides whether a contact who left the flow may
 * return when they re-enter the cell.
 *
 * A segment trigger points at either one retention-grid cell, { tenure_bucket, recency_bucket } (the original
 * form), or a SAVED segment, { segment_id }: a set of rules built in the segment builder. A saved segment's
 * members are found by running its rules as a query (see processSavedSegmentFlow), and the query leaves out
 * contacts the enrollment guards would only turn away (suppressed, already in this flow, held back by the
 * re-entry policy, or kept out by a running flow of equal or higher priority), so the per-scan cap is spent on
 * contacts who can actually enroll. The guards still run for every contact; the query is only a pre-filter.
 *
 * Throughput is bounded per flow per scan (SEGMENT_ENROLLMENT_CAP): a
 * brand-new segment flow over a large cell enrolls over several scan runs
 * rather than in one burst, so a big tenant cannot starve the scan
 * interval. The cap is per-flow, not per-tenant: fairness across flows
 * within a tenant matches the scan's per-tenant fairness across tenants.
 *
 * Mirror side: PUBLIC (packages/worker is mirrored).
 */
import { eq, and, inArray, gt, sql, type SQL } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { contacts, flows, segments, tenants } from "@loomail/db/schema";
import { compileSegment } from "@loomail/db/segments";
import {
  resolveLifecycleConfig,
  isSegmentTriggerConfig,
  isSavedSegmentTriggerConfig,
  segmentDefinitionSchema,
  tenureBucketRange,
  recencyBucketRange,
  type EnrollableFlow,
  type LifecycleConfig,
  type SegmentTriggerConfig,
} from "@loomail/core";
import { enrollContactInFlows } from "./enroll.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Number of contacts fetched per keyset page within one flow's cell. */
const BATCH_SIZE = 200;

/**
 * Maximum enrollments per flow per scan run. Bounds the work a new segment
 * flow over a large cell can create in one 15-minute interval; the rest
 * enrolls on later runs.
 */
const SEGMENT_ENROLLMENT_CAP = 200;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Db = NodePgDatabase<Record<string, never>>;

export interface PhaseSegmentEnrollmentResult {
  tenantsProcessed: number;
  flowsEvaluated: number;
  enrollmentsAttempted: number;
  enrollmentsSucceeded: number;
  /** Flows whose cell still had matching contacts when the cap was hit. */
  flowsCapped: number;
  /** Saved-segment flows not run this scan: the segment is gone, unreadable, or its query was too slow. */
  flowsSkipped: number;
}

// ---------------------------------------------------------------------------
// Phase entry point
// ---------------------------------------------------------------------------

/**
 * Phase 2b of the scan: enroll contacts into segment-triggered flows whose
 * retention-grid cell they currently occupy.
 *
 * @param db - Drizzle database instance.
 * @param now - Current time (injected for testability).
 * @param tenantIds - Optional tenant scope (production default: all).
 */
export async function phaseSegmentEnrollment(
  db: Db,
  now: Date,
  tenantIds?: string[],
): Promise<PhaseSegmentEnrollmentResult> {
  const stats: PhaseSegmentEnrollmentResult = {
    tenantsProcessed: 0,
    flowsEvaluated: 0,
    enrollmentsAttempted: 0,
    enrollmentsSucceeded: 0,
    flowsCapped: 0,
    flowsSkipped: 0,
  };

  let tenantRows: { id: string; settings: unknown }[];
  if (tenantIds && tenantIds.length > 0) {
    tenantRows = await db
      .select({ id: tenants.id, settings: tenants.settings })
      .from(tenants)
      .where(inArray(tenants.id, tenantIds))
      .orderBy(tenants.id);
  } else {
    tenantRows = await db
      .select({ id: tenants.id, settings: tenants.settings })
      .from(tenants)
      .orderBy(tenants.id);
  }

  for (const tenant of tenantRows) {
    const settings = tenant.settings as Record<string, unknown> | null | undefined;
    const config = resolveLifecycleConfig(
      settings?.lifecycle as Partial<LifecycleConfig> | null | undefined,
    );

    // Small cardinality: a tenant typically has < 50 flows total.
    const segmentFlows = await db
      .select({
        id: flows.id,
        tenantId: flows.tenantId,
        priority: flows.priority,
        triggerType: flows.triggerType,
        triggerConfig: flows.triggerConfig,
        flowClass: flows.flowClass,
        reentryPolicy: flows.reentryPolicy,
        reentryCooldownDays: flows.reentryCooldownDays,
      })
      .from(flows)
      .where(
        and(
          eq(flows.tenantId, tenant.id),
          eq(flows.status, "active"),
          eq(flows.triggerType, "segment"),
          eq(flows.compileStatus, "ready"),
          sql`${flows.compiledPlan} IS NOT NULL`,
        ),
      );

    for (const flow of segmentFlows) {
      if (isSavedSegmentTriggerConfig(flow.triggerConfig)) {
        stats.flowsEvaluated++;
        const saved = await processSavedSegmentFlow(
          db,
          tenant.id,
          {
            id: flow.id,
            tenantId: flow.tenantId,
            priority: flow.priority ?? 0,
            triggerType: "segment",
            triggerConfig: flow.triggerConfig,
            flowClass: (flow.flowClass ?? "nurture") as "critical" | "nurture",
            reentryPolicy: (flow.reentryPolicy ?? "cooldown") as "once" | "cooldown" | "every_time",
            reentryCooldownDays: flow.reentryCooldownDays ?? 30,
          },
          flow.triggerConfig.segment_id,
          now,
        );
        stats.enrollmentsAttempted += saved.attempted;
        stats.enrollmentsSucceeded += saved.succeeded;
        if (saved.capped) stats.flowsCapped++;
        if (saved.skipped) stats.flowsSkipped++;
        continue;
      }
      if (!isSegmentTriggerConfig(flow.triggerConfig)) continue;
      stats.flowsEvaluated++;

      const enrollable: EnrollableFlow = {
        id: flow.id,
        tenantId: flow.tenantId,
        priority: flow.priority ?? 0,
        triggerType: "segment",
        triggerConfig: flow.triggerConfig,
        flowClass: (flow.flowClass ?? "nurture") as "critical" | "nurture",
        reentryPolicy: (flow.reentryPolicy ?? "cooldown") as "once" | "cooldown" | "every_time",
        reentryCooldownDays: flow.reentryCooldownDays ?? 30,
      };

      const flowStats = await processSegmentFlow(
        db,
        tenant.id,
        enrollable,
        flow.triggerConfig,
        config,
        now,
      );

      stats.enrollmentsAttempted += flowStats.attempted;
      stats.enrollmentsSucceeded += flowStats.succeeded;
      if (flowStats.capped) stats.flowsCapped++;
    }

    stats.tenantsProcessed++;
  }

  return stats;
}

// ---------------------------------------------------------------------------
// Saved segments
// ---------------------------------------------------------------------------

/** A saved segment's query is cancelled after this long, so one slow segment cannot hold the scan. */
const SAVED_SEGMENT_QUERY_TIMEOUT_MS = 30_000;

type SavedSegmentSkip = "missing" | "unreadable" | "too_slow";

function isQueryTimeout(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return e?.code === "57014" || e?.cause?.code === "57014";
}

/**
 * Contacts the re-entry policy would turn away, as SQL: the same rules as core's isReentryAllowed, which looks
 * only at the contact's most recent finished membership in this flow.
 */
function reentryExclusion(flow: EnrollableFlow, now: Date): SQL {
  if (flow.reentryPolicy === "every_time") return sql``;
  if (flow.reentryPolicy === "once") {
    return sql`AND NOT EXISTS (
      SELECT 1 FROM flow_memberships fm
      WHERE fm.contact_id = contacts.id AND fm.flow_id = ${flow.id}::uuid AND fm.status <> 'active')`;
  }
  return sql`AND NOT EXISTS (
    SELECT 1 FROM (
      SELECT fm.exit_reason, fm.exited_at, fm.completed_at
      FROM flow_memberships fm
      WHERE fm.contact_id = contacts.id AND fm.flow_id = ${flow.id}::uuid AND fm.status <> 'active'
      ORDER BY fm.entered_at DESC LIMIT 1
    ) last
    WHERE last.exit_reason IS DISTINCT FROM 'priority_override'
      AND (COALESCE(last.exited_at, last.completed_at) IS NULL
           OR COALESCE(last.exited_at, last.completed_at) > ${new Date(now.getTime() - flow.reentryCooldownDays * 86_400_000)}::timestamptz))`;
}

/**
 * Contacts a running nurture flow of equal or higher priority would keep out, as SQL: a nurture flow does not
 * evict one of the same or higher priority. Critical flows have no such limit.
 */
function concurrencyExclusion(flow: EnrollableFlow): SQL {
  if (flow.flowClass !== "nurture") return sql``;
  return sql`AND NOT EXISTS (
    SELECT 1 FROM flow_memberships fm
    JOIN flows f ON f.id = fm.flow_id
    WHERE fm.contact_id = contacts.id AND fm.status = 'active'
      AND f.flow_class = 'nurture' AND COALESCE(f.priority, 0) >= ${flow.priority}::int)`;
}

/**
 * Enroll the current members of a saved segment into a flow that starts from it.
 *
 * Runs the segment's rules as a query, in pages by contact id, up to SEGMENT_ENROLLMENT_CAP enrollments attempts
 * per scan. A segment that has been archived, whose stored rules no longer parse, or whose query is too slow is
 * skipped for this scan and reported, never guessed at.
 */
async function processSavedSegmentFlow(
  db: Db,
  tenantId: string,
  flow: EnrollableFlow,
  segmentId: string,
  now: Date,
): Promise<SegmentFlowResult & { skipped?: SavedSegmentSkip }> {
  const result: SegmentFlowResult & { skipped?: SavedSegmentSkip } = { attempted: 0, succeeded: 0, capped: false };

  const rows = await db
    .select({ definition: segments.definition, archivedAt: segments.archivedAt })
    .from(segments)
    .where(and(eq(segments.id, segmentId), eq(segments.tenantId, tenantId)))
    .limit(1);
  const row = rows[0];
  if (!row || row.archivedAt !== null) {
    console.warn(`[scan] segment flow ${flow.id}: its segment ${segmentId} is missing or archived, skipping`);
    return { ...result, skipped: "missing" };
  }
  const parsed = segmentDefinitionSchema.safeParse(row.definition);
  if (!parsed.success) {
    console.warn(`[scan] segment flow ${flow.id}: segment ${segmentId} has rules that cannot be read, skipping`);
    return { ...result, skipped: "unreadable" };
  }

  const members = compileSegment(parsed.data);
  const reentry = reentryExclusion(flow, now);
  const concurrency = concurrencyExclusion(flow);
  let lastId: string | null = null;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (result.attempted >= SEGMENT_ENROLLMENT_CAP) {
      result.capped = true;
      break;
    }
    const limit = Math.min(BATCH_SIZE, SEGMENT_ENROLLMENT_CAP - result.attempted);
    const after: SQL = lastId === null ? sql`` : sql`AND contacts.id > ${lastId}::uuid`;

    let batch: Array<{ id: string }>;
    try {
      batch = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('statement_timeout', ${String(SAVED_SEGMENT_QUERY_TIMEOUT_MS)}, true)`);
        const found = await tx.execute<{ id: string }>(sql`
          SELECT contacts.id
          FROM contacts
          WHERE contacts.tenant_id = ${tenantId}::uuid
            AND ${members}
            AND NOT EXISTS (
              SELECT 1 FROM flow_memberships fm
              WHERE fm.contact_id = contacts.id AND fm.flow_id = ${flow.id}::uuid AND fm.status = 'active')
            AND NOT EXISTS (
              SELECT 1 FROM suppressions s
              WHERE s.tenant_id = contacts.tenant_id AND s.email = contacts.email)
            ${reentry}
            ${concurrency}
            ${after}
          ORDER BY contacts.id
          LIMIT ${limit}::int`);
        return found.rows;
      });
    } catch (err) {
      if (!isQueryTimeout(err)) throw err;
      console.warn(`[scan] segment flow ${flow.id}: segment ${segmentId} took too long to work out, skipping`);
      return { ...result, skipped: "too_slow" };
    }

    if (batch.length === 0) break;

    for (const contact of batch) {
      result.attempted++;
      const results = await db.transaction(async (tx) => {
        return enrollContactInFlows(tx as unknown as Db, contact.id, tenantId, [flow], now);
      });
      if (results.some((r) => r.enrolled)) result.succeeded++;
    }

    lastId = batch[batch.length - 1]!.id;
    if (batch.length < limit) break;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Per-flow processing
// ---------------------------------------------------------------------------

interface SegmentFlowResult {
  attempted: number;
  succeeded: number;
  capped: boolean;
}

async function processSegmentFlow(
  db: Db,
  tenantId: string,
  flow: EnrollableFlow,
  triggerConfig: SegmentTriggerConfig,
  config: LifecycleConfig,
  now: Date,
): Promise<SegmentFlowResult> {
  const tenure = tenureBucketRange(triggerConfig.tenure_bucket);
  const recency = recencyBucketRange(
    triggerConfig.recency_bucket,
    config.natural_frequency_days,
  );

  const result: SegmentFlowResult = { attempted: 0, succeeded: 0, capped: false };
  let lastId: string | null = null;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (result.attempted >= SEGMENT_ENROLLMENT_CAP) {
      result.capped = true;
      break;
    }

    // Contacts whose tenure and recency ages fall inside the cell, excluding
    // anyone already actively enrolled in this flow. Keyset pagination by id.
    const batch = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(
        and(
          eq(contacts.tenantId, tenantId),
          sql`${contacts.firstSeenAt} <= ${now}::timestamptz - make_interval(days => ${tenure.minDays})`,
          tenure.maxDays === null
            ? undefined
            : sql`${contacts.firstSeenAt} > ${now}::timestamptz - make_interval(days => ${tenure.maxDays})`,
          sql`${contacts.lastSeenAt} <= ${now}::timestamptz - make_interval(days => ${recency.minDays})`,
          recency.maxDays === null
            ? undefined
            : sql`${contacts.lastSeenAt} > ${now}::timestamptz - make_interval(days => ${recency.maxDays})`,
          sql`NOT EXISTS (
            SELECT 1 FROM flow_memberships fm
            WHERE fm.contact_id = ${contacts.id}
              AND fm.flow_id = ${flow.id}
              AND fm.status = 'active'
          )`,
          lastId === null ? undefined : gt(contacts.id, lastId),
        ),
      )
      .orderBy(contacts.id)
      .limit(Math.min(BATCH_SIZE, SEGMENT_ENROLLMENT_CAP - result.attempted));

    if (batch.length === 0) break;

    for (const contact of batch) {
      result.attempted++;
      const results = await db.transaction(async (tx) => {
        return enrollContactInFlows(
          tx as unknown as Db,
          contact.id,
          tenantId,
          [flow],
          now,
        );
      });
      if (results.some((r) => r.enrolled)) {
        result.succeeded++;
      }
      if (result.attempted >= SEGMENT_ENROLLMENT_CAP) break;
    }

    lastId = batch[batch.length - 1]!.id;
    if (batch.length < BATCH_SIZE) break;
  }

  return result;
}
