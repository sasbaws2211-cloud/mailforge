/**
 * Platform admin console: the support queue. Requests from every workspace; what has waited longest is at the top of "Waiting".
 *
 * Mirror side: PUBLIC (apps/dashboard is mirrored).
 */
import { useState } from "react";
import { Link } from "react-router-dom";
import { PageHeader } from "../../components/page-header.js";
import { Badge } from "../../components/ui/badge.js";
import { Input } from "../../components/ui/input.js";
import { Skeleton } from "../../components/ui/skeleton.js";
import { cn } from "../../lib/utils.js";
import { useAdminSupport, waitingFor, type AdminSupportFilter } from "../../admin-support.js";
import { CATEGORY_LABEL, timeAgo } from "../../support.js";
import { Notice, errorMessage } from "../settings/shared.js";

const TABS: Array<{ id: AdminSupportFilter; label: string }> = [
  { id: "open", label: "Waiting for us" },
  { id: "answered", label: "Answered" },
  { id: "closed", label: "Closed" },
  { id: "all", label: "All" },
];

export default function AdminSupportPage() {
  const [status, setStatus] = useState<AdminSupportFilter>("open");
  const [q, setQ] = useState("");
  const { data, isLoading, isError, error } = useAdminSupport({ status, q });
  const count = (id: AdminSupportFilter) => (id === "all" ? (data ? data.counts.open + data.counts.answered + data.counts.closed : undefined) : data?.counts[id]);

  return (
    <div>
      <PageHeader eyebrow="Platform" title="Support" subtitle="Requests from every workspace. Answers are emailed to the person who asked and shown in their dashboard." />
      {isError && <Notice>{errorMessage(error)}</Notice>}

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div role="tablist" aria-label="Status" className="flex flex-wrap gap-1">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={status === t.id}
              onClick={() => setStatus(t.id)}
              className={cn(
                "rounded-md px-3 py-1.5 text-[14px] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                status === t.id ? "bg-selected font-semibold text-foreground" : "text-muted-foreground hover:bg-sunken hover:text-foreground",
              )}
            >
              {t.label}
              {count(t.id) !== undefined && <span className="ml-1.5 text-[12px] text-muted-foreground">{count(t.id)}</span>}
            </button>
          ))}
        </div>
        <Input aria-label="Search requests" className="w-full max-w-xs" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search subject, email or workspace" />
      </div>

      {isLoading && <Skeleton className="h-48 w-full" />}
      {data && data.tickets.length === 0 && <p className="text-[14px] text-muted-foreground">{q ? "Nothing matches that search." : status === "open" ? "Nothing is waiting for an answer." : "No requests here."}</p>}
      {data && data.tickets.length > 0 && (
        <ul className="divide-y divide-border rounded-lg border border-border bg-card">
          {data.tickets.map((t) => (
            <li key={t.id}>
              <Link to={`/admin/support/${t.id}`} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 hover:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] font-medium text-foreground">{t.subject}</span>
                  <span className="block truncate text-[12px] text-muted-foreground">
                    {t.workspace.name} · {t.requester} · {CATEGORY_LABEL[t.category]}
                  </span>
                </span>
                <span className="text-[12px] text-muted-foreground">
                  {t.status === "open" ? `waiting ${waitingFor(t.last_message_at)}` : `${t.last_message_by === "staff" ? "we replied" : "they wrote"} ${timeAgo(t.last_message_at)}`}
                </span>
                <Badge variant={t.status === "open" ? "warning" : t.status === "answered" ? "success" : "neutral"}>{t.status === "open" ? "Waiting" : t.status === "answered" ? "Answered" : "Closed"}</Badge>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
