/**
 * The "you are live" card: shown on Home for a few days after a customer finishes
 * onboarding, so the moment their first email lands is acknowledged and the next useful
 * things are one click away. They can close it for good (kept in this browser).
 *
 * Mirror side: PUBLIC (apps/dashboard is mirrored).
 */
import { useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, PartyPopper, X } from "lucide-react";

const CLOSED_KEY = "mailforge-onboarding-complete-closed";

function readClosed(): boolean {
  try {
    return localStorage.getItem(CLOSED_KEY) === "1";
  } catch {
    return false;
  }
}

function close() {
  try {
    localStorage.setItem(CLOSED_KEY, "1");
  } catch {
    // storage unavailable; the card closes for this render only
  }
}

export function OnboardingComplete({ onTrial }: { onTrial: boolean }) {
  const [closed, setClosed] = useState(readClosed);
  if (closed) return null;

  const next = [
    { to: "/sent", label: "See the email you just sent" },
    { to: "/flows", label: "Add another flow" },
    { to: "/settings/team", label: "Invite a teammate" },
    ...(onTrial ? [{ to: "/settings/plan", label: "Choose a plan before your trial ends" }] : []),
  ];

  return (
    <section
      aria-label="Setup complete"
      data-testid="onboarding-complete"
      className="mb-6 rounded-lg border border-success bg-success-soft p-5"
    >
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-card text-success">
          <PartyPopper size={18} strokeWidth={1.5} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[15px] font-medium text-foreground">You are live. Your first email was delivered.</p>
          <p className="mt-0.5 text-[13px] text-muted-foreground">Here is what most teams do next.</p>
          <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5">
            {next.map((n) => (
              <li key={n.to}>
                <Link to={n.to} className="inline-flex items-center gap-1 text-[13px] text-accent-text underline-offset-4 hover:underline">
                  {n.label}
                  <ArrowRight size={12} />
                </Link>
              </li>
            ))}
          </ul>
        </div>
        <button
          type="button"
          aria-label="Close"
          title="Close"
          onClick={() => {
            close();
            setClosed(true);
          }}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-card hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X size={16} strokeWidth={1.5} />
        </button>
      </div>
    </section>
  );
}
