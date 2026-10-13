/**
 * "Send me a sample": fires a real signed_up event for the signed-in person, with no API key,
 * so a new customer can see event -> flow -> email work before wiring up their own app.
 *
 * Mirror side: PUBLIC (apps/dashboard is mirrored).
 */
import { Send } from "lucide-react";
import { Button } from "./ui/button.js";
import { cn } from "../lib/utils.js";
import { sampleMessage, useDemoData, useSendSample, useSendTestEmail } from "../onboarding.js";

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

/** "Send me a test email": one sample message from the platform sender to the signed-in person. */
export function TestEmailButton() {
  const test = useSendTestEmail();
  return (
    <div data-testid="test-email">
      <Button size="sm" variant="outline" disabled={test.isPending} onClick={() => test.mutate()}>
        <Send size={14} strokeWidth={1.5} />
        {test.isPending ? "Sending..." : "Send me a test email"}
      </Button>
      {test.data && (
        <p role="status" className="mt-2 rounded-md border border-success bg-success-soft px-3 py-2 text-[13px] text-foreground">
          Sent to {test.data.sent_to}. Check your inbox (and spam, the first time).
        </p>
      )}
      {test.isError && (
        <p role="alert" className="mt-2 rounded-md border border-danger bg-danger-soft px-3 py-2 text-[13px] text-foreground">
          {test.error instanceof Error ? test.error.message : "The test email could not be sent."}
        </p>
      )}
    </div>
  );
}

/** Add or clear a set of made-up customers, so the grid and People have something to explore. */
export function DemoDataButton({ present }: { present: boolean }) {
  const { add, clear } = useDemoData();
  const busy = add.isPending || clear.isPending;
  return (
    <div data-testid="demo-data">
      <Button size="sm" variant="outline" disabled={busy} onClick={() => (present ? clear.mutate() : add.mutate())}>
        {busy ? "Working..." : present ? "Clear demo data" : "Explore with demo data"}
      </Button>
      {(add.isError || clear.isError) && (
        <p role="alert" className="mt-2 rounded-md border border-danger bg-danger-soft px-3 py-2 text-[13px] text-foreground">
          Something went wrong. Please try again.
        </p>
      )}
    </div>
  );
}
