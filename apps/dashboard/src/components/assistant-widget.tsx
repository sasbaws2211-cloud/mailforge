/**
 * The in-app assistant: a button in the corner of every dashboard page that opens a small chat. It explains how Loomail works, points
 * to the right page, and can hand the conversation to Support. It only explains: it changes nothing in the workspace.
 *
 * Mounted once, in the dashboard shell, so it is on every page of a working workspace. A suspended workspace or one waiting for deletion
 * never reaches the shell, so it never sees this. The conversation is kept in the tab (not on the server) until the tab closes.
 *
 * Mirror side: PUBLIC (apps/dashboard is mirrored).
 */
import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { LifeBuoy, RotateCcw, Send, Sparkles, X } from "lucide-react";
import { Button } from "./ui/button.js";
import { Textarea } from "./ui/textarea.js";
import { cn } from "../lib/utils.js";
import {
  AssistantError,
  MAX_QUESTION,
  answerBlocks,
  inlineSegments,
  loadChat,
  messagesToSend,
  newId,
  questionProblem,
  saveChat,
  subjectFrom,
  suggestionsFor,
  transcript,
  useAskAssistant,
  useAssistantStatus,
  type ChatMessage,
} from "../assistant.js";
import { createTicket } from "../support.js";

function Inline({ text }: { text: string }) {
  return (
    <>
      {inlineSegments(text).map((s, i) =>
        s.kind === "bold" ? (
          <strong key={i} className="font-semibold text-foreground">{s.text}</strong>
        ) : s.kind === "code" ? (
          <code key={i} className="rounded bg-sunken px-1 font-mono text-[12px]">{s.text}</code>
        ) : (
          <Fragment key={i}>{s.text}</Fragment>
        ),
      )}
    </>
  );
}

/** An answer as paragraphs and lists. Only ever text: nothing in it can become a link, an image or markup. */
function Answer({ text }: { text: string }) {
  return (
    <div className="space-y-2">
      {answerBlocks(text).map((b, i) =>
        b.kind === "paragraph" ? (
          <p key={i}><Inline text={b.text} /></p>
        ) : b.ordered ? (
          <ol key={i} className="list-decimal space-y-1 pl-5">{b.items.map((it, j) => <li key={j}><Inline text={it} /></li>)}</ol>
        ) : (
          <ul key={i} className="list-disc space-y-1 pl-5">{b.items.map((it, j) => <li key={j}><Inline text={it} /></li>)}</ul>
        ),
      )}
    </div>
  );
}

