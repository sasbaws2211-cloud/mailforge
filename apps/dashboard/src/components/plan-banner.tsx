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
import { planNotice, useCheckoutFlow, usePlan, type PlanNotice } from "../plan.js";
import { useMe } from "../auth.js";
import { Button } from "./ui/button.js";
import { cn } from "../lib/utils.js";

const STORAGE_KEY = "loomail-plan-notice-dismissed";

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
  const { data: me } = useMe();
  const flow = useCheckoutFlow();
  const [dismissed, setDismissed] = useState<string | null>(readDismissed);
  const [error, setError] = useState<string | null>(null);
  const notice = planNotice(data);
  const isOwner = me?.user.role === "owner";
  const canPay = isOwner && data?.billing.enabled === true;

  async function act(n: PlanNotice) {
    if (!n.action || n.action.kind === "plans") return;
    setError(null);
    try {
      if (n.action.kind === "subscribe") await flow.start({ plan: "essential", interval: "monthly" });
      else await flow.start({ addon: { kind: n.action.addon, packs: 1 } });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start the payment.");
    }
  }

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
        {notice.action && notice.action.kind !== "plans" && canPay ? (
          <Button size="sm" className="ml-1 align-middle" disabled={flow.busy} onClick={() => void act(notice)}>
            {flow.busy
              ? "Opening checkout..."
              : notice.action.kind === "subscribe"
                ? "Subscribe to Essential"
                : notice.action.label}
          </Button>
        ) : (
          <Link to="/settings/plan" className="font-medium text-accent-text underline-offset-4 hover:underline">
            {notice.action?.kind === "subscribe" ? "Subscribe to Essential" : notice.action?.kind === "addon" ? "Add more usage" : "View plan"}
          </Link>
        )}
        {error && <span className="ml-2 text-danger">{error}</span>}
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
