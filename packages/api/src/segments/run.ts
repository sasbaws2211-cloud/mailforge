/**
 * Running a segment against the contacts table: count it, sample it, load it, with a time limit.
 *
 * A segment is a definition, so asking "who is in it" means running its rules as a query. The rules are checked
 * for shape by core's segmentDefinitionSchema before they get here and turned into SQL by @loomail/db/segments;
 * this file adds what an API needs around that: always scope to the workspace, never read unboundedly, and
 * give up (instead of tying up the database) when a segment is too slow.
 *
 * Shared by the segments routes and the People list, so both mean the same thing by "in this segment".
 */
import { and, eq, sql, type SQL } from "drizzle-orm";
import { segments } from "@loomail/db/schema";
import { compileSegment, SEGMENT_COUNT_LIMIT } from "@loomail/db/segments";
import { segmentDefinitionSchema, type SegmentDefinition } from "@loomail/core";
import type { Db } from "../plugins/db.js";

/** A segment query ran longer than its limit. Tell the person to narrow it; never retry. */
export class SegmentTooSlowError extends Error {
  constructor() {
    super("That segment takes too long to work out. Add a rule that narrows it down, or shorten an event window.");
    this.name = "SegmentTooSlowError";
  }
}

/** Counting and sampling for a screen the person is waiting on. */
export const PREVIEW_TIMEOUT_MS = 5_000;
/** Listing the members page by page in the People list. */
export const LIST_TIMEOUT_MS = 10_000;

function isTimeout(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return e?.code === "57014" || e?.cause?.code === "57014"; // query_canceled (statement_timeout)
}

/**
 * Run `fn` in a transaction whose queries are cancelled after `ms`. A cancelled query becomes
 * SegmentTooSlowError. SET LOCAL ends with the transaction, so the setting never leaks to other work.
 */
export async function withStatementTimeout<T>(db: Db, ms: number, fn: (tx: Db) => Promise<T>): Promise<T> {
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('statement_timeout', ${String(ms)}, true)`);
      return fn(tx as unknown as Db);
    });
  } catch (err) {
    if (isTimeout(err)) throw new SegmentTooSlowError();
    throw err;
  }
}

/** `contacts.tenant_id = <tenant> AND <the segment's rules>`: the whole WHERE for a segment's members. */
export function membersWhere(tenantId: string, definition: SegmentDefinition): SQL {
  return sql`contacts.tenant_id = ${tenantId}::uuid AND ${compileSegment(definition)}`;
}

export interface SegmentCount {
  /** Members found, up to the counting limit. */
  count: number;
  /** True when the real number is larger than `count` (counting stopped at the limit). */
  capped: boolean;
  /** Of those counted, how many have an email address that is not suppressed. */
  reachable: number;
}

export async function countMembers(db: Db, tenantId: string, definition: SegmentDefinition): Promise<SegmentCount> {
  return withStatementTimeout(db, PREVIEW_TIMEOUT_MS, async (tx) => {
    const result = await tx.execute<{ n: string; reachable: string }>(sql`
      SELECT count(*) AS n, count(*) FILTER (WHERE emailable) AS reachable
      FROM (
        SELECT (contacts.email IS NOT NULL AND btrim(contacts.email) <> ''
                AND NOT EXISTS (SELECT 1 FROM suppressions s WHERE s.tenant_id = contacts.tenant_id AND s.email = contacts.email)) AS emailable
        FROM contacts
        WHERE ${membersWhere(tenantId, definition)}
        LIMIT ${SEGMENT_COUNT_LIMIT + 1}::int
      ) counted`);
    const n = Number(result.rows[0]?.n ?? 0);
    const reachable = Number(result.rows[0]?.reachable ?? 0);
    return n > SEGMENT_COUNT_LIMIT
      ? { count: SEGMENT_COUNT_LIMIT, capped: true, reachable: Math.min(reachable, SEGMENT_COUNT_LIMIT) }
      : { count: n, capped: false, reachable };
  });
}

export type SampleContact = {
  id: string;
  external_id: string;
  email: string | null;
  name: string | null;
  lifecycle_state: string;
  payment_status: string | null;
  last_seen_at: string | null;
};

/** A few members, most recently active first, so the person can see who the rules pick out. */
export async function sampleMembers(db: Db, tenantId: string, definition: SegmentDefinition, limit = 10): Promise<SampleContact[]> {
  return withStatementTimeout(db, PREVIEW_TIMEOUT_MS, async (tx) => {
    const result = await tx.execute<SampleContact>(sql`
      SELECT contacts.id, contacts.external_id, contacts.email, contacts.name,
             contacts.lifecycle_state, contacts.payment_status, contacts.last_seen_at
      FROM contacts
      WHERE ${membersWhere(tenantId, definition)}
      ORDER BY contacts.last_seen_at DESC NULLS LAST, contacts.id
      LIMIT ${limit}::int`);
    return result.rows;
  });
}

/** Of these event names, the ones this workspace has never received (within the last 400 days). */
export async function neverSentEvents(db: Db, tenantId: string, names: string[]): Promise<string[]> {
  if (names.length === 0) return [];
  const result = await db.execute<{ event_name: string }>(sql`
    SELECT DISTINCT event_name FROM events
    WHERE tenant_id = ${tenantId}::uuid
      AND received_at > now() - interval '400 days'
      AND event_name IN (${sql.join(names.map((n) => sql`${n}::text`), sql`, `)})`);
  const seen = new Set(result.rows.map((r) => r.event_name));
  return names.filter((n) => !seen.has(n));
}

export type LoadedSegment =
  | { ok: true; id: string; name: string; definition: SegmentDefinition }
  | { ok: false; reason: "not_found" | "archived" | "unreadable" };

/**
 * Load a segment of this workspace to run it. The stored definition is read back through the same schema that
 * validated it, so a row that somehow holds something the engine no longer accepts is reported, not run.
 */
export async function loadSegment(db: Db, tenantId: string, id: string): Promise<LoadedSegment> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return { ok: false, reason: "not_found" };
  const rows = await db
    .select({ id: segments.id, name: segments.name, definition: segments.definition, archivedAt: segments.archivedAt })
    .from(segments)
    .where(and(eq(segments.id, id), eq(segments.tenantId, tenantId)))
    .limit(1);
  const row = rows[0];
  if (!row) return { ok: false, reason: "not_found" };
  if (row.archivedAt !== null) return { ok: false, reason: "archived" };
  const parsed = segmentDefinitionSchema.safeParse(row.definition);
  if (!parsed.success) return { ok: false, reason: "unreadable" };
  return { ok: true, id: row.id, name: row.name, definition: parsed.data };
}

