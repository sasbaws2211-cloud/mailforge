/**
 * Flows list page.
 *
 * The page header (title, count, primary action) renders in every state:
 * a list screen must always offer its verb, even while loading, empty, or
 * failed.
 *
 * Columns:
 *   name         - primary identifier, links to the editor
 *   status       - operational state (dot badge), acted on via row actions
 *   compile_status - whether the plan is ready (dot badge, pulse while pending)
 *   trigger_type - how contacts enter the flow (mono)
 *   approval_mode - whether drafts need manual approval
 *   created_at   - temporal orientation (mono)
 *   (actions)    - pause/resume/activate; archive lives in the editor,
 *                  destructive actions are not one click from a list
 *
 * Mirror side: PUBLIC (apps/dashboard is mirrored).
 */
import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { Plus, Workflow } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useFlows, useFlowStats, FLOWS_QUERY_KEY } from "../flows.js";
import { updateFlow, type Flow, type FlowApiError, type FlowHealthState, type FlowStats } from "../api.js";
import { SetupStrip } from "../components/setup-strip.js";
import { StarterPacks } from "../components/starter-packs.js";
import { EmptyState } from "../components/empty-state.js";
import { PageHeader } from "../components/page-header.js";
import { LibraryGallery } from "../components/library-gallery.js";
import { Badge, type BadgeVariant } from "../components/ui/badge.js";
import { Button } from "../components/ui/button.js";
import { Skeleton } from "../components/ui/skeleton.js";
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from "../components/ui/table.js";

// ---------------------------------------------------------------------------
// Badge tone mappings
// ---------------------------------------------------------------------------

/** Flow source -> content badge label and variant. */
function contentInfo(flow: Flow): { label: string; variant: BadgeVariant } {
  if (flow.source === "library") {
    return { label: "Fixed copy", variant: "muted" };
  }
  if (flow.content_mode === "fixed_content") {
    return { label: "Person-written", variant: "muted" };
  }
  return { label: "AI-drafted", variant: "neutral" };
}

/** Flow status -> badge tone. */
function statusVariant(status: Flow["status"]): BadgeVariant {
  switch (status) {
    case "active": return "success";
    case "draft": return "neutral";
    case "paused": return "warning";
    case "archived": return "muted";
  }
}

/** Health -> badge label and tone. Draft and paused flows just show their status. */
function healthBadge(h: FlowHealthState): { label: string; variant: BadgeVariant } | null {
  switch (h) {
    case "ok": return { label: "Sending", variant: "success" };
    case "waiting": return { label: "Waiting for first match", variant: "neutral" };
    case "quiet": return { label: "Quiet", variant: "warning" };
    case "attention": return { label: "Needs attention", variant: "danger" };
    default: return null;
  }
}

function pct(n: number, of: number): string {
  return of > 0 ? `${Math.round((n / of) * 100)}%` : "-";
}

/** The "last 30 days" cell: sent, open rate, and people currently in the flow. */
function StatsCell({ stats }: { stats: FlowStats | undefined }) {
  if (!stats) return <span className="text-muted-foreground">-</span>;
  if (stats.sent_30d === 0 && stats.in_flow === 0) {
    return <span className="text-muted-foreground">No sends yet</span>;
  }
  return (
    <div className="text-[13px] leading-snug">
      <span className="font-medium text-foreground tabular-nums">{stats.sent_30d.toLocaleString("en-US")}</span>
      <span className="text-muted-foreground"> sent</span>
      <span className="text-muted-foreground"> &middot; {pct(stats.opened_30d, stats.sent_30d)} opened</span>
      {stats.in_flow > 0 && <span className="block text-muted-foreground">{stats.in_flow.toLocaleString("en-US")} in the flow now</span>}
    </div>
  );
}

/** compile_status -> badge tone. */
function compileVariant(cs: Flow["compile_status"]): BadgeVariant {
  switch (cs) {
    case null: return "muted";
    case "pending": return "warning";
    case "ready": return "success";
    case "failed": return "danger";
  }
}

// ---------------------------------------------------------------------------
// Page header (always rendered, every state)
// ---------------------------------------------------------------------------

function FlowsHeader({ count }: { count: number | null }) {
  return (
    <PageHeader
      eyebrow="Automation"
      title="Flows"
      subtitle={
        count === null || count === 0
          ? "Email sequences that run themselves. Pick a ready-made one, or write your own with AI."
          : `${count} ${count === 1 ? "flow" : "flows"}`
      }
      actions={
        <Link to="/flows/new">
          <Button size="sm">
            <Plus size={16} strokeWidth={1.5} />
            Write a flow with AI
          </Button>
        </Link>
      }
    />
  );
}

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

function LoadingSkeleton() {
  return (
    <div>
      <div className="border-b border-border pb-3">
        <Skeleton className="h-3 w-full max-w-xl" />
      </div>
      <div className="divide-y divide-border">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="flex items-center gap-6 py-4">
            <Skeleton className="h-4 w-44" />
            <Skeleton className="h-5 w-16 rounded-full" />
            <Skeleton className="h-5 w-16 rounded-full" />
            <Skeleton className="h-4 w-36" />
            <Skeleton className="h-4 w-16" />
            <Skeleton className="h-4 w-24" />
          </div>
        ))}
      </div>
    </div>
  );
}

