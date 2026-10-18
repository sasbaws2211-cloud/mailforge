/**
 * The "send a request to support" form. Used on the Support page and on the screens a suspended workspace or one waiting for
 * deletion is left with, where it is the only way to ask a question.
 *
 * Mirror side: PUBLIC (apps/dashboard is mirrored).
 */
import { useState } from "react";
import { Button } from "./ui/button.js";
import { Input } from "./ui/input.js";
import { Select } from "./ui/select.js";
import { Textarea } from "./ui/textarea.js";
import { CATEGORY_LABEL, MAX_MESSAGE, MAX_SUBJECT, TICKET_CATEGORIES, newTicketProblems, pageToAttach, useCreateTicket, type Ticket, type TicketCategory } from "../support.js";

interface Props {
  /** The page the person was on, to attach for support. */
  from?: string | null;
  /** Fill in a subject to start with. */
  initialSubject?: string;
  onSent: (ticket: Ticket) => void;
  onCancel?: () => void;
}

export function SupportForm({ from, initialSubject = "", onSent, onCancel }: Props) {
  const create = useCreateTicket();
  const [category, setCategory] = useState<TicketCategory>("question");
  const [subject, setSubject] = useState(initialSubject);
  const [message, setMessage] = useState("");
  const [problems, setProblems] = useState<string[]>([]);
  const page = pageToAttach(from);

  return (
    <form
      className="space-y-4 rounded-lg border border-border bg-card p-4"
      aria-label="Send a request to support"
      onSubmit={(e) => {
        e.preventDefault();
        const found = newTicketProblems({ subject, message });
        setProblems(found);
        if (found.length > 0) return;
        create.mutate(
          { subject: subject.trim(), message: message.trim(), category, ...(page ? { page_url: page } : {}) },
          { onSuccess: (r) => onSent(r.ticket), onError: (err) => setProblems([err instanceof Error ? err.message : "Something went wrong. Please try again."]) },
        );
      }}
    >
      <div className="grid gap-3 sm:grid-cols-[14rem_1fr]">
        <div>
          <label className="mb-1 block text-[13px] font-medium text-foreground" htmlFor="support-category">What is it about?</label>
          <Select id="support-category" value={category} onChange={(e) => setCategory(e.target.value as TicketCategory)}>
            {TICKET_CATEGORIES.map((c) => (
              <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>
            ))}
          </Select>
        </div>
        <div>
          <label className="mb-1 block text-[13px] font-medium text-foreground" htmlFor="support-subject">Subject</label>
          <Input id="support-subject" value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={MAX_SUBJECT} placeholder="A short summary" />
        </div>
      </div>
      <div>
        <label className="mb-1 block text-[13px] font-medium text-foreground" htmlFor="support-message">How can we help?</label>
        <Textarea
          id="support-message"
          rows={6}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          maxLength={MAX_MESSAGE}
          placeholder="What were you trying to do, and what happened instead? Include any error message you saw."
        />
        <p className="mt-1 text-[12px] text-muted-foreground">
          We reply by email and here. {page ? <>We will also see the page you were on (<code className="font-mono">{page}</code>). </> : null}Never include passwords or API keys.
        </p>
      </div>
      {problems.length > 0 && (
        <ul role="alert" className="list-disc space-y-1 pl-5 text-[13px] text-danger">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={create.isPending}>
          {create.isPending ? "Sending..." : "Send to support"}
        </Button>
        {onCancel && (
          <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={create.isPending}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}
