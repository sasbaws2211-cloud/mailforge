/**
 * The hosted onboarding panel: the short path from a new workspace to its first
 * delivered email, shown at the top of Home until it is finished or put off.
 *
 * Shape: one list, one obvious next step. The step to do now is the only one with a
 * button; finished steps fade; later steps say what is coming. Nothing here blocks the
 * rest of the product, and "I will finish this later" is always one click.
 *
 * Mirror side: PUBLIC (apps/dashboard is mirrored).
 */
import { Link } from "react-router-dom";
import { Check } from "lucide-react";
import { Button } from "./ui/button.js";
import { SampleEventButton } from "./sample-event.js";
import { cn } from "../lib/utils.js";
import {
  hashTarget,
  onboardingHeadline,
  onboardingSubline,
  stepStates,
  useDismissOnboarding,
  type OnboardingInfo,
  type OnboardingStep,
  type StepState,
} from "../onboarding.js";

function Marker({ state, index }: { state: StepState; index: number }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-[12px] font-medium",
        state === "done" && "border-success bg-success-soft text-success",
        state === "next" && "border-accent bg-accent-soft text-accent-text",
        state === "todo" && "border-border-strong text-muted-foreground",
      )}
    >
      {state === "done" ? <Check size={13} strokeWidth={2.5} /> : index + 1}
    </span>
  );
}

function StepAction({ step }: { step: OnboardingStep }) {
  const target = hashTarget(step.href);
  if (target) {
    return (
      <Button
        size="sm"
        onClick={() => document.getElementById(target)?.scrollIntoView({ behavior: "smooth", block: "start" })}
      >
        {step.cta}
      </Button>
    );
  }
  return (
    <Link to={step.href}>
      <Button size="sm">{step.cta}</Button>
    </Link>
  );
}

export function OnboardingPanel({
  info,
  workspaceName,
}: {
  info: OnboardingInfo;
  workspaceName: string | null;
}) {
  const dismiss = useDismissOnboarding();
  const rows = stepStates(info);

  return (
    <section
      aria-label="Getting started"
      className="mb-8 rounded-lg border border-border bg-card p-6"
      data-testid="onboarding-panel"
    >
      <div className="flex flex-col gap-1">
        <h2 className="font-display text-[20px] font-bold tracking-[-0.01em] text-foreground">
          {onboardingHeadline(info, workspaceName)}
        </h2>
        <p className="text-[14px] text-muted-foreground">{onboardingSubline(info)}</p>
        <div
          role="progressbar"
          aria-valuenow={info.done}
          aria-valuemin={0}
          aria-valuemax={info.total}
          aria-label="Getting started progress"
          className="mt-3 h-1.5 w-full max-w-sm overflow-hidden rounded-full bg-sunken"
        >
          <div
            className="h-full rounded-full bg-accent transition-[width] duration-(--dur-med)"
            style={{ width: `${info.percent}%` }}
          />
        </div>
      </div>

      <ol className="mt-5">
        {rows.map(({ step, state }, i) => (
          <li
            key={step.id}
            data-step={step.id}
            data-state={state}
            className={cn(
              "flex flex-wrap items-start gap-x-3 gap-y-2 rounded-md px-3 py-3",
              state === "next" && "border border-border-strong bg-background",
            )}
          >
            <Marker state={state} index={i} />
            <div className="min-w-0 flex-1 basis-56">
              <p
                className={cn(
                  "text-[14px] font-medium leading-[20px]",
                  state === "done" ? "text-muted-foreground" : "text-foreground",
                )}
              >
                {step.title}
                {state !== "done" && step.minutes > 0 && (
                  <span className="ml-2 text-[12px] font-normal text-muted-foreground">
                    ~{step.minutes} min
                  </span>
                )}
              </p>
              {state !== "done" && (
                <p className="mt-0.5 text-[13px] leading-[20px] text-muted-foreground">
                  {step.description}
                </p>
              )}
              {state === "next" && step.id === "events" && (
                <div className="mt-2">
                  <p className="mb-2 text-[13px] text-muted-foreground">
                    Want to see it work first? Send yourself a sample. No API key needed.
                  </p>
                  <SampleEventButton />
                </div>
              )}
            </div>
            {state === "next" && (
              <div className="ml-9 shrink-0 sm:ml-0 sm:self-center">
                <StepAction step={step} />
              </div>
            )}
          </li>
        ))}
      </ol>

      <div className="mt-4 flex items-center justify-between gap-3 border-t border-border pt-4">
        <p className="text-[13px] text-muted-foreground">
          Progress saves itself. It updates as you finish each step.
        </p>
        <Button
          variant="ghost"
          size="sm"
          disabled={dismiss.isPending}
          onClick={() => dismiss.mutate(true)}
        >
          I will finish this later
        </Button>
      </div>
    </section>
  );
}
