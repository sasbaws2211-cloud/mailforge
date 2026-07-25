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
  type CompileJobData,
  type TriggerCheckJobData,
  type DrainJobData,
  type ReapJobData,
  type CounterRolloverJobData,
  type PartitionMaintenanceJobData,
} from "./jobs.js";

export {
  matchesLifecycleTransition,
  matchesEventTrigger,
  sortByPriority,
  isReentryAllowed,
  contactEnrollmentLockKey,
  dedupLockKey,
  type LifecycleTransitionTriggerConfig,
  type EventTriggerConfig,
  type EnrollableFlow,
  type PriorMembership,
} from "./enrollment.js";

export {
  LIFECYCLE_STATES,
  VALID_TRANSITIONS,
  VALID_TRANSITION_MAP,
  assertValidTransition,
  evaluateEventTransition,
  evaluateTimeTransition,
  checkActivationSatisfied,
  isActivationRelevantEvent,
  LIFECYCLE_DEFAULTS,
  resolveLifecycleConfig,
  computeMinCohortSize,
  computeRegularThreshold,
  assignEngagementDepth,
  type LifecycleState,
  type TransitionTrigger,
  type TransitionRule,
  type LifecycleConfig,
  type Transition,
  type EventTransitionInput,
  type TimeTransitionInput,
  type EngagementDepth,
  type DepthAssignmentInput,
} from "./lifecycle/index.js";

export {
  parseDelay,
  delayToMs,
  isValidDelay,
  validateStatusTransition,
  FLOW_TRIGGER_TYPES,
  FLOW_STATUSES,
  FLOW_STATUS_TRANSITIONS,
  FLOW_CLASSES,
  REENTRY_POLICIES,
  FLOW_SOURCES,
  APPROVAL_MODES,
  compiledPlanSchema,
  compiledStepSchema,
  compiledTriggerSchema,
  planExitConditionSchema,
  stepConditionSchema,
  type FlowDelay,
  type ParsedDelay,
  type FlowStep,
  type FlowTriggerType,
  type FlowStatus,
  type StatusTransitionRule,
  type FlowClass,
  type ReentryPolicy,
  type FlowSource,
  type ApprovalMode,
  type CompiledPlan,
  type CompiledStep,
  type CompiledTrigger,
  type PlanExitCondition,
  type StepCondition,
} from "./flow/index.js";

export {
  THROTTLE_DEFAULTS,
  resolveThrottleConfig,
  throttleConfigSchema,
  evaluateThrottleGate,
  resolveTimezone,
  isValidTimezone,
  type ThrottleConfig,
  type ThrottleGateInput,
  type ThrottleVerdict,
} from "./throttle/index.js";
