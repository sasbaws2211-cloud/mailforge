/**
 * The in-app assistant, the dashboard side: the API client, the hooks, and the small pure helpers the chat panel uses (formatting an
 * answer safely, remembering the conversation, writing a transcript for Support). Mirrors the API's rules
 * (packages/api/src/routes/assistant.ts), which have the last word.
 *
 * Mirror side: PUBLIC (apps/dashboard is mirrored).
 */
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiFetch } from "./api.js";

export const MAX_QUESTION = 2000;
/** The most turns sent with a question; older ones are dropped. The server keeps the last eight. */
export const MAX_SENT = 12;
/** The most messages kept in the browser for one conversation. */
export const MAX_KEPT = 40;

export interface AssistantSource {
  id: string;
  source: string;
  heading: string;
  /** A dashboard page that does what this describes. */
  path?: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  sources?: AssistantSource[];
  /** The assistant says a person should take over. */
  suggestSupport?: boolean;
  /** An error or notice shown in the conversation, not sent to the model. */
  notice?: boolean;
  /** A support request created from this conversation. */
  ticketId?: string;
}

export interface AssistantStatus {
  available: boolean;
  daily: { limit: number; remaining: number } | null;
}

export interface AssistantAnswer {
  answer: string;
  sources: AssistantSource[];
  suggest_support: boolean;
  remaining: number | null;
}

export class AssistantError extends Error {
  constructor(
    message: string,
    public readonly code: string | null,
    public readonly status: number,
  ) {
    super(message);
  }
}

async function assistantFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(`/v1/assistant${path}`, init);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string; issues?: Array<{ message: string }> };
    throw new AssistantError(body.issues?.[0]?.message ?? body.error ?? `Request failed (${res.status})`, body.code ?? null, res.status);
  }
  return res.json() as Promise<T>;
}

