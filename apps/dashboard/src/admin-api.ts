/**
 * Platform admin console API client (/v1/admin/*). Only works for platform
 * admins; everyone else gets a 404 from the server.
 *
 * Mirror side: PUBLIC (apps/dashboard is mirrored).
 */
import { apiFetch } from "./api.js";

export type AdminPaymentStatus = "none" | "current" | "overdue" | "lapsed";

export interface AdminWorkspace {
  id: string;
  name: string;
  slug: string;
  owner_email: string | null;
  created_at: string | null;
  stored_plan: string;
  effective_plan: { id: string; name: string };
  on_trial: boolean;
  trial_ends_at: string | null;
  payment_status: AdminPaymentStatus;
  paid_through: string | null;
  suspended: boolean;
  suspended_at: string | null;
  suspended_reason: string | null;
  deletion_scheduled_at: string | null;
  deletion_requested_by: string | null;
  /** A hand-set Mailforge AI token allowance: null = the plan's, -1 = no cap. */
  ai_allowance_override: number | null;
  contacts: number;
  emails_this_month: number;
  members: number;
  subscription: { status: string; plan: string | null; interval: string | null } | null;
}

export interface AdminOverview {
  workspaces: {
    total: number;
    suspended: number;
    signups_7d: number;
    signups_30d: number;
    by_stored_plan: { trial_running: number; trial_ended: number; free: number; starter: number; growth: number; scale: number };
  };
  revenue: { currency: string; mrr_usd: number; active_subscriptions: number; cancelling_subscriptions: number };
  usage: { contacts: number; emails_this_month: number };
  attention: { payments_overdue: number; subscriptions_lapsed: number; trials_ending_in_3_days: number };
  billing_enabled: boolean;
  generated_at: string;
}

export type FunnelStageId = "signed_up" | "signed_in" | "address" | "sender" | "flow" | "event" | "first_email" | "paid";

export interface AdminFunnel {
  days: 7 | 30 | 90;
  cohort: number;
  stages: { id: FunnelStageId; label: string; count: number; percent: number }[];
  biggest_drop: { from: FunnelStageId; to: FunnelStageId; lost: number } | null;
  median_hours_to_first_email: number | null;
  stalled: number;
  nudged: number;
  set_aside: number;
  goals: Record<"welcome" | "convert_trials" | "upgrade_free" | "explore" | "none", number>;
  generated_at: string;
}

export type AdminListStatus = "all" | "trial" | "free" | "paid" | "suspended";

export interface AdminTenantList {
  tenants: AdminWorkspace[];
  total: number;
  limit: number;
  offset: number;
}

export interface AdminAuditEntry {
  actor: string;
  action: string;
  tenant_id?: string | null;
  tenant_name?: string | null;
  detail: Record<string, unknown> | null;
  at: string | null;
}

export interface AdminTenantDetail {
  workspace: AdminWorkspace;
  usage: { contacts: number; emails_this_month: number; members: number; pending_invites: number };
  activity: { last_email_sent_at: string | null; flows: number; has_email_transport: boolean };
  /** Managed sending (through the operator's Resend): null when the workspace never turned it on. */
  sending: null | {
    enabled: boolean;
    domain: string | null;
    domain_status: string;
    /** Who paused it: an admin's email, or "auto" when sender health did. */
    paused: null | { at: string; reason: string | null; by: string | null };
    warned_at: string | null;
  };
  /** AI this month: where the workspace gets its AI from and what it used. */
  ai: {
    source: "byok" | "platform";
    platform_tokens_this_month: number;
    byok_tokens_this_month: number;
    calls_this_month: number;
    /** What this workspace's Mailforge AI use cost you this month, in US dollars. */
    platform_cost_usd: number;
    /** A hand-set allowance, or null when the plan's applies; -1 = no cap. */
    allowance_override: number | null;
    /** The allowance in force in Mailforge AI tokens; null = no cap. */
    allowance_tokens: number | null;
  };
  members: Array<{ email: string; name: string | null; role: string; last_login_at: string | null; deactivated: boolean }>;
  subscriptions: Array<{
    plan: string;
    interval: string;
    amount_usd: number;
    currency: string;
    status: string;
    payer_email: string;
    current_period_end: string | null;
    cancel_at_period_end: boolean;
    last_payment_at: string | null;
    created_at: string | null;
  }>;
  billing_events: Array<{ type: string; outcome: string; at: string | null }>;
  audit: AdminAuditEntry[];
  billing_enabled: boolean;
}

async function adminRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(`/v1/admin${path}`, init);
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

