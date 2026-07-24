/**
 * @claros/core - Pure logic, no I/O.
 * Contains domain types, state machines, and business rules.
 *
 * Mirror side: PUBLIC (packages/core is mirrored).
 */
export const CLAROS_CORE_VERSION = "0.0.0";

export {
  QUEUE,
  type QueueName,
  type ScanJobData,
} from "./jobs.js";