export const fetchAssistantStatus = () => assistantFetch<AssistantStatus>("/status");
export const askAssistant = (input: { messages: Array<{ role: "user" | "assistant"; content: string }>; page?: string }) =>
  assistantFetch<AssistantAnswer>("/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });

export function useAssistantStatus() {
  return useQuery({ queryKey: ["assistant", "status"], queryFn: fetchAssistantStatus, staleTime: 5 * 60_000, retry: false });
}
export function useAskAssistant() {
  return useMutation({ mutationFn: askAssistant });
}

let counter = 0;
export const newId = () => `m${Date.now().toString(36)}${(counter++).toString(36)}`;

/** What goes to the server: the real conversation, not the notices, newest turns only, ending on the user's question. */
export function messagesToSend(history: readonly ChatMessage[]): Array<{ role: "user" | "assistant"; content: string }> {
  const real = history.filter((m) => !m.notice).map((m) => ({ role: m.role, content: m.content.slice(0, MAX_QUESTION) }));
  const sent = real.slice(-MAX_SENT);
  // A conversation must start with the person's words.
  while (sent.length > 0 && sent[0]!.role !== "user") sent.shift();
  return sent;
}

/** Problems with a question before it is sent, in plain words, or null. */
export function questionProblem(text: string): string | null {
  const t = text.trim();
  if (t.length === 0) return "Type a question first.";
  if (t.length > MAX_QUESTION) return `Please keep it under ${MAX_QUESTION} characters.`;
  return null;
}

/** The conversation as plain text, for a support request (kept within what a request allows). */
export function transcript(history: readonly ChatMessage[], limit = 4800): string {
  const lines = history.filter((m) => !m.notice).map((m) => `${m.role === "user" ? "Me" : "Assistant"}: ${m.content}`);
  let text = lines.join("\n\n");
  if (text.length > limit) text = "…\n\n" + text.slice(text.length - (limit - 3));
  return text;
}

/** A short subject for a support request made from a conversation: what the person last asked. */
export function subjectFrom(history: readonly ChatMessage[]): string {
  const last = [...history].reverse().find((m) => m.role === "user" && !m.notice)?.content ?? "";
  const oneLine = last.replace(/\s+/g, " ").trim();
  if (oneLine.length < 3) return "Help from the assistant";
  return oneLine.length > 120 ? oneLine.slice(0, 117) + "..." : oneLine;
}

// ---------------------------------------------------------------------------
// Showing an answer safely
// ---------------------------------------------------------------------------

export type Segment = { kind: "text" | "bold" | "code"; text: string };

/**
 * Split a line into plain text, **bold** and `code`. The assistant's words are only ever shown as text: this is the whole of the
 * formatting, and there is no way for an answer to become a link, an image or markup.
 */
export function inlineSegments(line: string): Segment[] {
  const out: Segment[] = [];
  const re = /\*\*([^*\n]+)\*\*|`([^`\n]+)`/g;
  let last = 0;
  for (let m = re.exec(line); m !== null; m = re.exec(line)) {
    if (m.index > last) out.push({ kind: "text", text: line.slice(last, m.index) });
    if (m[1] !== undefined) out.push({ kind: "bold", text: m[1] });
    else out.push({ kind: "code", text: m[2]! });
    last = m.index + m[0].length;
  }
  if (last < line.length) out.push({ kind: "text", text: line.slice(last) });
  return out;
}

export type Block = { kind: "paragraph"; text: string } | { kind: "list"; ordered: boolean; items: string[] };

/** Paragraphs and simple lists ("1. step", "- item") from an answer. */
export function answerBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  const flush = () => {
    if (list) blocks.push({ kind: "list", ordered: list.ordered, items: list.items });
    list = null;
  };
  let para: string[] = [];
  const flushPara = () => {
    if (para.length) blocks.push({ kind: "paragraph", text: para.join(" ") });
    para = [];
  };
  for (const raw of text.replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.trim();
    const ordered = /^\d+[.)]\s+(.*)$/.exec(line);
    const bullet = /^[-*•]\s+(.*)$/.exec(line);
    if (ordered || bullet) {
      flushPara();
      const isOrdered = Boolean(ordered);
      if (list && list.ordered !== isOrdered) flush();
      list ??= { ordered: isOrdered, items: [] };
      list.items.push((ordered ?? bullet)![1]!);
    } else if (line === "") {
      flushPara();
      flush();
    } else {
      flush();
      para.push(line);
    }
  }
  flushPara();
  flush();
  return blocks;
}

// ---------------------------------------------------------------------------
// Remembering the conversation while the tab is open
// ---------------------------------------------------------------------------

const STORAGE_KEY = "loomail.assistant.v1";

/** Read the saved conversation. Anything wrong with it (not there, broken, from another version) is an empty conversation. */
export function loadChat(storage: Pick<Storage, "getItem"> | null = safeSession()): ChatMessage[] {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw) return [];
    const data: unknown = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    const out: ChatMessage[] = [];
    for (const m of data) {
      if (!m || typeof m !== "object") continue;
      const r = m as Record<string, unknown>;
      if ((r.role !== "user" && r.role !== "assistant") || typeof r.content !== "string" || typeof r.id !== "string") continue;
      out.push({
        id: r.id,
        role: r.role,
        content: r.content.slice(0, 4000),
        ...(Array.isArray(r.sources) ? { sources: (r.sources as AssistantSource[]).filter((s) => s && typeof s.heading === "string" && typeof s.source === "string").slice(0, 3) } : {}),
        ...(r.suggestSupport === true ? { suggestSupport: true } : {}),
        ...(r.notice === true ? { notice: true } : {}),
        ...(typeof r.ticketId === "string" ? { ticketId: r.ticketId } : {}),
      });
    }
    return out.slice(-MAX_KEPT);
  } catch {
    return [];
  }
}

export function saveChat(messages: readonly ChatMessage[], storage: Pick<Storage, "setItem" | "removeItem"> | null = safeSession()): void {
  try {
    if (messages.length === 0) storage?.removeItem(STORAGE_KEY);
    else storage?.setItem(STORAGE_KEY, JSON.stringify(messages.slice(-MAX_KEPT)));
  } catch {
    /* private window or storage full: the conversation simply is not remembered */
  }
}

function safeSession(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export { suggestionsFor } from "./assistant-suggestions.js";
