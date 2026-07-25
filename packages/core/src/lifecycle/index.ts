/**
 * Lifecycle state machine - public API.
 *
 * Mirror side: PUBLIC (packages/core is mirrored).
 */
export {
  LIFECYCLE_STATES,
  VALID_TRANSITIONS,
  VALID_TRANSITION_MAP,
  assertValidTransition,
  type LifecycleState,
  type TransitionTrigger,
  type TransitionRule,
  type LifecycleConfig,
} from "./states.js";

export {
  evaluateEventTransition,
  evaluateTimeTransition,
  checkActivationSatisfied,
  isActivationRelevantEvent,
  type Transition,
  type EventTransitionInput,
  type TimeTransitionInput,
} from "./evaluate.js";

export {
  LIFECYCLE_DEFAULTS,
  resolveLifecycleConfig,
} from "./constants.js";

export {
  computeMinCohortSize,
  computeRegularThreshold,
  assignEngagementDepth,
  type EngagementDepth,
  type DepthAssignmentInput,
} from "./engagement-depth.js";
