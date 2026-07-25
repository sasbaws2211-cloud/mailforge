/**
 * @claros/brain-oss - Brain interface and community implementation.
 * Provides the Brain contract that brain-cloud also implements.
 *
 * Exports:
 *   - Brain interface (decide + draft) - task 17 (stubs for now)
 *   - compile() - task 11 (flow prompt -> deterministic plan)
 *   - LLM provider interface + OpenAI-compatible implementation
 *   - Prompt builders for compile/decide/draft
 *
 * Mirror side: PUBLIC (packages/brain-oss is mirrored).
 */

// ---------------------------------------------------------------------------
// Brain interface (decide + draft - task 17, stubs for now)
// ---------------------------------------------------------------------------

/** Configuration for Brain initialization */
export interface BrainConfig {
  llmApiKey?: string;
  llmBaseUrl?: string;
  llmModel?: string;
}

/** Decision result from the Brain */
export interface BrainDecision {
  action: string;
  confidence: number;
  reasoning?: string;
}

/** Draft result from the Brain */
export interface BrainDraft {
  subject: string;
  body: string;
  metadata?: Record<string, unknown>;
}

/** The Brain interface - implemented by both OSS and Cloud editions */
export interface Brain {
  decide(context: Record<string, unknown>): Promise<BrainDecision>;
  draft(context: Record<string, unknown>): Promise<BrainDraft>;
}

/** Create the community Brain implementation (BYO LLM key) */
export function createOssBrain(_cfg: BrainConfig): Brain {
  return {
    async decide(_context) {
      // Placeholder - will use BYO LLM key with working prompts (task 17)
      return { action: "noop", confidence: 0 };
    },
    async draft(_context) {
      // Placeholder - will use BYO LLM key with working prompts (task 17)
      return { subject: "", body: "" };
    },
  };
}

// ---------------------------------------------------------------------------
// Flow compilation (task 11)
// ---------------------------------------------------------------------------

export { compile, type CompileResult, type CompileSuccess, type CompileFailure } from "./compile.js";

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
