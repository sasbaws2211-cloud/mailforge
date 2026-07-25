/**
 * Job queue contract: queue names and job payload types.
 *
 * Only queues whose handler is implemented belong here. Add a name and its
 * payload type in the same commit as the handler in packages/worker.
 *
 * No pg-boss import; payload types are plain TypeScript.
 * The scheduler (packages/scheduler) and API layer (packages/api) import
 * queue names from here without importing worker logic.
 *
 * Mirror side: PUBLIC (packages/core is mirrored).
 */

// ---------------------------------------------------------------------------
// Queue names
// ---------------------------------------------------------------------------

export const QUEUE = {
  /**
   * Scan contacts for flow eligibility (every 15 min).
   * Payload: empty - handler reads from DB directly.
   * Handler: packages/worker (task 12).
   * Schedule: packages/scheduler, cron "every-15 * * * *".
   */
  SCAN: "claros.scan",

  /**
   * Compile a flow's natural-language prompt into a deterministic execution plan.
   * Payload: flow_id + tenant_id.
   * Handler: packages/worker (task 11).
   * Trigger: POST /v1/flows/:id/compile enqueues on demand.
   * Singleton: singletonKey = flow_id (one compile per flow at a time).
   */
  COMPILE: "claros.compile",

  /**
   * Evaluate event-triggered flows for a single contact after an event is ingested.
   * Payload: tenant_id, contact_id, event_name.
   * Handler: packages/worker (task 12b).
   * Trigger: ingest route enqueues after inserting an event.
   * Latency: seconds (not waiting for the 15-min scan interval).
   */
  TRIGGER_CHECK: "claros.trigger-check",

  /**
   * Drain: pick up approved messages and hand them to transport (every 15 min).
   * Payload: empty - handler queries the database for approved messages.
   * Handler: packages/worker (task 14).
   * Schedule: packages/scheduler, cron at drain_interval_minutes.
   *
   * Dependency: the reap worker (task 15) recovers messages stuck at 'sending'
   * after transport errors.
   */
  DRAIN: "claros.drain",

  /**
   * Reap: recover messages stuck in 'sending' or 'generating' (every hour).
   * Payload: empty - handler queries the database for stuck messages.
   * Handler: packages/worker (task 15).
   * Schedule: packages/scheduler, cron "0 * * * *" (top of every hour).
   *
   * A message is stuck when its updated_at is older than REAP_STUCK_THRESHOLD_HOURS (2h)
   * and its status has not advanced. Recovery:
   *   - 'sending' stuck > 2h: reset to 'approved', increment retry_count.
   *   - 'generating' stuck > 2h: reset to 'pending_generation', increment retry_count.
   *   - retry_count >= MAX_RETRY_COUNT (3): set to 'failed' (terminal).
   */
  REAP: "claros.reap",

  /**
   * Counter rollover: rotate engagement depth buckets (every scan tick, 15 min).
   * The handler rolls over contacts whose last_counter_reset_at is older than
   * 15 days: bucket_prev = bucket_current, bucket_current = 0, reset timestamp.
   * Payload: empty - handler queries contacts by last_counter_reset_at.
   * Handler: packages/worker (task 14.5).
   * Schedule: packages/scheduler, cron every 15 min (piggybacks on scan interval).
   */
  COUNTER_ROLLOVER: "claros.counter-rollover",

  /**
   * Partition maintenance: ensure future monthly partitions exist for the events table.
   * Checks whether next month's partition exists; creates it if missing.
   * Payload: empty.
   * Handler: packages/worker (task 14.5).
   * Schedule: packages/scheduler, cron every 15 min (frequent + idempotent).
   */
  PARTITION_MAINTENANCE: "claros.partition-maintenance",
} as const;

export type QueueName = (typeof QUEUE)[keyof typeof QUEUE];

// ---------------------------------------------------------------------------
// Job payload types
// ---------------------------------------------------------------------------

/**
 * SCAN job: no payload. The worker queries the database for eligible contacts.
 * Cron-triggered; the scheduler sends an empty object every 15 minutes.
 */
export type ScanJobData = Record<string, never>;

/**
 * COMPILE job: identifies which flow to compile and the owning tenant.
 * Enqueued by the API on POST /v1/flows/:id/compile.
 */
export interface CompileJobData {
  flow_id: string;
  tenant_id: string;
}

/**
 * TRIGGER_CHECK job: evaluate event-triggered flows for one contact.
 * Enqueued by the ingest route after inserting a track event.
 */
export interface TriggerCheckJobData {
  tenant_id: string;
  contact_id: string;
  event_name: string;
}

/**
 * DRAIN job: no payload. The worker queries the database for approved messages.
 * Cron-triggered; the scheduler sends an empty object at drain_interval_minutes.
 *
 * NOTE: After task 14, the drain sends nothing in any real deployment. The
 * transport resolver returns null until Phase 4 builds real adapters (tasks 26-28).
 * Messages that pass the throttle gate remain at 'approved' and are re-evaluated
 * each tick. "Drain implemented" means scheduling, batch selection, throttle
 * evaluation, and transport seam are wired - not "email works."
 */
export type DrainJobData = Record<string, never>;

/**
 * REAP job: no payload. The worker queries the database for stuck messages.
 * Cron-triggered; the scheduler sends an empty object every REAP_INTERVAL_MINUTES (60).
 */
export type ReapJobData = Record<string, never>;

/**
 * COUNTER_ROLLOVER job: no payload. The worker rotates engagement counter
 * buckets for contacts whose current bucket has aged past 15 days.
 */
export type CounterRolloverJobData = Record<string, never>;

/**
 * PARTITION_MAINTENANCE job: no payload. The worker checks that next month's
 * partition exists on the events table and creates it if missing.
 */
export type PartitionMaintenanceJobData = Record<string, never>;
