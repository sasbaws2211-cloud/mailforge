/**
 * Platform admin console: one support request. The thread, who asked and from which workspace, and a box to answer. An answer is
 * saved, emailed to the requester and shown in their dashboard; it can close the request at the same time.
 *
 * Mirror side: PUBLIC (apps/dashboard is mirrored).
 */
import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { PageHeader } from "../../components/page-header.js";
import { Badge } from "../../components/ui/badge.js";
import { Button } from "../../components/ui/button.js";
import { Skeleton } from "../../components/ui/skeleton.js";
import { Textarea } from "../../components/ui/textarea.js";
import { useAdminSupportReply, useAdminSupportStatus, useAdminSupportThread } from "../../admin-support.js";
import { CATEGORY_LABEL, MAX_MESSAGE, replyProblem, timeAgo } from "../../support.js";
import { Notice, errorMessage } from "../settings/shared.js";

const STATUS_TEXT = { open: "Waiting for us", answered: "Answered", closed: "Closed" } as const;

export default function AdminSupportTicketPage() {
  const { id = "" } = useParams();
  const { data, isLoading, isError, error } = useAdminSupportThread(id);
  const reply = useAdminSupportReply(id);
  const setStatus = useAdminSupportStatus(id);
  const [text, setText] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  function send(close: boolean) {
    const p = replyProblem(text);
    setProblem(p);
    setNotice(null);
    if (p) return;
    reply.mutate(
      { message: text.trim(), close },
      {
        onSuccess: (r) => {
          setText("");
          setNotice(r.emailed ? "Sent, and emailed to the requester." : "Saved and shown in their dashboard, but the email could not be sent (check the platform email settings).");
        },
        onError: (err) => setProblem(errorMessage(err)),
      },
    );
  }

  return (
    <div className="max-w-3xl">
      <Link to="/admin/support" className="mb-4 inline-flex items-center gap-1.5 text-[14px] text-muted-foreground hover:text-foreground">
        <ArrowLeft size={14} /> Support queue
      </Link>
      {isLoading && <Skeleton className="h-48 w-full" />}
      {isError && <Notice>{errorMessage(error)}</Notice>}

      {data && (
        <>
          <PageHeader
            eyebrow={CATEGORY_LABEL[data.ticket.category]}
            title={data.ticket.subject}
            subtitle={`${data.ticket.requester} from ${data.workspace.name} (${data.workspace.plan} plan), opened ${timeAgo(data.ticket.created_at)}`}
            actions={<Badge variant={data.ticket.status === "open" ? "warning" : data.ticket.status === "answered" ? "success" : "neutral"}>{STATUS_TEXT[data.ticket.status]}</Badge>}
          />
          <p className="-mt-4 mb-6 text-[13px] text-muted-foreground">
            <Link to={`/admin/tenants/${data.workspace.id}`} className="underline underline-offset-4">Open the workspace</Link>
            {data.ticket.page_url && (
              <>
                {" · they were on "}
                <code className="font-mono">{data.ticket.page_url}</code>
              </>
            )}
          </p>

          <ol className="space-y-3" aria-label="Conversation">
            {data.messages.map((m) => (
              <li key={m.id} className={m.author === "staff" ? "rounded-lg border border-accent bg-accent-soft p-4" : "rounded-lg border border-border bg-card p-4"}>
                <p className="mb-1 text-[12px] font-semibold text-muted-foreground">
                  {m.author === "staff" ? `${m.author_email} (staff)` : m.author_email} · {timeAgo(m.created_at)}
                </p>
                <p className="whitespace-pre-wrap break-words text-[14px] leading-[22px] text-foreground">{m.body}</p>
              </li>
            ))}
          </ol>

          <form
            className="mt-6 space-y-3"
            aria-label="Answer"
            onSubmit={(e) => {
              e.preventDefault();
              send(false);
            }}
          >
            <label className="block text-[13px] font-medium text-foreground" htmlFor="admin-support-reply">Your answer</label>
            <Textarea id="admin-support-reply" rows={6} value={text} onChange={(e) => setText(e.target.value)} maxLength={MAX_MESSAGE} />
            {problem && <p role="alert" className="text-[13px] text-danger">{problem}</p>}
            {notice && <p role="status" className="text-[13px] text-foreground">{notice}</p>}
            <div className="flex flex-wrap gap-2">
              <Button type="submit" size="sm" disabled={reply.isPending}>{reply.isPending ? "Sending..." : "Send answer"}</Button>
              <Button type="button" variant="outline" size="sm" disabled={reply.isPending} onClick={() => send(true)}>Send and close</Button>
              {data.ticket.status === "closed" ? (
                <Button type="button" variant="ghost" size="sm" disabled={setStatus.isPending} onClick={() => setStatus.mutate("open")}>Reopen</Button>
              ) : (
                <Button type="button" variant="ghost" size="sm" disabled={setStatus.isPending} onClick={() => setStatus.mutate("closed")}>Close without answering</Button>
              )}
            </div>
          </form>
        </>
      )}
    </div>
  );
}
