/**
 * @loomail/core - Pure logic, no I/O.
 * Contains domain types, state machines, and business rules.
 *
 * Mirror side: PUBLIC (packages/core is mirrored).
 */
export const LOOMAIL_CORE_VERSION = "0.0.0";

/**
 * Maximum hours of clock skew tolerated between a client-supplied event
 * timestamp and the server time at ingestion.
 *
 * The ingest route (packages/api/src/routes/ingest.ts) clamps any
 * client-supplied timestamp to within +/- this many hours of server time.
 * The context-events builder (packages/worker) adds this same value as a
 * slack to the received_at partition-pruning bound so that events whose
 * timestamp is inside a semantic window but whose received_at is slightly
 * earlier (clock running ahead) are never excluded by the pruning filter.
 *
 * Both sides of the system derive from this single source so the values
 * cannot drift independently.
 */
export const INGEST_TIMESTAMP_CLAMP_HOURS = 72;

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
  type ContentGenerationJobData,
  type KbEmbedJobData,
  type AdvanceMembershipJobData,
  type ProcessMessageJobData,
  type DrainMessageJobData,
  type GridSnapshotJobData,
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
  AUDIENCE_MAX_CONDITIONS,
  AUDIENCE_PAYMENT_STATUSES,
  AUDIENCE_ENGAGEMENT_DEPTHS,
  AUDIENCE_TRIGGER_TYPES,
  audienceSchema,
  audienceConditionSchema,
  readAudience,
  stripAudience,
  evaluateAudience,
  audienceConditionHolds,
  type Audience,
  type AudienceCondition,
  type AudienceContact,
  type AudienceResult,
} from "./audience.js";

export {
  SEGMENT_MAX_LEAVES,
  SEGMENT_MAX_GROUP_LEAVES,
  SEGMENT_MAX_EVENT_DAYS,
  SEGMENT_LIFECYCLE_STATES,
  segmentDefinitionSchema,
  segmentGroupSchema,
  segmentLeafSchema,
  isSegmentGroup,
  countSegmentLeaves,
  segmentEventNames,
  savedSegmentTriggerSchema,
  isSavedSegmentTriggerConfig,
  savedSegmentIdOf,
  type SavedSegmentTriggerConfig,
  type SegmentDefinition,
  type SegmentGroup,
  type SegmentLeaf,
  type SegmentRule,
} from "./segment.js";

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
  RETENTION_TENURE_BUCKETS,
  RETENTION_RECENCY_BUCKETS,
  RETENTION_TENURE_THRESHOLDS_DAYS,
  RETENTION_RECENCY_MULTIPLIERS,
  tenureBucket,
  recencyBucket,
  recencyThresholdDays,
  tenureBucketRange,
  recencyBucketRange,
  isSegmentTriggerConfig,
  matchesSegmentTrigger,
  type RetentionTenureBucket,
  type RetentionRecencyBucket,
  type SegmentTriggerConfig,
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
  CONTENT_MODES,
  TEMPLATE_APPROVAL_MODES,
  compiledPlanSchema,
  compiledStepSchema,
  compiledBranchSchema,
  compiledTriggerSchema,
  planExitConditionSchema,
  stepConditionSchema,
  conditionSchema,
  eventConditionSchema,
  conditionShape,
  MAX_CONDITION_LEAVES,
  MAX_CONDITION_DEPTH,
  type Condition,
  type EventCondition,
  type LegacyCondition,
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
  type ContentMode,
  type TemplateApprovalMode,
  type CompiledPlan,
  type CompiledStep,
  type CompiledBranch,
  type CompiledTrigger,
  type PlanExitCondition,
  type StepCondition,
} from "./flow/index.js";

export {
  analyzePlanGraph,
  defaultNext,
  stepTarget,
  isBranchingPlan,
  nodeTargetSchema,
  MAX_PLAN_NODES,
  MAX_BRANCH_DEPTH,
  type NodeTarget,
  type GraphStep,
  type GraphBranch,
  type PlanGraphInput,
} from "./flow/plan-graph.js";

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

export {
  decideOutputSchema,
  draftOutputSchema,
  assessOutputSchema,
  type DecideOutput,
  type DraftOutput,
  type AssessOutput,
} from "./brain.js";

export {
  BUSINESS_MODEL_TEMPLATES,
  BUSINESS_MODEL_TEMPLATE_LIST,
  BUSINESS_MODEL_IDS,
  type BusinessModelId,
  type BusinessModelTemplate,
  type TemplateFlow,
} from "./business-model-templates.js";

export {
  LIBRARY_TEMPLATES,
  LIBRARY_FLOW_WELCOME,
  type LibraryTemplate,
  type LibraryFlow,
  type InstallResult,
} from "./library-flows.js";

export {
  renderTemplate,
  escapeTemplateHtml,
  SUPPORTED_VARIABLE_PREFIXES,
  type TemplateContext,
  type TemplateRenderOutcome,
  type RenderResult,
  type RenderError,
} from "./template-renderer.js";