export function AssistantWidget() {
  const { pathname, search } = useLocation();
  const status = useAssistantStatus();
  const ask = useAskAssistant();
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>(() => loadChat());
  const [text, setText] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [sendingToSupport, setSendingToSupport] = useState(false);
  const [remaining, setRemaining] = useState<number | null | undefined>(undefined);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => saveChat(messages), [messages]);
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);
  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: "end" });
  }, [messages, ask.isPending, open]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const left = remaining !== undefined ? remaining : status.data?.daily?.remaining ?? null;

  const send = useCallback(
    (question: string) => {
      const p = questionProblem(question);
      setProblem(p);
      if (p || ask.isPending) return;
      const next: ChatMessage[] = [...messages, { id: newId(), role: "user", content: question.trim() }];
      setMessages(next);
      setText("");
      ask.mutate(
        { messages: messagesToSend(next), page: pathname + search },
        {
          onSuccess: (r) => {
            setRemaining(r.remaining);
            setMessages((m) => [...m, { id: newId(), role: "assistant", content: r.answer, sources: r.sources, suggestSupport: r.suggest_support }]);
          },
          onError: (err) => {
            if (err instanceof AssistantError && err.code === "assistant_daily_limit") setRemaining(0);
            const message = err instanceof Error ? err.message : "Something went wrong. Please try again.";
            setMessages((m) => [...m, { id: newId(), role: "assistant", content: message, notice: true, suggestSupport: true }]);
          },
        },
      );
    },
    [ask, messages, pathname, search],
  );

  async function toSupport() {
    setSendingToSupport(true);
    try {
      const r = await createTicket({ subject: subjectFrom(messages), message: transcript(messages), category: "question", page_url: pathname });
      setMessages((m) => [...m.map((x) => ({ ...x, suggestSupport: false })), { id: newId(), role: "assistant", content: "I sent this conversation to Support. They will reply by email, and you can follow it under Support.", notice: true, ticketId: r.ticket.id }]);
    } catch (err) {
      setMessages((m) => [...m, { id: newId(), role: "assistant", content: err instanceof Error ? err.message : "I could not send that to Support. Please use the Support page.", notice: true }]);
    } finally {
      setSendingToSupport(false);
    }
  }

  // Not offered when the operator has not switched an assistant on, and nothing flashes in while it is being checked.
  if (!status.data?.available) return null;

  const empty = messages.length === 0;
  const limitReached = left === 0;

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-40 flex justify-end p-3 sm:p-5" data-testid="assistant">
      {open ? (
        <section
          role="dialog"
          aria-label="Loomail assistant"
          className="pointer-events-auto flex h-[min(34rem,calc(100vh-1.5rem))] w-full flex-col overflow-hidden rounded-xl border border-border bg-card shadow-xl sm:w-[24rem]"
        >
          <header className="flex items-center gap-2 border-b border-border px-4 py-3">
            <Sparkles size={16} strokeWidth={1.75} className="text-accent-text" aria-hidden="true" />
            <h2 className="flex-1 text-[14px] font-semibold text-foreground">Assistant</h2>
            {!empty && (
              <button type="button" className="rounded p-1 text-muted-foreground hover:bg-sunken hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label="Start a new conversation" title="Start a new conversation" onClick={() => { setMessages([]); setProblem(null); }}>
                <RotateCcw size={15} />
              </button>
            )}
            <button type="button" className="rounded p-1 text-muted-foreground hover:bg-sunken hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label="Close the assistant" onClick={() => setOpen(false)}>
              <X size={16} />
            </button>
          </header>

          <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3 text-[13px] leading-[20px] text-foreground" aria-live="polite">
            {empty && (
              <div className="space-y-3">
                <p>Hi! I can explain how Loomail works and point you to the right page. I can only explain: I cannot change anything for you, and I never see your contacts.</p>
                <div className="flex flex-col gap-1.5">
                  {suggestionsFor(pathname).map((s) => (
                    <button key={s} type="button" onClick={() => send(s)} disabled={limitReached} className="rounded-md border border-border px-3 py-2 text-left text-[13px] hover:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((m) => (
              <div key={m.id} className={m.role === "user" ? "flex justify-end" : "flex justify-start"}>
                <div className={cn("max-w-[92%] rounded-lg px-3 py-2", m.role === "user" ? "bg-selected" : m.notice ? "border border-border bg-sunken text-muted-foreground" : "border border-border bg-background")}>
                  {m.role === "user" ? <p className="whitespace-pre-wrap break-words">{m.content}</p> : <Answer text={m.content} />}
                  {m.sources && m.sources.length > 0 && (
                    <ul className="mt-2 space-y-0.5 border-t border-border pt-2 text-[12px] text-muted-foreground" aria-label="Where this came from">
                      {m.sources.map((s) => (
                        <li key={s.id}>
                          {s.path ? (
                            <Link to={s.path} className="underline underline-offset-4 hover:text-foreground" onClick={() => setOpen(false)}>{s.heading}</Link>
                          ) : (
                            <span>{s.source}: {s.heading.split(" > ").slice(-1)[0]}</span>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                  {m.ticketId && (
                    <p className="mt-2 text-[12px]">
                      <Link to={`/support/${m.ticketId}`} className="underline underline-offset-4" onClick={() => setOpen(false)}>View your request</Link>
                    </p>
                  )}
                  {m.suggestSupport && !m.ticketId && (
                    <Button type="button" variant="outline" size="sm" className="mt-2" disabled={sendingToSupport} onClick={toSupport}>
                      <LifeBuoy aria-hidden="true" /> {sendingToSupport ? "Sending..." : "Send this to Support"}
                    </Button>
                  )}
                </div>
              </div>
            ))}
            {ask.isPending && <p className="text-muted-foreground" role="status">Thinking...</p>}
            <div ref={endRef} />
          </div>

          <form
            className="border-t border-border p-3"
            onSubmit={(e) => {
              e.preventDefault();
              send(text);
            }}
          >
            {limitReached ? (
              <p className="text-[12px] text-muted-foreground">You have used today&apos;s assistant questions for your trial. They come back at midnight UTC. <Link to="/support" className="underline underline-offset-4" onClick={() => setOpen(false)}>Ask Support</Link> if you are stuck.</p>
            ) : (
              <>
                <div className="flex items-end gap-2">
                  <Textarea
                    ref={inputRef}
                    aria-label="Ask the assistant"
                    rows={2}
                    value={text}
                    maxLength={MAX_QUESTION}
                    placeholder="Ask how something works..."
                    className="min-h-0 resize-none text-[13px]"
                    onChange={(e) => setText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        send(text);
                      }
                    }}
                  />
                  <Button type="submit" size="sm" disabled={ask.isPending} aria-label="Send">
                    <Send size={15} aria-hidden="true" />
                  </Button>
                </div>
                {problem && <p role="alert" className="mt-1 text-[12px] text-danger">{problem}</p>}
                <p className="mt-1.5 text-[11px] text-muted-foreground">
                  {left !== null ? `${left} question${left === 1 ? "" : "s"} left today. ` : ""}Never paste passwords or keys. <Link to="/support" className="underline underline-offset-4" onClick={() => setOpen(false)}>Contact Support</Link>
                </p>
              </>
            )}
          </form>
        </section>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Open the assistant"
          className="pointer-events-auto flex h-12 items-center gap-2 rounded-full bg-accent px-4 text-[14px] font-medium text-accent-foreground shadow-lg transition-transform hover:scale-[1.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          <Sparkles size={18} strokeWidth={1.75} aria-hidden="true" />
          <span className="hidden sm:inline">Ask Loomail</span>
        </button>
      )}
    </div>
  );
}

export type { ReactNode };
