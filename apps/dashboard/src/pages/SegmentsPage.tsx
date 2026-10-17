/**
 * Segments: saved groups of people, described by rules.
 *
 * The list shows each segment with its rules in plain English, how many people it had when last counted
 * (a cache, with the time, and a button to recount), and how many flows start from it. A segment that a flow
 * uses cannot be archived: the server says which flows, and so does this page.
 *
 * Mirror side: PUBLIC (apps/dashboard is mirrored).
 */
import { useState } from "react";
import { Link } from "react-router-dom";
import { Layers, RefreshCw } from "lucide-react";
import { PageHeader } from "../components/page-header.js";
import { EmptyState } from "../components/empty-state.js";
import { Button } from "../components/ui/button.js";
import { Skeleton } from "../components/ui/skeleton.js";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table.js";
import {
  SegmentApiError,
  useArchiveSegment,
  useRefreshSegment,
  useSegments,
  type Segment,
  type SegmentFlowRef,
} from "../segments.js";
import { describeSegment, formatMemberCount, timeAgo } from "../segment-rules.js";

function ListSkeleton() {
  return (
    <div className="space-y-3" aria-busy="true" aria-label="Loading segments">
      {Array.from({ length: 4 }).map((_, i) => (
        <Skeleton key={i} className="h-14 w-full" />
      ))}
    </div>
  );
}

export default function SegmentsPage() {
  const list = useSegments();
  const refresh = useRefreshSegment();
  const archive = useArchiveSegment();
  const [confirming, setConfirming] = useState<string | null>(null);
  const [problem, setProblem] = useState<{ id: string; message: string; flows: SegmentFlowRef[] } | null>(null);

  const segments = list.data ?? [];

  async function doArchive(s: Segment) {
    setProblem(null);
    try {
      await archive.mutateAsync(s.id);
      setConfirming(null);
    } catch (err) {
      setConfirming(null);
      setProblem(
        err instanceof SegmentApiError
          ? { id: s.id, message: err.message, flows: err.flows }
          : { id: s.id, message: "That did not work. Try again.", flows: [] },
      );
    }
  }

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        eyebrow="Audiences"
        title="Segments"
        subtitle="Saved groups of people, described by rules. Start a flow from one, or look at exactly those people."
        actions={
          <Link to="/segments/new">
            <Button>New segment</Button>
          </Link>
        }
      />

      {list.isLoading && <ListSkeleton />}

      {list.isError && (
        <div className="flex items-center justify-between rounded-md border border-danger bg-danger-soft px-4 py-3" role="alert">
          <p className="text-[15px] text-foreground">
            Failed to load segments: {list.error instanceof Error ? list.error.message : "Unknown error"}
          </p>
          <Button variant="outline" size="sm" onClick={() => list.refetch()}>
            Try again
          </Button>
        </div>
      )}

      {!list.isLoading && !list.isError && segments.length === 0 && (
        <EmptyState
          icon={Layers}
          title="No segments yet"
          description="A segment is a group of people you describe once, for example paid customers who have not logged in for two weeks. Loomail keeps it up to date, and a flow can start from it."
          action={
            <Link to="/segments/new">
              <Button>Create your first segment</Button>
            </Link>
          }
        />
      )}

      {problem && (
        <div className="mb-4 rounded-md border border-danger bg-danger-soft px-4 py-3" role="alert">
          <p className="text-[15px] text-foreground">{problem.message}</p>
          {problem.flows.length > 0 && (
            <ul className="mt-2 list-disc pl-5 text-[14px] text-foreground">
              {problem.flows.map((f) => (
                <li key={f.id}>
                  <Link to={`/flows/${f.id}/edit`} className="text-accent-text underline underline-offset-4">
                    {f.name}
                  </Link>
                  {f.status && <span className="text-muted-foreground"> ({f.status})</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {segments.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Segment</TableHead>
              <TableHead className="text-right">People</TableHead>
              <TableHead className="text-right">Flows</TableHead>
              <TableHead className="text-right">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {segments.map((s) => (
              <TableRow key={s.id}>
                <TableCell>
                  <Link to={`/segments/${s.id}`} className="font-medium text-foreground underline-offset-4 hover:underline">
                    {s.name}
                  </Link>
                  <p className="mt-0.5 max-w-xl truncate text-[13px] text-muted-foreground" title={describeSegment(s.definition)}>
                    {s.description || describeSegment(s.definition) || "Rules cannot be shown"}
                  </p>
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex items-center justify-end gap-2">
                    <div>
                      <Link
                        to={`/people?segment=${s.id}`}
                        className="font-mono text-[14px] text-foreground underline-offset-4 hover:underline"
                        aria-label={`See the ${formatMemberCount(s.member_count, s.count_capped)} people in ${s.name}`}
                      >
                        {formatMemberCount(s.member_count, s.count_capped)}
                      </Link>
                      <p className="text-[12px] text-muted-foreground">counted {timeAgo(s.counted_at)}</p>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Recount ${s.name}`}
                      disabled={refresh.isPending && refresh.variables === s.id}
                      onClick={() => refresh.mutate(s.id)}
                    >
                      <RefreshCw size={16} strokeWidth={1.5} className={refresh.isPending && refresh.variables === s.id ? "animate-spin" : ""} />
                    </Button>
                  </div>
                </TableCell>
                <TableCell className="text-right font-mono text-[14px] text-muted-foreground">{s.flow_count ?? 0}</TableCell>
                <TableCell className="text-right">
                  {confirming === s.id ? (
                    <span className="inline-flex items-center gap-2">
                      <span className="text-[13px] text-foreground">Archive this segment?</span>
                      <Button variant="outline" size="sm" disabled={archive.isPending} onClick={() => void doArchive(s)}>
                        {archive.isPending ? "Archiving..." : "Archive"}
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setConfirming(null)}>
                        Cancel
                      </Button>
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1">
                      <Link to={`/flows/new?segment_id=${s.id}`}>
                        <Button variant="ghost" size="sm" aria-label={`Start a flow from ${s.name}`}>
                          Start a flow
                        </Button>
                      </Link>
                      <Link to={`/segments/${s.id}`}>
                        <Button variant="ghost" size="sm">
                          Edit
                        </Button>
                      </Link>
                      <Button variant="ghost" size="sm" onClick={() => setConfirming(s.id)} aria-label={`Archive ${s.name}`}>
                        Archive
                      </Button>
                    </span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