export {
  flowHealth,
  BOUNCE_ATTENTION_RATE,
  COMPLAINT_ATTENTION_RATE,
  MIN_SENDS_FOR_RATES,
  type FlowHealth,
  type FlowHealthState,
  type FlowHealthInput,
} from "./flow/health.js";

export { LIBRARY_CATALOG, libraryEntry, recommendedLibraryFlow, type LibraryCatalogEntry } from "./library-catalog.js";

export {
  PLAN_IDS,
  PLANS,
  TRIAL_PLAN,
  TRIAL_PLAN_VALUE,
  TRIAL_DAYS,
  TRIAL_MAX_DAYS,
  rebasedTrialEnd,
  isPlanId,
  isPaidPlanId,
  isBillingInterval,
  BILLING_INTERVALS,
  BILLING_GRACE_DAYS,
  planPriceUsd,
  chargeAmountMinor,
  parseUsdRate,
  MAX_USD_RATE,
  addBillingPeriod,
  paymentStatus,
  effectivePlan,
  trialDaysLeft,
  trialEndDate,
  ADDONS,
  ADDON_KINDS,
  MAX_ADDON_PACKS,
  isAddonKind,
  isValidPackCount,
  addonPriceUsd,
  addonUnits,
  addonCheckoutPlan,
  parseAddonCheckoutPlan,
  type AddonKind,
  type AddonDef,
  type BillingInterval,
  type PaidPlanId,
  type PaymentStatus,
  type PlanId,
  type PlanDef,
  type PlanLimits,
} from "./plans.js";

export {
  DEFAULT_SHARED_DAILY_LIMIT,
  RESEND_API_BASE,
  DOMAIN_STATUSES,
  SENDER_HEALTH_WINDOW_DAYS,
  SENDER_HEALTH_MIN_SENT,
  SENDER_COMPLAINT_RATE_PAUSE,
  SENDER_MIN_COMPLAINTS,
  SENDER_HARD_BOUNCE_RATE_PAUSE,
  SENDER_MIN_HARD_BOUNCES,
  SENDER_WARN_FRACTION,
  managedSendingConfigFromEnv,
  isDomainStatus,
  validateSendingDomain,
  validateFromLocalPart,
  sanitizeDisplayName,
  isValidReplyAddress,
  chooseManagedSender,
  senderHealth,
  type ManagedSendingConfig,
  type DomainStatus,
  type DomainCheck,
  type ManagedSenderInput,
  type ManagedSender,
  type SenderHealth,
  type SenderHealthState,
} from "./managed-sending.js";

export {
  LLM_SOURCES,
  LLM_FEATURES,
  PLATFORM_LLM_SLOTS,
  PLATFORM_AI_NAME,
  NO_AI_PROVIDER_MESSAGE,
  isPlatformLlmSlot,
  estimateTokens,
  aiAllowanceSpent,
  aiAllowanceMessage,
  MAX_PRICE_USD_PER_MTOK,
  isValidPriceUsdPerMtok,
  costMicros,
  microsToUsd,
  AI_BUDGET_NEAR_FRACTION,
  MAX_AI_BUDGET_USD,
  isValidAiBudgetUsd,
  aiBudgetState,
  AI_UNAVAILABLE_MESSAGE,
  type AiBudgetState,
  AI_ALERT_WINDOW_MINUTES,
  AI_ALERT_MIN_CALLS,
  AI_ALERT_FAIL_RATE,
  AI_ALERT_COOLDOWN_MINUTES,
  aiHealth,
  shouldSendAiAlert,
  type AiHealth,
  type LlmSource,
  type LlmFeature,
  type PlatformLlmSlot,
} from "./ai.js";

export {
  plansEnforced,
  entitlementsFor,
  limitFor,
  wouldExceed,
  usageFraction,
  startOfMonthUtc,
  startOfNextMonthUtc,
  planLimitMessage,
  assertWithinLimit,
  poweredByFor,
  PlanLimitError,
  type Entitlements,
  type AddonTotals,
  type LimitKind,
} from "./entitlements.js";

export {
  ONBOARDING_STEP_IDS,
  computeOnboarding,
  showOnboardingPanel,
  parseOnboardingPatch,
  nudgeDue,
  waitingReason,
  ONBOARDING_GOALS,
  GOAL_INFO,
  parseGoal,
  MAX_NUDGES,
  NUDGE_AFTER_WELCOME_HOURS,
  NUDGE_MIN_GAP_HOURS,
  type OnboardingStepId,
  type OnboardingFacts,
  type OnboardingState,
  type OnboardingStep,
  type OnboardingProgress,
  type OnboardingPatch,
  type WaitingReason,
  type OnboardingGoal,
  type GoalInfo,
  type WaitingInput,
} from "./onboarding.js";

export {
  wrapInShell,
  wrapInTextShell,
  buildShellComplianceHtml,
  buildShellComplianceText,
  DEFAULT_ACCENT,
  brandLinkStyle,
  type BrandSettings,
  type PoweredBy,
  type EmailShellInput,
  type TextShellInput,
} from "./email-shell.js";
