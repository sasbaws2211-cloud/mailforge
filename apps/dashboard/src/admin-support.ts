/**
 * Platform admin console: support requests from every workspace (/v1/admin/support). Only works for platform admins; everyone else
 * gets a 404 from the server. The customer's side is in support.ts.
 *
 * Mirror side: PUBLIC (apps/dashboard is mirrored).
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "./api.js";
import { ADMIN_KEY } from "./admin.js";
import type { Ticket, TicketCategory, TicketMessage, TicketStatus } from "./support.js";

export type AdminSupportFilter = TicketStatus | "all";

export interface AdminSupportRow {
  id: string;
  subject: string;
  category: TicketCategory;
  status: TicketStatus;
  requester: string;
  workspace: { id: string; name: string; slug: string; plan: string };
  created_at: string;
  last_message_at: string;
  last_message_by: "customer" | "staff";
}

export interface AdminSupportList {
  counts: Record<TicketStatus, number>;
  tickets: AdminSupportRow[];
}

export interface AdminSupportThread {
  ticket: Ticket;
  workspace: { id: string; name: string; slug: string; plan: string };
  messages: Array<TicketMessage & { author_email: string }>;
}

async function adminSupportFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(`/v1/admin/support${path}`, init);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; issues?: Array<{ message: string }> };
    throw new Error(body.issues?.[0]?.message ?? body.error ?? `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}
const post = (body: unknown): RequestInit => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

export const fetchAdminSupport = (p: { status: AdminSupportFilter; q: string }) => {
  const qs = new URLSearchParams({ status: p.status, limit: "100" });
  if (p.q.trim()) qs.set("q", p.q.trim());
  return adminSupportFetch<AdminSupportList>(`?${qs.toString()}`);
};
export const fetchAdminSupportThread = (id: string) => adminSupportFetch<AdminSupportThread>(`/${id}`);
export const replyAdminSupport = (id: string, input: { message: string; close: boolean }) => adminSupportFetch<{ ok: true; status: TicketStatus; emailed: boolean }>(`/${id}/reply`, post(input));
export const setAdminSupportStatus = (id: string, status: "open" | "closed") => adminSupportFetch<{ ok: true; status: TicketStatus }>(`/${id}/status`, post({ status }));

const SUPPORT_KEY = [...ADMIN_KEY, "support"] as const;

export function useAdminSupport(p: { status: AdminSupportFilter; q: string }) {
  return useQuery({ queryKey: [...SUPPORT_KEY, "list", p], queryFn: () => fetchAdminSupport(p), placeholderData: (prev) => prev, refetchInterval: 60_000 });
}
export function useAdminSupportThread(id: string) {
  return useQuery({ queryKey: [...SUPPORT_KEY, "thread", id], queryFn: () => fetchAdminSupportThread(id) });
}
export function useAdminSupportReply(id: string) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (input: { message: string; close: boolean }) => replyAdminSupport(id, input), onSuccess: () => qc.invalidateQueries({ queryKey: SUPPORT_KEY }) });
}
export function useAdminSupportStatus(id: string) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (status: "open" | "closed") => setAdminSupportStatus(id, status), onSuccess: () => qc.invalidateQueries({ queryKey: SUPPORT_KEY }) });
}

/** How long a request has been waiting, for the queue: "3 hours", "2 days". */
export function waitingFor(iso: string, now: Date = new Date()): string {
  const mins = Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / 60000));
  if (mins < 60) return `${Math.max(1, mins)} min`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"}`;
  return `${Math.floor(hours / 24)} days`;
}
