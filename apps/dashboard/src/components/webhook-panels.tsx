/**
 * What a person needs once a flow has webhook steps: whether the calls are arriving (WebhookDeliveries), and the
 * secret their server uses to check a call really came from Loomail (WebhookSecretCard).
 *
 * Mirror side: PUBLIC (apps/dashboard is mirrored).
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchFlowWebhookDeliveries, fetchWebhookSecret, rotateWebhookSecret, type WebhookDelivery } from "../api.js";
import { useMe } from "../auth.js";
import { Badge, type BadgeVariant } from "./ui/badge.js";
import { Button } from "./ui/button.js";

const STATUS: Record<WebhookDelivery["status"], { label: string; variant: BadgeVariant }> = {
  pending: { label: "Waiting", variant: "neutral" },
  succeeded: { label: "Delivered", variant: "success" },
  failed: { label: "Failed", variant: "danger" },
};

const when = (iso: string) =>
  new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** The result of a call in a few words: the answer, or why it did not get one. */
export function describeDelivery(d: Pick<WebhookDelivery, "status" | "attempts" | "last_status_code" | "last_error" | "next_attempt_at">): string {
  if (d.status === "succeeded") return `Answered ${d.last_status_code ?? "2xx"}`;
  if (d.status === "pending") {
    return d.attempts === 0
      ? "Waiting to be sent"
      : `${d.last_error ?? "Failed"} Trying again ${when(d.next_attempt_at)} (attempt ${d.attempts} of 6 so far).`;
  }
  return d.last_error ?? "Failed";
}

export function WebhookDeliveries({ flowId }: { flowId: string }) {
  const q = useQuery({
    queryKey: ["flows", flowId, "webhook-deliveries"],
    queryFn: () => fetchFlowWebhookDeliveries(flowId),
    refetchInterval: 15_000,
  });
  return (
    <section className="mt-6 rounded-lg border border-border bg-card p-5" aria-label="Webhook calls">
      <p className="text-[14px] font-medium text-foreground">Webhook calls</p>
      <p className="mb-3 mt-1 text-[13px] text-muted-foreground">What this flow&apos;s webhook steps have sent in the last 30 days.</p>
      {q.isLoading && <p className="text-[13px] text-muted-foreground">Loading...</p>}
      {q.isError && <p className="text-[13px] text-danger" role="alert">Could not load the calls.</p>}
      {q.data && (
        <>
          <p className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-foreground" data-testid="webhook-counts">
            <span>{q.data.counts.succeeded} delivered</span>
            <span>{q.data.counts.pending} waiting</span>
            <span className={q.data.counts.failed > 0 ? "text-danger" : ""}>{q.data.counts.failed} failed</span>
          </p>
          {q.data.deliveries.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">No calls yet. They appear here when people reach a webhook step.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[520px] text-left text-[13px]">
                <thead>
                  <tr className="text-[11px] uppercase tracking-[0.06em] text-muted-foreground">
                    <th className="py-2 pr-3 font-medium">When</th>
                    <th className="py-2 pr-3 font-medium">Person</th>
                    <th className="py-2 pr-3 font-medium">Step</th>
                    <th className="py-2 pr-3 font-medium">Result</th>
                  </tr>
                </thead>
                <tbody>
                  {q.data.deliveries.map((d) => (
                    <tr key={d.id} className="border-t border-border align-top">
                      <td className="whitespace-nowrap py-2 pr-3 text-muted-foreground">{when(d.created_at)}</td>
                      <td className="py-2 pr-3 text-foreground">{d.contact_email ?? <span className="text-muted-foreground">(no email)</span>}</td>
                      <td className="py-2 pr-3 text-muted-foreground">{d.step_order}</td>
                      <td className="py-2 pr-3">
                        <Badge variant={STATUS[d.status].variant}>{STATUS[d.status].label}</Badge>
                        <span className="ml-2 text-muted-foreground">{describeDelivery(d)}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}

const VERIFY_EXAMPLE = `// Node.js: check a call really came from Loomail
import { createHmac, timingSafeEqual } from "node:crypto";

function verify(rawBody, header, secret) {
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=")));
  if (Math.abs(Date.now() / 1000 - Number(parts.t)) > 300) return false; // too old
  const expected = createHmac("sha256", secret).update(parts.t + "." + rawBody).digest("hex");
  const a = Buffer.from(expected), b = Buffer.from(parts.v1 ?? "");
  return a.length === b.length && timingSafeEqual(a, b);
}
// header = request.headers["x-loomail-signature"], rawBody = the request body exactly as received`;

export function WebhookSecretCard() {
  const qc = useQueryClient();
  const me = useMe();
  const isOwner = me.data?.user.role === "owner";
  const [shown, setShown] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const secret = useQuery({ queryKey: ["webhook-secret"], queryFn: fetchWebhookSecret, enabled: isOwner && shown });
  const rotate = useMutation({
    mutationFn: rotateWebhookSecret,
    onSuccess: (data) => {
      qc.setQueryData(["webhook-secret"], data);
      setConfirming(false);
    },
  });
  const [copied, setCopied] = useState(false);

  return (
    <section className="mt-6 rounded-lg border border-border bg-card p-5" aria-label="Webhook signing secret">
      <p className="text-[14px] font-medium text-foreground">Check that calls come from Loomail</p>
      <p className="mb-3 mt-1 text-[13px] text-muted-foreground">
        Every call has an <code className="font-mono">X-Loomail-Signature</code> header, made with a secret only you and
        Loomail know. Your server recomputes it and rejects the call if it does not match. One secret covers all your
        flows.
      </p>
      {!isOwner ? (
        <p className="text-[13px] text-muted-foreground">Only a workspace owner can see the secret.</p>
      ) : !shown ? (
        <Button type="button" variant="outline" size="sm" onClick={() => setShown(true)}>
          Show signing secret
        </Button>
      ) : (
        <div className="space-y-3">
          {secret.isLoading && <p className="text-[13px] text-muted-foreground">Loading...</p>}
          {secret.isError && <p className="text-[13px] text-danger" role="alert">{(secret.error as Error).message}</p>}
          {secret.data && (
            <div className="flex flex-wrap items-center gap-2">
              <code className="break-all rounded bg-sunken px-2 py-1 font-mono text-[13px] text-foreground" data-testid="webhook-secret">
                {secret.data.secret}
              </code>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  void navigator.clipboard?.writeText(secret.data!.secret).then(() => setCopied(true));
                }}
              >
                {copied ? "Copied" : "Copy"}
              </Button>
              {!confirming ? (
                <Button type="button" variant="ghost" size="sm" onClick={() => setConfirming(true)}>
                  Rotate
                </Button>
              ) : (
                <span className="flex items-center gap-2 text-[13px] text-foreground">
                  The old secret stops working at once. Update your server too.
                  <Button type="button" variant="destructive" size="sm" disabled={rotate.isPending} onClick={() => rotate.mutate()}>
                    {rotate.isPending ? "Rotating..." : "Rotate now"}
                  </Button>
                  <Button type="button" variant="ghost" size="sm" onClick={() => setConfirming(false)}>
                    Cancel
                  </Button>
                </span>
              )}
            </div>
          )}
          {rotate.isError && <p className="text-[13px] text-danger" role="alert">{(rotate.error as Error).message}</p>}
          <details className="text-[13px]">
            <summary className="cursor-pointer text-muted-foreground">How to check the signature</summary>
            <pre className="mt-2 overflow-x-auto rounded bg-sunken p-3 font-mono text-[12px] leading-relaxed text-foreground">{VERIFY_EXAMPLE}</pre>
          </details>
        </div>
      )}
    </section>
  );
}
