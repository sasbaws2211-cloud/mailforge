/**
 * The assistant's documentation index, built once from the generated pieces, and a way to say what a dashboard page is.
 *
 * Mirror side: PUBLIC (packages/api is mirrored).
 */
import { APP_MAP } from "./app-map.js";
import type { DocChunk } from "./chunk.js";
import { DOC_CHUNKS } from "./docs-data.generated.js";
import { DocIndex, type ScoredChunk } from "./search.js";

let index: DocIndex | null = null;
export function docIndex(): DocIndex {
  index ??= new DocIndex(DOC_CHUNKS);
  return index;
}

/**
 * How much of a question's meaning a piece must contain to be shown to the model (see ScoredChunk.coverage). On the questions this was
 * tuned on, on-topic ones reached 0.5 to 1.0 and unrelated ones stayed at or below 0.4.
 */
export const MIN_COVERAGE = 0.5;
export const RESULTS = 6;

/** Which dashboard page a path belongs to: "/flows/abc/edit" is Flows, "/settings/transport" is Settings, Email sending. */
export function pageInfo(path: string | null): { path: string; title: string } | null {
  if (!path) return null;
  const clean = path.split(/[?#]/)[0]!.replace(/\/+$/, "") || "/";
  let best: { path: string; title: string } | null = null;
  for (const p of APP_MAP) {
    if (!p.path) continue;
    const exact = clean === p.path;
    const inside = clean.startsWith(`${p.path}/`) && !p.path.startsWith("/settings");
    if ((exact || inside) && (!best || p.path.length > best.path.length)) best = { path: p.path, title: p.title };
  }
  return best;
}

/**
 * The pieces to hand the model for a question: the best match first, then the description of the page they are on (when something
 * relevant was found), then the other matches. The best match leads because the question decides what is most useful; the page only
 * adds context. (A vague question such as "what is this page?" searches with the page's name, so that page leads anyway.)
 */
export function retrieve(query: string, page: { path: string } | null): { chunks: DocChunk[]; scored: ScoredChunk[] } {
  const scored = docIndex().search(query, RESULTS + 6).filter((s) => s.coverage >= MIN_COVERAGE);
  const chunks: DocChunk[] = [];
  const seen = new Set<string>();
  const add = (c: DocChunk) => {
    if (!seen.has(c.id)) {
      seen.add(c.id);
      chunks.push(c);
    }
  };
  if (scored.length > 0) add(scored[0]!.chunk);
  // For a question that is not about Loomail at all there is nothing to add: a page description would only make a refusal look as if it
  // came from the documentation.
  if (page && scored.length > 0) {
    const own = DOC_CHUNKS.find((c) => c.path === page.path && c.source === "Dashboard map");
    if (own) add(own);
  }
  for (const s of scored) add(s.chunk);
  return { chunks: chunks.slice(0, RESULTS), scored };
}
