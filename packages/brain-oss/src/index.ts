/**
 * @claros/brain-oss - Brain interface and community implementation.
 * Provides the Brain contract that brain-cloud also implements.
 */

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
      // Placeholder - will use BYO LLM key with working prompts
      return { action: "noop", confidence: 0 };
    },
    async draft(_context) {
      // Placeholder - will use BYO LLM key with working prompts
      return { subject: "", body: "" };
    },
  };
}
