/**
 * Support: send a request to the people who run the service, and see where each one stands. Answers arrive here and by email.
 *
 * Mirror side: PUBLIC (apps/dashboard is mirrored).
 */
import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { LifeBuoy, Plus } from "lucide-react";
import { PageHeader } from "../components/page-header.js";
import { SupportForm } from "../components/support-form.js";
import { Badge, type BadgeVariant } from "../components/ui/badge.js";
import { Button } from "../components/ui/button.js";
import { Skeleton } from "../components/ui/skeleton.js";
import { CATEGORY_LABEL, STATUS_LABEL, timeAgo, useTickets, type TicketStatus } from "../support.js";
import { Notice, errorMessage } from "./settings/shared.js";

export const STATUS_VARIANT: Record<TicketStatus, BadgeVariant> = { open: "warning", answered: "success", closed: "neutral" };

export default function SupportPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const from = params.get("from");
  const { data, isLoading, isError, error } = useTickets();
  const [composing, setComposing] = useState(params.get("new") === "1");
  const nothingYet = data !== undefined && data.tickets.length === 0;
  const showForm = composing || nothingYet;

  return (
    <div>
      <PageHeader
        eyebrow="Help"
        title="Support"
        subtitle="Ask us anything. We reply by email, and the conversation stays here."
        actions={
          !showForm ? (
            <Button size="sm" onClick={() => setComposing(true)}>
              <Plus size={14} /> New request
            </Button>
          ) : undefined
        }
      />
      {isError && <Notice>{errorMessage(error)}</Notice>}

      {showForm && (
        <div className="mb-8 max-w-3xl">
          <SupportForm from={from} onSent={(t) => navigate(`/support/${t.id}`)} onCancel={nothingYet ? undefined : () => setComposing(false)} />
        </div>
      )}

      {isLoading && <Skeleton className="h-32 w-full" />}
      {data && data.tickets.length > 0 && (
        <section aria-label="Your requests" className="max-w-3xl">
          <h2 className="mb-2 flex items-center gap-2 text-[15px] font-semibold text-foreground">
            <LifeBuoy size={16} strokeWidth={1.75} aria-hidden="true" /> Your requests
          </h2>
          <ul className="divide-y divide-border rounded-lg border border-border bg-card">
            {data.tickets.map((t) => (
              <li key={t.id}>
                <Link to={`/support/${t.id}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 hover:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14px] font-medium text-foreground">{t.subject}</span>
                    <span className="block text-[12px] text-muted-foreground">
                      {CATEGORY_LABEL[t.category]} · {t.last_message_by === "staff" ? "Support replied" : "You wrote"} {timeAgo(t.last_message_at)}
                    </span>
                  </span>
                  <Badge variant={STATUS_VARIANT[t.status]}>{STATUS_LABEL[t.status]}</Badge>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
