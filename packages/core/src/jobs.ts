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
