/**
 * Platform admin console: AI providers (Mailforge AI).
 *
 * The operator's own AI provider, shared by every workspace that has not saved
 * a key of its own. A primary and an optional fallback (used when the primary
 * fails), each with a kill switch, plus this month's usage and the workspaces
 * using the most.
 *
 * Customers on their own key never touch these providers. Keys are verified
 * with a real call before saving, stored encrypted, and never shown again.
 * Every change needs a written reason and goes in the audit log.
 *
 * Mirror side: PUBLIC (apps/dashboard is mirrored).
 */
import { useState } from "react";
import { Link } from "react-router-dom";
import { PageHeader } from "../../components/page-header.js";
import { Badge } from "../../components/ui/badge.js";
import { Button } from "../../components/ui/button.js";
import { Input } from "../../components/ui/input.js";
import { Select } from "../../components/ui/select.js";
import { Skeleton } from "../../components/ui/skeleton.js";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table.js";
import { ago, formatCost, planLabel, useAdminAi, useAdminAiChange, useAdminAiTest } from "../../admin.js";
import type { AdminAiOverview, AdminAiProvider, AdminAiSlot } from "../../admin-api.js";
import { llmDefaultsFor } from "../../llm-defaults.js";
import { Notice, Section, SummaryItem, SummaryList, errorMessage } from "../settings/shared.js";

const nf = (n: number) => n.toLocaleString("en-US");
const MAX_REASON = 300;

const PROVIDER_LABEL: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  ollama: "Ollama",
  custom: "Custom (OpenAI-compatible)",
};

const SLOT_COPY: Record<AdminAiSlot, { title: string; blurb: string }> = {
  primary: {
    title: "Primary provider",
    blurb: "Used first for every workspace that has no AI key of its own.",
  },
  fallback: {
    title: "Fallback provider",
    blurb: "Optional. Tried automatically when the primary fails: an outage, a rate limit, or a rejected key. Pick a different vendor from the primary so one outage cannot take both down.",
  },
};

const FEATURE_LABEL: Record<string, string> = {
  compile: "Flow compiling",
  content: "Email generation",
  ai_draft: "AI drafting in the editor",
  embedding: "Knowledge-base search",
};

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <p className="text-[13px] text-muted-foreground">{label}</p>
      <p className="mt-1 font-display text-[26px] font-bold leading-[32px] tracking-[-0.02em] text-foreground">{value}</p>
      {hint && <p className="mt-0.5 text-[13px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** The reason box every change asks for. */
function ReasonField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <label className="block">
      <span className="text-[13px] text-muted-foreground">Reason (kept in the audit log)</span>
      <Input value={value} onChange={(e) => onChange(e.target.value)} maxLength={MAX_REASON} placeholder="Why are you doing this?" className="mt-1" />
    </label>
  );
}

