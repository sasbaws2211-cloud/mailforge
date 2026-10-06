/**
 * Warning shown on Home when approved email cannot go out: nothing to send through, sending
 * paused, or no postal address. Silence here used to mean a customer activated a flow, saw
 * nothing happen, and had no idea why.
 *
 * Mirror side: PUBLIC (apps/dashboard is mirrored).
 */
import { Link } from "react-router-dom";
import { AlertTriangle, ArrowRight } from "lucide-react";
import { waitingNotice, type OnboardingInfo } from "../onboarding.js";

export function WaitingNotice({ info }: { info: Pick<OnboardingInfo, "waiting_emails" | "waiting_reason"> | undefined }) {
  const notice = info ? waitingNotice(info) : null;
  if (!notice) return null;
  return (
    <div
      role="alert"
      data-testid="waiting-notice"
      className="mb-6 flex items-start gap-3 rounded-lg border border-warning bg-warning-soft p-4"
    >
      <AlertTriangle size={16} className="mt-0.5 shrink-0 text-warning" />
      <div className="min-w-0 flex-1">
        <p className="text-[14px] font-medium text-foreground">{notice.title}</p>
        <p className="mt-0.5 text-[13px] text-muted-foreground">{notice.body}</p>
        <Link to={notice.to} className="mt-2 inline-flex items-center gap-1 text-[13px] text-accent-text underline-offset-4 hover:underline">
          {notice.cta}
          <ArrowRight size={12} />
        </Link>
      </div>
    </div>
  );
}
