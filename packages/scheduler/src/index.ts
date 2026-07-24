/**
 * @claros/scheduler - Registers cron schedules on the pg-boss instance.
 *
 * The scheduler role's only job is to call boss.schedule() for each recurring
 * job. It does NOT call boss.work(). Workers (startWorker) own the handler
 * side; the scheduler owns the trigger side.
 *
 * Depends on @claros/core (queue names) and pg-boss (PgBoss type).
 * Does NOT depend on @claros/worker. The queue name string is the only
 * interface between scheduler and worker at the code level.
 *
 * Pattern: one boss.schedule() call per cron-triggered queue constant.
 * Add a new schedule here in the same commit as the queue name in @claros/core
 * and the handler in @claros/worker.
 *
 * Mirror side: PUBLIC (packages/scheduler is mirrored).
 */
import type { PgBoss } from "pg-boss";
import { QUEUE } from "@claros/core";

export const CLAROS_SCHEDULER_VERSION = "0.0.0";

/**
 * Registers (or updates) cron schedules on the supplied PgBoss instance.
 * Must be called after boss.start() resolves.
 *
 * Schedules are upserted - safe to call on every startup.
 * pg-boss deduplicates cron firings across concurrent instances using
 * internal job throttling, so multiple scheduler processes are safe.
 */
export async function startScheduler(boss: PgBoss): Promise<void> {
  // scan: every 15 minutes (5-placeholder cron, minute-level precision)
  await boss.schedule(QUEUE.SCAN, "*/15 * * * *", {});
}
