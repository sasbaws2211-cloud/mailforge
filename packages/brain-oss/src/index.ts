/**
 * @claros/brain-oss - Brain interface and community implementation.
 * Provides the Brain contract that brain-cloud also implements.
 *
 * Exports:
 *   - Brain interface (decide + draft) - task 17
 *   - compile() - task 11 (flow prompt -> deterministic plan)
 *   - LLM provider interface + OpenAI-compatible implementation
 *   - Prompt builders for compile/decide/draft
 *   - Zod output schemas for decide and draft (task 17.1)
 *
 * Mirror side: PUBLIC (packages/brain-oss is mirrored).
 */

// ---------------------------------------------------------------------------
// Brain context types (decide + draft - task 17)
// ---------------------------------------------------------------------------

/**
 * Context passed to brain.decide().
 * Carries the information the Brain needs to make a send/skip/wait decision
 * for a specific contact at a specific flow step. Populated by the context
 * packet builder (task 18). Empty at this slice - placeholder for now.
 */
export interface DecideContext {
  [key: string]: unknown;
}

/**
 * Context passed to brain.draft().
 * Carries the information the Brain needs to generate email content.
 * Populated by the context packet builder (task 18). Empty at this slice.
 */
export interface DraftContext {
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Brain output types (decide + draft - task 17)
// ---------------------------------------------------------------------------

/**
 * Decision result from brain.decide().
 *
 * action: the send/no-send verdict.
 *   - "contact": proceed - draft the email and queue for approval.
 *   - "skip": do not send - record reasoning and mark message as skipped.
 *   - "wait": treat as skip for this slice (task 17 impl decision 3).
 *
 * confidence: advisory value only. Must not appear in any branch condition.
 * If present, callers record it in brain_reasoning for observability only.
 *
 * reasoning: optional human-readable explanation, stored in brain_reasoning.
 */
export interface BrainDecision {
  action: "contact" | "skip" | "wait";
  confidence?: number;
  reasoning?: string;
}

/**
 * Draft result from brain.draft().
 *
 * The Brain produces text only. The deterministic side renders markdown to
 * body_html and derives body_text at write time (task 17 impl decision 1).
 */
export interface BrainDraft {
  subject: string;
  body_markdown: string;
}

// ---------------------------------------------------------------------------
// Brain interface
// ---------------------------------------------------------------------------

/** Configuration for Brain initialization */
export interface BrainConfig {
  llmApiKey?: string;
  llmBaseUrl?: string;
  llmModel?: string;
}

/** The Brain interface - implemented by both OSS and Cloud editions */
export interface Brain {
  decide(context: DecideContext): Promise<BrainDecision>;
  draft(context: DraftContext): Promise<BrainDraft>;
}

// ---------------------------------------------------------------------------
// Community Brain implementation (BYO LLM key)
// ---------------------------------------------------------------------------

/** Create the community Brain implementation (BYO LLM key) */
export function createOssBrain(_cfg: BrainConfig): Brain {
  return {
    async decide(_context) {
      // Stub - returns skip so no email is sent until real prompts are wired (task 17).
      return { action: "skip", reasoning: "stub: Brain prompts not yet wired" };
    },
    async draft(_context) {
      // Stub - real implementation wired in task 17.
      return { subject: "", body_markdown: "" };
    },
  };
}

// ---------------------------------------------------------------------------
// Zod output schemas for decide and draft (task 17.1)
// ---------------------------------------------------------------------------

export {
  decideOutputSchema,
  draftOutputSchema,
  assessOutputSchema,
  type DecideOutput,
  type DraftOutput,
  type AssessOutput,
} from "@claros/core";

// ---------------------------------------------------------------------------
// Flow compilation (task 11)
// ---------------------------------------------------------------------------

export { compile, type CompileResult, type CompileSuccess, type CompileFailure } from "./compile.js";

// ---------------------------------------------------------------------------
// Brain decide (task 17)
// ---------------------------------------------------------------------------

export {
  decide,
  DECISION_TEMPERATURE,
  type DecideResult,
  type DecideSuccess,
  type DecideFailure,
} from "./decide.js";

// ---------------------------------------------------------------------------
// Email content drafting (task 17)
// ---------------------------------------------------------------------------

export { draft, DRAFT_TEMPERATURE, type DraftResult, type DraftSuccess, type DraftFailure } from "./draft.js";

// ---------------------------------------------------------------------------
// LLM providers
// ---------------------------------------------------------------------------

export type {
  ChatMessage,
  CompletionOptions,
  CompletionResult,
  LlmProvider,
  LlmProviderConfig,
} from "./providers/index.js";

export {
  OpenAICompatibleProvider,
  LlmProviderError,
} from "./providers/index.js";

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

export { buildCompileMessages, type CompilePromptContext } from "./prompts/compile.js";
export { buildDecideMessages, type DecidePromptContext } from "./prompts/decide.js";
export { buildDraftMessages, type DraftPromptContext } from "./prompts/draft.js";
export { buildAssessMessages, type AssessPromptContext } from "./prompts/assess.js";

// ---------------------------------------------------------------------------
// Brain value gate (task 20, slice 20.1)
// ---------------------------------------------------------------------------

export {
  assess,
  ASSESS_TEMPERATURE,
  type AssessResult,
  type AssessSuccess,
  type AssessFailure,
} from "./assess.js";
