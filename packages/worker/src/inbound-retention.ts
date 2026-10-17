/**
 * Sweep for inbound sources: delete log lines (what each source received) older than the retention period.
 * Runs on the hourly reap tick.
 *
 * Mirror side: PUBLIC (packages/worker is mirrored).
 */
import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

type Db = NodePgDatabase<Record<string, never>>;

export const INBOUND_LOG_RETENTION_DAYS = 30;

export async function sweepInboundLog(db: Db, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - INBOUND_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const r = await db.execute(sql`DELETE FROM inbound_source_log WHERE created_at < ${cutoff} RETURNING id`);
  return r.rows.length;
}
