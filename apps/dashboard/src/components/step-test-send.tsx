/**
 * "Send test to me": sends one step of a flow, as written, to the signed-in person's own
 * address. Only fixed-copy steps have text to send; AI steps do not show this.
 *
 * Mirror side: PUBLIC (apps/dashboard is mirrored).
 */
import { useState } from "react";
import { Send } from "lucide-react";
import { testSendFlowStep } from "../api.js";

export function StepTestSend({ flowId, order }: { flowId: string; order: number }) {
  const [state, setState] = useState<{ kind: "idle" } | { kind: "sending" } | { kind: "sent"; to: string } | { kind: "error"; message: string }>({ kind: "idle" });

  async function send() {
    setState({ kind: "sending" });
    try {
      const r = await testSendFlowStep(flowId, order);
      setState({ kind: "sent", to: r.sent_to });
    } catch (err) {
      setState({ kind: "error", message: err instanceof Error ? err.message : "The test email could not be sent." });
    }
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button
        type="button"
        disabled={state.kind === "sending"}
        onClick={() => void send()}
        className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[13px] text-accent-text transition-colors hover:bg-sunken disabled:opacity-60"
      >
        <Send size={12} strokeWidth={1.5} aria-hidden="true" />
        {state.kind === "sending" ? "Sending..." : "Send test to me"}
      </button>
      {state.kind === "sent" && (
        <span role="status" className="text-[12px] text-success">
          Sent to {state.to}. Check your inbox.
        </span>
      )}
      {state.kind === "error" && (
        <span role="alert" className="text-[12px] text-danger">
          {state.message}
        </span>
      )}
    </span>
  );
}