function FlowsEmptyState() {
  return (
    <EmptyState
      icon={Workflow}
      title="Or write your own"
      description="Describe what should happen in plain language and Loomail's AI turns it into a flow you can read before it goes live. Needs an AI provider (Settings, AI provider)."
      action={
        <Link to="/flows/new">
          <Button size="sm">
            <Plus size={16} strokeWidth={1.5} />
            Write a flow with AI
          </Button>
        </Link>
      }
    />
  );
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div
      className="flex items-center justify-between rounded-md border border-danger bg-danger-soft px-4 py-3"
      role="alert"
    >
      <p className="text-[15px] text-foreground">
        Failed to load flows: {message}
      </p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function actionErrorMessage(err: unknown): string {
  if (err !== null && typeof err === "object" && "kind" in err) {
    const apiErr = err as FlowApiError;
    if (apiErr.kind === "validation") {
      return apiErr.issues.map((i) => i.message).join("; ");
    }
    return apiErr.message;
  }
  return err instanceof Error ? err.message : "An unexpected error occurred.";
}

/** The action a row offers, or null. Archive is intentionally absent. */
function rowAction(flow: Flow): { label: string; status: "active" | "paused" } | null {
  if (flow.status === "active") return { label: "Pause", status: "paused" };
  if (flow.status === "paused") {
    return flow.compile_status === "ready" && flow.compiled_plan !== null
      ? { label: "Resume", status: "active" }
      : null;
  }
  if (flow.status === "draft") {
    return flow.compile_status === "ready" && flow.compiled_plan !== null
      ? { label: "Activate", status: "active" }
      : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function FlowsPage() {
  const { data, isLoading, isError, error, refetch } = useFlows();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);

  const statusMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: "active" | "paused" }) =>
      updateFlow(id, { status }),
    onSuccess: () => {
      setActionError(null);
      void qc.invalidateQueries({ queryKey: FLOWS_QUERY_KEY });
    },
    onError: (err) => {
      setActionError(actionErrorMessage(err));
    },
  });

  const statsQuery = useFlowStats();
  const flows = data?.flows ?? [];
  const count = isLoading || isError ? null : flows.length;
  const location = useLocation();

  // Arriving from setup ("Choose a flow") lands on the gallery, not the top of the page.
  useEffect(() => {
    if (location.hash === "#ready-made" && !isLoading) {
      document.getElementById("ready-made")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [location.hash, isLoading, flows.length]);

  return (
    <div className="mx-auto max-w-6xl">
      <FlowsHeader count={count} />

      <SetupStrip />

      {actionError && (
        <div
          className="mb-6 rounded-md border border-danger bg-danger-soft px-4 py-3"
          role="alert"
        >
          <p className="text-[15px] text-foreground">{actionError}</p>
        </div>
      )}

      {isLoading && <LoadingSkeleton />}

      {isError && (
        <ErrorState
          message={error instanceof Error ? error.message : "Unknown error"}
          onRetry={() => refetch()}
        />
      )}

      {!isLoading && !isError && flows.length === 0 && (
        <>
          <LibraryGallery />
          <FlowsEmptyState />
          <div className="mt-8">
            <StarterPacks />
          </div>
        </>
      )}

      {!isLoading && !isError && flows.length > 0 && (
        <details className="mb-6 rounded-lg border border-border bg-card px-4 py-3" open={location.hash === "#ready-made"}>
          <summary className="cursor-pointer select-none text-[14px] font-medium text-foreground">
            Add a ready-made flow
          </summary>
          <div className="mt-4">
            <LibraryGallery compact />
            <StarterPacks />
          </div>
        </details>
      )}

      {!isLoading && !isError && flows.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Name</TableHead>
              <TableHead>Content</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Last 30 days</TableHead>
              <TableHead>Trigger</TableHead>
              <TableHead className="text-right">Created</TableHead>
              <TableHead>
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {flows.map((flow) => {
              const action = rowAction(flow);
              return (
                <TableRow
                  key={flow.id}
                  className="cursor-pointer"
                  onClick={() => navigate(`/flows/${flow.id}/edit`)}
                >
                  <TableCell className="font-medium text-foreground">
                    <Link
                      to={`/flows/${flow.id}/edit`}
                      className="text-foreground"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {flow.name}
                    </Link>
                    {flow.approval_mode === "require" && flow.status === "active" && (
                      <span className="block text-[12px] font-normal text-muted-foreground">Emails wait for your approval</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge variant={contentInfo(flow).variant}>
                      {contentInfo(flow).label}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-col items-start gap-1">
                      {(() => {
                        const stats = statsQuery.data?.[flow.id];
                        const hb = flow.status === "active" && stats ? healthBadge(stats.health) : null;
                        return (
                          <>
                            <Badge variant={hb ? hb.variant : statusVariant(flow.status)}>
                              {hb ? hb.label : flow.status}
                            </Badge>
                            {stats?.health_note && flow.status === "active" && (
                              <span className="max-w-[16rem] text-[12px] leading-snug text-muted-foreground">{stats.health_note}</span>
                            )}
                          </>
                        );
                      })()}
                      {flow.compile_status !== "ready" && (
                        <Badge variant={compileVariant(flow.compile_status)} pulse={flow.compile_status === "pending"}>
                          {flow.compile_status === "failed" ? "plan failed" : flow.compile_status === "pending" ? "compiling" : "not compiled"}
                        </Badge>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    <StatsCell stats={statsQuery.data?.[flow.id]} />
                  </TableCell>
                  <TableCell className="font-mono text-[13px] text-muted-foreground">
                    {flow.trigger_type}
                  </TableCell>
                  <TableCell className="text-right font-mono text-[13px] text-muted-foreground">
                    {formatDate(flow.created_at)}
                  </TableCell>
                  <TableCell
                    className="w-px whitespace-nowrap text-right"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {action && (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={statusMutation.isPending}
                        onClick={() =>
                          statusMutation.mutate({ id: flow.id, status: action.status })
                        }
                      >
                        {action.label}
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