const adminPost = <T>(path: string, body: unknown) =>
  adminRequest<T>(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

export const fetchAdminOverview = () => adminRequest<AdminOverview>("/overview");

export const fetchAdminFunnel = (days: 7 | 30 | 90) => adminRequest<AdminFunnel>(`/funnel?days=${days}`);

export function fetchAdminTenants(p: { q: string; status: AdminListStatus; offset: number; limit: number }) {
  const qs = new URLSearchParams({ status: p.status, offset: String(p.offset), limit: String(p.limit) });
  if (p.q.trim()) qs.set("q", p.q.trim());
  return adminRequest<AdminTenantList>(`/tenants?${qs}`);
}

export const fetchAdminTenant = (id: string) => adminRequest<AdminTenantDetail>(`/tenants/${encodeURIComponent(id)}`);

/** Where an admin downloads a workspace's data export. */
export const adminExportUrl = (id: string) => `/v1/admin/tenants/${encodeURIComponent(id)}/export`;

export const fetchAdminAudit = (limit = 20) => adminRequest<{ entries: AdminAuditEntry[] }>(`/audit?limit=${limit}`);

export type AdminAction =
  | { kind: "plan"; plan: string; reason: string }
  | { kind: "trial"; days: number; reason: string }
  | { kind: "suspend"; reason: string }
  | { kind: "unsuspend"; reason: string }
  | { kind: "cancel-subscription"; reason: string }
  | { kind: "delete"; confirm: string; immediate: boolean; reason: string }
  | { kind: "cancel-deletion"; reason: string }
  | { kind: "ai-allowance"; tokens: number | "unlimited" | null; reason: string }
  | { kind: "managed-sending"; action: "pause" | "resume"; reason: string };

export function postAdminAction(id: string, a: AdminAction) {
  const base = `/tenants/${encodeURIComponent(id)}`;
  switch (a.kind) {
    case "plan":
      return adminPost<{ ok: true }>(`${base}/plan`, { plan: a.plan, reason: a.reason });
    case "trial":
      return adminPost<{ ok: true }>(`${base}/trial`, { days: a.days, reason: a.reason });
    case "managed-sending":
      return adminPost<{ ok: true }>(`${base}/managed-sending`, { action: a.action, reason: a.reason });
    case "ai-allowance":
      return adminPost<{ ok: true }>(`${base}/ai-allowance`, { tokens: a.tokens, reason: a.reason });
    case "delete":
      return adminPost<{ ok: true; deleted: boolean }>(`${base}/delete`, { confirm: a.confirm, immediate: a.immediate, reason: a.reason });
    default:
      return adminPost<{ ok: true }>(`${base}/${a.kind}`, { reason: a.reason });
  }
}

// ---------------------------------------------------------------------------
// AI providers (Mailforge AI)
// ---------------------------------------------------------------------------

export type AdminAiSlot = "primary" | "fallback";

export type AdminAiProvider =
  | { slot: AdminAiSlot; configured: false }
  | {
      slot: AdminAiSlot;
      configured: true;
      provider: string;
      enabled: boolean;
      /** Non-secret details; null when the saved key can no longer be read. */
      model: string | null;
      base_url: string | null;
      embedding_model: string | null;
      /** What the provider charges, US dollars per million tokens; null when not set. */
      input_price: number | null;
      output_price: number | null;
      readable: boolean;
      updated_by: string | null;
      updated_at: string | null;
    };

export interface AdminAiOverview {
  encryption_configured: boolean;
  known_providers: string[];
  providers: AdminAiProvider[];
  /** At least one switched-on provider exists, so workspaces without their own key can use AI. */
  available: boolean;
  /** The operator's monthly dollar budget. At 100% Mailforge AI pauses for every workspace on it. */
  budget: { monthly_usd: number | null; spent_usd: number; state: "none" | "ok" | "near" | "reached"; max_usd: number };
  /** A switched-on provider has no prices, so the dollar figures undercount. */
  prices_missing: boolean;
  /** How the operator's provider did in the last few minutes (customers' own keys never count). */
  health: { window_minutes: number; calls: number; failed: number; rate: number; unhealthy: boolean };
  usage: {
    since: string;
    platform_tokens: number;
    platform_calls: number;
    platform_failed_calls: number;
    platform_workspaces: number;
    /** What Mailforge AI cost you this month (chat calls; embeddings are not priced). */
    platform_cost_usd: number;
    byok_tokens: number;
    by_feature: Array<{ feature: string; tokens: number; calls: number; cost_usd: number }>;
  };
  top_workspaces: Array<{ id: string; name: string; slug: string; plan: string; tokens: number; cost_usd: number; calls: number; failed_calls: number }>;
}

export interface AdminAiSaveInput {
  provider: string;
  /** Leave blank to keep the saved key (same provider only). */
  api_key?: string;
  base_url?: string;
  model?: string;
  embedding_model?: string;
  /** US dollars per million tokens. Left out keeps the saved price; null clears it. */
  input_price?: number | null;
  output_price?: number | null;
  reason: string;
}

export const fetchAdminAi = () => adminRequest<AdminAiOverview>("/ai");

export const saveAdminAi = (slot: AdminAiSlot, input: AdminAiSaveInput) =>
  adminRequest<{ ok: true }>(`/ai/${slot}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });

export const setAdminAiEnabled = (slot: AdminAiSlot, enabled: boolean, reason: string) =>
  adminPost<{ ok: true }>(`/ai/${slot}/enabled`, { enabled, reason });

/** Set the monthly dollar budget, or null to remove it. */
export const saveAdminAiBudget = (monthlyUsd: number | null, reason: string) =>
  adminRequest<{ ok: true }>("/ai/budget", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ monthly_usd: monthlyUsd, reason }) });

export const removeAdminAi = (slot: AdminAiSlot, reason: string) => adminPost<{ ok: true }>(`/ai/${slot}/remove`, { reason });

export type AdminAiTestResult = { ok: true } | { ok: false; kind?: string; status?: number | null; detail?: string; error?: string };

/** Makes one tiny real call with the saved key. A key that stopped working answers 200 with ok:false. */
export async function testAdminAi(slot: AdminAiSlot): Promise<AdminAiTestResult> {
  const res = await apiFetch(`/v1/admin/ai/${slot}/test`, { method: "POST" });
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; kind?: string; status?: number | null; detail?: string; error?: string };
  if (body.ok === true) return { ok: true };
  if (body.ok === false) return { ok: false, kind: body.kind, status: body.status, detail: body.detail, error: body.error };
  return { ok: false, error: body.error ?? `Request failed (${res.status})` };
}
