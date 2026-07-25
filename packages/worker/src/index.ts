/**
 * @claros/worker - Background job processing.
 *
 * Exports:
 *   - createBoss(connectionString, opts?): creates a configured PgBoss instance.
 *     Called by apps/server before startWorker / startScheduler.
 *   - startWorker(boss, db): registers work() handlers. Add one handler per queue
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
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { QUEUE, type ScanJobData, type CompileJobData, type TriggerCheckJobData, type DrainJobData, type ReapJobData, type CounterRolloverJobData, type PartitionMaintenanceJobData } from "@claros/core";
import { handleCompileJob } from "./compile.js";
import { phaseTimeTransitions } from "./scan-time-transitions.js";
import { phaseEnrollment } from "./scan-enrollment.js";
import { phaseStepAdvancement } from "./scan-step-advancement.js";
import { phaseEngagementDepth } from "./scan-engagement-depth.js";
import { handleTriggerCheck } from "./trigger-check.js";
import { processDrainTick, fetchDrainBatchSimple, type FetchDrainBatch } from "./drain.js";
import { processReapTick } from "./reap.js";
import { processCounterRollover } from "./counter-rollover.js";
import { processPartitionMaintenance } from "./partition-maintenance.js";
import { nullTransportResolver, type TransportResolver } from "./transport.js";

export { fromDrizzle };
export { nullTransportResolver } from "./transport.js";
export type { TransportAdapter, TransportResolver, TransportSendResult, TransportSendParams } from "./transport.js";
export { processDrainTick, fetchDrainBatchSimple } from "./drain.js";
export type { FetchDrainBatch, DrainTickResult, DrainCandidate } from "./drain.js";
export { processReapTick } from "./reap.js";
export type { ReapTickResult } from "./reap.js";
export { processCounterRollover } from "./counter-rollover.js";
export type { CounterRolloverResult } from "./counter-rollover.js";
export { processPartitionMaintenance } from "./partition-maintenance.js";
export type { PartitionMaintenanceResult } from "./partition-maintenance.js";
export const CLAROS_WORKER_VERSION = "0.0.0";

type Db = NodePgDatabase<Record<string, never>>;

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
export async function startWorker(boss: PgBoss, db: Db): Promise<void> {
  // Ensure queue rows exist before any boss.schedule() call can reference them.
  await boss.createQueue(QUEUE.SCAN);
  await boss.createQueue(QUEUE.COMPILE);
  await boss.createQueue(QUEUE.TRIGGER_CHECK);
  await boss.createQueue(QUEUE.DRAIN);
  await boss.createQueue(QUEUE.REAP);
  await boss.createQueue(QUEUE.COUNTER_ROLLOVER);
  await boss.createQueue(QUEUE.PARTITION_MAINTENANCE);

  await boss.work<ScanJobData>(
    QUEUE.SCAN,
    { pollingIntervalSeconds: 5 },
    async (jobs: Job<ScanJobData>[]) => {
      // Scan runs as a single job (cron-triggered, singleton). Process phases
      // sequentially. Phase 1: time transitions. Phase 2: enrollment.
      const now = new Date();

      // Phase 1: time-based lifecycle transitions
      const phase1 = await phaseTimeTransitions(db, now);
      console.log(
        `[scan] time-transitions: ${phase1.tenantsProcessed} tenants, ` +
          `${phase1.contactsEvaluated} contacts evaluated, ` +
          `${phase1.transitionsApplied} transitions applied`,
      );

      // Phase 2: enroll contacts into lifecycle-transition-triggered flows
      // Uses transitions from phase 1 as input (only newly-transitioned contacts).
      if (phase1.appliedTransitions.length > 0) {
        const phase2 = await phaseEnrollment(db, phase1.appliedTransitions, now);
        console.log(
          `[scan] enrollment: ${phase2.transitionsEvaluated} transitions evaluated, ` +
            `${phase2.enrollmentsSucceeded}/${phase2.enrollmentsAttempted} enrollments, ` +
            `${phase2.evictions} evictions`,
        );
      }

      // Phase 3: step advancement and message creation
      const phase3 = await phaseStepAdvancement(db, now);
      console.log(
        `[scan] step-advancement: ${phase3.tenantsProcessed} tenants, ` +
          `${phase3.membershipsEvaluated} memberships evaluated, ` +
          `${phase3.messagesCreated} messages created, ` +
          `${phase3.stepsAdvanced} steps advanced, ` +
          `${phase3.membershipsCompleted} completed, ` +
          `${phase3.membershipsExitedArchived} exited (archived)`,
      );

      // Phase 4: engagement_depth computation for engaged contacts.
      // Runs unconditionally every tick (one aggregate query per tenant).
      // IS DISTINCT FROM in the UPDATE ensures zero writes when nothing changed.
      const phase4 = await phaseEngagementDepth(db, now);
      if (phase4.contactsUpdated > 0) {
        console.log(
          `[scan] engagement-depth: ${phase4.tenantsProcessed} tenants, ` +
            `${phase4.contactsUpdated} contacts updated, ` +
            `${phase4.contactsUnchanged} unchanged`,
        );
      }

      void jobs;
    },
  );

  await boss.work<CompileJobData>(
    QUEUE.COMPILE,
    { pollingIntervalSeconds: 2 },
    async (jobs: Job<CompileJobData>[]) => {
      for (const job of jobs) {
        try {
          await handleCompileJob(job.data, db);
        } catch (err) {
          console.error(`[compile] unhandled error for flow ${job.data.flow_id}:`, err);
          // pg-boss will mark the job as failed and retry per retryLimit config.
          throw err;
        }
      }
    },
  );

  await boss.work<TriggerCheckJobData>(
    QUEUE.TRIGGER_CHECK,
    { pollingIntervalSeconds: 2 },
    async (jobs: Job<TriggerCheckJobData>[]) => {
      for (const job of jobs) {
        try {
          await handleTriggerCheck(job.data, db);
        } catch (err) {
          console.error(
            `[trigger-check] error for contact ${job.data.contact_id}, event "${job.data.event_name}":`,
            err,
          );
          throw err;
        }
      }
    },
  );

  await boss.work<DrainJobData>(
    QUEUE.DRAIN,
    { pollingIntervalSeconds: 5 },
    async (jobs: Job<DrainJobData>[]) => {
      // Drain runs as a single cron-triggered job. Uses the null transport
      // resolver by default (no messages actually send until Phase 4).
      // Cloud overrides via startWorkerWithDrain() passing a real resolver
      // and fairness-aware batch fetcher.
      const now = new Date();
      const result = await processDrainTick(
        db,
        now,
        nullTransportResolver,
        fetchDrainBatchSimple,
      );

      if (result.candidatesFetched > 0) {
        console.log(
          `[drain] tick: ${result.candidatesFetched} candidates, ` +
            `${result.sent} sent, ${result.suppressed} suppressed, ` +
            `${result.deferredFrequency + result.deferredWindow} deferred, ` +
            `${result.skippedNoTransport} no-transport, ` +
            `${result.transportErrors} errors`,
        );
      }

      void jobs;
    },
  );

  await boss.work<ReapJobData>(
    QUEUE.REAP,
    { pollingIntervalSeconds: 5 },
    async (jobs: Job<ReapJobData>[]) => {
      // Reap runs as a single cron-triggered job (every hour).
      // Finds messages stuck in 'sending' or 'generating' for > 2h and
      // either retries them or marks them failed after MAX_RETRY_COUNT.
      const now = new Date();
      const result = await processReapTick(db, now);

      const total =
        result.sendingRetried +
        result.sendingFailed +
        result.generatingRetried +
        result.generatingFailed;

      if (total > 0) {
        console.log(
          `[reap] tick: sending retried=${result.sendingRetried} failed=${result.sendingFailed}, ` +
            `generating retried=${result.generatingRetried} failed=${result.generatingFailed}`,
        );
      }

      void jobs;
    },
  );

  await boss.work<CounterRolloverJobData>(
    QUEUE.COUNTER_ROLLOVER,
    { pollingIntervalSeconds: 5 },
    async (jobs: Job<CounterRolloverJobData>[]) => {
      // Counter rollover runs every 15 min. Only touches contacts whose
      // bucket has aged past 15 days - cheap no-op otherwise.
      const now = new Date();
      const result = await processCounterRollover(db, now);

      if (result.contactsRolled > 0) {
        console.log(`[counter-rollover] tick: ${result.contactsRolled} contacts rolled`);
      }

      void jobs;
    },
  );

  await boss.work<PartitionMaintenanceJobData>(
    QUEUE.PARTITION_MAINTENANCE,
    { pollingIntervalSeconds: 5 },
    async (jobs: Job<PartitionMaintenanceJobData>[]) => {
      // Partition maintenance runs every 15 min. Checks current + next 2
      // months of event partitions exist; creates any missing ones.
      const now = new Date();
      const result = await processPartitionMaintenance(db, now);

      if (result.partitionsCreated.length > 0) {
        console.log(
          `[partition-maintenance] tick: created ${result.partitionsCreated.join(", ")}`,
        );
      }

      void jobs;
    },
  );
}
