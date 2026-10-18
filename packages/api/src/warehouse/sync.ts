/**
 * Running a warehouse source: read a batch of rows after the saved position, record each one the way
 * POST /v1/identify and /v1/track would (same plan limits, email-conflict handling and lifecycle rules), move the
 * position forward, repeat until caught up or the per-run cap is reached.
 *
 * Why it is safe to run again and again:
 *   - the query is `>= :cursor`, so the row at the boundary is read once more each run; an event's message id is a
 *     fingerprint of the row, so the repeat is recognised and dropped, and traits are idempotent
 *   - the position only moves after every row in the batch was handled. A failure (database trouble, a plan limit)
 *     stops the run with the position where it was, and the next run starts from there
 *   - one run at a time per source: a lease is taken before reading and released after (it also expires on its own,
 *     so a crashed server does not block a source forever)
 *
 * Mirror side: PUBLIC (packages/api is mirrored).
 */
import { and, eq, isNull, lte, or, sql } from "drizzle-orm";
import { PlanLimitError } from "@loomail/core";
import { createWarehouseClient, openWebhookSecret, WarehouseError, type CellValue, type WarehouseClient, type WarehouseConnection } from "@loomail/adapters";
import { inboundSources, inboundSourceLog } from "@loomail/db/schema";
import type { Db } from "../plugins/db.js";
import { applyMapped } from "../inbound/process.js";
import { defaultCursor, toConnection, warehouseConfigSchema, type WarehouseConfig, type WarehouseSecret } from "./config.js";
import { cursorOf, laterCursor, mapWarehouseRow, rowsFingerprint } from "./mapping.js";

type Enqueue = Parameters<typeof applyMapped>[1];
type Source = typeof inboundSources.$inferSelect;

export type ClientFactory = (conn: WarehouseConnection) => WarehouseClient;
export interface SyncDeps {
  enqueue: Enqueue;
  clientFor?: ClientFactory;
  now?: () => Date;
  log?: { info: (o: unknown, m?: string) => void; error: (o: unknown, m?: string) => void };
}

export interface SyncOutcome {
  ok: boolean;
  /** One short line for the dashboard and the log. */
  note: string;
  read: number;
  applied: number;
  skipped: number;
}

export function readSecret(source: Pick<Source, "secretSealed">): WarehouseSecret {
  if (!source.secretSealed) throw new Error("This source has no credential saved.");
  return JSON.parse(openWebhookSecret(source.secretSealed)) as WarehouseSecret;
}

