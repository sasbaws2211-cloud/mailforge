/**
 * Segments: the API calls and the hooks the screens use.
 *
 * A segment is a saved group of contacts described by rules (see segment-rules.ts for the rules, and the
 * server's /v1/segments routes for what each call does). Counts are a cache with a time on them, and a preview
 * counts a definition that is not saved yet.
 *
 * Mirror side: PUBLIC (apps/dashboard is mirrored).
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "./api.js";
import type { ApiSegmentDefinition } from "./segment-rules.js";

export const SEGMENTS_QUERY_KEY = ["segments"] as const;

export interface SegmentFlowRef {
  id: string;
  name: string;
  status: string | null;
}

export interface Segment {
  id: string;
  name: string;
  description: string | null;
  definition: unknown;
  member_count: number | null;
  /** True when counting stopped at the limit, so the real number is at least member_count. */
  count_capped: boolean;
  counted_at: string | null;
  archived: boolean;
  created_at: string | null;
  updated_at: string | null;
  /** Present on a single segment: the flows that start from it. */
  used_by_flows?: SegmentFlowRef[];
  /** Present in the list: how many flows start from it. */
  flow_count?: number;
}

export interface PreviewContact {
  id: string;
  external_id: string;
  email: string | null;
  name: string | null;
  lifecycle_state: string;
  payment_status: string | null;
  last_seen_at: string | null;
}

export interface SegmentPreview {
  count: number;
  capped: boolean;
  /** Of those counted, how many have an email that is not suppressed. */
  reachable: number;
  sample: PreviewContact[];
  /** Event names the rules use that this workspace has never received. */
  never_sent_events: string[];
}

/** A call that failed, with what the server said. */
export class SegmentApiError extends Error {
  readonly status: number;
  readonly issues: Array<{ path: string; message: string }>;
  readonly flows: SegmentFlowRef[];
  constructor(status: number, message: string, issues: Array<{ path: string; message: string }> = [], flows: SegmentFlowRef[] = []) {
    super(message);
    this.name = "SegmentApiError";
    this.status = status;
    this.issues = issues;
    this.flows = flows;
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(`/v1/segments${path}`, {
    ...init,
    headers: init?.body ? { "Content-Type": "application/json", ...(init.headers ?? {}) } : init?.headers,
  });
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) {
    const issues = Array.isArray(body?.issues) ? (body!.issues as Array<{ path: string; message: string }>) : [];
    const message =
      typeof body?.error === "string" && body.error !== "Validation failed"
        ? body.error
        : issues[0]?.message ?? `That did not work (${res.status}).`;
    throw new SegmentApiError(res.status, message, issues, Array.isArray(body?.flows) ? (body!.flows as SegmentFlowRef[]) : []);
  }
  return body as T;
}

export interface SegmentInput {
  name: string;
  description?: string | null;
  definition: ApiSegmentDefinition;
}

export const listSegments = () => call<{ segments: Segment[] }>("").then((r) => r.segments);
export const getSegment = (id: string) => call<Segment>(`/${encodeURIComponent(id)}`);
export const createSegment = (input: SegmentInput) => call<Segment>("", { method: "POST", body: JSON.stringify(input) });
export const updateSegment = (id: string, input: Partial<SegmentInput>) =>
  call<Segment>(`/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(input) });
export const refreshSegment = (id: string) => call<Segment>(`/${encodeURIComponent(id)}/refresh`, { method: "POST" });
export const archiveSegment = (id: string) => call<Segment>(`/${encodeURIComponent(id)}`, { method: "DELETE" });
export const previewSegment = (definition: ApiSegmentDefinition) =>
  call<SegmentPreview>("/preview", { method: "POST", body: JSON.stringify({ definition }) });

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/** The workspace's live segments, newest first. */
export function useSegments() {
  return useQuery({ queryKey: SEGMENTS_QUERY_KEY, queryFn: listSegments });
}

export function useSegment(id: string | undefined) {
  return useQuery({
    queryKey: [...SEGMENTS_QUERY_KEY, id],
    queryFn: () => getSegment(id!),
    enabled: Boolean(id),
  });
}

export function useCreateSegment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: createSegment,
    onSuccess: () => qc.invalidateQueries({ queryKey: SEGMENTS_QUERY_KEY }),
  });
}

export function useUpdateSegment(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Partial<SegmentInput>) => updateSegment(id, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: SEGMENTS_QUERY_KEY }),
  });
}

export function useRefreshSegment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: refreshSegment,
    onSuccess: () => qc.invalidateQueries({ queryKey: SEGMENTS_QUERY_KEY }),
  });
}

export function useArchiveSegment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: archiveSegment,
    onSuccess: () => qc.invalidateQueries({ queryKey: SEGMENTS_QUERY_KEY }),
  });
}

/**
 * Count and sample a definition that is not saved yet. Pass null while the rules are not valid and nothing is
 * asked. Results are kept briefly so flipping back to rules already tried is instant.
 */
export function useSegmentPreview(definition: ApiSegmentDefinition | null) {
  return useQuery({
    queryKey: ["segment-preview", definition],
    queryFn: () => previewSegment(definition!),
    enabled: definition !== null,
    staleTime: 30_000,
    retry: false,
    placeholderData: (previous) => previous,
  });
}
