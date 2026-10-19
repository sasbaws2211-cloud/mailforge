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
  PAYSTACK_EVENTS,
  PAYSTACK_IPS,
  SOURCE_KIND_LABEL,
  STRIPE_EVENTS_TO_SEND,
  addressWithToken,
  buildGenericConfig,
  emptyGenericForm,
  genericFormFromConfig,
  looksLikePaystackKey,
  looksLikeStripeSecret,
  sampleCurl,
  sourceUrl,
  type GenericForm,
} from "../inbound-sources.js";
import { PRESET_GROUPS, TOOL_PRESETS, presetById } from "../inbound-presets.js";
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

/** Exported for tests. */
export function SourceForm({ initial, onCancel, onSaved }: FormProps) {
  const qc = useQueryClient();
  const editing = initial !== undefined;
  const [kind, setKind] = useState<InboundSource["kind"]>(initial?.kind ?? "generic");
  const [name, setName] = useState(initial?.name ?? "");
  const [generic, setGeneric] = useState<GenericForm>(initial?.kind === "generic" ? genericFormFromConfig(initial.config) : emptyGenericForm());
  const [metaKey, setMetaKey] = useState(typeof initial?.config.user_id_metadata_key === "string" ? (initial.config.user_id_metadata_key as string) : "user_id");
  const [secret, setSecret] = useState("");
  const [verification, setVerification] = useState<"token" | "signature">(initial?.config.verification === "signature" ? "signature" : "token");
  const [ipCheck, setIpCheck] = useState(initial?.config.require_paystack_ip === true);
  const [problems, setProblems] = useState<string[]>([]);
  /** A ready-made tool (Typeform, Tally...) chosen for a new generic source. */
  const [presetId, setPresetId] = useState<string>("");
  /** The secret the sender signs with, for a source that checks signatures. */
  const [signingSecret, setSigningSecret] = useState("");
  const preset = presetId ? presetById(presetId) : undefined;

  /** The type selector holds one value: a kind, or `tool:<id>` for a ready-made tool. */
  const chooseType = (value: string) => {
    if (value.startsWith("tool:")) {
      const chosen = presetById(value.slice(5));
      if (!chosen) return;
      setKind("generic");
      setPresetId(chosen.id);
      setGeneric({ ...emptyGenericForm(), ...chosen.form });
      if (!name.trim() || TOOL_PRESETS.some((p) => p.label === name)) setName(chosen.label);
      return;
    }
    setPresetId("");
    if (preset && TOOL_PRESETS.some((p) => p.label === name)) setName("");
    if (preset) setGeneric(emptyGenericForm());
    setKind(value as InboundSource["kind"]);
  };

  const save = useMutation({
    mutationFn: async () => {
      const issues: string[] = [];
      if (!name.trim()) issues.push("Give the source a name.");
      let config: Record<string, unknown> = { user_id_metadata_key: metaKey.trim() || "user_id" };
      if (kind === "generic") {
        const built = buildGenericConfig(generic);
        if (!built.ok) issues.push(...built.problems);
        else config = built.config;
        if (generic.verification === "signature" && !editing && !signingSecret.trim()) issues.push("Paste the signing secret the other tool signs its calls with.");
      } else if (kind === "stripe") {
        if (!editing && !looksLikeStripeSecret(secret)) issues.push("Paste the signing secret from Stripe. It starts with whsec_.");
        else if (editing && secret.trim() !== "" && !looksLikeStripeSecret(secret)) issues.push("That does not look like a Stripe signing secret. It starts with whsec_.");
      } else if (kind === "paystack") {
        config = { ...config, verification, require_paystack_ip: ipCheck };
        const needsKey = verification === "signature";
        if (needsKey && !editing && !looksLikePaystackKey(secret)) issues.push("Paste your Paystack secret key. It starts with sk_test_ or sk_live_.");
        else if (needsKey && editing && secret.trim() !== "" && !looksLikePaystackKey(secret)) issues.push("That does not look like a Paystack secret key. It starts with sk_test_ or sk_live_.");
      }
      if (issues.length > 0) {
        setProblems(issues);
        throw new Error("invalid");
      }
      setProblems([]);
      const secrets = {
        ...(kind === "generic" && generic.verification === "signature" && signingSecret.trim() ? { signing_secret: signingSecret.trim() } : {}),
        ...(kind === "stripe" && secret.trim() ? { stripe_signing_secret: secret.trim() } : {}),
        ...(kind === "paystack" && verification === "signature" && secret.trim() ? { paystack_secret_key: secret.trim() } : {}),
      };
      if (editing) {
        const r = await updateInboundSource(initial.id, { name: name.trim(), config, ...secrets });
        return { source: r.source, form: generic };
      }
      const r = await createInboundSource({ kind, name: name.trim(), config, ...secrets });
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
          <Select id="source-kind" value={preset ? `tool:${preset.id}` : kind} onChange={(e) => chooseType(e.target.value)}>
            <option value="generic">Any JSON webhook (Zapier, Make, your own app...)</option>
            {PRESET_GROUPS.map((group) => (
              <optgroup key={group} label={group}>
                {TOOL_PRESETS.filter((t) => t.group === group).map((t) => (
                  <option key={t.id} value={`tool:${t.id}`}>{t.label}</option>
                ))}
              </optgroup>
            ))}
            <optgroup label="Payments and subscriptions">
              <option value="stripe">Stripe</option>
            </optgroup>
            {/* Paystack and Flutterwave are hidden from new sources for now. Existing ones still work and can be edited
                (this dropdown only shows when adding). To bring them back, add:
                <option value="paystack">Paystack</option>
                <option value="flutterwave">Flutterwave</option> */}
          </Select>
        </div>
      )}
      <div className="max-w-md">
        <label className="mb-1 block text-[13px] font-medium text-foreground" htmlFor="source-name">Name</label>
        <Input id="source-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={kind === "generic" ? "Typeform signups" : SOURCE_KIND_LABEL[kind]} maxLength={100} />
      </div>

      {kind === "paystack" ? (
        <>
          <ol className="list-decimal space-y-1 pl-5 text-[13px] text-muted-foreground">
            <li>Choose how Loomail checks that a call really comes from Paystack (below).</li>
            <li>Save this source, then copy the address it shows.</li>
            <li>In Paystack, open Settings, then API Keys &amp; Webhooks, and paste the address as the webhook URL (Paystack has one for test mode and one for live mode, so add a source for each).</li>
            <li>Paystack sends: {PAYSTACK_EVENTS.map((e) => (<code key={e} className="mx-0.5 rounded bg-card px-1 font-mono text-[12px]">{e}</code>))} Loomail uses these and ignores the rest.</li>
          </ol>
          <div className="max-w-xl">
            <label className="mb-1 block text-[13px] font-medium text-foreground" htmlFor="ps-verification">How to check calls</label>
            <Select id="ps-verification" value={verification} disabled={editing} onChange={(e) => setVerification(e.target.value === "signature" ? "signature" : "token")}>
              <option value="token">A secret in the address (Loomail holds no Paystack key)</option>
              <option value="signature">Paystack&apos;s signature (you give Loomail your secret key)</option>
            </Select>
            <p className="mt-1 text-[12px] text-muted-foreground">
              {verification === "token"
                ? "The address Loomail gives you contains a secret token. Anyone with the address could send events, so keep it private. Nothing sensitive is stored."
                : "Paystack signs every call with your secret key, so Loomail needs that key to check it. It is stored encrypted and never shown again, but it is the key that can move money: use this only if you are comfortable with that."}
              {editing && " This cannot be changed after the source is made."}
            </p>
          </div>
          {verification === "signature" && (
            <div className="max-w-md">
              <label className="mb-1 block text-[13px] font-medium text-foreground" htmlFor="ps-key">
                Paystack secret key{editing && <span className="font-normal text-muted-foreground"> (leave empty to keep the saved one)</span>}
              </label>
              <Input id="ps-key" type="password" autoComplete="off" spellCheck={false} value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="sk_live_..." />
            </div>
          )}
          <label className="flex items-start gap-2 text-[13px] text-foreground">
            <input type="checkbox" className="mt-0.5 h-4 w-4 accent-(--accent-deep)" checked={ipCheck} onChange={(e) => setIpCheck(e.target.checked)} />
            <span>
              Also accept calls only from Paystack&apos;s published addresses ({PAYSTACK_IPS.join(", ")}). Only turn this on if
              Loomail can see the real sender address (not behind a proxy that hides it), or every call will be refused.
            </span>
          </label>
          <div className="max-w-md">
            <label className="mb-1 block text-[13px] font-medium text-foreground" htmlFor="ps-meta">Metadata key holding your user id</label>
            <Input id="ps-meta" value={metaKey} onChange={(e) => setMetaKey(e.target.value)} placeholder="user_id" />
            <p className="mt-1 text-[12px] text-muted-foreground">
              If you pass your own user id in the metadata when you start a Paystack payment, Loomail uses it. Otherwise people are
              matched by email, and by the Paystack customer code once it has been seen.
            </p>
          </div>
        </>
      ) : kind === "flutterwave" ? (
        <>
          <ol className="list-decimal space-y-1 pl-5 text-[13px] text-muted-foreground">
            <li>Save this source. Loomail then shows an address and a secret hash.</li>
            <li>In Flutterwave, open Settings, then Webhooks. Paste the address as the URL and the secret hash as the secret hash, and turn on webhook retries.</li>
            <li>Loomail uses <code className="rounded bg-card px-1 font-mono text-[12px]">charge.completed</code> (successful and failed payments) and <code className="rounded bg-card px-1 font-mono text-[12px]">subscription.cancelled</code>, and ignores the rest.</li>
          </ol>
          <p className="max-w-2xl text-[12px] text-muted-foreground">
            Flutterwave does not tell Loomail when a subscription starts or renews, and a charge does not say which plan it was for.
            So a successful payment marks someone as paid and a cancellation marks them cancelled, but there is no plan name or
            &quot;past due&quot; status from Flutterwave. A failed payment is recorded as an event only. Amounts are in whole units (100 means 100 NGN).
          </p>
          <div className="max-w-md">
            <label className="mb-1 block text-[13px] font-medium text-foreground" htmlFor="fw-meta">Key in a charge&apos;s meta holding your user id</label>
            <Input id="fw-meta" value={metaKey} onChange={(e) => setMetaKey(e.target.value)} placeholder="user_id" />
            <p className="mt-1 text-[12px] text-muted-foreground">If you send your own user id in the charge&apos;s meta, Loomail uses it. Otherwise people are matched by email.</p>
          </div>
        </>
      ) : kind === "stripe" ? (
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
          {preset && !editing && (
            <div className="rounded-md border border-border bg-card p-3" data-testid="tool-steps">
              <p className="text-[13px] font-medium text-foreground">{preset.summary}</p>
              <ol className="mt-2 list-decimal space-y-1 pl-5 text-[13px] text-muted-foreground">
                {preset.steps.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
              {preset.note && <p className="mt-2 text-[12px] text-muted-foreground">{preset.note}</p>}
              <p className="mt-2 text-[12px] text-muted-foreground">
                {preset.confidence === "docs"
                  ? "The settings below follow the tool's own documentation. You can change them."
                  : "The settings below follow the tool's documentation, but a full example of what it sends was not available. Send a test and read this source's log; change the fields below if something is not found."}
              </p>
            </div>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-[13px] font-medium text-foreground" htmlFor="event-mode">The event</label>
              <Select id="event-mode" value={generic.eventMode} onChange={(e) => set({ eventMode: e.target.value as GenericForm["eventMode"] })}>
                <option value="fixed">Always the same name</option>
                <option value="path">Named by a field in the payload</option>
                <option value="header">Named by a request header (Shopify, WooCommerce...)</option>
                <option value="none">No event, only set traits</option>
              </Select>
            </div>
            {generic.eventMode !== "none" && (
              <div>
                <label className="mb-1 block text-[13px] font-medium text-foreground" htmlFor="event-value">
                  {generic.eventMode === "fixed" ? "Event name" : generic.eventMode === "header" ? "Header holding the event name" : "Field holding the event name"}
                </label>
                <Input id="event-value" value={generic.eventValue} onChange={(e) => set({ eventValue: e.target.value })} placeholder={generic.eventMode === "fixed" ? "form_submitted" : generic.eventMode === "header" ? "X-Topic" : "type"} />
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
            {generic.eventMode !== "none" && (
              <div className="sm:col-span-2">
                <label className="mb-1 block text-[13px] font-medium text-foreground" htmlFor="event-id-path">
                  Field holding the sender&apos;s own id for the event <span className="font-normal text-muted-foreground">(optional)</span>
                </label>
                <div className="grid gap-2 sm:grid-cols-2">
                  <Input id="event-id-path" value={generic.eventIdPath} onChange={(e) => set({ eventIdPath: e.target.value })} placeholder="event_id" aria-label="Field holding the sender's event id" />
                  <Input id="event-id-header" value={generic.eventIdHeader} onChange={(e) => set({ eventIdHeader: e.target.value })} placeholder="or a header, such as X-Shopify-Event-Id" aria-label="Header holding the sender's event id" />
                </div>
                <p className="mt-1 text-[12px] text-muted-foreground">
                  If the sender retries a delivery, the same id is recorded once. Typeform sends <code className="font-mono">event_id</code>. Senders
                  that can set headers can send <code className="font-mono">X-Loomail-Event-Id</code> instead.
                </p>
              </div>
            )}
          </div>
          <p className="text-[12px] text-muted-foreground">
            A field is written as a path into the JSON, such as <code className="font-mono">data.user.email</code> or{" "}
            <code className="font-mono">items.0.id</code>. To pick an item from a list by what it is rather than where it is, search
            it: <code className="font-mono">answers[type=email].email</code> finds the answer whose type is email, even when
            a skipped question moves the others. Give a user id, an email, or both; with only an email, people are matched by it.
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

      {kind === "generic" && (
        <div className="rounded-md border border-border bg-card p-3" data-testid="verification">
          <label className="mb-1 block text-[13px] font-medium text-foreground" htmlFor="verification">How Loomail checks that a call is genuine</label>
          {editing ? (
            <p className="text-[13px] text-muted-foreground">
              {generic.verification === "signature" ? "By the sender's signature." : "By the token in the address or header."} This cannot be changed after the source is made.
            </p>
          ) : (
            <Select
              id="verification"
              value={generic.verification}
              onChange={(e) => {
                const mode = e.target.value as GenericForm["verification"];
                const sig = preset?.signature;
                set(mode === "signature" && sig ? { verification: mode, signatureHeader: sig.header, signatureEncoding: sig.encoding, signaturePrefix: sig.prefix ?? "" } : { verification: mode });
              }}
            >
              <option value="token">A token Loomail makes (in the address or a header)</option>
              <option value="signature">The sender&apos;s own signature (you paste the shared signing secret)</option>
            </Select>
          )}
          {generic.verification === "signature" && (
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              {!editing && (
                <>
                  <div>
                    <label className="mb-1 block text-[13px] font-medium text-foreground" htmlFor="sig-header">Header carrying the signature</label>
                    <Input id="sig-header" value={generic.signatureHeader} onChange={(e) => set({ signatureHeader: e.target.value })} placeholder="X-Hub-Signature-256" />
                  </div>
                  <div>
                    <label className="mb-1 block text-[13px] font-medium text-foreground" htmlFor="sig-encoding">Written as</label>
                    <Select id="sig-encoding" value={generic.signatureEncoding} onChange={(e) => set({ signatureEncoding: e.target.value as GenericForm["signatureEncoding"] })}>
                      <option value="either">Hex or base64 (either)</option>
                      <option value="hex">Hex</option>
                      <option value="base64">Base64</option>
                    </Select>
                  </div>
                  <div>
                    <label className="mb-1 block text-[13px] font-medium text-foreground" htmlFor="sig-prefix">Text before the signature (optional)</label>
                    <Input id="sig-prefix" value={generic.signaturePrefix} onChange={(e) => set({ signaturePrefix: e.target.value })} placeholder="sha256=" />
                  </div>
                </>
              )}
              <div className="sm:col-span-2">
                <label className="mb-1 block text-[13px] font-medium text-foreground" htmlFor="sig-secret">
                  Signing secret{editing && <span className="font-normal text-muted-foreground"> (leave empty to keep the saved one)</span>}
                </label>
                <Input id="sig-secret" type="password" autoComplete="new-password" value={signingSecret} onChange={(e) => setSigningSecret(e.target.value)} />
                <p className="mt-1 text-[12px] text-muted-foreground">
                  {preset?.signature?.secretHint ?? "The secret the sender signs each call with. It is stored encrypted and never shown again."} Loomail checks an
                  HMAC-SHA256 of the exact request body. No token is made, so the address can be shared with the tool as it is.
                </p>
              </div>
            </div>
          )}
        </div>
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
  // Paystack sets no headers, so its token rides in the address; Flutterwave sends the secret hash as a header.
  const paystackUrl = source.kind === "paystack" && token ? addressWithToken(url, token) : null;
  return (
    <div className="mt-4 rounded-md border border-success bg-success-soft p-4" role="status" data-testid="fresh-source">
      <p className="text-[14px] font-medium text-foreground">{source.name} is ready.</p>
      <p className="mt-2 text-[13px] text-foreground">{paystackUrl ? "Give Paystack this address, token included (keep it private):" : "Send to this address:"}</p>
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <code className="break-all rounded bg-card px-2 py-1 font-mono text-[12px]" data-testid="source-url">{paystackUrl ?? url}</code>
        <CopyButton text={paystackUrl ?? url} />
      </div>
      {source.kind === "flutterwave" && token ? (
        <>
          <p className="mt-3 text-[13px] text-foreground">
            And this secret hash, shown only now. Paste it as the secret hash in Flutterwave&apos;s webhook settings; Flutterwave sends it back in
            the <code className="font-mono">verif-hash</code> header of every call:
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <code className="break-all rounded bg-card px-2 py-1 font-mono text-[12px]" data-testid="source-token">{token}</code>
            <CopyButton text={token} />
          </div>
        </>
      ) : paystackUrl ? (
        <p className="mt-3 text-[13px] text-foreground">
          The token is part of that address and is shown only now. Paste it into Paystack under Settings, API Keys &amp; Webhooks. Paystack
          has a separate webhook URL for test mode and live mode.
          <span className="sr-only" data-testid="source-token">{token}</span>
        </p>
      ) : token ? (
        <>
          <p className="mt-3 text-[13px] text-foreground">
            With this token, shown only now. Put it in an <code className="font-mono">Authorization: Bearer</code> header, an{" "}
            <code className="font-mono">X-Loomail-Token</code> header, or add <code className="font-mono">?token=</code> to the address:
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <code className="break-all rounded bg-card px-2 py-1 font-mono text-[12px]" data-testid="source-token">{token}</code>
            <CopyButton text={token} />
          </div>
          <p className="mt-3 text-[13px] text-foreground">
            For tools that cannot set a header (Typeform, Webflow, Cal.com, Gumroad, Shopify and others), give them this address instead, token
            included. Keep it private:
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <code className="break-all rounded bg-card px-2 py-1 font-mono text-[12px]" data-testid="source-url-with-token">{addressWithToken(url, token)}</code>
            <CopyButton text={addressWithToken(url, token)} />
          </div>
          {form && (
            <details className="mt-3 text-[13px]">
              <summary className="cursor-pointer text-muted-foreground">Try it with curl</summary>
              <pre className="mt-2 overflow-x-auto rounded bg-card p-3 font-mono text-[12px]">{sampleCurl(url, token, form)}</pre>
            </details>
          )}
        </>
      ) : (
        <p className="mt-3 text-[13px] text-foreground">
          {source.kind === "generic"
            ? "Calls are checked by the sender's signature, so there is no token to keep. Give the other tool this address and the same signing secret you pasted here."
            : source.kind === "paystack"
              ? "Paystack will sign each call with your secret key, so there is no token to keep. Finish by pasting this address as the webhook URL in Paystack."
              : "Stripe will sign each call, so there is no token to keep. Finish by adding this address as an endpoint in Stripe."}
        </p>
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
        <Badge variant="neutral">{SOURCE_KIND_LABEL[source.kind]}</Badge>
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
        {source.token_prefix && confirming !== "rotate" && (
          <Button type="button" variant="ghost" size="sm" onClick={() => setConfirming("rotate")}>{source.kind === "flutterwave" ? "New secret hash" : "New token"}</Button>
        )}
        {confirming === null && (
          <Button type="button" variant="ghost" size="sm" onClick={() => setConfirming("delete")}>Delete</Button>
        )}
        {confirming === "rotate" && (
          <span className="flex items-center gap-2 text-[13px] text-foreground">
            {source.kind === "flutterwave" ? "The current secret hash stops working at once, until you update it in Flutterwave." : source.kind === "paystack" ? "The current address stops working at once, until you update it in Paystack." : "The current token stops working at once."}
            <Button type="button" variant="destructive" size="sm" disabled={rotate.isPending} onClick={() => rotate.mutate()}>{source.kind === "flutterwave" ? "Make a new secret hash" : "Make a new token"}</Button>
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