/** Add a provider, or change the saved one. A blank key keeps the saved key when the provider is unchanged. */
function ProviderForm({
  slot,
  current,
  onDone,
}: {
  slot: AdminAiSlot;
  current: Extract<AdminAiProvider, { configured: true }> | null;
  onDone: () => void;
}) {
  const change = useAdminAiChange();
  const [provider, setProvider] = useState(current?.provider ?? "openai");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [embeddingModel, setEmbeddingModel] = useState("");
  // Prices as typed: blank keeps the saved price (or leaves it unset on a new provider).
  const [inputPrice, setInputPrice] = useState("");
  const [outputPrice, setOutputPrice] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  const defaults = llmDefaultsFor(provider);
  const isCustom = provider === "custom";
  const keepingKey = current !== null && current.provider === provider && apiKey === "";
  const hasKey = apiKey !== "" || defaults.keyOptional || keepingKey;
  const priceOk = (v: string) => v.trim() === "" || (Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= 1000);
  const ready =
    priceOk(inputPrice) && priceOk(outputPrice) && hasKey && reason.trim().length > 0 && reason.length <= MAX_REASON && (!isCustom || ((baseUrl.trim() !== "" || keepingKey) && (model.trim() !== "" || keepingKey)));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!ready || change.isPending) return;
    setError(null);
    try {
      await change.mutateAsync({
        kind: "save",
        slot,
        input: {
          provider,
          api_key: apiKey,
          base_url: baseUrl.trim() || undefined,
          model: model.trim() || undefined,
          embedding_model: embeddingModel.trim() || undefined,
          input_price: inputPrice.trim() === "" ? undefined : Number(inputPrice),
          output_price: outputPrice.trim() === "" ? undefined : Number(outputPrice),
          reason: reason.trim(),
        },
      });
      setApiKey("");
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  const id = (s: string) => `ai-${slot}-${s}`;
  return (
    <form onSubmit={submit} noValidate className="mt-4 space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label htmlFor={id("provider")} className="mb-1.5 block text-[14px] font-medium text-foreground">Provider</label>
          <Select
            id={id("provider")}
            value={provider}
            onChange={(e) => {
              setProvider(e.target.value);
              setBaseUrl("");
              setModel("");
              setEmbeddingModel("");
            }}
            disabled={change.isPending}
          >
            {Object.entries(PROVIDER_LABEL).map(([v, l]) => (
              <option key={v} value={v}>{l}</option>
            ))}
          </Select>
        </div>
        <div>
          <label htmlFor={id("key")} className="mb-1.5 block text-[14px] font-medium text-foreground">
            API key {keepingKey && <span className="font-normal text-muted-foreground">(blank keeps the saved key)</span>}
          </label>
          <Input id={id("key")} type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} autoComplete="off" disabled={change.isPending} />
        </div>
      </div>
      {isCustom && (
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label htmlFor={id("base")} className="mb-1.5 block text-[14px] font-medium text-foreground">Base URL</label>
            <Input id={id("base")} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://your-endpoint.example.com/v1" disabled={change.isPending} />
          </div>
          <div>
            <label htmlFor={id("model")} className="mb-1.5 block text-[14px] font-medium text-foreground">Model</label>
            <Input id={id("model")} value={model} onChange={(e) => setModel(e.target.value)} disabled={change.isPending} />
          </div>
        </div>
      )}
      {!isCustom && (
        <p className="text-[14px] text-muted-foreground">
          Uses <span className="font-mono text-[13px]">{model.trim() || defaults.model}</span> via{" "}
          <span className="font-mono text-[13px]">{baseUrl.trim() || defaults.baseUrl}</span>.
        </p>
      )}
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label htmlFor={id("pin")} className="mb-1.5 block text-[14px] font-medium text-foreground">Input price ($ per 1M tokens)</label>
          <Input id={id("pin")} inputMode="decimal" value={inputPrice} onChange={(e) => setInputPrice(e.target.value)} placeholder={current?.input_price != null ? `${current.input_price} (saved)` : "e.g. 0.15"} disabled={change.isPending} />
        </div>
        <div>
          <label htmlFor={id("pout")} className="mb-1.5 block text-[14px] font-medium text-foreground">Output price ($ per 1M tokens)</label>
          <Input id={id("pout")} inputMode="decimal" value={outputPrice} onChange={(e) => setOutputPrice(e.target.value)} placeholder={current?.output_price != null ? `${current.output_price} (saved)` : "e.g. 0.60"} disabled={change.isPending} />
        </div>
        <p className="col-span-2 -mt-2 text-[13px] text-muted-foreground">
          Copy these from your provider's price list. They turn tokens into the dollar figures on this page; without them cost shows as $0. Optional.
        </p>
      </div>
      <details className="rounded-md border border-border px-3.5 py-2.5">
        <summary className="cursor-pointer text-[14px] font-medium text-foreground">Advanced</summary>
        <div className="mt-3 grid grid-cols-2 gap-4">
          {!isCustom && (
            <>
              <div>
                <label htmlFor={id("model-adv")} className="mb-1.5 block text-[14px] font-medium text-foreground">Model</label>
                <Input id={id("model-adv")} value={model} onChange={(e) => setModel(e.target.value)} placeholder={defaults.model ?? ""} disabled={change.isPending} />
              </div>
              <div>
                <label htmlFor={id("base-adv")} className="mb-1.5 block text-[14px] font-medium text-foreground">Base URL</label>
                <Input id={id("base-adv")} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder={defaults.baseUrl ?? ""} disabled={change.isPending} />
              </div>
            </>
          )}
          <div>
            <label htmlFor={id("emb")} className="mb-1.5 block text-[14px] font-medium text-foreground">Embedding model</label>
            <Input id={id("emb")} value={embeddingModel} onChange={(e) => setEmbeddingModel(e.target.value)} placeholder={defaults.embeddingModel ?? "none"} disabled={change.isPending} />
            <p className="mt-1 text-[13px] text-muted-foreground">
              Needed for knowledge-base search. A chat-only provider (Anthropic) has none; give one to the provider that does, and search will use it.
            </p>
          </div>
        </div>
      </details>
      <ReasonField value={reason} onChange={setReason} />
      {error && <p className="text-[14px] text-danger" role="alert">{error}</p>}
      <div className="flex gap-3">
        <Button type="submit" disabled={!ready || change.isPending}>
          {change.isPending ? "Verifying..." : current ? "Verify and replace" : "Verify and save"}
        </Button>
        {current && (
          <Button type="button" variant="ghost" onClick={onDone} disabled={change.isPending}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}

/** A small action with its own reason box (switch off/on, remove). */
function ReasonAction({
  label,
  destructive = false,
  onConfirm,
  pending,
  error,
}: {
  label: string;
  destructive?: boolean;
  onConfirm: (reason: string) => void;
  pending: boolean;
  error: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const ready = reason.trim().length > 0 && reason.length <= MAX_REASON;
  if (!open) {
    return (
      <Button type="button" variant={destructive ? "destructive" : "outline"} size="sm" onClick={() => setOpen(true)}>
        {label}
      </Button>
    );
  }
  return (
    <form
      className="w-full space-y-2 rounded-md border border-border bg-sunken p-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready && !pending) onConfirm(reason.trim());
      }}
    >
      <ReasonField value={reason} onChange={setReason} />
      {error && <p className="text-[14px] text-danger" role="alert">{error}</p>}
      <div className="flex gap-2">
        <Button type="submit" size="sm" variant={destructive ? "destructive" : "default"} disabled={!ready || pending}>
          {pending ? "Working..." : label}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** The monthly dollar budget: a hard stop for Mailforge AI, with alerts at 80% and 100%. */
function BudgetCard({ budget }: { budget: AdminAiOverview["budget"] }) {
  const change = useAdminAiChange();
  const [editing, setEditing] = useState(false);
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const n = Number(amount);
  const amountOk = amount.trim() !== "" && Number.isFinite(n) && n > 0 && n <= budget.max_usd;
  const reasonOk = reason.trim().length > 0 && reason.length <= MAX_REASON;
  const set = budget.monthly_usd !== null;
  const pct = set ? Math.min(100, Math.round((budget.spent_usd / budget.monthly_usd!) * 100)) : 0;
  const bar = budget.state === "reached" ? "bg-danger" : budget.state === "near" ? "bg-warning" : "bg-accent";

  async function run(monthlyUsd: number | null) {
    setError(null);
    try {
      await change.mutateAsync({ kind: "budget", monthlyUsd, reason: reason.trim() });
      setEditing(false);
      setAmount("");
      setReason("");
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <Section
      title="Monthly budget"
      description="A hard limit on what Mailforge AI may cost you each calendar month. You are emailed at 80%. At 100% Mailforge AI pauses for every workspace without its own key (nothing is lost; queued work waits). Customers on their own key are never affected."
      configured={null}
      actions={set ? <Badge variant={budget.state === "reached" ? "danger" : budget.state === "near" ? "warning" : "success"}>{budget.state === "reached" ? "paused" : budget.state === "near" ? "nearly used" : "on"}</Badge> : <Badge variant="neutral">no limit</Badge>}
    >
      {set && (
        <div>
          <div className="flex items-baseline justify-between gap-3">
            <p className="text-[14px] text-muted-foreground">Spent this month</p>
            <p className="text-[14px] tabular-nums text-muted-foreground">
              <span className="font-medium text-foreground">{formatCost(budget.spent_usd)}</span> of {formatCost(budget.monthly_usd!)} ({pct}%)
            </p>
          </div>
          <div
            role="progressbar"
            aria-label="Monthly AI budget used"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct}
            className="mt-2 h-2 overflow-hidden rounded-full bg-sunken"
          >
            <div className={`h-full rounded-full ${bar}`} style={{ width: `${pct}%` }} />
          </div>
        </div>
      )}
      {!set && <p className="text-[14px] text-muted-foreground">No budget is set, so Mailforge AI is never paused for cost. Set one to protect yourself from a runaway bill.</p>}

      {!editing ? (
        <div className="mt-4 flex gap-2">
          <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
            {set ? "Change budget" : "Set a monthly budget"}
          </Button>
        </div>
      ) : (
        <form
          className="mt-4 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (amountOk && reasonOk && !change.isPending) void run(n);
          }}
        >
          <label className="block">
            <span className="text-[13px] text-muted-foreground">Monthly budget in US dollars</span>
            <Input type="number" min={0.01} step="any" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="e.g. 200" className="mt-1 w-48" />
          </label>
          <ReasonField value={reason} onChange={setReason} />
          {error && <p className="text-[14px] text-danger" role="alert">{error}</p>}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" disabled={!amountOk || !reasonOk || change.isPending}>
              {change.isPending ? "Saving..." : "Save budget"}
            </Button>
            {set && (
              <Button type="button" size="sm" variant="outline" disabled={!reasonOk || change.isPending} onClick={() => void run(null)}>
                Remove the budget
              </Button>
            )}
            <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)} disabled={change.isPending}>
              Cancel
            </Button>
          </div>
        </form>
      )}
      {budget.state === "reached" && !editing && (
        <p className="mt-3 text-[13px] text-muted-foreground">Raising the budget resumes Mailforge AI immediately.</p>
      )}
    </Section>
  );
}

