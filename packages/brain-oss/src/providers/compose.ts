/**
 * Provider composition: metering and failover around OpenAICompatibleProvider.
 *
 * brain-oss knows nothing about tenants, databases or encryption. It receives
 * already-loaded candidate configs (still encrypted), a decrypt function and a
 * usage callback, and hands back one LlmProvider:
 *
 *   - every candidate is wrapped so each call reports its token usage
 *     (MeteredProvider), and
 *   - when there is more than one candidate (the operator's primary and
 *     fallback), they are chained so a failing primary falls through to the
 *     fallback (FailoverProvider).
 *
 * Mirror side: PUBLIC (packages/brain-oss is mirrored).
 */
import { costMicros, estimateTokens, type LlmSource, type PlatformLlmSlot } from "@mailforge/core";
import { LlmProviderError, OpenAICompatibleProvider } from "./openai-compatible.js";
import type { CompletionOptions, CompletionResult, LlmProvider, LlmProviderConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Metering
// ---------------------------------------------------------------------------

/** What one call used, as reported to the usage callback. */
export interface ProviderUsageEvent {
  ok: boolean;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/** Which provider a usage event belongs to. */
export interface ProviderUsageMeta {
  source: LlmSource;
  slot: PlatformLlmSlot | null;
  provider: string;
  model: string;
}

/**
 * Reports every call's token usage. When the provider does not report usage
 * (some compatible endpoints omit it) the count is estimated from text length,
 * so an allowance cannot be dodged by a provider that stays silent. A callback
 * that throws never fails the call it measures.
 */
export class MeteredProvider implements LlmProvider {
  constructor(
    private readonly inner: LlmProvider,
    private readonly onUsage: (event: ProviderUsageEvent) => void | Promise<void>,
  ) {}

  async complete(opts: CompletionOptions): Promise<CompletionResult> {
    let result: CompletionResult;
    try {
      result = await this.inner.complete(opts);
    } catch (err) {
      await this.report({ ok: false, promptTokens: 0, completionTokens: 0, totalTokens: 0 });
      throw err;
    }
    const reported = result.usage;
    const prompt = reported?.prompt_tokens ?? estimateTokens(opts.messages.map((m) => m.content).join(""));
    const completion = reported?.completion_tokens ?? estimateTokens(result.content);
    const total = reported?.total_tokens ?? prompt + completion;
    await this.report({ ok: true, promptTokens: prompt, completionTokens: completion, totalTokens: total });
    return result;
  }

  private async report(event: ProviderUsageEvent): Promise<void> {
    try {
      await this.onUsage(event);
    } catch {
      // Metering is best effort.
    }
  }
}

// ---------------------------------------------------------------------------
// Failover
// ---------------------------------------------------------------------------

/**
 * Should the next provider be tried after this error? Yes for anything that is
 * the provider's or its key's fault: no answer, an unusable answer, rate limit,
 * outage, rejected key, no credit, forbidden, unknown model. No for 400, which
 * says the request itself is wrong and a second provider would only repeat it.
 */
export function isFailoverError(err: unknown): boolean {
  if (!(err instanceof LlmProviderError)) return true;
  const s = err.statusCode;
  if (s === null) return true;
  return s === 429 || s >= 500 || s === 401 || s === 402 || s === 403 || s === 404;
}

/** Tries each provider in order until one answers. */
export class FailoverProvider implements LlmProvider {
  constructor(
    private readonly providers: readonly LlmProvider[],
    private readonly onFailover?: (failedIndex: number, err: unknown) => void,
  ) {
    if (providers.length === 0) throw new Error("FailoverProvider needs at least one provider.");
  }

  async complete(opts: CompletionOptions): Promise<CompletionResult> {
    let lastErr: unknown;
    for (let i = 0; i < this.providers.length; i++) {
      try {
        return await this.providers[i]!.complete(opts);
      } catch (err) {
        lastErr = err;
        if (i === this.providers.length - 1 || !isFailoverError(err)) throw err;
        this.onFailover?.(i, err);
      }
    }
    throw lastErr;
  }
}

// ---------------------------------------------------------------------------
// Building the provider for a workspace
// ---------------------------------------------------------------------------

/** A stored provider config, still encrypted. Same shape as @mailforge/db/llm LlmCandidate. */
export interface ProviderCandidate {
  source: LlmSource;
  slot: PlatformLlmSlot | null;
  provider: string;
  config: string;
}

export interface BuildProviderOptions {
  /** Decrypts a stored config; throws if it cannot. */
  decrypt: (encrypted: string) => string;
  /** Called after every AI call made through the returned provider. */
  onUsage?: (meta: ProviderUsageMeta, event: ProviderUsageEvent & { costMicros: number }) => void | Promise<void>;
  /** Called when a platform provider failed and the next one is being tried. */
  onFailover?: (meta: ProviderUsageMeta, err: unknown) => void;
}

export type BuildProviderResult =
  | { ok: true; provider: LlmProvider; source: LlmSource; usable: number }
  | { ok: false; reason: string };

/**
 * Decrypt each candidate, wrap it with metering and chain them with failover.
 * A candidate that cannot be decrypted is skipped; when none can be used the
 * result is a failure with the first reason, so a broken own key is reported
 * as such.
 */
export function buildProviderFromCandidates(
  candidates: readonly ProviderCandidate[],
  opts: BuildProviderOptions,
): BuildProviderResult {
  const built: Array<{ provider: LlmProvider; meta: ProviderUsageMeta }> = [];
  let firstReason: string | null = null;

  for (const c of candidates) {
    let config: LlmProviderConfig;
    try {
      config = JSON.parse(opts.decrypt(c.config)) as LlmProviderConfig;
    } catch (err) {
      firstReason ??= `Failed to decrypt LLM configuration: ${err instanceof Error ? err.message : String(err)}`;
      continue;
    }
    const meta: ProviderUsageMeta = { source: c.source, slot: c.slot, provider: c.provider, model: config.model };
    const leaf = new OpenAICompatibleProvider(config);
    const onUsage = opts.onUsage;
    built.push({
      meta,
      provider: onUsage
        ? new MeteredProvider(leaf, (event) =>
            onUsage(meta, {
              ...event,
              // Only the operator's provider costs the operator anything; a customer's own key is theirs to pay for.
              costMicros:
                meta.source === "platform"
                  ? costMicros(event.promptTokens, event.completionTokens, config.input_price, config.output_price)
                  : 0,
            }),
          )
        : leaf,
    });
  }

  if (built.length === 0) {
    return { ok: false, reason: firstReason ?? "No usable LLM configuration." };
  }
  const source = built[0]!.meta.source;
  if (built.length === 1) return { ok: true, provider: built[0]!.provider, source, usable: 1 };
  const failover = opts.onFailover;
  return {
    ok: true,
    source,
    usable: built.length,
    provider: new FailoverProvider(
      built.map((b) => b.provider),
      failover ? (i, err) => failover(built[i]!.meta, err) : undefined,
    ),
  };
}
