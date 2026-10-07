/**
 * Platform admin console: one workspace in full, and the things an operator can
 * do to it (set a plan by hand, give a trial, suspend, cancel a subscription).
 *
 * Every change asks for a written reason, which goes in the audit log. The
 * server enforces the rules; this page only explains them (for example, a
 * workspace with a live subscription cannot be moved by hand).
 *
 * Mirror side: PUBLIC (apps/dashboard is mirrored).
 */
import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { Badge } from "../../components/ui/badge.js";
import { Button } from "../../components/ui/button.js";
import { Input } from "../../components/ui/input.js";
import { Select } from "../../components/ui/select.js";
import { Skeleton } from "../../components/ui/skeleton.js";
import { ago, auditReason, auditSummary, describeAllowance, formatCost, planLabel, useAdminAction, useAdminTenant, workspaceBadge } from "../../admin.js";
import { adminExportUrl, type AdminAction, type AdminTenantDetail } from "../../admin-api.js";
import { cn } from "../../lib/utils.js";
import { buttonVariants } from "../../components/ui/button.js";
import { Notice, Section, SummaryItem, SummaryList, errorMessage, formatDate } from "../settings/shared.js";

const nf = (n: number) => n.toLocaleString("en-US");
const MAX_REASON = 300;

/** A change with a reason box and one button. Clears itself after success. */
function ActionPanel({
  title,
  description,
  buttonLabel,
  destructive = false,
  disabledReason,
  extra,
  build,
  workspaceId,
}: {
  title: string;
  description: string;
  buttonLabel: string;
  destructive?: boolean;
  /** When set the panel explains why it cannot be used and shows no form. */
  disabledReason?: string;
  extra?: { node: React.ReactNode; valid: boolean };
  build: (reason: string) => AdminAction;
  workspaceId: string;
}) {
  const action = useAdminAction(workspaceId);
  const [reason, setReason] = useState("");
  const [done, setDone] = useState(false);
  const ready = reason.trim().length > 0 && reason.length <= MAX_REASON && (extra?.valid ?? true);

  return (
    <div className="rounded-md border border-border p-4">
      <h3 className="text-[15px] font-semibold text-foreground">{title}</h3>
      <p className="mt-1 text-[14px] leading-relaxed text-muted-foreground">{description}</p>
      {disabledReason ? (
        <p className="mt-3 text-[14px] text-warning">{disabledReason}</p>
      ) : (
        <form
          className="mt-3 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!ready || action.isPending) return;
            setDone(false);
            action.mutate(build(reason.trim()), {
              onSuccess: () => {
                setReason("");
                setDone(true);
              },
            });
          }}
        >
          {extra?.node}
          <label className="block">
            <span className="text-[13px] text-muted-foreground">Reason (kept in the audit log)</span>
            <Input
              value={reason}
              onChange={(e) => {
                setReason(e.target.value);
                setDone(false);
              }}
              maxLength={MAX_REASON}
              placeholder="Why are you doing this?"
              className="mt-1"
            />
          </label>
          <Button type="submit" variant={destructive ? "destructive" : "default"} size="sm" disabled={!ready || action.isPending}>
            {action.isPending ? "Working..." : buttonLabel}
          </Button>
          {action.isError && <p className="text-[14px] text-danger">{errorMessage(action.error)}</p>}
          {done && !action.isPending && <p className="text-[14px] text-success">Done.</p>}
        </form>
      )}
    </div>
  );
}

