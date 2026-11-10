/**
 * Platform admin console: AppSumo lifetime deals.
 *
 * The operator picks the billing mode, sets how many licences to sell, makes the codes that go to AppSumo as a
 * CSV, and watches licences arrive. Licences AppSumo reports (purchase, activate, upgrade, refund) change only
 * by AppSumo's webhooks and are never edited here; the one thing an operator can refund is a code Loomail
 * generated. Every change needs a written reason and goes in the audit log.
 *
 * Mirror side: PUBLIC (apps/dashboard is mirrored).
 */
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { PageHeader } from "../../components/page-header.js";
import { Badge } from "../../components/ui/badge.js";
import { Button } from "../../components/ui/button.js";
import { Input } from "../../components/ui/input.js";
import { Select } from "../../components/ui/select.js";
import { Skeleton } from "../../components/ui/skeleton.js";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table.js";
import { ago, useAdminLifetime } from "../../admin.js";
import { adminLifetimeCsvUrl, makeAdminLifetimeCodes, refundAdminLifetimeCode, saveAdminLifetimeSettings } from "../../admin-api.js";
import { Notice, Section, errorMessage } from "../settings/shared.js";

const nf = (n: number) => n.toLocaleString("en-US");

const MODE_LABEL: Record<string, string> = {
  both: "Subscriptions and trial, and AppSumo codes can be redeemed (recommended)",
  subscriptions: "Subscriptions and trial only",
  lifetime: "AppSumo lifetime deal only (no free trial)",
};

