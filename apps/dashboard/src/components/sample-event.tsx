/**
 * "Send me a sample": fires a real signed_up event for the signed-in person, with no API key,
 * so a new customer can see event -> flow -> email work before wiring up their own app.
 *
 * Mirror side: PUBLIC (apps/dashboard is mirrored).
 */
import { Send } from "lucide-react";
import { Button } from "./ui/button.js";
import { cn } from "../lib/utils.js";
import { sampleMessage, useSendSample } from "../onboarding.js";

export function SampleEventButton({ variant = "outline", label = "Send me a sample" }: { variant?: "outline" | "default"; label?: string }) {
  const sample = useSendSample();
  const msg = sample.data ? sampleMessage(sample.data) : null;
  return (
    <div data-testid="sample-event">
      <Button size="sm" variant={variant} disabled={sample.isPending} onClick={() => sample.mutate()}>
        <Send size={14} strokeWidth={1.5} />
        {sample.isPending ? "Sending..." : label}
      </Button>
      {msg && (
        <p
          role="status"
          className={cn(
            "mt-2 rounded-md border px-3 py-2 text-[13px] text-foreground",
            msg.tone === "ok" ? "border-success bg-success-soft" : "border-warning bg-warning-soft",
          )}
        >
          {msg.text}
        </p>
      )}
      {sample.isError && (
        <p role="alert" className="mt-2 rounded-md border border-danger bg-danger-soft px-3 py-2 text-[13px] text-foreground">
          {sample.error instanceof Error ? sample.error.message : "The sample could not be sent."}
        </p>
      )}
    </div>
  );
}
