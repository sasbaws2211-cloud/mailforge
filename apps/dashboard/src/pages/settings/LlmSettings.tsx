/**
 * Settings / AI provider.
 *
 * A workspace's AI comes from one of two places:
 *   - Mailforge AI: the operator's provider, included in the plan, nothing to
 *     set up, counted against a monthly token allowance
 *   - the customer's own key: used instead whenever one is saved, never capped
 *     here, billed by their provider
 *
 * The GET endpoint never returns a key, so this screen shows what is in use and
 * lets a key be added, replaced or removed, never what it is. Without either,
 * every flow compile returns 422.
 *
 * Mirror side: PUBLIC (apps/dashboard is mirrored).
 */
import React, { useState } from "react";
import { useSetupState, usePutLlm, useDeleteLlm } from "../../settings.js";
import { Button } from "../../components/ui/button.js";
import { Input } from "../../components/ui/input.js";
import { Select } from "../../components/ui/select.js";
import { Skeleton } from "../../components/ui/skeleton.js";
import { llmDefaultsFor } from "../../llm-defaults.js";
import { aiMeterState, aiPercent, describeAi, resetDay, tokens } from "../../ai.js";
import { cn } from "../../lib/utils.js";
import type { LlmAiInfo } from "../../api.js";
import { Section, FormError, Notice, SummaryList, SummaryItem, errorMessage, formatDate } from "./shared.js";

const LLM_PROVIDERS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "openai", label: "OpenAI" },
  { value: "anthropic", label: "Anthropic" },
  { value: "ollama", label: "Ollama" },
  { value: "custom", label: "Custom (OpenAI-compatible)" },
];

/** The Mailforge AI allowance as a bar. Only shown for a workspace on Mailforge AI with a cap. */
function AllowanceMeter({ ai }: { ai: LlmAiInfo }) {
  const { limit, used, resets_at } = ai.allowance;
  if (limit === null) return null;
  const state = aiMeterState(limit, used);
  const bar = state === "near" ? "bg-warning" : state === "at_limit" || state === "over" ? "bg-danger" : "bg-accent";
  return (
    <div className="mt-4">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-[14px] font-medium text-foreground">Mailforge AI tokens this month</h3>
        <p className="text-[14px] tabular-nums text-muted-foreground">
          <span className="font-medium text-foreground">{tokens(used)}</span> of {tokens(limit)}
        </p>
      </div>
      <div
        role="progressbar"
        aria-label="Mailforge AI tokens this month"
        aria-valuemin={0}
        aria-valuemax={limit}
        aria-valuenow={Math.min(used, limit)}
        aria-valuetext={`${tokens(used)} of ${tokens(limit)}`}
        className="mt-2 h-2 overflow-hidden rounded-full bg-sunken"
      >
        <div className={cn("h-full rounded-full transition-[width]", bar)} style={{ width: `${aiPercent(limit, used)}%` }} />
      </div>
      <p className="mt-1.5 text-[13px] text-muted-foreground">Resets on {resetDay(resets_at)}.</p>
    </div>
  );
}

