/**
 * Starter packs: the business-model templates (Freemium, Time-limited trial, Preview-free). Each
 * installs a set of AI-written draft flows matched to how a product charges. They need an AI
 * provider to compile, so they sit below the ready-made flows, which need nothing.
 *
 * Mirror side: PUBLIC (apps/dashboard is mirrored).
 */
import { useState } from "react";
import { useTemplates, useApplyTemplate } from "../settings.js";
import type { FlowApiError } from "../api.js";
import { Button } from "./ui/button.js";
import { Select } from "./ui/select.js";

function errorMessage(err: unknown): string {
  if (err !== null && typeof err === "object" && "kind" in err) {
    const apiErr = err as FlowApiError;
    if (apiErr.kind === "validation") return apiErr.issues.map((i) => i.message).join("; ");
    return apiErr.message;
  }
  return err instanceof Error ? err.message : "An unexpected error occurred.";
}

export function StarterPacks() {
  const templates = useTemplates();
  const apply = useApplyTemplate();
  const [templateId, setTemplateId] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const list = templates.data?.templates ?? [];
  if (!templates.isLoading && list.length === 0) return null;

  function handleApply() {
    if (!templateId) return;
    setNote(null);
    setError(null);
    apply.mutate(templateId, {
      onSuccess: (data) =>
        setNote(`Added "${data.template_name}": ${data.flows_created.length} draft flows. Review them in the list.`),
      onError: (err) => setError(errorMessage(err)),
    });
  }

  return (
    <section aria-label="Starter packs" className="mb-8 rounded-lg border border-border bg-card p-5">
      <h2 className="text-[16px] font-semibold text-foreground">Starter packs for your business model</h2>
      <p className="mt-1 text-[13px] text-muted-foreground">
        A set of draft flows matched to how your product charges, written by AI from your own words. They need an AI
        provider to compile, and nothing sends until you review and turn them on.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <div className="w-72 max-w-full">
          <Select
            aria-label="Business model starter pack"
            value={templateId}
            onChange={(e) => setTemplateId(e.target.value)}
            disabled={apply.isPending || templates.isLoading}
          >
            <option value="">{templates.isLoading ? "Loading..." : "Choose a starter pack"}</option>
            {list.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} ({t.flow_count} flows)
              </option>
            ))}
          </Select>
        </div>
        <Button variant="outline" size="sm" disabled={!templateId || apply.isPending} onClick={handleApply}>
          {apply.isPending ? "Adding..." : "Add this pack"}
        </Button>
      </div>
      {templateId && (
        <p className="mt-2 text-[13px] text-muted-foreground">{list.find((t) => t.id === templateId)?.description}</p>
      )}
      {note && (
        <p className="mt-3 rounded-md border border-border bg-secondary px-3.5 py-2.5 text-[14px] text-foreground" role="status">
          {note}
        </p>
      )}
      {error && (
        <p className="mt-3 rounded-md border border-danger bg-danger-soft px-3.5 py-2.5 text-[14px] text-foreground" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
