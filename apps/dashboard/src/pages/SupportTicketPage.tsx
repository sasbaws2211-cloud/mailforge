/**
 * One support request: the conversation, a box to reply, and a way to close it once it is resolved.
 *
 * Mirror side: PUBLIC (apps/dashboard is mirrored).
 */
import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { PageHeader } from "../components/page-header.js";
import { Badge } from "../components/ui/badge.js";
import { Button } from "../components/ui/button.js";
import { Skeleton } from "../components/ui/skeleton.js";
import { Textarea } from "../components/ui/textarea.js";
import { CATEGORY_LABEL, MAX_MESSAGE, STATUS_LABEL, replyProblem, timeAgo, useCloseTicket, useReplyToTicket, useTicket } from "../support.js";
import { STATUS_VARIANT } from "./SupportPage.js";
import { Notice, errorMessage } from "./settings/shared.js";

export default function SupportTicketPage() {
  const { id = "" } = useParams();
  const { data, isLoading, isError, error } = useTicket(id);
  const reply = useReplyToTicket(id);
  const close = useCloseTicket(id);
  const [text, setText] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  return (
    <div className="max-w-3xl">
      <Link to="/support" className="mb-4 inline-flex items-center gap-1.5 text-[14px] text-muted-foreground hover:text-foreground">
        <ArrowLeft size={14} /> All requests
      </Link>
      {isLoading && <Skeleton className="h-48 w-full" />}
      {isError && <Notice>{errorMessage(error)}</Notice>}

      {data && (
        <>
          <PageHeader
            eyebrow={CATEGORY_LABEL[data.ticket.category]}
            title={data.ticket.subject}
            subtitle={`Opened ${timeAgo(data.ticket.created_at)} by ${data.ticket.requester}`}
            actions={<Badge variant={STATUS_VARIANT[data.ticket.status]}>{STATUS_LABEL[data.ticket.status]}</Badge>}
          />

          <ol className="space-y-3" aria-label="Conversation">
            {data.messages.map((m) => (
              <li key={m.id} className={m.author === "staff" ? "rounded-lg border border-accent bg-accent-soft p-4" : "rounded-lg border border-border bg-card p-4"}>
                <p className="mb-1 text-[12px] font-semibold text-muted-foreground">
                  {m.author === "staff" ? "Support" : (m.author_email ?? "You")} · {timeAgo(m.created_at)}
                </p>
                {/* Plain text, with the line breaks kept. React escapes it. */}
                <p className="whitespace-pre-wrap break-words text-[14px] leading-[22px] text-foreground">{m.body}</p>
              </li>
            ))}
          </ol>

          <form
            className="mt-6 space-y-3"
            aria-label="Reply"
            onSubmit={(e) => {
              e.preventDefault();
              const p = replyProblem(text);
              setProblem(p);
              if (p) return;
              reply.mutate(text.trim(), { onSuccess: () => setText(""), onError: (err) => setProblem(errorMessage(err)) });
            }}
          >
            <label className="block text-[13px] font-medium text-foreground" htmlFor="support-reply">
              {data.ticket.status === "closed" ? "Reply to reopen this request" : "Reply"}
            </label>
            <Textarea id="support-reply" rows={4} value={text} onChange={(e) => setText(e.target.value)} maxLength={MAX_MESSAGE} />
            {problem && <p role="alert" className="text-[13px] text-danger">{problem}</p>}
            <div className="flex flex-wrap gap-2">
              <Button type="submit" size="sm" disabled={reply.isPending}>
                {reply.isPending ? "Sending..." : "Send reply"}
              </Button>
              {data.ticket.status !== "closed" && (
                <Button type="button" variant="outline" size="sm" disabled={close.isPending} onClick={() => close.mutate()}>
                  This is resolved: close it
                </Button>
              )}
            </div>
          </form>
        </>
      )}
    </div>
  );
}
