/**
 * Ready-made flows: a gallery of flows that work with no AI key. One click installs one as a
 * draft and opens it, so the customer reviews the copy and the plan before switching it on.
 *
 * Mirror side: PUBLIC (apps/dashboard is mirrored).
 */
import { Link, useNavigate } from "react-router-dom";
import { Check, Mail } from "lucide-react";
import { useInstallLibrary, useLibrary } from "../home.js";
import { useOnboarding } from "../onboarding.js";
import { recommendedFlowId } from "../library.js";
import type { LibraryFlowEntry } from "../api.js";
import { Badge } from "./ui/badge.js";
import { Button } from "./ui/button.js";
import { Skeleton } from "./ui/skeleton.js";

function Card({ entry, busy, recommended, onInstall }: { entry: LibraryFlowEntry; busy: boolean; recommended: boolean; onInstall: (id: string) => void }) {
  return (
    <div
      className={`flex flex-col rounded-lg border bg-card p-4 ${recommended && !entry.installed ? "border-accent" : "border-border"}`}
      data-testid={`library-${entry.id}`}
    >
      {recommended && !entry.installed && (
        <div className="mb-2">
          <Badge variant="accent" className="whitespace-nowrap">Recommended for you</Badge>
        </div>
      )}
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-[15px] font-semibold text-foreground">{entry.name}</h3>
        {entry.installed && <Badge variant="success" className="shrink-0 whitespace-nowrap">Installed</Badge>}
      </div>
      <p className="mt-1 text-[13px] text-muted-foreground">{entry.tagline}</p>
      <dl className="mt-3 space-y-1 text-[13px]">
        <div className="flex gap-2">
          <dt className="w-14 shrink-0 text-muted-foreground">Starts</dt>
          <dd className="text-foreground">{entry.when}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-14 shrink-0 text-muted-foreground">Sends</dt>
          <dd className="text-foreground">
            {entry.emails} {entry.emails === 1 ? "email" : "emails"} {entry.span}
          </dd>
        </div>
      </dl>
      {entry.needs_event && (
        <p className="mt-2 text-[12px] text-muted-foreground">
          Needs your app to send the <code className="rounded bg-sunken px-1">{entry.needs_event}</code> event.
        </p>
      )}
      <div className="mt-4 flex-1" />
      {entry.installed && entry.flow_id ? (
        <Link to={`/flows/${entry.flow_id}/edit`} className="text-[13px] font-medium text-accent-text underline-offset-4 hover:underline">
          Open flow
        </Link>
      ) : (
        <Button size="sm" variant="outline" disabled={busy} onClick={() => onInstall(entry.id)}>
          <Mail size={14} strokeWidth={1.5} />
          {busy ? "Adding..." : "Add this flow"}
        </Button>
      )}
    </div>
  );
}

/** The gallery. `compact` hides the heading when the page already has one. */
export function LibraryGallery({ compact = false }: { compact?: boolean }) {
  const library = useLibrary();
  const onboarding = useOnboarding();
  const install = useInstallLibrary();
  const navigate = useNavigate();

  function add(id: string) {
    install.mutate(id, {
      onSuccess: (r) => navigate(`/flows/${r.flowId}/edit`),
    });
  }

  if (library.isLoading) return <Skeleton className="h-40 w-full rounded-lg" />;
  if (library.isError || !library.data) return null;
  const recommendedId = recommendedFlowId(onboarding.data?.goal ?? null);
  // The recommended flow first (when not yet installed), then the catalog in its own order.
  const flows = [...library.data.flows].sort(
    (a, b) => Number(b.id === recommendedId && !b.installed) - Number(a.id === recommendedId && !a.installed),
  );
  if (flows.length === 0) return null;

  return (
    <section id="ready-made" aria-label="Ready-made flows" className="mb-8 scroll-mt-6">
      {!compact && (
        <div className="mb-3">
          <h2 className="text-[16px] font-semibold text-foreground">Ready-made flows</h2>
          <p className="mt-0.5 text-[13px] text-muted-foreground">
            Written for you, no AI key needed. Adding one creates a draft you can read and edit before turning it on.
          </p>
        </div>
      )}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {flows.map((f) => (
          <Card key={f.id} entry={f} busy={install.isPending && install.variables === f.id} recommended={f.id === recommendedId} onInstall={add} />
        ))}
      </div>
      {install.isError && (
        <p role="alert" className="mt-3 flex items-center gap-2 text-[13px] text-danger">
          <Check size={14} className="hidden" />
          {install.error instanceof Error ? install.error.message : "Could not add that flow."}
        </p>
      )}
    </section>
  );
}
