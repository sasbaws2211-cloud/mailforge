/**
 * Account data and deletion: API calls, hooks and the plain-language rules for
 * how the pending-deletion state is described.
 *
 * Mirror side: PUBLIC (apps/dashboard is mirrored).
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "./api.js";
import { ME_QUERY_KEY } from "./query-client.js";

export interface DeletionStatus {
  scheduled: boolean;
  requested_at: string | null;
  scheduled_at: string | null;
  requested_by: string | null;
  grace_days: number;
  workspace: { name: string; slug: string };
}

/** Where the browser goes to download the export (the server sends it as a file). */
export const EXPORT_URL = "/v1/account/export";

export const DELETION_KEY = ["account", "deletion"] as const;

async function accountRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(`/v1/account${path}`, init);
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

export function useDeletionStatus() {
  return useQuery({ queryKey: DELETION_KEY, queryFn: () => accountRequest<DeletionStatus>("/deletion") });
}

/** Ask to delete the workspace. The confirmation is the workspace name, typed by the owner. */
export function useScheduleDeletion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (confirm: string) =>
      accountRequest<{ ok: true; scheduled_at: string }>("/deletion", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm }),
      }),
    onSuccess: () => {
      // The whole app switches to the pending-deletion screen once /auth/me says so.
      void qc.invalidateQueries({ queryKey: DELETION_KEY });
      void qc.invalidateQueries({ queryKey: ME_QUERY_KEY });
    },
  });
}

export function useCancelDeletion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => accountRequest<{ ok: true }>("/deletion", { method: "DELETE" }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: DELETION_KEY });
      void qc.invalidateQueries({ queryKey: ME_QUERY_KEY });
    },
  });
}

/** Does what the owner typed match the workspace name exactly (ignoring outer spaces)? */
export function confirmationMatches(typed: string, slug: string): boolean {
  return slug.length > 0 && typed.trim() === slug;
}

/** "in 6 days", "in 1 day", "today": time left before erasure, rounded up. */
export function timeUntilErasure(scheduledAtIso: string, now: Date = new Date()): string {
  const ms = new Date(scheduledAtIso).getTime() - now.getTime();
  if (ms <= 0) return "today";
  const days = Math.ceil(ms / 86_400_000);
  return days === 1 ? "in 1 day" : `in ${days} days`;
}
