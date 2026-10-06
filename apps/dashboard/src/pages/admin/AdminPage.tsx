/**
 * Platform admin console: the whole service at a glance.
 *
 * Totals, signups, subscription revenue, things that need attention (overdue
 * payments, lapsed subscriptions, trials about to end), a searchable list of
 * every workspace, and the latest admin changes. Only platform admins reach this
 * page; the server answers 404 to everyone else.
 *
 * Mirror side: PUBLIC (apps/dashboard is mirrored).
 */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { PageHeader } from "../../components/page-header.js";
import { Badge } from "../../components/ui/badge.js";
import { Button } from "../../components/ui/button.js";
import { Input } from "../../components/ui/input.js";
import { Select } from "../../components/ui/select.js";
import { Skeleton } from "../../components/ui/skeleton.js";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table.js";
import { ago, auditReason, auditSummary, auditWorkspaceName, dropSentence, formatHours, goalsSentence, formatUsd, useAdminAudit, useAdminFunnel, useAdminOverview, useAdminTenants, workspaceBadge } from "../../admin.js";
import type { AdminListStatus } from "../../admin-api.js";
import { Notice, errorMessage } from "../settings/shared.js";

const PAGE_SIZE = 25;
const nf = (n: number) => n.toLocaleString("en-US");

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <p className="text-[13px] text-muted-foreground">{label}</p>
      <p className="mt-1 font-display text-[26px] font-bold leading-[32px] tracking-[-0.02em] text-foreground">{value}</p>
      {hint && <p className="mt-0.5 text-[13px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** How far new signups got: one bar per stage, as a share of everyone who signed up in the window. */
function SignupFunnel() {
  const [days, setDays] = useState<7 | 30 | 90>(30);
  const f = useAdminFunnel(days);
  const d = f.data;
  const sentence = d ? dropSentence(d) : null;
  return (
    <section className="mt-10" aria-label="Signup funnel">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-[20px] font-semibold leading-[28px] tracking-[-0.015em] text-foreground">Signup funnel</h2>
          <p className="mt-1 text-[13px] text-muted-foreground">How far new workspaces got. Each bar is counted on its own, so a later step can be higher than an earlier one.</p>
        </div>
        <div className="w-40">
          <Select value={String(days)} onChange={(e) => setDays(Number(e.target.value) as 7 | 30 | 90)} aria-label="Signup window">
            <option value="7">Last 7 days</option>
            <option value="30">Last 30 days</option>
            <option value="90">Last 90 days</option>
          </Select>
        </div>
      </div>

      {f.isError && <Notice className="mt-4">{errorMessage(f.error)}</Notice>}
      {!d && !f.isError && <Skeleton className="mt-4 h-64 w-full" />}
      {d && d.cohort === 0 && <Notice variant="info" className="mt-4">No workspaces signed up in this window.</Notice>}
      {d && d.cohort > 0 && (
        <>
          <ol className="mt-4 space-y-2" data-testid="funnel-stages">
            {d.stages.map((s) => (
              <li key={s.id} data-stage={s.id}>
                <div className="flex items-baseline justify-between gap-3 text-[13px]">
                  <span className="text-foreground">{s.label}</span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">
                    <strong className="font-medium text-foreground">{nf(s.count)}</strong> · {s.percent}%
                  </span>
                </div>
                <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-sunken" role="img" aria-label={`${s.label}: ${s.count} of ${d.cohort}`}>
                  <div className="h-full rounded-full bg-accent" style={{ width: `${Math.max(s.count > 0 ? 2 : 0, s.percent)}%` }} />
                </div>
              </li>
            ))}
          </ol>
          {sentence && <p className="mt-4 text-[14px] text-foreground">{sentence}</p>}
          {goalsSentence(d.goals) && (
            <p className="mt-1 text-[13px] text-muted-foreground" data-testid="funnel-goals">
              What they asked for at signup: {goalsSentence(d.goals)}.
            </p>
          )}
          <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Median time to first email" value={formatHours(d.median_hours_to_first_email)} hint="From signup, for those that got one" />
            <Stat label="Stalled" value={nf(d.stalled)} hint="Signed in, over a day old, no email yet" />
            <Stat label="Reminded" value={nf(d.nudged)} hint="Got at least one stall reminder" />
            <Stat label="Set aside" value={nf(d.set_aside)} hint={'Chose "I will finish this later"'} />
          </div>
        </>
      )}
    </section>
  );
}

/** Debounce so the list does not refetch on every keystroke. */
function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export default function AdminPage() {
  const overview = useAdminOverview();
  const audit = useAdminAudit(8);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<AdminListStatus>("all");
  const [offset, setOffset] = useState(0);
  const q = useDebounced(search, 250);
  useEffect(() => setOffset(0), [q, status]);
  const list = useAdminTenants({ q, status, offset, limit: PAGE_SIZE });

  const o = overview.data;
  const attention = o
    ? [
        o.attention.payments_overdue > 0 && `${o.attention.payments_overdue} ${o.attention.payments_overdue === 1 ? "payment is" : "payments are"} overdue (still inside the 3 day grace period).`,
        o.attention.subscriptions_lapsed > 0 && `${o.attention.subscriptions_lapsed} paid ${o.attention.subscriptions_lapsed === 1 ? "workspace has" : "workspaces have"} lapsed and ${o.attention.subscriptions_lapsed === 1 ? "is" : "are"} now on Free.`,
        o.attention.trials_ending_in_3_days > 0 && `${o.attention.trials_ending_in_3_days} ${o.attention.trials_ending_in_3_days === 1 ? "trial ends" : "trials end"} within 3 days.`,
      ].filter((x): x is string => typeof x === "string")
    : [];

  const total = list.data?.total ?? 0;
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(total, offset + PAGE_SIZE);

  return (
    <div>
      <PageHeader eyebrow="Platform" title="Admin console" subtitle="Every workspace on this service. Changes here are recorded in the audit log." />

      {overview.isError && <Notice className="mb-6">{errorMessage(overview.error)}</Notice>}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {o ? (
          <>
            <Stat label="Workspaces" value={nf(o.workspaces.total)} hint={`${nf(o.workspaces.signups_7d)} new this week, ${nf(o.workspaces.signups_30d)} this month`} />
            <Stat
              label="Monthly recurring revenue"
              value={formatUsd(o.revenue.mrr_usd)}
              hint={`${nf(o.revenue.active_subscriptions)} paying${o.revenue.cancelling_subscriptions ? `, ${nf(o.revenue.cancelling_subscriptions)} cancelling` : ""}`}
            />
            <Stat
              label="On a trial"
              value={nf(o.workspaces.by_stored_plan.trial_running)}
              hint={`${nf(o.workspaces.by_stored_plan.free)} on Free, ${nf(o.workspaces.by_stored_plan.trial_ended)} trials ended`}
            />
            <Stat label="Emails this month" value={nf(o.usage.emails_this_month)} hint={`${nf(o.usage.contacts)} contacts in total`} />
          </>
        ) : (
          [0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-[104px] w-full" />)
        )}
      </div>

      {o && !o.billing_enabled && (
        <Notice variant="info" className="mt-4">
          Online billing is not configured, so subscription revenue shows as zero. See guide/BILLING.md.
        </Notice>
      )}
      {attention.length > 0 && (
        <div className="mt-4 space-y-2">
          {attention.map((m) => (
            <Notice key={m}>{m}</Notice>
          ))}
        </div>
      )}
      {o && o.workspaces.suspended > 0 && (
        <Notice variant="info" className="mt-4">
          {o.workspaces.suspended} {o.workspaces.suspended === 1 ? "workspace is" : "workspaces are"} suspended.
        </Notice>
      )}

      <SignupFunnel />

      <section className="mt-10">
        <h2 className="text-[20px] font-semibold leading-[28px] tracking-[-0.015em] text-foreground">Workspaces</h2>
        <div className="mt-4 flex flex-col gap-3 sm:flex-row">
          <Input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name, slug or email"
            aria-label="Search workspaces"
            className="sm:max-w-sm"
          />
          <div className="sm:w-44">
            <Select value={status} onChange={(e) => setStatus(e.target.value as AdminListStatus)} aria-label="Filter by plan status">
              <option value="all">All workspaces</option>
              <option value="trial">On a trial</option>
              <option value="free">Free</option>
              <option value="paid">Paid plans</option>
              <option value="suspended">Suspended</option>
            </Select>
          </div>
        </div>

        {list.isError && <Notice className="mt-4">{errorMessage(list.error)}</Notice>}

        <div className="mt-4">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Workspace</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Contacts</TableHead>
                <TableHead className="text-right">Emails (month)</TableHead>
                <TableHead>Joined</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.data?.tenants.map((w) => {
                const b = workspaceBadge(w);
                return (
                  <TableRow key={w.id}>
                    <TableCell>
                      <Link to={`/admin/tenants/${w.id}`} className="font-medium text-foreground underline-offset-4 hover:underline">
                        {w.name}
                      </Link>
                      <div className="text-[13px] text-muted-foreground">{w.owner_email ?? "no owner"}</div>
                    </TableCell>
                    <TableCell>
                      <Badge variant={b.variant}>{b.label}</Badge>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{nf(w.contacts)}</TableCell>
                    <TableCell className="text-right tabular-nums">{nf(w.emails_this_month)}</TableCell>
                    <TableCell className="text-muted-foreground">{ago(w.created_at)}</TableCell>
                  </TableRow>
                );
              })}
              {list.isLoading &&
                [0, 1, 2].map((i) => (
                  <TableRow key={i}>
                    <TableCell colSpan={5}>
                      <Skeleton className="h-8 w-full" />
                    </TableCell>
                  </TableRow>
                ))}
            </TableBody>
          </Table>
          {list.data && list.data.tenants.length === 0 && (
            <p className="py-8 text-center text-[14px] text-muted-foreground">No workspaces match.</p>
          )}
        </div>

        {total > 0 && (
          <div className="mt-3 flex items-center justify-between text-[14px] text-muted-foreground">
            <span>
              {from} to {to} of {nf(total)}
            </span>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>
                Previous
              </Button>
              <Button variant="outline" size="sm" disabled={to >= total} onClick={() => setOffset(offset + PAGE_SIZE)}>
                Next
              </Button>
            </div>
          </div>
        )}
      </section>

      <section className="mt-10">
        <div className="flex items-baseline justify-between gap-4">
          <h2 className="text-[20px] font-semibold leading-[28px] tracking-[-0.015em] text-foreground">Recent admin changes</h2>
          <Link to="/admin/audit" className="text-[14px] text-accent-text underline underline-offset-4">View all</Link>
        </div>
        {audit.data && audit.data.entries.length === 0 && <p className="mt-3 text-[14px] text-muted-foreground">No changes yet.</p>}
        <ul className="mt-3 divide-y divide-border rounded-lg border border-border bg-card">
          {audit.data?.entries.map((e, i) => (
            <li key={i} className="px-4 py-3 text-[14px]">
              <p className="text-foreground">
                {auditSummary(e)}
                {e.tenant_id ? (
                  <>
                    {" for "}
                    <Link to={`/admin/tenants/${e.tenant_id}`} className="underline underline-offset-4">
                      {auditWorkspaceName(e) ?? "a workspace"}
                    </Link>
                  </>
                ) : (
                  auditWorkspaceName(e) && ` (${auditWorkspaceName(e)})`
                )}
              </p>
              <p className="text-[13px] text-muted-foreground">
                {e.actor}, {ago(e.at)}
                {auditReason(e) && `: ${auditReason(e)}`}
              </p>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