function SlotCard({ p }: { p: AdminAiProvider }) {
  const copy = SLOT_COPY[p.slot];
  const change = useAdminAiChange();
  const test = useAdminAiTest();
  const [editing, setEditing] = useState(false);
  const [changeError, setChangeError] = useState<string | null>(null);

  async function run(c: Parameters<typeof change.mutateAsync>[0]) {
    setChangeError(null);
    try {
      await change.mutateAsync(c);
    } catch (err) {
      setChangeError(errorMessage(err));
    }
  }

  if (!p.configured) {
    return (
      <Section title={copy.title} description={copy.blurb} configured={false}>
        {editing ? (
          <ProviderForm slot={p.slot} current={null} onDone={() => setEditing(false)} />
        ) : (
          <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
            {p.slot === "primary" ? "Set up the primary provider" : "Add a fallback"}
          </Button>
        )}
      </Section>
    );
  }

  const testResult = test.data;
  return (
    <Section
      title={copy.title}
      description={copy.blurb}
      configured={null}
      actions={<Badge variant={p.enabled ? "success" : "warning"}>{p.enabled ? "on" : "switched off"}</Badge>}
    >
      <SummaryList>
        <SummaryItem label="Provider">{PROVIDER_LABEL[p.provider] ?? p.provider}</SummaryItem>
        <SummaryItem label="Model" mono>{p.model ?? "unreadable"}</SummaryItem>
        <SummaryItem label="Last changed">{p.updated_by ? `${p.updated_by}, ${ago(p.updated_at)}` : ago(p.updated_at)}</SummaryItem>
        {p.base_url && <SummaryItem label="Endpoint" mono span>{p.base_url}</SummaryItem>}
        {p.embedding_model && <SummaryItem label="Embedding model" mono>{p.embedding_model}</SummaryItem>}
        <SummaryItem label="Prices (per 1M tokens)">
          {p.input_price === null && p.output_price === null ? "not set" : `$${p.input_price ?? "?"} in, $${p.output_price ?? "?"} out`}
        </SummaryItem>
      </SummaryList>

      {!p.readable && (
        <Notice className="mt-4">
          The saved key can no longer be read (the encryption key changed). Replace it, or workspaces on Mailforge AI will fail.
        </Notice>
      )}

      {!editing && (
        <div className="mt-4 flex flex-wrap items-start gap-2">
          <Button variant="outline" size="sm" onClick={() => test.mutate(p.slot)} disabled={test.isPending}>
            {test.isPending ? "Testing..." : "Test key"}
          </Button>
          <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
            Change
          </Button>
          <ReasonAction
            label={p.enabled ? "Switch off" : "Switch on"}
            onConfirm={(reason) => void run({ kind: "enabled", slot: p.slot, enabled: !p.enabled, reason })}
            pending={change.isPending}
            error={changeError}
          />
          <ReasonAction
            label="Remove"
            destructive
            onConfirm={(reason) => void run({ kind: "remove", slot: p.slot, reason })}
            pending={change.isPending}
            error={changeError}
          />
        </div>
      )}
      {testResult && !test.isPending && (
        <p className={testResult.ok ? "mt-3 text-[14px] text-success" : "mt-3 text-[14px] text-danger"} role="status">
          {testResult.ok
            ? "The key works: the provider answered a test call."
            : `The provider refused the test call${"status" in testResult && testResult.status ? ` (HTTP ${testResult.status})` : ""}${testResult.detail ? `: ${testResult.detail}` : testResult.error ? `: ${testResult.error}` : "."}`}
        </p>
      )}
      {editing && <ProviderForm slot={p.slot} current={p} onDone={() => setEditing(false)} />}
    </Section>
  );
}