/** Give this workspace its own monthly Mailforge AI token allowance instead of the plan's. */
function AllowancePanel({ d }: { d: AdminTenantDetail }) {
  const [mode, setMode] = useState<"number" | "unlimited" | "plan">("number");
  const [tokens, setTokens] = useState("");
  const n = Number(tokens);
  const validNumber = tokens.trim() !== "" && Number.isInteger(n) && n >= 0 && n <= 1_000_000_000;
  return (
    <ActionPanel
      workspaceId={d.workspace.id}
      title="AI allowance"
      description="Overrides the plan's monthly Mailforge AI token allowance for this workspace only. Only matters on a hosted service that enforces plans. Use it for design partners, goodwill after an outage, or to rein in a heavy user."
      buttonLabel="Set allowance"
      extra={{
        valid: mode !== "number" || validNumber,
        node: (
          <div className="space-y-2">
            <Select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)} aria-label="Allowance type">
              <option value="number">A number of tokens a month</option>
              <option value="unlimited">No cap</option>
              <option value="plan">Back to the plan's allowance</option>
            </Select>
            {mode === "number" && (
              <Input type="number" min={0} max={1_000_000_000} step={1} value={tokens} onChange={(e) => setTokens(e.target.value)} placeholder="e.g. 500000" aria-label="Tokens per month" className="w-48" />
            )}
          </div>
        ),
      }}
      build={(reason) => ({ kind: "ai-allowance", tokens: mode === "plan" ? null : mode === "unlimited" ? "unlimited" : n, reason })}
    />
  );
}

/** Pause or resume a workspace's managed sending. Its mail waits, untouched, while paused. */
function SendingPanel({ d }: { d: AdminTenantDetail }) {
  const s = d.sending;
  if (!s) return null;
  return s.paused ? (
    <ActionPanel
      key="resume-sending"
      workspaceId={d.workspace.id}
      title="Resume managed sending"
      description={`Paused ${s.paused.by === "auto" ? "automatically" : `by ${s.paused.by ?? "an admin"}`}${s.paused.reason ? `: ${s.paused.reason}` : ""}. Its mail is waiting, not lost. Resuming restarts sending and tells the workspace's owners. Only do it once the list has been cleaned up.`}
      buttonLabel="Resume sending"
      build={(reason) => ({ kind: "managed-sending", action: "resume", reason })}
    />
  ) : (
    <ActionPanel
      key="pause-sending"
      workspaceId={d.workspace.id}
      title="Pause managed sending"
      description="Stops this workspace's email going out through the shared Resend account. Its mail waits, untouched, and its owners are told. Use it if you see abuse or while you look into complaints."
      buttonLabel="Pause sending"
      destructive
      build={(reason) => ({ kind: "managed-sending", action: "pause", reason })}
    />
  );
}

