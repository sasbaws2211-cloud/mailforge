/**
 * "Contact support" for the screens that replace the dashboard (a suspended workspace, one waiting for deletion), where there is no
 * sidebar to reach the Support page from. Opens the same form and says it was sent; the answer comes by email.
 *
 * Mirror side: PUBLIC (apps/dashboard is mirrored).
 */
import { useState } from "react";
import { LifeBuoy } from "lucide-react";
import { Button } from "./ui/button.js";
import { SupportForm } from "./support-form.js";

export function SupportPanel({ initialSubject }: { initialSubject?: string }) {
  const [open, setOpen] = useState(false);
  const [sent, setSent] = useState(false);

  if (sent) {
    return (
      <p role="status" className="mt-6 max-w-md text-[14px] text-foreground">
        Thank you. Your request was sent and we will reply by email.
      </p>
    );
  }
  if (!open) {
    return (
      <Button className="mt-4" variant="outline" onClick={() => setOpen(true)}>
        <LifeBuoy aria-hidden="true" /> Contact support
      </Button>
    );
  }
  return (
    <div className="mt-6 w-full max-w-xl text-left">
      <SupportForm initialSubject={initialSubject} onSent={() => setSent(true)} onCancel={() => setOpen(false)} />
    </div>
  );
}
