/**
 * Platform admin console hooks and the pure rules the console uses to describe
 * a workspace and an audit entry in plain language.
 *
 * Mirror side: PUBLIC (apps/dashboard is mirrored).
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  fetchAdminAi,
  removeAdminAi,
  saveAdminAi,
  saveAdminAiBudget,
  setAdminAiEnabled,
  testAdminAi,
  type AdminAiSaveInput,
  type AdminAiSlot,
  fetchAdminAudit,
  fetchAdminOverview,
  fetchAdminFunnel,
  fetchAdminTenant,
  fetchAdminTenants,
  postAdminAction,
  type AdminAction,
  type AdminAuditEntry,
  type AdminListStatus,
  type AdminWorkspace,
} from "./admin-api.js";
import type { BadgeVariant } from "./components/ui/badge.js";

export const ADMIN_KEY = ["admin"] as const;

export function useAdminOverview() {
  return useQuery({ queryKey: [...ADMIN_KEY, "overview"], queryFn: fetchAdminOverview, staleTime: 30_000 });
}

export function useAdminFunnel(days: 7 | 30 | 90) {
  return useQuery({ queryKey: [...ADMIN_KEY, "funnel", days], queryFn: () => fetchAdminFunnel(days), staleTime: 60_000, placeholderData: (prev) => prev });
}

export function useAdminTenants(p: { q: string; status: AdminListStatus; offset: number; limit: number }) {
  return useQuery({
    queryKey: [...ADMIN_KEY, "tenants", p],
    queryFn: () => fetchAdminTenants(p),
    placeholderData: (prev) => prev,
  });
}

export function useAdminTenant(id: string) {
  return useQuery({ queryKey: [...ADMIN_KEY, "tenant", id], queryFn: () => fetchAdminTenant(id) });
}

export function useAdminAudit(limit = 20) {
  return useQuery({ queryKey: [...ADMIN_KEY, "audit", limit], queryFn: () => fetchAdminAudit(limit) });
}

/** Run one admin change, then refresh everything the console shows. */
export function useAdminAction(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: AdminAction) => postAdminAction(id, a),
    onSuccess: () => qc.invalidateQueries({ queryKey: ADMIN_KEY }),
  });
}

export function useAdminAi() {
  return useQuery({ queryKey: [...ADMIN_KEY, "ai"], queryFn: fetchAdminAi, staleTime: 15_000 });
}

/** One change to the operator AI providers, then refresh the console. */
export type AdminAiChange =
  | { kind: "save"; slot: AdminAiSlot; input: AdminAiSaveInput }
  | { kind: "enabled"; slot: AdminAiSlot; enabled: boolean; reason: string }
  | { kind: "remove"; slot: AdminAiSlot; reason: string }
  | { kind: "budget"; monthlyUsd: number | null; reason: string };

export function useAdminAiChange() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (c: AdminAiChange) => {
      if (c.kind === "save") return saveAdminAi(c.slot, c.input);
      if (c.kind === "enabled") return setAdminAiEnabled(c.slot, c.enabled, c.reason);
      if (c.kind === "budget") return saveAdminAiBudget(c.monthlyUsd, c.reason);
      return removeAdminAi(c.slot, c.reason);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ADMIN_KEY }),
  });
}

export function useAdminAiTest() {
  return useMutation({ mutationFn: (slot: AdminAiSlot) => testAdminAi(slot) });
}

const DAY = 86_400_000;

export function planLabel(id: string | null | undefined): string {
  if (!id) return "Free";
  return id.charAt(0).toUpperCase() + id.slice(1);
}

/** One badge that says the most important thing about a workspace. */
export function workspaceBadge(w: AdminWorkspace, now: Date = new Date()): { label: string; variant: BadgeVariant } {
  if (w.suspended) return { label: "Suspended", variant: "danger" };
  if (w.deletion_scheduled_at) {
    const days = Math.max(0, Math.ceil((new Date(w.deletion_scheduled_at).getTime() - now.getTime()) / DAY));
    return { label: days === 0 ? "Erasing today" : `Deleting in ${days} ${days === 1 ? "day" : "days"}`, variant: "danger" };
  }
  if (w.payment_status === "lapsed") return { label: `${planLabel(w.stored_plan)} lapsed`, variant: "danger" };
  if (w.payment_status === "overdue") return { label: `${planLabel(w.stored_plan)} overdue`, variant: "warning" };
  if (w.on_trial && w.trial_ends_at) {
    const days = Math.max(1, Math.ceil((new Date(w.trial_ends_at).getTime() - now.getTime()) / DAY));
    return { label: `Trial, ${days} ${days === 1 ? "day" : "days"} left`, variant: "accent" };
  }
  if (w.stored_plan === "trial") return { label: "Trial ended", variant: "muted" };
  if (w.effective_plan.id === "free") return { label: "Free", variant: "neutral" };
  return { label: w.effective_plan.name, variant: "success" };
}

/** "$1,234" or "$15.83": whole dollars when exact. */
export function formatUsd(n: number): string {
  const whole = Number.isInteger(n);
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 });
}

/** A past moment as "today" / "3 days ago" / a date; null as an em dash. */
export function ago(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return "—";
  const days = Math.floor((now.getTime() - new Date(iso).getTime()) / DAY);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 60) return `${days} days ago`;
  return new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
}

/** The reason an admin gave for a change, or an empty string. */
export function auditReason(e: AdminAuditEntry): string {
  return typeof e.detail?.reason === "string" ? e.detail.reason : "";
}

