/**
 * Inbound sources on the Integrate page: other systems that send events to Loomail. A generic source reads any JSON
 * POST (you say where the person and the event are in it); a Stripe source turns Stripe's billing events into payment
 * status, plan and events. See ../inbound-sources.ts for the form logic and the API's inbound/mapping.ts for the rules.
 *
 * Mirror side: PUBLIC (apps/dashboard is mirrored).
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Webhook } from "lucide-react";
import {
  createInboundSource,
  deleteInboundSource,
  fetchInboundLog,
  fetchInboundSources,
  rotateInboundToken,
  updateInboundSource,
  type InboundSource,
} from "../api.js";
import {
  LOG_STATUS_LABEL,
  STRIPE_EVENTS_TO_SEND,
  buildGenericConfig,
  emptyGenericForm,
  genericFormFromConfig,
  looksLikeStripeSecret,
  sampleCurl,
  sourceUrl,
  type GenericForm,
} from "../inbound-sources.js";
import { Badge, type BadgeVariant } from "./ui/badge.js";
import { Button } from "./ui/button.js";
import { Input } from "./ui/input.js";
import { Select } from "./ui/select.js";

const QUERY_KEY = ["inbound-sources"] as const;
const origin = () => (typeof window === "undefined" ? "" : window.location.origin);
const when = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const STATUS_VARIANT: Record<string, BadgeVariant> = { processed: "success", ignored: "neutral", rejected: "warning", error: "danger" };

function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        });
      }}
    >
      {done ? "Copied" : label}
    </Button>
  );
}

// ---------------------------------------------------------------------------
// The form
// ---------------------------------------------------------------------------

interface FormProps {
  initial?: InboundSource;
  onCancel: () => void;
  onSaved: (result: { source: InboundSource; token?: string; form?: GenericForm }) => void;
}

function SourceForm({ initial, onCancel, onSaved }: FormProps) {
  const qc = useQueryClient();
  const editing = initial !== undefined;
  const [kind, setKind] = useState<"generic" | "stripe">(initial?.kind ?? "generic");
  const [name, setName] = useState(initial?.name ?? "");
  const [generic, setGeneric] = useState<GenericForm>(initial?.kind === "generic" ? genericFormFromConfig(initial.config) : emptyGenericForm());
  const [metaKey, setMetaKey] = useState(typeof initial?.config.user_id_metadata_key === "string" ? (initial.config.user_id_metadata_key as string) : "user_id");
  const [secret, setSecret] = useState("");
  const [problems, setProblems] = useState<string[]>([]);

  const save = useMutation({
    mutationFn: async () => {
      const issues: string[] = [];
      if (!name.trim()) issues.push("Give the source a name.");
      let config: Record<string, unknown> = { user_id_metadata_key: metaKey.trim() || "user_id" };
      if (kind === "generic") {
        const built = buildGenericConfig(generic);
        if (!built.ok) issues.push(...built.problems);
        else config = built.config;
      } else if (!editing && !looksLikeStripeSecret(secret)) {
        issues.push("Paste the signing secret from Stripe. It starts with whsec_.");
      } else if (editing && secret.trim() !== "" && !looksLikeStripeSecret(secret)) {
        issues.push("That does not look like a Stripe signing secret. It starts with whsec_.");
      }
      if (issues.length > 0) {
        setProblems(issues);
        throw new Error("invalid");
      }
      setProblems([]);
      if (editing) {
        const r = await updateInboundSource(initial.id, { name: name.trim(), config, ...(kind === "stripe" && secret.trim() ? { stripe_signing_secret: secret.trim() } : {}) });
        return { source: r.source, form: generic };
      }
      const r = await createInboundSource({ kind, name: name.trim(), config, ...(kind === "stripe" ? { stripe_signing_secret: secret.trim() } : {}) });
      return { ...r, form: generic };
    },
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: QUERY_KEY });
      onSaved(r);
    },
    onError: (err: Error) => {
      if (err.message !== "invalid") setProblems([err.message]);
    },
  });

  const set = (patch: Partial<GenericForm>) => setGeneric((g) => ({ ...g, ...patch }));

  return (
    <form
      className="mt-4 space-y-4 rounded-md border border-border bg-sunken p-4"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
      aria-label={editing ? "Edit source" : "Add a source"}
    >
      {!editing && (
        <div className="max-w-xs">
          <label className="mb-1 block text-[13px] font-medium text-foreground" htmlFor="source-kind">Type</label>
          <Select id="source-kind" value={kind} onChange={(e) => setKind(e.target.value === "stripe" ? "stripe" : "generic")}>
            <option value="generic">Any JSON webhook (Typeform, Zapier, your own app...)</option>
            <option value="stripe">Stripe</option>
          </Select>
        </div>
      )}
      <div className="max-w-md">
        <label className="mb-1 block text-[13px] font-medium text-foreground" htmlFor="source-name">Name</label>
        <Input id="source-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={kind === "stripe" ? "Stripe" : "Typeform signups"} maxLength={100} />
      </div>

      {kind === "stripe" ? (
        <>
          <ol className="list-decimal space-y-1 pl-5 text-[13px] text-muted-foreground">
            <li>In Stripe, open Developers, then Webhooks, and create an event destination of type Webhook endpoint.</li>
            <li>
              Set the payload to <strong className="text-foreground">Snapshot</strong>, not Thin. Thin events carry no details, so
              Loomail cannot use them.
            </li>
            <li>Select these events: {STRIPE_EVENTS_TO_SEND.map((e) => (<code key={e} className="mx-0.5 rounded bg-card px-1 font-mono text-[12px]">{e}</code>))}</li>
            <li>For the endpoint URL, use the address shown after you save this source.</li>
            <li>Copy the endpoint&apos;s signing secret (starts with whsec_) and paste it below. Test mode and live mode have different secrets, so add one source for each mode you use.</li>
          </ol>
          <div className="max-w-md">
            <label className="mb-1 block text-[13px] font-medium text-foreground" htmlFor="stripe-secret">
              Signing secret{editing && <span className="font-normal text-muted-foreground"> (leave empty to keep the saved one)</span>}
            </label>
            <Input id="stripe-secret" type="password" autoComplete="off" spellCheck={false} value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="whsec_..." />
          </div>
          <div className="max-w-md">
            <label className="mb-1 block text-[13px] font-medium text-foreground" htmlFor="stripe-meta">Metadata key holding your user id</label>
            <Input id="stripe-meta" value={metaKey} onChange={(e) => setMetaKey(e.target.value)} placeholder="user_id" />
            <p className="mt-1 text-[12px] text-muted-foreground">
              If you put your own user id in a Stripe metadata field (on customers, subscriptions or checkout sessions), or in a
              checkout&apos;s client_reference_id, Loomail uses it. Otherwise people are matched by their email.
            </p>
          </div>
        </>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-[13px] font-medium text-foreground" htmlFor="event-mode">The event</label>
              <Select id="event-mode" value={generic.eventMode} onChange={(e) => set({ eventMode: e.target.value as GenericForm["eventMode"] })}>
                <option value="fixed">Always the same name</option>
                <option value="path">Named by a field in the payload</option>
                <option value="none">No event, only set traits</option>
              </Select>
            </div>
            {generic.eventMode !== "none" && (
              <div>
                <label className="mb-1 block text-[13px] font-medium text-foreground" htmlFor="event-value">
                  {generic.eventMode === "fixed" ? "Event name" : "Field holding the event name"}
                </label>
                <Input id="event-value" value={generic.eventValue} onChange={(e) => set({ eventValue: e.target.value })} placeholder={generic.eventMode === "fixed" ? "form_submitted" : "type"} />
              </div>
            )}
            <div>
              <label className="mb-1 block text-[13px] font-medium text-foreground" htmlFor="uid-path">Field holding the user id</label>
              <Input id="uid-path" value={generic.userIdPath} onChange={(e) => set({ userIdPath: e.target.value })} placeholder="data.user.id" />
            </div>
            <div>
              <label className="mb-1 block text-[13px] font-medium text-foreground" htmlFor="email-path">Field holding the email</label>
              <Input id="email-path" value={generic.emailPath} onChange={(e) => set({ emailPath: e.target.value })} placeholder="data.user.email" />
            </div>
          </div>
          <p className="text-[12px] text-muted-foreground">
            A field is written as a path into the JSON, such as <code className="font-mono">data.user.email</code> or{" "}
            <code className="font-mono">items.0.id</code>. Give a user id, an email, or both; with only an email, people are
            matched by it.
          </p>

          <div>
            <p className="mb-1 text-[13px] font-medium text-foreground">Traits to set <span className="font-normal text-muted-foreground">(optional)</span></p>
            {generic.traits.map((t, i) => (
              <div key={i} className="mb-2 flex flex-wrap items-center gap-2">
                <Input
                  aria-label={`Trait ${i + 1} name`}
                  className="w-44"
                  value={t.name}
                  onChange={(e) => set({ traits: generic.traits.map((r, j) => (j === i ? { ...r, name: e.target.value } : r)) })}
                  placeholder="plan"
                />
                <span className="text-[13px] text-muted-foreground">from</span>
                <Input
                  aria-label={`Trait ${i + 1} field`}
                  className="w-56"
                  value={t.path}
                  onChange={(e) => set({ traits: generic.traits.map((r, j) => (j === i ? { ...r, path: e.target.value } : r)) })}
                  placeholder="data.plan"
                />
                <Button type="button" variant="ghost" size="sm" onClick={() => set({ traits: generic.traits.filter((_, j) => j !== i) })}>
                  Remove
                </Button>
              </div>
            ))}
            <Button type="button" variant="outline" size="sm" disabled={generic.traits.length >= 20} onClick={() => set({ traits: [...generic.traits, { name: "", path: "" }] })}>
              <Plus size={14} /> Add a trait
            </Button>
          </div>

          {generic.eventMode !== "none" && (
            <label className="flex items-center gap-2 text-[13px] text-foreground">
              <input type="checkbox" className="h-4 w-4 accent-(--accent-deep)" checked={generic.sendProperties} onChange={(e) => set({ sendProperties: e.target.checked })} />
              Keep the whole payload on the event, so flows and segments can use any of it
            </label>
          )}
        </>
      )}

      {problems.length > 0 && (
        <ul role="alert" className="list-disc space-y-1 pl-5 text-[13px] text-danger">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={save.isPending}>
          {save.isPending ? "Saving..." : editing ? "Save changes" : "Add source"}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={save.isPending}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// What was just created (the token is shown once)
// ---------------------------------------------------------------------------

function Fresh({ source, token, form, onDismiss }: { source: InboundSource; token?: string; form?: GenericForm; onDismiss: () => void }) {
  const url = sourceUrl(origin(), source.id);
  return (
    <div className="mt-4 rounded-md border border-success bg-success-soft p-4" role="status" data-testid="fresh-source">
      <p className="text-[14px] font-medium text-foreground">{source.name} is ready.</p>
      <p className="mt-2 text-[13px] text-foreground">Send to this address:</p>
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <code className="break-all rounded bg-card px-2 py-1 font-mono text-[12px]" data-testid="source-url">{url}</code>
        <CopyButton text={url} />
      </div>
      {token ? (
        <>
          <p className="mt-3 text-[13px] text-foreground">
            With this token, shown only now. Put it in an <code className="font-mono">Authorization: Bearer</code> header, an{" "}
            <code className="font-mono">X-Loomail-Token</code> header, or add <code className="font-mono">?token=</code> to the address:
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <code className="break-all rounded bg-card px-2 py-1 font-mono text-[12px]" data-testid="source-token">{token}</code>
            <CopyButton text={token} />
          </div>
          {form && (
            <details className="mt-3 text-[13px]">
              <summary className="cursor-pointer text-muted-foreground">Try it with curl</summary>
              <pre className="mt-2 overflow-x-auto rounded bg-card p-3 font-mono text-[12px]">{sampleCurl(url, token, form)}</pre>
            </details>
          )}
        </>
      ) : (
        <p className="mt-3 text-[13px] text-foreground">Stripe will sign each call, so there is no token to keep. Finish by adding this address as an endpoint in Stripe.</p>
      )}
      <Button type="button" variant="ghost" size="sm" className="mt-3" onClick={onDismiss}>
        Done
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// One source
// ---------------------------------------------------------------------------

function SourceLog({ id }: { id: string }) {
  const q = useQuery({ queryKey: [...QUERY_KEY, id, "log"], queryFn: () => fetchInboundLog(id), refetchInterval: 15_000 });
  if (q.isLoading) return <p className="mt-2 text-[13px] text-muted-foreground">Loading...</p>;
  if (q.isError) return <p className="mt-2 text-[13px] text-danger" role="alert">Could not load the log.</p>;
  if (!q.data || q.data.log.length === 0) return <p className="mt-2 text-[13px] text-muted-foreground">Nothing received yet.</p>;
  return (
    <ul className="mt-2 space-y-1.5 text-[13px]" data-testid="source-log">
      {q.data.log.map((l) => (
        <li key={l.id} className="flex flex-wrap items-baseline gap-2">
          <span className="whitespace-nowrap text-muted-foreground">{when(l.created_at)}</span>
          <Badge variant={STATUS_VARIANT[l.status] ?? "neutral"}>{LOG_STATUS_LABEL[l.status]}</Badge>
          <span className="text-foreground">{l.summary}</span>
        </li>
      ))}
    </ul>
  );
}

function SourceRow({ source, onEdit, onToken }: { source: InboundSource; onEdit: () => void; onToken: (token: string) => void }) {
  const qc = useQueryClient();
  const [showLog, setShowLog] = useState(false);
  const [confirming, setConfirming] = useState<"delete" | "rotate" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: QUERY_KEY });
  const toggle = useMutation({ mutationFn: () => updateInboundSource(source.id, { enabled: !source.enabled }), onSuccess: refresh, onError: (e: Error) => setError(e.message) });
  const remove = useMutation({ mutationFn: () => deleteInboundSource(source.id), onSuccess: refresh, onError: (e: Error) => setError(e.message) });
  const rotate = useMutation({
    mutationFn: () => rotateInboundToken(source.id),
    onSuccess: (r) => {
      setConfirming(null);
      onToken(r.token);
      void refresh();
    },
    onError: (e: Error) => setError(e.message),
  });
  const url = sourceUrl(origin(), source.id);

  return (
    <li className="rounded-md border border-border bg-card p-4" data-testid={`source-${source.id}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[14px] font-medium text-foreground">{source.name}</span>
        <Badge variant="neutral">{source.kind === "stripe" ? "Stripe" : "JSON webhook"}</Badge>
        {!source.enabled && <Badge variant="warning">Off</Badge>}
        <span className="ml-auto text-[12px] text-muted-foreground">
          {source.last_received_at ? `Last received ${when(source.last_received_at)}` : "Nothing received yet"}
        </span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <code className="break-all rounded bg-sunken px-2 py-1 font-mono text-[12px] text-foreground">{url}</code>
        <CopyButton text={url} label="Copy address" />
        {source.token_prefix && <span className="text-[12px] text-muted-foreground">token {source.token_prefix}...</span>}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" onClick={() => setShowLog((v) => !v)}>
          {showLog ? "Hide log" : "Show log"}
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={onEdit}>Edit</Button>
        <Button type="button" variant="outline" size="sm" disabled={toggle.isPending} onClick={() => toggle.mutate()}>
          {source.enabled ? "Turn off" : "Turn on"}
        </Button>
        {source.kind === "generic" && confirming !== "rotate" && (
          <Button type="button" variant="ghost" size="sm" onClick={() => setConfirming("rotate")}>New token</Button>
        )}
        {confirming === null && (
          <Button type="button" variant="ghost" size="sm" onClick={() => setConfirming("delete")}>Delete</Button>
        )}
        {confirming === "rotate" && (
          <span className="flex items-center gap-2 text-[13px] text-foreground">
            The current token stops working at once.
            <Button type="button" variant="destructive" size="sm" disabled={rotate.isPending} onClick={() => rotate.mutate()}>Make a new token</Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setConfirming(null)}>Cancel</Button>
          </span>
        )}
        {confirming === "delete" && (
          <span className="flex items-center gap-2 text-[13px] text-foreground">
            Delete this source and its log?
            <Button type="button" variant="destructive" size="sm" disabled={remove.isPending} onClick={() => remove.mutate()}>Delete</Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setConfirming(null)}>Cancel</Button>
          </span>
        )}
      </div>
      {error && <p className="mt-2 text-[13px] text-danger" role="alert">{error}</p>}
      {showLog && <SourceLog id={source.id} />}
    </li>
  );
}

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------

export function InboundSourcesCard() {
  const q = useQuery({ queryKey: QUERY_KEY, queryFn: fetchInboundSources });
  const [mode, setMode] = useState<{ kind: "none" } | { kind: "add" } | { kind: "edit"; id: string }>({ kind: "none" });
  const [fresh, setFresh] = useState<{ source: InboundSource; token?: string; form?: GenericForm } | null>(null);
  const sources = q.data?.sources ?? [];
  const editing = mode.kind === "edit" ? sources.find((s) => s.id === mode.id) : undefined;

  return (
    <section className="rounded-lg border border-border bg-card p-6" aria-label="Inbound sources">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-[20px] font-semibold leading-[28px] tracking-[-0.015em] text-foreground">
            <Webhook size={20} strokeWidth={1.5} aria-hidden="true" className="text-accent-text" />
            Connect other tools
          </h2>
          <p className="mt-2 max-w-2xl text-[14px] text-muted-foreground">
            Let Stripe, a form tool, Zapier or your own app send events to Loomail without writing code against the API. Each
            source gets its own address, and a log of what it received.
          </p>
        </div>
        {mode.kind === "none" && (
          <Button size="sm" onClick={() => { setFresh(null); setMode({ kind: "add" }); }}>
            <Plus size={16} strokeWidth={1.5} /> Add a source
          </Button>
        )}
      </div>

      {mode.kind === "add" && (
        <SourceForm
          onCancel={() => setMode({ kind: "none" })}
          onSaved={(r) => {
            setFresh(r);
            setMode({ kind: "none" });
          }}
        />
      )}
      {mode.kind === "edit" && editing && (
        <SourceForm
          initial={editing}
          onCancel={() => setMode({ kind: "none" })}
          onSaved={() => setMode({ kind: "none" })}
        />
      )}
      {fresh && <Fresh {...fresh} onDismiss={() => setFresh(null)} />}

      {q.isLoading && <p className="mt-4 text-[13px] text-muted-foreground">Loading...</p>}
      {q.isError && <p className="mt-4 text-[13px] text-danger" role="alert">Could not load your sources.</p>}
      {q.data && sources.length === 0 && mode.kind === "none" && !fresh && (
        <p className="mt-4 text-[13px] text-muted-foreground">No sources yet. Add one to start receiving events from another tool.</p>
      )}
      {sources.length > 0 && (
        <ul className="mt-4 space-y-3">
          {sources.map((s) => (
            <SourceRow
              key={s.id}
              source={s}
              onEdit={() => { setFresh(null); setMode({ kind: "edit", id: s.id }); }}
              onToken={(token) => setFresh({ source: s, token, form: s.kind === "generic" ? genericFormFromConfig(s.config) : undefined })}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
