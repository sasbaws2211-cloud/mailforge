/**
 * Support requests, the customer side: the API client, the hooks and the plain-language labels. The admin console's side is in
 * admin-support.ts. Mirrors the API's rules (packages/api/src/support/logic.ts), which have the last word.
 *
 * Mirror side: PUBLIC (apps/dashboard is mirrored).
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "./api.js";

export const TICKET_CATEGORIES = ["question", "bug", "billing", "feature", "other"] as const;
export type TicketCategory = (typeof TICKET_CATEGORIES)[number];
export type TicketStatus = "open" | "answered" | "closed";

export const CATEGORY_LABEL: Record<TicketCategory, string> = {
  question: "A question",
  bug: "Something is broken",
  billing: "Billing",
  feature: "A feature request",
  other: "Something else",
};

/** What the customer sees for each status. "answered" means support replied and the ball is in their court. */
export const STATUS_LABEL: Record<TicketStatus, string> = { open: "Waiting for support", answered: "Support replied", closed: "Closed" };

export const MAX_SUBJECT = 150;
export const MAX_MESSAGE = 5000;

export interface Ticket {
  id: string;
  subject: string;
  category: TicketCategory;
  status: TicketStatus;
  page_url: string | null;
  requester: string;
  created_at: string;
  last_message_at: string;
  last_message_by: "customer" | "staff";
  closed_at: string | null;
}

export interface TicketMessage {
  id: string;
  author: "customer" | "staff";
  /** Only a customer's own messages carry an email: staff are shown as "Support". */
  author_email: string | null;
  body: string;
  created_at: string;
}

async function supportFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(`/v1/support${path}`, init);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; issues?: Array<{ message: string }> };
    throw new Error(body.issues?.[0]?.message ?? body.error ?? `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}
const post = (body?: unknown): RequestInit => ({ method: "POST", ...(body !== undefined ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) });

export const SUPPORT_KEY = ["support"] as const;

export const fetchTickets = () => supportFetch<{ tickets: Ticket[] }>("/tickets");
export const fetchTicket = (id: string) => supportFetch<{ ticket: Ticket; messages: TicketMessage[] }>(`/tickets/${id}`);
export const createTicket = (input: { subject: string; message: string; category: TicketCategory; page_url?: string }) => supportFetch<{ ticket: Ticket }>("/tickets", post(input));
export const replyToTicket = (id: string, message: string) => supportFetch<{ ticket: Ticket }>(`/tickets/${id}/reply`, post({ message }));
export const closeTicket = (id: string) => supportFetch<{ ticket: Ticket }>(`/tickets/${id}/close`, post());

export function useTickets() {
  return useQuery({ queryKey: [...SUPPORT_KEY, "list"], queryFn: fetchTickets });
}
export function useTicket(id: string) {
  return useQuery({ queryKey: [...SUPPORT_KEY, "ticket", id], queryFn: () => fetchTicket(id) });
}
export function useCreateTicket() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: createTicket, onSuccess: () => qc.invalidateQueries({ queryKey: SUPPORT_KEY }) });
}
export function useReplyToTicket(id: string) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (message: string) => replyToTicket(id, message), onSuccess: () => qc.invalidateQueries({ queryKey: SUPPORT_KEY }) });
}
export function useCloseTicket(id: string) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: () => closeTicket(id), onSuccess: () => qc.invalidateQueries({ queryKey: SUPPORT_KEY }) });
}

/** Problems with a new request, in plain words, before it is sent. Empty when it is fine. */
export function newTicketProblems(input: { subject: string; message: string }): string[] {
  const problems: string[] = [];
  const subject = input.subject.trim();
  const message = input.message.trim();
  if (subject.length < 3) problems.push("Give your request a short subject (at least 3 characters).");
  else if (subject.length > MAX_SUBJECT) problems.push(`The subject is too long (at most ${MAX_SUBJECT} characters).`);
  if (message.length < 5) problems.push("Tell us what is happening (at least 5 characters).");
  else if (message.length > MAX_MESSAGE) problems.push(`The message is too long (at most ${MAX_MESSAGE} characters).`);
  return problems;
}

/** A reply cannot be empty or longer than the limit. */
export function replyProblem(message: string): string | null {
  const m = message.trim();
  if (m.length === 0) return "Write a message first.";
  if (m.length > MAX_MESSAGE) return `The message is too long (at most ${MAX_MESSAGE} characters).`;
  return null;
}

/** "just now", "5 minutes ago", "3 hours ago", "yesterday", "4 days ago", else the date. */
export function timeAgo(iso: string, now: Date = new Date()): string {
  const secs = Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  return new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

/** The page to attach to a new request: the page the person came from, when it is a path inside the app. */
export function pageToAttach(from: string | null | undefined): string | undefined {
  if (!from || !/^\/[A-Za-z0-9\-._~!$&'()*+,;=:@%/?#]{0,299}$/.test(from) || from.startsWith("//")) return undefined;
  // Their own support pages are not what they needed help with.
  return from.startsWith("/support") ? undefined : from;
}