function Actions({ d }: { d: AdminTenantDetail }) {
  const w = d.workspace;
  const live = d.subscriptions.find((s) => s.status === "active" || s.status === "cancelled");
  const [plan, setPlan] = useState(w.stored_plan === "trial" ? "free" : w.stored_plan);
  const [days, setDays] = useState("14");
  const dayCount = Number(days);
  const subNote = live
    ? "This workspace has a live paid subscription, which would overwrite a hand-set plan at its next charge. Cancel the subscription first."
    : undefined;

  return (
    <div className="space-y-4">
      <ActionPanel
        workspaceId={w.id}
        title="Set plan by hand"
        description="Puts the workspace on a plan with no expiry, replacing any trial. Use it for design partners, goodwill and fixes."
        buttonLabel="Set plan"
        disabledReason={subNote}
        extra={{
          valid: plan.length > 0,
          node: (
            <Select value={plan} onChange={(e) => setPlan(e.target.value)} aria-label="Plan">
              {["free", "starter", "growth", "scale"].map((p) => (
                <option key={p} value={p}>
                  {planLabel(p)}
                </option>
              ))}
            </Select>
          ),
        }}
        build={(reason) => ({ kind: "plan", plan, reason })}
      />
      <AllowancePanel d={d} />
      <SendingPanel d={d} />
      <ActionPanel
        workspaceId={w.id}
        title="Give a trial"
        description="Starts a Growth trial that ends this many days from now (it does not add to a running trial)."
        buttonLabel="Start trial"
        disabledReason={subNote}
        extra={{
          valid: Number.isInteger(dayCount) && dayCount >= 1 && dayCount <= 90,
          node: (
            <label className="block">
              <span className="text-[13px] text-muted-foreground">Days (1 to 90)</span>
              <Input type="number" min={1} max={90} value={days} onChange={(e) => setDays(e.target.value)} className="mt-1 w-28" />
            </label>
          ),
        }}
        build={(reason) => ({ kind: "trial", days: dayCount, reason })}
      />
      {live && live.status === "active" && (
        <ActionPanel
          workspaceId={w.id}
          title="Cancel subscription"
          description="Stops future charges. The workspace keeps its plan until the paid period ends. Nothing is refunded here."
          buttonLabel="Cancel subscription"
          destructive
          disabledReason={d.billing_enabled ? undefined : "Online billing is not configured on this install."}
          build={(reason) => ({ kind: "cancel-subscription", reason })}
        />
      )}
      {w.deletion_scheduled_at ? (
        <ActionPanel
          key="cancel-deletion"
          workspaceId={w.id}
          title="Cancel scheduled deletion"
          description={`Scheduled for erasure on ${formatDate(w.deletion_scheduled_at)}${w.deletion_requested_by ? `, requested by ${w.deletion_requested_by}` : ""}. Cancelling restores the workspace to how it was (unless it is also suspended).`}
          buttonLabel="Cancel deletion"
          build={(reason) => ({ kind: "cancel-deletion", reason })}
        />
      ) : null}
      <DeletePanel d={d} />
      {w.suspended ? (
        <ActionPanel
          key="unsuspend"
          workspaceId={w.id}
          title="Reinstate workspace"
          description="Switches the workspace back on: people can sign in, the API accepts its keys, and held emails go out."
          buttonLabel="Reinstate"
          build={(reason) => ({ kind: "unsuspend", reason })}
        />
      ) : (
        <ActionPanel
          key="suspend"
          workspaceId={w.id}
          title="Suspend workspace"
          description="Switches the workspace off: nobody can use the dashboard, the API refuses its keys, and nothing is sent. Nothing is deleted. Reversible."
          buttonLabel="Suspend"
          destructive
          build={(reason) => ({ kind: "suspend", reason })}
        />
      )}
    </div>
  );
}

/** Delete a workspace: scheduled by default, immediate only when ticked. Needs the slug typed. */
function DeletePanel({ d }: { d: AdminTenantDetail }) {
  const w = d.workspace;
  const [typed, setTyped] = useState("");
  const [immediate, setImmediate] = useState(false);
  const alreadyScheduled = w.deletion_scheduled_at !== null;
  return (
    <ActionPanel
      key={`delete-${immediate}`}
      workspaceId={w.id}
      title={immediate ? "Delete workspace now" : "Delete workspace"}
      description={
        immediate
          ? "Erases everything immediately. This cannot be undone. Use it only for legal erasure requests or abuse. Download an export first if there is any doubt."
          : "Switches the workspace off and erases everything after the grace period, unless cancelled. Any active subscription is cancelled first."
      }
      buttonLabel={immediate ? "Delete now, permanently" : "Schedule deletion"}
      destructive
      disabledReason={alreadyScheduled && !immediate ? "Deletion is already scheduled. Tick the box below to erase it now instead." : undefined}
      extra={{
        valid: typed.trim() === w.slug,
        node: (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-3">
              <a href={adminExportUrl(w.id)} download className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
                Download export first
              </a>
              <label className="flex items-center gap-2 text-[14px] text-foreground">
                <input type="checkbox" checked={immediate} onChange={(e) => setImmediate(e.target.checked)} />
                Erase immediately (no grace period)
              </label>
            </div>
            <label className="block">
              <span className="text-[13px] text-muted-foreground">
                Type <span className="font-mono">{w.slug}</span> to confirm
              </span>
              <Input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} className="mt-1 font-mono" />
            </label>
          </div>
        ),
      }}
      build={(reason) => ({ kind: "delete", confirm: typed.trim(), immediate, reason })}
    />
  );
}

