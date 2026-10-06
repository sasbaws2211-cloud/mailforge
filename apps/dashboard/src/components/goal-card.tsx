/**
 * Picks up the goal a customer chose at signup: once the Welcome flow is on, offers the
 * ready-made flows that fit it. One click creates them as drafts (nothing sends).
 *
 * Mirror side: PUBLIC (apps/dashboard is mirrored).
 */
import { useState } from "react";
import { Link } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Target } from "lucide-react";
import { Button } from "./ui/button.js";
import { useApplyTemplate } from "../settings.js";
import { ONBOARDING_QUERY_KEY, goalCard, type OnboardingInfo } from "../onboarding.js";

function message(err: unknown): string {
  if (err !== null && typeof err === "object" && "message" in err && typeof (err as { message: unknown }).message === "string") {
    return (err as { message: string }).message;
  }
  return "Something went wrong. Try again.";
}

export function GoalCard({ info }: { info: Pick<OnboardingInfo, "goal" | "goal_suggestion" | "steps"> | undefined }) {
  const apply = useApplyTemplate();
  const qc = useQueryClient();
  const [created, setCreated] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (created !== null) {
    return (
      <div role="status" data-testid="goal-card-done" className="mb-6 rounded-lg border border-success bg-success-soft p-4 text-[14px] text-foreground">
        Added {created} draft flows. <Link to="/flows" className="text-accent-text underline underline-offset-4">Review them in Flows</Link>.
      </div>
    );
  }

  const card = info ? goalCard(info) : null;
  if (!card) return null;

  return (
    <section aria-label="Your goal" data-testid="goal-card" className="mb-6 rounded-lg border border-border bg-card p-5">
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-accent-soft text-accent-text">
          <Target size={18} strokeWidth={1.5} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[15px] font-medium text-foreground">{card.title}</p>
          <p className="mt-1 text-[13px] leading-[20px] text-muted-foreground">{card.body}</p>
          <div className="mt-3">
            <Button
              size="sm"
              disabled={apply.isPending}
              onClick={() => {
                setError(null);
                apply.mutate(card.templateId, {
                  onSuccess: (data) => {
                    setCreated(data.flows_created.length);
                    void qc.invalidateQueries({ queryKey: ONBOARDING_QUERY_KEY });
                  },
                  onError: (err) => setError(message(err)),
                });
              }}
            >
              {apply.isPending ? "Adding..." : card.button}
            </Button>
          </div>
          {error && (
            <p role="alert" className="mt-3 rounded-md border border-danger bg-danger-soft px-3.5 py-2.5 text-[14px] text-foreground">
              {error}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
