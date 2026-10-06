/**
 * Settings / Mailforge Sending: let Mailforge send your email for you.
 *
 * No email provider to set up. Email goes out from a shared Mailforge address straight
 * away (at a modest daily volume), and from your own domain once its DNS records are
 * added and verified, which is better for delivery and has no extra daily cap. If the
 * workspace connects a provider of its own, that is used instead and this waits.
 *
 * Mirror side: PUBLIC (apps/dashboard is mirrored).
 */
import React, { useState } from "react";
import { Badge } from "../../components/ui/badge.js";
import { Button } from "../../components/ui/button.js";
import { Input } from "../../components/ui/input.js";
import { Skeleton } from "../../components/ui/skeleton.js";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table.js";
import { useMe } from "../../auth.js";
import { domainStatusInfo, describeSender, recordFullName, recordPurpose, sendingApi, useSending, useSendingChange } from "../../sending.js";
import type { SendingDnsRecord } from "../../api.js";
import { FormError, Notice, Section, errorMessage } from "./shared.js";

/** A value with a copy button: DNS values are long and easy to mistype. */
function Copyable({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="inline-flex items-start gap-2">
      <code className="break-all font-mono text-[12.5px] text-foreground">{value}</code>
      <button
        type="button"
        className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[12px] text-muted-foreground hover:bg-secondary hover:text-foreground"
        aria-label={`Copy ${label}`}
        onClick={() => {
          try {
            void navigator.clipboard.writeText(value).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          } catch {
            // No clipboard access: the value is still selectable.
          }
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </span>
  );
}

function DnsTable({ domain, records }: { domain: string; records: SendingDnsRecord[] }) {
  if (records.length === 0) return null;
  return (
    <div className="mt-3 overflow-x-auto rounded-md border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Type</TableHead>
            <TableHead>Name (host)</TableHead>
            <TableHead>Value</TableHead>
            <TableHead>What it does</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {records.map((r, i) => (
            <TableRow key={`${r.type}-${r.name}-${i}`}>
              <TableCell className="whitespace-nowrap font-medium">
                {r.type}
                {r.priority !== undefined && <span className="ml-1 text-[12px] text-muted-foreground">priority {r.priority}</span>}
              </TableCell>
              <TableCell>
                <Copyable value={r.name} label={`${r.type} name`} />
                <div className="mt-1 text-[12px] text-muted-foreground">Full name: {recordFullName(r, domain)}</div>
              </TableCell>
              <TableCell>
                <Copyable value={r.value} label={`${r.type} value`} />
              </TableCell>
              <TableCell className="text-[13px] text-muted-foreground">
                {recordPurpose(r)}
                {r.status === "verified" && <Badge variant="success" className="ml-2">ok</Badge>}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

export default function ManagedSendingSettings() {
  const { data: view, isLoading } = useSending();
  const { data: me } = useMe();
  const isOwner = me?.user.role === "owner";
  const enable = useSendingChange(sendingApi.enable);
  const disable = useSendingChange(sendingApi.disable);
  const setDomain = useSendingChange(sendingApi.setDomain);
  const verify = useSendingChange(sendingApi.verify);
  const removeDomain = useSendingChange(sendingApi.removeDomain);
  const patch = useSendingChange(sendingApi.patch);

  const [domain, setDomainText] = useState("");
  const [local, setLocal] = useState("");
  const [name, setName] = useState<string | null>(null);
  const [fromLocal, setFromLocal] = useState<string | null>(null);
  const [reply, setReply] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [confirmOff, setConfirmOff] = useState(false);

  if (isLoading) return <Skeleton className="h-40 w-full" />;
  // Not offered on this service (a self-hosted install): nothing to show.
  if (!view || !view.available) return null;

  const m = view.managed;
  const summary = describeSender(view);
  const busy = enable.isPending || disable.isPending || setDomain.isPending || verify.isPending || removeDomain.isPending || patch.isPending;
  const on = m !== null && m.enabled;
  const ownTransport = view.uses === "own_transport";

  async function run<T>(fn: () => Promise<T>, after?: () => void) {
    setError(null);
    setSaved(false);
    try {
      await fn();
      after?.();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  const status = m && m.domain ? domainStatusInfo(m.domain_status) : null;

  return (
    <Section
      title="Mailforge Sending"
      description="Let Mailforge send your email for you. Nothing to connect: there is no email provider to sign up for."
      configured={null}
      actions={<Badge variant={view.uses === "managed" ? "success" : m?.paused ? "danger" : "neutral"}>{view.uses === "managed" ? "in use" : m?.paused ? "paused" : on ? "on" : "off"}</Badge>}
    >
      <Notice variant={summary.tone === "warning" ? "warning" : summary.tone === "success" ? "success" : "info"}>
        <span className="font-medium">{summary.headline}.</span> {summary.detail}
      </Notice>

      {!on && (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button onClick={() => void run(() => enable.mutateAsync())} disabled={busy || !isOwner}>
            {enable.isPending ? "Turning on..." : "Turn on Mailforge Sending"}
          </Button>
          {!isOwner && <p className="text-[13px] text-muted-foreground">Only the workspace owner can turn this on.</p>}
        </div>
      )}

      {on && m && (
        <div className="mt-5 space-y-6">
          {/* ---- Domain ---- */}
          <div>
            <h3 className="text-[15px] font-semibold text-foreground">Your sending domain</h3>
            {!m.domain ? (
              <form
                className="mt-2 space-y-3"
                onSubmit={(e: React.FormEvent) => {
                  e.preventDefault();
                  void run(() => setDomain.mutateAsync({ domain: domain.trim(), ...(local.trim() ? { from_local: local.trim() } : {}) }), () => setDomainText(""));
                }}
              >
                <p className="text-[14px] text-muted-foreground">
                  Optional, but recommended: send from your own domain (for example <span className="font-mono text-[13px]">mail.yourcompany.com</span>). Delivery is better, the
                  address your customers see is yours, and the shared daily limit no longer applies. A subdomain such as <span className="font-mono text-[13px]">mail.</span> or{" "}
                  <span className="font-mono text-[13px]">updates.</span> is safest: it keeps your everyday email separate.
                </p>
                <div className="flex flex-wrap items-end gap-3">
                  <label className="block">
                    <span className="text-[13px] text-muted-foreground">Domain</span>
                    <Input value={domain} onChange={(e) => setDomainText(e.target.value)} placeholder="mail.yourcompany.com" className="mt-1 w-72" disabled={busy || !isOwner} aria-label="Sending domain" />
                  </label>
                  <label className="block">
                    <span className="text-[13px] text-muted-foreground">Sender address starts with</span>
                    <Input value={local} onChange={(e) => setLocal(e.target.value)} placeholder="hello" className="mt-1 w-40" disabled={busy || !isOwner} aria-label="Start of the sender address" />
                  </label>
                  <Button type="submit" variant="outline" disabled={busy || !isOwner || domain.trim() === ""}>
                    {setDomain.isPending ? "Adding..." : "Add domain"}
                  </Button>
                </div>
              </form>
            ) : (
              <div className="mt-2">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="font-mono text-[14px] text-foreground">{m.domain}</span>
                  {status && <Badge variant={status.variant}>{status.label}</Badge>}
                </div>
                {status && <p className="mt-1.5 text-[14px] text-muted-foreground">{status.help}</p>}
                {m.domain_status !== "verified" && <DnsTable domain={m.domain} records={m.dns_records} />}
                <div className="mt-3 flex flex-wrap gap-2">
                  {m.domain_status !== "verified" && (
                    <Button variant="outline" size="sm" onClick={() => void run(() => verify.mutateAsync())} disabled={busy || !isOwner}>
                      {verify.isPending ? "Checking..." : "Check now"}
                    </Button>
                  )}
                  <Button variant="ghost" size="sm" onClick={() => void run(() => removeDomain.mutateAsync())} disabled={busy || !isOwner}>
                    Remove domain
                  </Button>
                </div>
              </div>
            )}
          </div>

          {/* ---- Sender details ---- */}
          <form
            className="space-y-3"
            onSubmit={(e: React.FormEvent) => {
              e.preventDefault();
              void run(
                () =>
                  patch.mutateAsync({
                    ...(name !== null ? { from_name: name } : {}),
                    ...(fromLocal !== null && m.domain ? { from_local: fromLocal } : {}),
                    ...(reply !== null ? { reply_to: reply } : {}),
                  }),
                () => {
                  setName(null);
                  setFromLocal(null);
                  setReply(null);
                  setSaved(true);
                },
              );
            }}
          >
            <h3 className="text-[15px] font-semibold text-foreground">Who your email is from</h3>
            <div className="flex flex-wrap items-end gap-3">
              <label className="block">
                <span className="text-[13px] text-muted-foreground">Sender name</span>
                <Input value={name ?? m.from_name ?? ""} onChange={(e) => setName(e.target.value)} placeholder={m.sender?.from_name ?? "Your company"} className="mt-1 w-56" disabled={busy || !isOwner} aria-label="Sender name" />
              </label>
              {m.domain && (
                <label className="block">
                  <span className="text-[13px] text-muted-foreground">Address starts with</span>
                  <Input value={fromLocal ?? m.from_local} onChange={(e) => setFromLocal(e.target.value)} className="mt-1 w-36" disabled={busy || !isOwner} aria-label="Address start" />
                </label>
              )}
              <label className="block">
                <span className="text-[13px] text-muted-foreground">Replies go to</span>
                <Input value={reply ?? m.reply_to ?? ""} onChange={(e) => setReply(e.target.value)} placeholder={m.sender?.reply_to ?? "you@yourcompany.com"} className="mt-1 w-64" disabled={busy || !isOwner} aria-label="Reply address" />
              </label>
              <Button type="submit" variant="outline" disabled={busy || !isOwner || (name === null && fromLocal === null && reply === null)}>
                {patch.isPending ? "Saving..." : "Save"}
              </Button>
            </div>
            <p className="text-[13px] text-muted-foreground">
              {m.sender?.mode === "shared"
                ? "Until your domain is verified, email is sent from a shared Mailforge address, with your name as the sender and your reply address so people can answer you directly."
                : "Leave a field empty to use the default (your workspace name, and your account email for replies)."}
            </p>
          </form>

          {saved && <p className="text-[13px] text-success" role="status">Saved.</p>}

          {/* ---- Turn off ---- */}
          <div className="border-t border-border pt-4">
            {!confirmOff ? (
              <Button variant="ghost" size="sm" onClick={() => setConfirmOff(true)} disabled={busy || !isOwner}>
                Turn off Mailforge Sending
              </Button>
            ) : (
              <div className="rounded-md border border-border bg-sunken px-4 py-3" role="group" aria-label="Turn off Mailforge Sending">
                <p className="text-[14px] text-foreground">
                  {ownTransport
                    ? "Turn it off? You are using your own email provider, so your email is not affected."
                    : "Turn it off? Your email will stop going out until you connect an email provider of your own or turn this back on. Nothing is lost: it waits."}
                </p>
                <div className="mt-3 flex gap-2">
                  <Button variant="destructive" size="sm" disabled={busy} onClick={() => void run(() => disable.mutateAsync(), () => setConfirmOff(false))}>
                    {disable.isPending ? "Turning off..." : "Turn off"}
                  </Button>
                  <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirmOff(false)}>
                    Keep it on
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
      <FormError message={error} />
    </Section>
  );
}
