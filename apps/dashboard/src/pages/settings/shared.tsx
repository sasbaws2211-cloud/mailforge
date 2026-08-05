/**
 * Shared pieces for the settings sub-pages: the section card, the form
 * error banner, and small helpers every section reuses.
 *
 * Mirror side: PUBLIC (apps/dashboard is mirrored).
 */
import * as React from "react";
import { Badge } from "../../components/ui/badge.js";
import type { FlowApiError } from "../../api.js";

export function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function errorMessage(err: unknown): string {
  if (err !== null && typeof err === "object" && "kind" in err) {
    const apiErr = err as FlowApiError;
    if (apiErr.kind === "validation") {
      return apiErr.issues.map((i) => i.message).join("; ");
    }
    return apiErr.message;
  }
  return err instanceof Error ? err.message : "An unexpected error occurred.";
}

export function Section({
  title,
  configured,
  children,
}: {
  title: string;
  configured: boolean | null;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-border bg-card p-6">
      <div className="mb-4 flex items-center gap-3">
        <h2 className="text-[20px] font-semibold leading-[28px] tracking-[-0.015em] text-foreground">{title}</h2>
        {configured !== null && (
          <Badge variant={configured ? "success" : "warning"}>
            {configured ? "configured" : "not configured"}
          </Badge>
        )}
      </div>
      {children}
    </section>
  );
}

export function FormError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div
      className="mt-4 rounded-md border border-danger bg-danger-soft px-3.5 py-2.5"
      role="alert"
    >
      <p className="text-[14px] text-foreground">{message}</p>
    </div>
  );
}
