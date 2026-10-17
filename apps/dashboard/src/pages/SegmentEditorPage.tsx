/**
 * Create or edit a segment: a name, rules, and a live preview of who matches.
 *
 * The preview counts and samples the rules as they stand (without saving), a moment after the person stops
 * changing them, so they can see what a rule does before committing to it. Problems with a rule are shown beside
 * it once the person tries to save. Editing a segment that flows start from warns that the change reaches those
 * flows from the next scan.
 *
 * Mirror side: PUBLIC (apps/dashboard is mirrored).
 */
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { PageHeader } from "../components/page-header.js";
import { SegmentRuleEditor } from "../components/segment-rule-editor.js";
import { Badge } from "../components/ui/badge.js";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";
import { Skeleton } from "../components/ui/skeleton.js";
import { Textarea } from "../components/ui/textarea.js";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table.js";
import { useEventNames } from "../flows.js";
import {
  SegmentApiError,
  useCreateSegment,
  useSegment,
  useSegmentPreview,
  useUpdateSegment,
} from "../segments.js";
import {
  definitionToState,
  describeSegment,
  emptySegmentState,
  formatMemberCount,
  stateFromFilters,
  stateToDefinition,
  timeAgo,
  type SegmentState,
} from "../segment-rules.js";

/** The value, once it has held still for `ms`. */
function useSettled<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
}

