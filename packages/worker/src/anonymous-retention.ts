/**
 * Sweep for anonymous visitors: delete stored events from visitors who never identified, and the links from
 * anonymous ids to contacts once they are old. Runs on the hourly reap tick.
 *
 * Deleting is the point: an anonymous visitor who never signs up should not leave data behind for ever.
 * Both limits live in @loomail/core so the API and this sweep read the same numbers.
 *
 * Mirror side: PUBLIC (packages/worker is mirrored).
 */
import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { ANONYMOUS_ALIAS_RETENTION_DAYS, ANONYMOUS_EVENT_RETENTION_DAYS } from "@loomail/core";

type Db = NodePgDatabase<Record<string, never>>;

export interface AnonymousSweepResult {
  eventsDeleted: number;
  aliasesDeleted: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export async function sweepAnonymous(db: Db, now: Date): Promise<AnonymousSweepResult> {
  const eventCutoff = new Date(now.getTime() - ANONYMOUS_EVENT_RETENTION_DAYS * DAY_MS);
  const aliasCutoff = new Date(now.getTime() - ANONYMOUS_ALIAS_RETENTION_DAYS * DAY_MS);
  const events = await db.execute(sql`DELETE FROM anonymous_events WHERE received_at < ${eventCutoff} RETURNING id`);
  const aliases = await db.execute(sql`DELETE FROM anonymous_aliases WHERE created_at < ${aliasCutoff} RETURNING id`);
  return { eventsDeleted: events.rows.length, aliasesDeleted: aliases.rows.length };
}