export default function LlmSettings() {
  const { llm, ai, isLoading } = useSetupState();
  const put = usePutLlm();
  const del = useDeleteLlm();
  const [open, setOpen] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [provider, setProvider] = useState("openai");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [embeddingModel, setEmbeddingModel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [removedNote, setRemovedNote] = useState<string | null>(null);

  if (isLoading) return <Skeleton className="h-40 w-full" />;

  const defaults = llmDefaultsFor(provider);
  const isCustom = provider === "custom";
  const effectiveModel = model.trim() || defaults.model;
  const effectiveBaseUrl = baseUrl.trim() || defaults.baseUrl;
  const onPlatform = llm === null && ai !== null && ai.source === "platform";
  const summary = ai ? describeAi(ai) : null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await put.mutateAsync({
        provider,
        api_key: apiKey,
        base_url: baseUrl.trim() === "" ? undefined : baseUrl.trim(),
        model: model.trim() === "" ? undefined : model.trim(),
        embedding_model: embeddingModel.trim() === "" ? undefined : embeddingModel.trim(),
      });
      setOpen(false);
      setSaved(true);
      setRemovedNote(null);
      setApiKey("");
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function handleRemove() {
    setError(null);
    try {
      const r = await del.mutateAsync();
      setConfirmRemove(false);
      setSaved(false);
      setRemovedNote(
        r.ai.source === "platform"
          ? "Your key was removed. This workspace now uses Mailforge AI."
          : "Your key was removed. AI drafting and compiling are off until you add a key.",
      );
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  // The form shows while the person is adding or replacing a key, or when there is nothing else to use.
  const noAiAtAll = llm === null && !onPlatform;
  const formVisible = open || noAiAtAll;
  const canSubmit =
    (apiKey !== "" || defaults.keyOptional) &&
    (!isCustom || (effectiveBaseUrl !== null && effectiveModel !== null));

  return (
    <Section
      title="AI provider"
      description="Used for AI drafting, flow compiling and knowledge-base search."
      configured={llm !== null || onPlatform}
      actions={
        !formVisible && llm ? (
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => { setOpen(true); setSaved(false); setRemovedNote(null); }}>
              Replace
            </Button>
            <Button variant="ghost" size="sm" onClick={() => { setConfirmRemove(true); setSaved(false); }}>
              Remove my key
            </Button>
          </div>
        ) : undefined
      }
    >
      {!formVisible && llm && (
        <>
          <SummaryList>
            <SummaryItem label="Provider">
              {LLM_PROVIDERS.find((p) => p.value === llm.provider)?.label ?? llm.provider}
            </SummaryItem>
            <SummaryItem label="Model" mono>{llm.model ?? "default"}</SummaryItem>
            <SummaryItem label="Configured">{formatDate(llm.created_at)}</SummaryItem>
            {llm.base_url && (
              <SummaryItem label="Endpoint" mono span>{llm.base_url}</SummaryItem>
            )}
            {llm.embedding_model && (
              <SummaryItem label="Embedding model" mono>{llm.embedding_model}</SummaryItem>
            )}
          </SummaryList>
          <p className="mt-4 text-[13px] text-muted-foreground">
            Drafts and compiles run on your own provider and are billed by them, so no Mailforge AI allowance is used.
            The key is stored encrypted and never displayed.
          </p>
        </>
      )}

      {confirmRemove && llm && (
        <div className="mt-4 rounded-md border border-border bg-sunken px-4 py-3" role="group" aria-label="Remove your key">
          <p className="text-[14px] text-foreground">
            Remove your key? This workspace will use Mailforge AI instead, within your plan's monthly allowance, if it is available.
            Otherwise AI drafting and compiling stop until you add a key.
          </p>
          <div className="mt-3 flex gap-2">
            <Button variant="destructive" size="sm" onClick={() => void handleRemove()} disabled={del.isPending}>
              {del.isPending ? "Removing..." : "Remove key"}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setConfirmRemove(false)} disabled={del.isPending}>
              Keep it
            </Button>
          </div>
        </div>
      )}

      {onPlatform && ai && summary && !formVisible && (
        <>
          <Notice variant={summary.tone === "warning" ? "warning" : "info"}>
            <span className="font-medium">{summary.heading}.</span> {summary.body}
          </Notice>
          {summary.showMeter && <AllowanceMeter ai={ai} />}
          <div className="mt-5 flex flex-wrap items-center gap-3">
            <Button variant="outline" size="sm" onClick={() => { setOpen(true); setSaved(false); setRemovedNote(null); }}>
              Use my own key instead
            </Button>
            <p className="text-[13px] text-muted-foreground">
              With your own key there is no monthly cap here; your provider bills you directly.
            </p>
          </div>
        </>
      )}

      {saved && !formVisible && (
        <p className="mt-3 text-[13px] text-success" role="status">
          Saved. The key was verified with the provider before storing.
        </p>
      )}
      {removedNote && (
        <p className="mt-3 text-[13px] text-success" role="status">
          {removedNote}
        </p>
      )}
      {noAiAtAll && (
        <Notice className="mb-4">
          Without an AI provider every flow compile returns 422. Nothing in
          the product can draft or compile until this is set.
        </Notice>
      )}
      {formVisible && (
        <form onSubmit={handleSubmit} noValidate className="mt-2 space-y-4">
          {onPlatform && (
            <p className="text-[14px] text-muted-foreground">
              Add your own provider key. Once it is saved, this workspace uses it instead of Mailforge AI.
            </p>
          )}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label htmlFor="llm-provider" className="mb-1.5 block text-[14px] font-medium text-foreground">
                Provider
              </label>
              <Select
                id="llm-provider"
                value={provider}
                onChange={(e) => { setProvider(e.target.value); setBaseUrl(""); setModel(""); setEmbeddingModel(""); }}
                disabled={put.isPending}
              >
                {LLM_PROVIDERS.map((p) => (
                  <option key={p.value} value={p.value}>{p.label}</option>
                ))}
              </Select>
            </div>
            <div>
              <label htmlFor="llm-api-key" className="mb-1.5 block text-[14px] font-medium text-foreground">
                API key{" "}
                {defaults.keyOptional ? (
                  <span className="font-normal text-muted-foreground">(optional for a local install)</span>
                ) : (
                  <span className="text-danger" aria-hidden="true">*</span>
                )}
              </label>
              <Input id="llm-api-key" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} autoComplete="off" disabled={put.isPending} required={!defaults.keyOptional} />
            </div>
          </div>
          {isCustom && (
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label htmlFor="llm-base-url" className="mb-1.5 block text-[14px] font-medium text-foreground">
                  Base URL <span className="text-danger" aria-hidden="true">*</span>
                </label>
                <Input id="llm-base-url" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://your-endpoint.example.com/v1" disabled={put.isPending} required />
              </div>
              <div>
                <label htmlFor="llm-model" className="mb-1.5 block text-[14px] font-medium text-foreground">
                  Model <span className="text-danger" aria-hidden="true">*</span>
                </label>
                <Input id="llm-model" value={model} onChange={(e) => setModel(e.target.value)} disabled={put.isPending} required />
              </div>
            </div>
          )}
          {!isCustom && effectiveModel !== null && effectiveBaseUrl !== null && (
            <p className="text-[14px] text-muted-foreground">
              Mailforge will use <span className="font-mono text-[13px]">{effectiveModel}</span>
              {" via "}
              <span className="font-mono text-[13px]">{effectiveBaseUrl}</span>.
            </p>
          )}
          <details className="rounded-md border border-border px-3.5 py-2.5">
            <summary className="cursor-pointer text-[14px] font-medium text-foreground">
              Advanced
            </summary>
            <p className="mt-2 text-[14px] text-muted-foreground">
              The defaults work for almost everyone. Only change these if you
              know why.
            </p>
            <div className="mt-3 grid grid-cols-2 gap-4">
              {!isCustom && (
                <>
                  <div>
                    <label htmlFor="llm-model-adv" className="mb-1.5 block text-[14px] font-medium text-foreground">
                      Model
                    </label>
                    <Input
                      id="llm-model-adv"
                      value={model}
                      onChange={(e) => setModel(e.target.value)}
                      placeholder={defaults.model ?? ""}
                      disabled={put.isPending}
                    />
                  </div>
                  <div>
                    <label htmlFor="llm-base-url-adv" className="mb-1.5 block text-[14px] font-medium text-foreground">
                      Base URL
                    </label>
                    <Input
                      id="llm-base-url-adv"
                      value={baseUrl}
                      onChange={(e) => setBaseUrl(e.target.value)}
                      placeholder={defaults.baseUrl ?? ""}
                      disabled={put.isPending}
                    />
                  </div>
                </>
              )}
              <div>
                <label htmlFor="llm-embedding-model" className="mb-1.5 block text-[14px] font-medium text-foreground">
                  Embedding model
                </label>
                <Input
                  id="llm-embedding-model"
                  value={embeddingModel}
                  onChange={(e) => setEmbeddingModel(e.target.value)}
                  placeholder={defaults.embeddingModel ?? "text-embedding-3-small"}
                  disabled={put.isPending}
                />
                <p className="mt-1 text-[13px] text-muted-foreground">
                  Used for knowledge base search. Must produce 1536-dimension vectors.
                </p>
              </div>
            </div>
          </details>
          <FormError message={error} />
          <div className="flex items-center gap-3 pt-1">
            <Button type="submit" disabled={put.isPending || !canSubmit}>
              {put.isPending ? "Verifying..." : llm === null ? "Verify and save" : "Verify and replace"}
            </Button>
            {(llm !== null || onPlatform) && (
              <Button type="button" variant="ghost" disabled={put.isPending} onClick={() => setOpen(false)}>
                Cancel
              </Button>
            )}
          </div>
        </form>
      )}
      {!formVisible && <FormError message={error} />}
    </Section>
  );
}
