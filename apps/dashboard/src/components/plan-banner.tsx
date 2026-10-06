/**
 * PlanBanner: one line at the top of every signed-in page that tells the
 * customer the most important thing about their plan (a limit reached, a trial
 * ending), with a link to the Plan & usage page.
 *
 * Renders nothing on installs that do not enforce plans, and nothing when
 * there is nothing worth saying. Messages that are only informational can be
 * dismissed for the browser session; limits and ended trials cannot.
 *
 * Mirror side: PUBLIC (apps/dashboard is mirrored).
 */
import { useState } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, Info, X } from "lucide-react";
import { planNotice, usePlan, type PlanNotice } from "../plan.js";
import { cn } from "../lib/utils.js";

const STORAGE_KEY = "mailforge-plan-notice-dismissed";

function readDismissed(): string | null {
  try {
    return sessionStorage.getItem(STORAGE_KEY);
  } catch {
    return null; // storage unavailable: the banner just stays visible
  }
}

const TONE: Record<PlanNotice["tone"], string> = {
  danger: "border-danger bg-danger-soft",
  warning: "border-warning bg-warning-soft",
  info: "border-border bg-sunken",
};

const TONE_ICON: Record<PlanNotice["tone"], string> = {
  danger: "text-danger",
  warning: "text-warning",
  info: "text-muted-foreground",
};

export function PlanBanner() {
  const { data } = usePlan();
  const [dismissed, setDismissed] = useState<string | null>(readDismissed);
  const notice = planNotice(data);

  if (!notice) return null;
  if (notice.dismissible && dismissed === notice.id) return null;

  const Icon = notice.tone === "info" ? Info : AlertTriangle;

  function dismiss(id: string) {
    setDismissed(id);
    try {
      sessionStorage.setItem(STORAGE_KEY, id);
    } catch {
      // storage unavailable: dismissed for this view only
    }
  }

  return (
    <div
      role="region"
      aria-label="Plan status"
      className={cn("mb-6 flex items-start gap-3 rounded-md border px-4 py-3", TONE[notice.tone])}
    >
      <Icon size={16} className={cn("mt-0.5 shrink-0", TONE_ICON[notice.tone])} aria-hidden="true" />
      <p className="flex-1 text-[14px] leading-relaxed text-foreground">
        {notice.message}{" "}
        <Link to="/settings/plan" className="font-medium text-accent-text underline-offset-4 hover:underline">
          View plans
        </Link>
      </p>
      {notice.dismissible && (
        <button
          type="button"
          onClick={() => dismiss(notice.id)}
          aria-label="Dismiss"
          className="shrink-0 rounded p-1 text-muted-foreground hover:bg-secondary hover:text-foreground"
        >
          <X size={14} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