export default function AdminAiPage() {
  const { data, isLoading, isError, error } = useAdminAi();

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Platform"
        title="AI providers"
        subtitle="Mailforge AI: the provider every workspace uses until it adds a key of its own. Workspaces on their own key never use these."
      />

      {isError && <Notice>{errorMessage(error)}</Notice>}
      {isLoading && <Skeleton className="h-48 w-full" />}

      {data?.budget.state === "reached" && (
        <Notice>
          <span className="font-medium">Mailforge AI is paused.</span> It has cost {formatCost(data.budget.spent_usd)} this month and reached your {formatCost(data.budget.monthly_usd ?? 0)} budget. Workspaces
          without their own key cannot use AI until you raise the budget or the month rolls over. Customers on their own key are unaffected.
        </Notice>
      )}
      {data?.budget.state === "near" && (
        <Notice>
          Mailforge AI has cost {formatCost(data.budget.spent_usd)} of your {formatCost(data.budget.monthly_usd ?? 0)} monthly budget. At 100% it pauses.
        </Notice>
      )}
      {data?.health.unhealthy && (
        <Notice>
          <span className="font-medium">Mailforge AI is failing.</span> {nf(data.health.failed)} of {nf(data.health.calls)} calls failed in the last{" "}
          {data.health.window_minutes} minutes ({Math.round(data.health.rate * 100)}%). Workspaces without their own key are affected. Test each key below, and add a
          fallback from a different vendor if you have none. Platform admins are emailed about this.
        </Notice>
      )}
      {data && !data.encryption_configured && (
        <Notice>ENCRYPTION_KEY is not set on this server, so provider keys cannot be stored. Set it first.</Notice>
      )}
      {data && data.encryption_configured && !data.available && (
        <Notice>
          Mailforge AI is off: no provider is switched on. Workspaces without their own key cannot compile flows or use AI drafting.
        </Notice>
      )}

      {data && data.available && data.prices_missing && (
        <Notice variant="info">
          A provider has no prices set, so the dollar figures below undercount. Use Change on the provider to add them.
        </Notice>
      )}

      {data && (
        <>
          {data.providers.map((p) => (
            <SlotCard key={p.slot} p={p} />
          ))}

          <BudgetCard budget={data.budget} />

          <section>
            <h2 className="text-[20px] font-semibold leading-[28px] tracking-[-0.015em] text-foreground">This month</h2>
            <p className="mt-1 text-[14px] text-muted-foreground">
              Tokens spent on Mailforge AI since the 1st (UTC). This is your cost. Calls made with customers' own keys are counted
              separately and cost you nothing.
            </p>
            <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Stat label="Cost this month" value={formatCost(data.usage.platform_cost_usd)} hint="chat calls, from your prices" />
              <Stat label="Mailforge AI tokens" value={nf(data.usage.platform_tokens)} hint={`${nf(data.usage.platform_workspaces)} ${data.usage.platform_workspaces === 1 ? "workspace" : "workspaces"}, ${nf(data.usage.platform_calls)} calls`} />
              <Stat
                label="Failed calls"
                value={nf(data.usage.platform_failed_calls)}
                hint={data.usage.platform_calls > 0 ? `${Math.round((data.usage.platform_failed_calls / data.usage.platform_calls) * 100)}% of calls` : undefined}
              />
              <Stat label="On customers' own keys" value={nf(data.usage.byok_tokens)} hint="not your cost" />
            </div>

            {data.usage.by_feature.length > 0 && (
              <ul className="mt-4 divide-y divide-border rounded-lg border border-border bg-card text-[14px]">
                {data.usage.by_feature.map((f) => (
                  <li key={f.feature} className="flex items-center justify-between px-4 py-2.5">
                    <span className="text-foreground">{FEATURE_LABEL[f.feature] ?? f.feature}</span>
                    <span className="tabular-nums text-muted-foreground">
                      {nf(f.tokens)} tokens, {nf(f.calls)} {f.calls === 1 ? "call" : "calls"}, {formatCost(f.cost_usd)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <h2 className="text-[20px] font-semibold leading-[28px] tracking-[-0.015em] text-foreground">Heaviest workspaces</h2>
            {data.top_workspaces.length === 0 ? (
              <p className="mt-3 text-[14px] text-muted-foreground">No Mailforge AI use yet this month.</p>
            ) : (
              <div className="mt-3 overflow-x-auto rounded-lg border border-border bg-card">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Workspace</TableHead>
                      <TableHead>Plan</TableHead>
                      <TableHead className="text-right">Tokens</TableHead>
                      <TableHead className="text-right">Cost</TableHead>
                      <TableHead className="text-right">Calls</TableHead>
                      <TableHead className="text-right">Failed</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.top_workspaces.map((w) => (
                      <TableRow key={w.id}>
                        <TableCell>
                          <Link to={`/admin/tenants/${w.id}`} className="font-medium text-foreground underline-offset-4 hover:underline">
                            {w.name}
                          </Link>
                        </TableCell>
                        <TableCell>{planLabel(w.plan)}</TableCell>
                        <TableCell className="text-right tabular-nums">{nf(w.tokens)}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatCost(w.cost_usd)}</TableCell>
                        <TableCell className="text-right tabular-nums">{nf(w.calls)}</TableCell>
                        <TableCell className="text-right tabular-nums">{nf(w.failed_calls)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
