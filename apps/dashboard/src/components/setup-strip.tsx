/**
 * A one-line version of the Home setup checklist, for other pages. It reads the same data
 * (GET /v1/onboarding), so Home and every other page always agree on where setup stands.
 * Hidden when setup is complete, when the customer chose "later", and on self-hosted installs.
 *
 * Mirror side: PUBLIC (apps/dashboard is mirrored).
 */
import { Link } from "react-router-dom";
import { useOnboarding } from "../onboarding.js";
import { Button } from "./ui/button.js";

export function SetupStrip() {
  const { data } = useOnboarding();
  if (!data || !data.hosted || data.complete || data.dismissed || !data.next) return null;
  const step = data.steps.find((s) => s.id === data.next);
  if (!step) return null;
  return (
    <div
      role="region"
      aria-label="Setup progress"
      className="mb-6 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-md border border-border bg-card px-4 py-3"
    >
      <p className="min-w-0 flex-1 text-[14px] text-foreground">
        <span className="font-medium">Setup: {data.done} of {data.total} done.</span>{" "}
        <span className="text-muted-foreground">Next: {step.title}.</span>
      </p>
      <Link to={step.href.startsWith("/home#") ? "/home" : step.href}>
        <Button size="sm" variant="outline">
          {step.cta}
        </Button>
      </Link>
    </div>
  );
}