function formatSeen(iso: string | null): string {
  if (!iso) return "-";
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export default function SegmentEditorPage() {
  const { id } = useParams<{ id: string }>();
  const isNew = id === undefined;
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const existing = useSegment(id);
  const create = useCreateSegment();
  const update = useUpdateSegment(id ?? "");
  const eventNames = useEventNames();

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [rules, setRules] = useState<SegmentState>(emptySegmentState);
  const [initialised, setInitialised] = useState(false);
  const [unreadable, setUnreadable] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Fill the form once: from the stored segment, or from the People page's filters ("Save as segment").
  useEffect(() => {
    if (initialised) return;
    if (isNew) {
      const from = stateFromFilters({
        ...(searchParams.get("lifecycle_state") ? { lifecycle_state: searchParams.get("lifecycle_state")! } : {}),
        ...(searchParams.get("engagement_depth") ? { engagement_depth: searchParams.get("engagement_depth")! } : {}),
      });
      if (from.state) setRules(from.state);
      setInitialised(true);
    } else if (existing.data) {
      setName(existing.data.name);
      setDescription(existing.data.description ?? "");
      const parsed = definitionToState(existing.data.definition);
      setRules(parsed.state);
      setUnreadable(parsed.unreadable);
      setInitialised(true);
    }
  }, [initialised, isNew, existing.data, searchParams]);

  const built = useMemo(() => stateToDefinition(rules), [rules]);
  const settledDefinition = useSettled(built.definition, 500);
  // Ask only for a definition that has held still; a definition that is not valid right now asks for nothing.
  const preview = useSegmentPreview(built.definition === null ? null : settledDefinition);
  const previewing = built.definition !== null && (built.definition !== settledDefinition || preview.isFetching);

  const saving = create.isPending || update.isPending;

  async function save() {
    setSubmitted(true);
    setBanner(null);
    setNameError(null);
    setSaved(false);
    if (!name.trim()) {
      setNameError("A segment needs a name.");
      return;
    }
    if (built.definition === null) {
      setBanner(
        rules.items.length === 0 ? "Add at least one rule." : "Fix the highlighted rules first.",
      );
      return;
    }
    const input = { name: name.trim(), description: description.trim() || null, definition: built.definition };
    try {
      if (isNew) {
        // A new segment with no description simply has none; only an edit needs null, to clear an old one.
        await create.mutateAsync({ name: input.name, definition: input.definition, ...(input.description ? { description: input.description } : {}) });
        navigate("/segments");
      } else {
        await update.mutateAsync(input);
        setSaved(true);
        setUnreadable(false);
      }
    } catch (err) {
      if (err instanceof SegmentApiError && err.status === 409) setNameError(err.message);
      else setBanner(err instanceof Error ? err.message : "That did not work. Try again.");
    }
  }

  if (!isNew && existing.isError) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title="Segment not found" subtitle="It may have been archived, or belong to another workspace." actions={<Link to="/segments"><Button variant="outline">Back to segments</Button></Link>} />
      </div>
    );
  }

  if ((!isNew && existing.isLoading) || !initialised) {
    return (
      <div className="mx-auto max-w-6xl" aria-busy="true">
        <Skeleton className="mb-6 h-10 w-64" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const usedBy = existing.data?.used_by_flows ?? [];
  const showErrors = submitted ? built.errors : {};

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        eyebrow="Segments"
        title={isNew ? "New segment" : name || "Segment"}
        subtitle="Describe who belongs. The preview shows who matches right now."
        actions={
          <>
            <Link to="/segments">
              <Button variant="outline">Cancel</Button>
            </Link>
            <Button onClick={() => void save()} disabled={saving}>
              {saving ? "Saving..." : isNew ? "Create segment" : "Save changes"}
            </Button>
          </>
        }
      />

      {banner && (
        <div className="mb-4 rounded-md border border-danger bg-danger-soft px-4 py-3" role="alert">
          <p className="text-[15px] text-foreground">{banner}</p>
        </div>
      )}
      {saved && !banner && (
        <p className="mb-4 text-[14px] text-foreground" role="status">
          Saved.
        </p>
      )}
      {unreadable && (
        <p className="mb-4 rounded-md bg-sunken px-4 py-3 text-[14px] text-muted-foreground">
          This segment's saved rules cannot be shown here. Saving replaces them with the rules below.
        </p>
      )}
      {usedBy.length > 0 && (
        <div className="mb-4 rounded-md border border-border bg-sunken px-4 py-3" role="note">
          <p className="text-[14px] text-foreground">
            {usedBy.length === 1 ? "A flow starts" : `${usedBy.length} flows start`} from this segment. Changing the rules changes who
            enters {usedBy.length === 1 ? "it" : "them"} from the next scan; people already in a flow stay in it.
          </p>
          <ul className="mt-1.5 list-disc pl-5 text-[14px]">
            {usedBy.map((f) => (
              <li key={f.id}>
                <Link to={`/flows/${f.id}/edit`} className="text-accent-text underline underline-offset-4">
                  {f.name}
                </Link>
                {f.status && <span className="text-muted-foreground"> ({f.status})</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0 space-y-6">
          <section className="rounded-lg border border-border bg-card p-5">
            <label htmlFor="segment-name" className="mb-1.5 block text-[14px] font-medium text-foreground">
              Name
            </label>
            <Input id="segment-name" value={name} maxLength={100} placeholder="e.g. Paid customers gone quiet" onChange={(e) => setName(e.target.value)} />
            {nameError && (
              <p className="mt-1 text-[13px] text-danger" role="alert">
                {nameError}
              </p>
            )}
            <label htmlFor="segment-description" className="mb-1.5 mt-4 block text-[14px] font-medium text-foreground">
              Description <span className="font-normal text-muted-foreground">(optional)</span>
            </label>
            <Textarea
              id="segment-description"
              rows={2}
              maxLength={500}
              value={description}
              placeholder="What is this group for?"
              onChange={(e) => setDescription(e.target.value)}
            />
          </section>

          <section className="rounded-lg border border-border bg-card p-5">
            <h2 className="mb-3 text-[15px] font-semibold text-foreground">Who belongs</h2>
            <SegmentRuleEditor state={rules} onChange={setRules} errors={showErrors} eventSuggestions={eventNames.data ?? []} />
          </section>
        </div>

        {/* The preview: who matches the rules as they stand */}
        <aside aria-label="Preview" className="lg:sticky lg:top-6 lg:self-start">
          <div className="rounded-lg border border-border bg-card p-5">
            <h2 className="text-[15px] font-semibold text-foreground">Preview</h2>
            {built.definition === null ? (
              <p className="mt-2 text-[14px] text-muted-foreground">
                {rules.items.length === 0 ? "Add a rule to see who matches." : "Finish the rules to see who matches."}
              </p>
            ) : preview.isError ? (
              <p className="mt-2 text-[14px] text-danger" role="alert">
                {preview.error instanceof Error ? preview.error.message : "The preview did not work."}
              </p>
            ) : preview.data ? (
              <div className={previewing ? "opacity-60 transition-opacity" : "transition-opacity"} aria-busy={previewing}>
                <p className="mt-2 font-display text-[32px] font-bold leading-none text-foreground" data-testid="preview-count">
                  {formatMemberCount(preview.data.count, preview.data.capped)}
                </p>
                <p className="mt-1 text-[14px] text-muted-foreground">
                  {preview.data.count === 1 ? "person matches" : "people match"}
                  {preview.data.capped ? " (at least; counting stops here)" : ""}
                </p>
                {preview.data.count > 0 && (
                  <p className="mt-2 text-[14px] text-foreground">
                    {formatMemberCount(preview.data.reachable, preview.data.capped)} can be emailed
                    <span className="text-muted-foreground"> (an address that is not suppressed)</span>
                  </p>
                )}
                {preview.data.never_sent_events.length > 0 && (
                  <p className="mt-3 rounded-md bg-sunken px-3 py-2 text-[13px] text-foreground" role="note">
                    Your app has not sent{" "}
                    {preview.data.never_sent_events.map((n, i) => (
                      <span key={n}>
                        {i > 0 && ", "}
                        <code className="font-mono">{n}</code>
                      </span>
                    ))}{" "}
                    in the last year, so a rule using {preview.data.never_sent_events.length === 1 ? "it" : "them"} cannot match anyone yet.
                  </p>
                )}
                {preview.data.sample.length > 0 && (
                  <div className="mt-4">
                    <p className="mb-1.5 text-[12px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">Some of them</p>
                    <Table>
                      <TableHeader>
                        <TableRow className="hover:bg-transparent">
                          <TableHead>Who</TableHead>
                          <TableHead className="text-right">Seen</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {preview.data.sample.map((c) => (
                          <TableRow key={c.id}>
                            <TableCell>
                              <Link to={`/people/${c.id}`} className="text-[13px] text-foreground underline-offset-4 hover:underline">
                                {c.name || c.email || c.external_id}
                              </Link>
                              <div className="mt-0.5">
                                <Badge>{c.lifecycle_state}</Badge>
                              </div>
                            </TableCell>
                            <TableCell className="text-right font-mono text-[12px] text-muted-foreground">{formatSeen(c.last_seen_at)}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </div>
            ) : (
              <div className="mt-3 space-y-2" aria-busy="true">
                <Skeleton className="h-9 w-24" />
                <Skeleton className="h-4 w-40" />
              </div>
            )}
          </div>

          {built.definition !== null && (
            <p className="mt-3 text-[13px] leading-relaxed text-muted-foreground">
              In words: <span className="text-foreground">{describeSegment(built.definition)}</span>
            </p>
          )}
          {!isNew && existing.data && (
            <p className="mt-3 text-[13px] text-muted-foreground">
              Saved count: {formatMemberCount(existing.data.member_count, existing.data.count_capped)}, counted {timeAgo(existing.data.counted_at)}.{" "}
              <Link to={`/people?segment=${existing.data.id}`} className="text-accent-text underline underline-offset-4">
                See these people
              </Link>
            </p>
          )}
      </aside>
      </div>
    </div>
  );
}