export default function AdminTenantPage() {
  const { id = "" } = useParams();
  const { data: d, isLoading, isError, error } = useAdminTenant(id);

  const back = (
    <Link to="/admin" className="mb-6 inline-flex items-center gap-1.5 text-[14px] text-muted-foreground hover:text-foreground">
      <ArrowLeft size={14} aria-hidden="true" /> All workspaces
    </Link>
  );

  if (isLoading) {
    return (
      <div>
        {back}
        <Skeleton className="h-10 w-72" />
        <Skeleton className="mt-6 h-48 w-full" />
      </div>
    );
  }
  if (isError || !d) {
    return (
      <div>
        {back}
        <Notice>{errorMessage(error)}</Notice>
      </div>
    );
  }

  const w = d.workspace;
  const b = workspaceBadge(w);

  return (
    <div className="space-y-6">
      <div>
        {back}
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="font-display text-[24px] font-bold leading-[30px] tracking-[-0.02em] text-foreground sm:text-[28px]">{w.name}</h1>
          <Badge variant={b.variant}>{b.label}</Badge>
        </div>
        <p className="mt-1 text-[14px] text-muted-foreground">
          {w.owner_email ?? "No owner"} &middot; <span className="font-mono text-[13px]">{w.slug}</span>
        </p>
      </div>

      {w.suspended && (
        <Notice variant="warning">
          Suspended {ago(w.suspended_at)}
          {w.suspended_reason ? `: ${w.suspended_reason}` : "."} Nobody in this workspace can use it and nothing is being sent.
        </Notice>
      )}

      <Section title="Account" configured={null}>
        <SummaryList>
          <SummaryItem label="Plan in force">{w.effective_plan.name}</SummaryItem>
          <SummaryItem label="Plan on record">{w.stored_plan === "trial" ? "Trial" : planLabel(w.stored_plan)}</SummaryItem>
          <SummaryItem label="Joined">{w.created_at ? formatDate(w.created_at) : "—"}</SummaryItem>
          {w.trial_ends_at && <SummaryItem label={w.on_trial ? "Trial ends" : "Trial ended"}>{formatDate(w.trial_ends_at)}</SummaryItem>}
          {w.paid_through && <SummaryItem label="Paid through">{formatDate(w.paid_through)}</SummaryItem>}
          <SummaryItem label="Payment">{w.payment_status === "none" ? "No billing date" : w.payment_status}</SummaryItem>
        </SummaryList>
      </Section>

      <Section title="Usage" description="Counts only. Message content and contact details are never shown here." configured={null}>
        <SummaryList>
          <SummaryItem label="Contacts">{nf(d.usage.contacts)}</SummaryItem>
          <SummaryItem label="Emails this month">{nf(d.usage.emails_this_month)}</SummaryItem>
          <SummaryItem label="Team members">
            {nf(d.usage.members)}
            {d.usage.pending_invites > 0 && ` (+${d.usage.pending_invites} invited)`}
          </SummaryItem>
          <SummaryItem label="Flows">{nf(d.activity.flows)}</SummaryItem>
          <SummaryItem label="Email transport">
            {d.activity.has_email_transport ? "Own provider connected" : d.sending?.enabled && !d.sending.paused ? "Mailforge Sending" : d.sending?.paused ? "Mailforge Sending (paused)" : "Not set up"}
          </SummaryItem>
          <SummaryItem label="Last email sent">{ago(d.activity.last_email_sent_at)}</SummaryItem>
        </SummaryList>
      </Section>

      {d.sending && (
        <Section title="Email sending" description="Managed sending through the shared Resend account. Counts and status only." configured={null}>
          <SummaryList>
            <SummaryItem label="Managed sending">{!d.sending.enabled ? "Off" : d.sending.paused ? "Paused" : "On"}</SummaryItem>
            <SummaryItem label="Sending domain">
              {d.sending.domain ? `${d.sending.domain} (${d.sending.domain_status.replace(/_/g, " ")})` : "None: using the shared address"}
            </SummaryItem>
            {d.sending.paused && (
              <SummaryItem label="Paused" span>
                {d.sending.paused.by === "auto" ? "Automatically" : `By ${d.sending.paused.by ?? "an admin"}`}, {ago(d.sending.paused.at)}
                {d.sending.paused.reason ? `: ${d.sending.paused.reason}` : ""}
              </SummaryItem>
            )}
            {d.sending.warned_at && <SummaryItem label="Last warned">{ago(d.sending.warned_at)}</SummaryItem>}
          </SummaryList>
        </Section>
      )}

      <Section
        title="AI"
        description="Where this workspace gets its AI from, and what it used this month. Counts only."
        configured={null}
      >
        <SummaryList>
          <SummaryItem label="Using">{d.ai.source === "byok" ? "Its own key" : "Mailforge AI"}</SummaryItem>
          <SummaryItem label="Mailforge AI tokens">
            {nf(d.ai.platform_tokens_this_month)}
            {d.ai.allowance_tokens !== null && ` of ${nf(d.ai.allowance_tokens)}`}
          </SummaryItem>
          <SummaryItem label="Own-key tokens">{nf(d.ai.byok_tokens_this_month)}</SummaryItem>
          <SummaryItem label="AI calls this month">{nf(d.ai.calls_this_month)}</SummaryItem>
          <SummaryItem label="Cost to you this month">{formatCost(d.ai.platform_cost_usd)}</SummaryItem>
          <SummaryItem label="Allowance">
            {d.ai.allowance_override === null ? (d.ai.allowance_tokens === null ? "no cap (plan)" : `${nf(d.ai.allowance_tokens)} (plan)`) : `${describeAllowance(d.ai.allowance_override)} (set by hand)`}
          </SummaryItem>
        </SummaryList>
      </Section>

      <Section title="Actions" description="Each change needs a reason and is recorded in the audit log." configured={null}>
        <Actions d={d} />
      </Section>

      <Section title="Team" configured={null}>
        <ul className="divide-y divide-border">
          {d.members.map((m) => (
            <li key={m.email} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-[14px]">
              <span className="text-foreground">
                {m.email} <span className="text-muted-foreground">({m.role})</span>
                {m.deactivated && <span className="ml-2 text-muted-foreground">removed</span>}
              </span>
              <span className="text-[13px] text-muted-foreground">last sign-in {ago(m.last_login_at)}</span>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Billing" configured={null}>
        {d.subscriptions.length === 0 ? (
          <p className="text-[14px] text-muted-foreground">No subscription has ever been started for this workspace.</p>
        ) : (
          <ul className="divide-y divide-border">
            {d.subscriptions.map((s, i) => (
              <li key={i} className="py-2.5 text-[14px]">
                <p className="text-foreground">
                  {planLabel(s.plan)}, {s.interval}, ${s.amount_usd}{s.currency.toUpperCase() === "USD" ? "" : ` (charged ${s.charged_amount} ${s.currency})`} <Badge variant={s.status === "active" ? "success" : "muted"}>{s.status}</Badge>
                </p>
                <p className="text-[13px] text-muted-foreground">
                  payer {s.payer_email}
                  {s.current_period_end && ` · ${s.status === "active" ? "renews" : "runs to"} ${formatDate(s.current_period_end)}`}
                  {s.last_payment_at && ` · last paid ${ago(s.last_payment_at)}`}
                </p>
              </li>
            ))}
          </ul>
        )}
        {d.billing_events.length > 0 && (
          <div className="mt-4">
            <p className="text-[13px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">Payment events</p>
            <ul className="mt-2 space-y-1 text-[13px] text-muted-foreground">
              {d.billing_events.map((e, i) => (
                <li key={i}>
                  {ago(e.at)}: {e.type} ({e.outcome})
                </li>
              ))}
            </ul>
          </div>
        )}
      </Section>

      <Section title="Admin history" configured={null}>
        {d.audit.length === 0 ? (
          <p className="text-[14px] text-muted-foreground">No admin has changed this workspace.</p>
        ) : (
          <ul className="divide-y divide-border">
            {d.audit.map((e, i) => (
              <li key={i} className="py-2.5 text-[14px]">
                <p className="text-foreground">{auditSummary(e)}</p>
                <p className="text-[13px] text-muted-foreground">
                  {e.actor}, {ago(e.at)}
                  {auditReason(e) && `: ${auditReason(e)}`}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