const STATUS_VARIANT: Record<string, "success" | "neutral" | "muted" | "warning"> = {
  active: "success",
  inactive: "neutral",
  superseded: "muted",
  deactivated: "warning",
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

function Check({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className="mr-4 inline-flex items-center gap-1.5 text-[13px]">
      <Badge variant={ok ? "success" : "warning"}>{ok ? "set" : "missing"}</Badge>
      {label}
    </span>
  );
}

export default function AdminLifetimePage() {
  const { data, isLoading, error } = useAdminLifetime();
  const qc = useQueryClient();
  const [mode, setMode] = useState<string | null>(null);
  const [cap, setCap] = useState<string | null>(null);
  const [settingsReason, setSettingsReason] = useState("");
  const [count, setCount] = useState("1000");
  const [makeReason, setMakeReason] = useState("");
  const [refundCode, setRefundCode] = useState("");
  const [refundReason, setRefundReason] = useState("");
  const [note, setNote] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = () => void qc.invalidateQueries({ queryKey: ["admin", "lifetime"] });

  async function run(fn: () => Promise<string>) {
    setBusy(true);
    setNote(null);
    try {
      setNote({ tone: "success", text: await fn() });
      refresh();
    } catch (err) {
      setNote({ tone: "danger", text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  if (isLoading) return <Skeleton className="h-64 w-full" />;
  if (error || !data) return <Notice>Could not load the lifetime-deal settings.</Notice>;

  const curMode = mode ?? data.mode;
  const curCap = cap ?? String(data.spots.cap);
  const a = data.appsumo;
  const origin = typeof window !== "undefined" ? window.location.origin : "https://YOUR-APP-DOMAIN";

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader
        eyebrow="Admin"
        title="Lifetime deals"
        subtitle="Sell Loomail on AppSumo. Licences arrive by AppSumo's webhook and unlock a lifetime plan for one workspace."
      />

      {note && (
        <Notice variant={note.tone === "success" ? "success" : "warning"} onDismiss={() => setNote(null)}>
          {note.text}
        </Notice>
      )}

      <div className="grid gap-4 sm:grid-cols-4">
        <Stat label="Licences sold" value={nf(data.spots.sold)} hint={data.spots.cap ? `${nf(data.spots.left)} of ${nf(data.spots.cap)} left` : "no limit set"} />
        <Stat label="Codes made" value={nf(data.codes.total)} hint={`${nf(data.codes.unused)} unused`} />
        <Stat label="Codes redeemed" value={nf(data.codes.redeemed)} />
        <Stat label="Codes refunded" value={nf(data.codes.refunded)} />
      </div>

      <Section
        title="Mode and number of licences"
        configured={null}
        description="In the first two modes people can try Loomail free and pay by subscription. Lifetime only has no trial: a new workspace waits for a licence to be redeemed. Lifetime only needs plan limits to be enforced."
      >
        <div className="space-y-3">
          <div className="max-w-xl">
            <label className="text-[13px] text-foreground" htmlFor="lt-mode">
              Billing mode
            </label>
            <Select id="lt-mode" value={curMode} onChange={(e) => setMode(e.target.value)}>
              {data.modes.map((m) => (
                <option key={m} value={m}>
                  {MODE_LABEL[m] ?? m}
                </option>
              ))}
            </Select>
          </div>
          <div className="max-w-xs">
            <label className="text-[13px] text-foreground" htmlFor="lt-cap">
              Licences to sell (set the same limit on AppSumo)
            </label>
            <Input id="lt-cap" type="number" min={0} value={curCap} onChange={(e) => setCap(e.target.value)} />
            {data.spots.cap > 0 && data.spots.sold >= Math.min(90, data.spots.cap) && (
              <p className="mt-1 text-[13px] text-warning">Nearly sold out: end the AppSumo deal at {nf(data.spots.cap)}.</p>
            )}
          </div>
          <div className="max-w-xl">
            <label className="text-[13px] text-foreground" htmlFor="lt-reason">
              Reason (kept in the audit log)
            </label>
            <Input id="lt-reason" value={settingsReason} maxLength={300} onChange={(e) => setSettingsReason(e.target.value)} placeholder="For example: AppSumo launch" />
          </div>
          <Button
            size="sm"
            disabled={busy || !settingsReason.trim()}
            onClick={() =>
              void run(async () => {
                await saveAdminLifetimeSettings({ mode: curMode, cap: Number(curCap), reason: settingsReason.trim() });
                setMode(null);
                setCap(null);
                setSettingsReason("");
                return "Saved.";
              })
            }
          >
            Save
          </Button>
        </div>
      </Section>

      <Section title="Connect AppSumo" configured={null} description="Set these on the server, then give AppSumo the two addresses below.">
        <p>
          <Check ok={a.api_key} label="APPSUMO_API_KEY (signs webhooks)" />
          <Check ok={a.oauth} label="APPSUMO_CLIENT_ID / APPSUMO_CLIENT_SECRET (activation)" />
          <Check ok={Boolean(a.redirect_url)} label="APPSUMO_REDIRECT_URL" />
          <Check ok={Boolean(a.buy_url)} label="APPSUMO_BUY_URL (your product page)" />
        </p>
        <dl className="mt-4 space-y-2 text-[14px]">
          <div>
            <dt className="text-muted-foreground">Webhook URL to give AppSumo</dt>
            <dd>
              <code className="rounded bg-sunken px-1.5 py-0.5 text-[13px]">
                {origin}
                {data.webhook_path}
              </code>
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Redirect (OAuth callback) URL</dt>
            <dd>
              <code className="rounded bg-sunken px-1.5 py-0.5 text-[13px]">
                {origin}
                {data.callback_path}
              </code>
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Redeem address for codes</dt>
            <dd>
              <code className="rounded bg-sunken px-1.5 py-0.5 text-[13px]">
                {origin}
                {data.redeem_path}
              </code>
            </dd>
          </div>
        </dl>
        <p className="mt-3 text-[13px] text-muted-foreground">
          Licences are created, upgraded and refunded only by AppSumo's webhooks. They cannot be edited here.
        </p>
      </Section>

      <Section
        title="Codes for AppSumo"
        configured={null}
        description={`${nf(data.codes.total)} made · ${nf(data.codes.unused)} unused · ${nf(data.codes.redeemed)} redeemed · ${nf(data.codes.refunded)} refunded.`}
      >
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-32">
            <label className="text-[13px] text-foreground" htmlFor="lt-count">
              How many
            </label>
            <Input id="lt-count" type="number" min={1} max={10000} value={count} onChange={(e) => setCount(e.target.value)} />
          </div>
          <div className="min-w-0 flex-1 basis-64">
            <label className="text-[13px] text-foreground" htmlFor="lt-make-reason">
              Reason
            </label>
            <Input id="lt-make-reason" value={makeReason} maxLength={300} onChange={(e) => setMakeReason(e.target.value)} placeholder="For example: first AppSumo batch" />
          </div>
          <Button
            size="sm"
            disabled={busy || !makeReason.trim()}
            onClick={() =>
              void run(async () => {
                const r = await makeAdminLifetimeCodes(Number(count) || 1, makeReason.trim());
                setMakeReason("");
                return `${nf(r.made)} codes made. Download the CSV below.`;
              })
            }
          >
            Make codes
          </Button>
        </div>
        <div className="mt-3 flex flex-wrap gap-3">
          <a className="text-[14px] text-accent-text underline-offset-4 hover:underline" href={adminLifetimeCsvUrl(false)}>
            Download unused codes (CSV)
          </a>
          <a className="text-[14px] text-accent-text underline-offset-4 hover:underline" href={adminLifetimeCsvUrl(true)}>
            Download all codes (CSV)
          </a>
        </div>
        <p className="mt-2 text-[13px] text-muted-foreground">One code per line, no header: the format AppSumo asks for.</p>

        <h3 className="mt-6 text-[14px] font-medium text-foreground">Refund a code</h3>
        <p className="text-[13px] text-muted-foreground">
          For a code Loomail made that AppSumo refunded. The workspace using it drops a tier, or onto no plan if it was the last. Licences AppSumo reports
          are refunded by AppSumo's webhook.
        </p>
        <div className="mt-2 flex flex-wrap items-end gap-3">
          <div className="w-64">
            <Input value={refundCode} onChange={(e) => setRefundCode(e.target.value)} placeholder="LM-XXXX-XXXX-XXXX" aria-label="Code to refund" />
          </div>
          <div className="min-w-0 flex-1 basis-64">
            <Input value={refundReason} maxLength={300} onChange={(e) => setRefundReason(e.target.value)} placeholder="Reason, for example: refunded on AppSumo" aria-label="Reason" />
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || !refundCode.trim() || !refundReason.trim()}
            onClick={() =>
              void run(async () => {
                const r = await refundAdminLifetimeCode(refundCode.trim(), refundReason.trim());
                setRefundCode("");
                setRefundReason("");
                return `Result: ${r.result}`;
              })
            }
          >
            Refund
          </Button>
        </div>
      </Section>

      <Section title="Licences" configured={null} description="Bought, claimed or refunded. Newest first.">
        {data.licenses.length === 0 ? (
          <p className="text-[14px] text-muted-foreground">No licences yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Licence</TableHead>
                  <TableHead>Tier</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Workspace</TableHead>
                  <TableHead>Last event</TableHead>
                  <TableHead className="text-right">Claimed</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.licenses.map((l) => (
                  <TableRow key={l.license_key}>
                    <TableCell className="font-mono text-[13px]">
                      {l.license_key_short}
                      {l.source === "code" && <span className="ml-2 text-[12px] text-muted-foreground">our code</span>}
                    </TableCell>
                    <TableCell>{l.tier}</TableCell>
                    <TableCell>
                      <Badge variant={STATUS_VARIANT[l.status] ?? "neutral"}>{l.status}</Badge>
                    </TableCell>
                    <TableCell>{l.workspace_name ?? <span className="text-muted-foreground">not claimed</span>}</TableCell>
                    <TableCell className="text-muted-foreground">{l.last_event || "-"}</TableCell>
                    <TableCell className="text-right text-muted-foreground">{l.claimed_at ? ago(l.claimed_at) : "-"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Section>

      <Section title="Recent AppSumo events" configured={null} description="Every webhook, as received, with what Loomail did about it.">
        {data.events.length === 0 ? (
          <p className="text-[14px] text-muted-foreground">Nothing received yet.</p>
        ) : (
          <ul className="space-y-1 text-[13px]">
            {data.events.map((e, i) => (
              <li key={i} className="flex flex-wrap gap-x-3 text-foreground">
                <span className="font-mono text-muted-foreground">{ago(e.at)}</span>
                <span className="font-medium">{e.event || "?"}</span>
                <span className="font-mono text-muted-foreground">{e.license}</span>
                <span className="text-muted-foreground">{e.outcome}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
