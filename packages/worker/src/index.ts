/**
 * @claros/worker - Background job processing.
 *
 * Exports:
 *   - createBoss(connectionString, opts?): creates a configured PgBoss instance.
 *     Called by apps/server before startWorker / startScheduler.
 *   - startWorker(boss): registers work() handlers. Add one handler per queue
 *     in the same commit as the queue name in @claros/core.
 *   - fromDrizzle: pg-boss Drizzle transaction adapter, re-exported so API
 *     routes can enqueue jobs atomically inside Drizzle transactions without
 *     a direct pg-boss import.
 *
 * Queue names and payload types live in @claros/core. Import them from there.
 * Nothing re-exports the queue contract through this package.
 *
 * Connection model:
 *   pg-boss opens its own pg.Pool (max=3, sized up in Phase 2 once real
 *   concurrency is known). The Drizzle pool used by the API is separate.
 *   See apps/server/src/main.ts for per-role connection totals.
 *
 * Mirror side: PUBLIC (packages/worker is mirrored).
 */
import { PgBoss, fromDrizzle } from "pg-boss";
import type { Job } from "pg-boss";
import { QUEUE, type ScanJobData } from "@claros/core";

export { fromDrizzle };
export const CLAROS_WORKER_VERSION = "0.0.0";

// ---------------------------------------------------------------------------
// Boss factory
// ---------------------------------------------------------------------------

/**
 * Creates and returns a configured PgBoss instance. Does NOT call start().
 * The caller (apps/server) calls boss.start() then passes the instance to
 * startWorker() and/or startScheduler().
 *
 * @param connectionString - DATABASE_URL for the pg-boss pool.
 * @param opts - Optional overrides (e.g. { schedule: false } for worker-only role).
 */
export function createBoss(
  connectionString: string,
  opts: Partial<ConstructorParameters<typeof PgBoss>[0]> = {},
): PgBoss {
  return new PgBoss({
    connectionString,
    // The default "pgboss" schema is used. drizzle-kit never sees it because
    // drizzle.config.ts scans only ./drizzle/schema/*.ts, not the live DB.
    schema: "pgboss",
    // Conservative pool for now - no real work runs yet.
    // Raise in Phase 2 when drain/scan concurrency is known.
    max: 3,
    ...opts,
  });
}

// ---------------------------------------------------------------------------
// Worker registration
// ---------------------------------------------------------------------------

/**
 * Registers all work() handlers on the supplied PgBoss instance.
 * Must be called after boss.start() resolves.
 *
 * Each queue is explicitly created before the work() handler is registered.
 * boss.work() alone creates the queue row lazily (on the first internal poll),
 * which means boss.schedule() in startScheduler() can fail with a FK violation
 * if it runs before that first poll. createQueue() is idempotent (upsert) and
 * ensures the row exists immediately so schedule() can reference it.
 *
 * Pattern: one createQueue() + work() pair per queue constant. Add both in the
 * same commit as the queue name in @claros/core and the handler logic.
 * Handler bodies are stubs until the Phase 2 task that implements them.
 */
export async function startWorker(boss: PgBoss): Promise<void> {
  // Ensure queue rows exist before any boss.schedule() call can reference them.
  await boss.createQueue(QUEUE.SCAN);

  await boss.work<ScanJobData>(
    QUEUE.SCAN,
    { pollingIntervalSeconds: 5 },
    async (jobs: Job<ScanJobData>[]) => {
      // TODO(task-12): scan contacts for flow eligibility
      void jobs;
    },
  );
}