/** Columns the settings name that the query did not return. */
export function missingColumns(config: WarehouseConfig, columns: string[]): string[] {
  const have = new Set(columns);
  const wanted = [config.cursor_column, config.user_id_column, config.email_column, config.event_name_column, config.timestamp_column, ...Object.values(config.trait_columns)];
  return [...new Set(wanted.filter((c): c is string => !!c).map((c) => c.toLowerCase()))].filter((c) => !have.has(c));
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Run one source now. The caller holds the lease. Never throws: a failure is an outcome. */
export async function runSync(db: Db, source: Source, deps: SyncDeps): Promise<SyncOutcome> {
  const parsed = warehouseConfigSchema.safeParse(source.config);
  if (!parsed.success) return { ok: false, note: "The settings are not valid. Open the source and save it again.", read: 0, applied: 0, skipped: 0 };
  const config = parsed.data;

  let client: WarehouseClient;
  try {
    client = (deps.clientFor ?? ((c) => createWarehouseClient(c)))(toConnection(config, readSecret(source)));
  } catch (err) {
    return { ok: false, note: err instanceof Error ? err.message.slice(0, 300) : "The credential could not be read.", read: 0, applied: 0, skipped: 0 };
  }

  let cursor = source.syncCursor ?? config.initial_cursor ?? defaultCursor(config.cursor_type);
  let boundary = source.syncBoundary;
  let read = 0;
  let applied = 0;
  let skipped = 0;
  const skipReasons = new Map<string, number>();

  try {
    for (let batch = 0; batch < config.max_batches_per_run; batch++) {
      const res = await client.query({ sql: config.query, cursor, cursorColumn: config.cursor_column, maxRows: config.batch_size, timeoutMs: config.timeout_seconds * 1000 });
      const missing = missingColumns(config, res.columns);
      if (missing.length > 0) {
        return { ok: false, note: `The query does not return ${missing.length === 1 ? "this column" : "these columns"}: ${missing.join(", ")}. It returns: ${res.columns.join(", ") || "nothing"}.`, read, applied, skipped };
      }

      // The query is `>= :cursor`, so the rows at exactly the saved position come back every time. If they are the very
      // rows handled last time, skip them; if anything about them differs (a late row with the same value, an edit),
      // handle them all again - events are recognised by their fingerprint, so a repeat costs nothing.
      const rows = res.rows as Array<Record<string, CellValue>>;
      const atStart = rows.filter((r) => cursorOf(config, r) === cursor);
      const skipAtStart = atStart.length > 0 && boundary !== null && rowsFingerprint(atStart) === boundary;

      let next: string | null = null;
      for (const row of rows) {
        next = laterCursor(config.cursor_type, next, cursorOf(config, row));
        if (skipAtStart && cursorOf(config, row) === cursor) continue;
        read++;
        const mapped = mapWarehouseRow(config, row, source.id);
        if (!mapped.ok) {
          skipped++;
          skipReasons.set(mapped.reason, (skipReasons.get(mapped.reason) ?? 0) + 1);
          continue;
        }
        const r = await applyMapped(db, deps.enqueue, source.tenantId, source.id, mapped.mapped);
        if (r.applied) applied++;
        else {
          skipped++;
          skipReasons.set(r.reason, (skipReasons.get(r.reason) ?? 0) + 1);
        }
      }

      const before = cursor;
      if (next !== null) {
        const newBoundary = rowsFingerprint(rows.filter((r) => cursorOf(config, r) === next));
        if (next !== cursor || newBoundary !== boundary) {
          cursor = next;
          boundary = newBoundary;
          await db.update(inboundSources).set({ syncCursor: cursor, syncBoundary: boundary }).where(eq(inboundSources.id, source.id));
        }
      }
      if (res.rows.length < config.batch_size) break; // caught up
      if (next === null) {
        return { ok: false, note: `Rows came back without a value in ${config.cursor_column}, so Loomail cannot tell where it is up to.`, read, applied, skipped };
      }
      if (next === before) {
        return { ok: false, note: `More than ${config.batch_size} rows share the same ${config.cursor_column} value, so the sync cannot move past them. Raise the batch size.`, read, applied, skipped };
      }
    }
  } catch (err) {
    const why =
      err instanceof PlanLimitError
        ? "Your plan's contact limit is reached. The sync will continue from here once there is room."
        : err instanceof WarehouseError
          ? err.message
          : "Something went wrong while recording rows. It will be tried again.";
    if (!(err instanceof WarehouseError) && !(err instanceof PlanLimitError)) deps.log?.error({ err, sourceId: source.id }, "[warehouse] sync failed");
    return { ok: false, note: why.slice(0, 400), read, applied, skipped };
  }

  const reasons = [...skipReasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([r, n]) => `${n} ${r}`);
  const note = read === 0 ? "Nothing new." : `Read ${plural(read, "row")}: ${applied} recorded${skipped > 0 ? `, ${skipped} skipped${reasons.length ? ` (${reasons.join("; ")})` : ""}` : ""}.`;
  return { ok: true, note, read, applied, skipped };
}

/** How long the lease lasts: the longest a run can take, plus a minute. */
function leaseMs(config: WarehouseConfig): number {
  return (config.timeout_seconds * config.max_batches_per_run + 60) * 1000;
}

/** Claim one source for a run. Null when it is already running, disabled or gone. */
async function claim(db: Db, id: string, now: Date, force: boolean): Promise<Source | null> {
  const row = (await db.select().from(inboundSources).where(and(eq(inboundSources.id, id), eq(inboundSources.kind, "warehouse"))).limit(1))[0];
  if (!row || (!row.enabled && !force)) return null;
  const parsed = warehouseConfigSchema.safeParse(row.config);
  const until = new Date(now.getTime() + (parsed.success ? leaseMs(parsed.data) : 5 * 60_000));
  const won = await db
    .update(inboundSources)
    .set({ syncLeaseUntil: until, lastSyncStatus: "running" })
    .where(and(eq(inboundSources.id, id), or(isNull(inboundSources.syncLeaseUntil), lte(inboundSources.syncLeaseUntil, now))))
    .returning();
  return won[0] ?? null;
}

/** Claim, run, record. `force` runs a disabled or not-yet-due source (the "Sync now" button). */
export async function syncSource(db: Db, id: string, deps: SyncDeps, force = false): Promise<SyncOutcome | null> {
  const now = (deps.now ?? (() => new Date()))();
  const source = await claim(db, id, now, force);
  if (!source) return null;
  const outcome = await runSync(db, source, deps);
  const parsed = warehouseConfigSchema.safeParse(source.config);
  const interval = parsed.success ? parsed.data.interval_minutes : 60;
  const finished = (deps.now ?? (() => new Date()))();
  // After a failure try again sooner than a full interval, but not in a tight loop.
  const waitMin = outcome.ok ? interval : Math.min(interval, 15);
  await db
    .update(inboundSources)
    .set({
      syncLeaseUntil: null,
      lastSyncAt: finished,
      lastSyncStatus: outcome.ok ? "ok" : "error",
      lastSyncNote: outcome.note.slice(0, 500),
      nextSyncAt: new Date(finished.getTime() + waitMin * 60_000),
      ...(outcome.read > 0 ? { lastReceivedAt: finished } : {}),
    })
    .where(eq(inboundSources.id, id));
  // Quiet runs (nothing new) are not worth a log line every interval; anything else is.
  if (!outcome.ok || outcome.applied > 0 || outcome.skipped > 0) {
    await db
      .insert(inboundSourceLog)
      .values({ tenantId: source.tenantId, sourceId: id, status: outcome.ok ? "processed" : "error", summary: outcome.note.slice(0, 500) })
      .catch(() => {});
  }
  return outcome;
}

/** Sources that are due now, oldest first, in workspaces that are switched on. */
export async function dueSources(db: Db, now: Date, limit = 10): Promise<string[]> {
  const r = await db.execute<{ id: string }>(sql`
    SELECT s.id FROM inbound_sources s JOIN tenants t ON t.id = s.tenant_id
    WHERE s.kind = 'warehouse' AND s.enabled
      AND (s.next_sync_at IS NULL OR s.next_sync_at <= ${now})
      AND (s.sync_lease_until IS NULL OR s.sync_lease_until <= ${now})
      AND t.suspended_at IS NULL AND t.deletion_scheduled_at IS NULL
    ORDER BY s.next_sync_at NULLS FIRST
    LIMIT ${limit}`);
  return r.rows.map((x) => x.id);
}

export async function syncDueSources(db: Db, deps: SyncDeps): Promise<number> {
  const ids = await dueSources(db, (deps.now ?? (() => new Date()))());
  let ran = 0;
  for (const id of ids) {
    const o = await syncSource(db, id, deps).catch((err) => {
      deps.log?.error({ err, sourceId: id }, "[warehouse] sync crashed");
      return null;
    });
    if (o) ran++;
  }
  return ran;
}