/** One plain sentence for an audit entry, without the reason (shown separately). */
export function auditSummary(e: AdminAuditEntry): string {
  const d = e.detail ?? {};
  const before = (d.before ?? {}) as { plan?: string | null };
  const after = (d.after ?? {}) as { plan?: string | null };
  switch (e.action) {
    case "set_plan":
      return `Set plan to ${planLabel(after.plan)} (was ${planLabel(before.plan)})`;
    case "extend_trial":
      return "Started a trial";
    case "suspend":
      return "Suspended the workspace";
    case "unsuspend":
      return "Reinstated the workspace";
    case "schedule_deletion":
      return "Scheduled the workspace for deletion";
    case "cancel_deletion":
      return "Cancelled the scheduled deletion";
    case "delete_workspace":
      return "Permanently deleted the workspace";
    case "export_data":
      return "Downloaded a data export";
    case "cancel_subscription":
      return `Cancelled the ${planLabel(typeof d.plan === "string" ? d.plan : null)} subscription`;
    case "set_ai_allowance": {
      const after = (d.after ?? {}) as { ai_allowance_override?: number | null };
      return `Set the AI allowance to ${describeAllowance(after.ai_allowance_override)}`;
    }
    case "managed_sending_pause":
      return "Paused managed sending";
    case "managed_sending_resume":
      return "Resumed managed sending";
    case "managed_sending_auto_pause":
      return "Managed sending was paused automatically (bounces or complaints too high)";
    case "ai_budget_set": {
      const after = (d.after ?? {}) as { monthly_usd?: number | null };
      return `Set the monthly AI budget to ${typeof after.monthly_usd === "number" ? formatCost(after.monthly_usd) : "nothing"}`;
    }
    case "ai_budget_clear":
      return "Removed the monthly AI budget";
    case "ai_provider_set":
      return `Added the ${slotLabel(d.slot)} AI provider`;
    case "ai_provider_change":
      return `Changed the ${slotLabel(d.slot)} AI provider`;
    case "ai_provider_enable":
      return `Switched the ${slotLabel(d.slot)} AI provider on`;
    case "ai_provider_disable":
      return `Switched the ${slotLabel(d.slot)} AI provider off`;
    case "ai_provider_remove":
      return `Removed the ${slotLabel(d.slot)} AI provider`;
    default:
      return e.action.replace(/_/g, " ");
  }
}

/** A hand-set AI allowance in words: null = the plan's, negative = no cap. */
export function describeAllowance(v: number | null | undefined): string {
  if (v === null || v === undefined) return "the plan's allowance";
  if (v < 0) return "no cap";
  return `${v.toLocaleString("en-US")} tokens a month`;
}

/** "$12.34", or "$0.0042" for tiny amounts so a few cents of cost does not read as zero. */
export function formatCost(usd: number): string {
  if (usd === 0) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return usd.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function slotLabel(slot: unknown): string {
  return slot === "fallback" ? "fallback" : "primary";
}

/** The workspace an audit entry is about; deleted workspaces keep their name inside the entry. */
export function auditWorkspaceName(e: AdminAuditEntry): string | null {
  if (e.tenant_name) return e.tenant_name;
  const n = e.detail?.workspace_name;
  return typeof n === "string" ? n : null;
}

/** Which admin header tab a path belongs to: workspace pages count as Overview. */
export function adminTabFor(pathname: string): "overview" | "ai" | "audit" | "security" {
  if (pathname === "/admin/ai" || pathname.startsWith("/admin/ai/")) return "ai";
  if (pathname === "/admin/audit" || pathname.startsWith("/admin/audit/")) return "audit";
  if (pathname === "/admin/security" || pathname.startsWith("/admin/security/")) return "security";
  return "overview";
}

/** Hours as "40 minutes", "3.5 hours", "2 days"; null as an em dash. */
export function formatHours(h: number | null | undefined): string {
  if (h === null || h === undefined || !Number.isFinite(h)) return "—";
  if (h < 1) {
    const m = Math.max(1, Math.round(h * 60));
    return `${m} minute${m === 1 ? "" : "s"}`;
  }
  if (h < 48) {
    const r = Math.round(h * 10) / 10;
    return `${r} hour${r === 1 ? "" : "s"}`;
  }
  const d = Math.round(h / 24);
  return `${d} days`;
}

const STAGE_SHORT: Record<string, string> = {
  signed_up: "signup",
  signed_in: "first sign-in",
  address: "adding an address",
  sender: "setting up sending",
  flow: "turning on a flow",
  event: "sending a first event",
  first_email: "the first delivered email",
};

/** One sentence naming where most new workspaces are lost, or null when nothing is. */
export function dropSentence(f: { cohort: number; biggest_drop: { from: string; to: string; lost: number } | null }): string | null {
  const d = f.biggest_drop;
  if (!d || f.cohort === 0) return null;
  const share = Math.round((d.lost / f.cohort) * 100);
  return `Biggest drop: between ${STAGE_SHORT[d.from] ?? d.from} and ${STAGE_SHORT[d.to] ?? d.to}. ${d.lost} ${d.lost === 1 ? "workspace" : "workspaces"} (${share}% of signups) did not get past it.`;
}

const GOAL_LABEL: Record<string, string> = {
  welcome: "welcome new signups",
  convert_trials: "convert trials",
  upgrade_free: "upgrade free users",
  explore: "just exploring",
  none: "skipped",
};

/** "convert trials 3, welcome new signups 2, skipped 1" in descending order, zeros left out; null when empty. */
export function goalsSentence(goals: Record<string, number>): string | null {
  const parts = Object.entries(goals)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${GOAL_LABEL[k] ?? k} ${n}`);
  return parts.length === 0 ? null : parts.join(", ");
}
