/**
 * Finding the pieces of documentation that answer a question: BM25 over the guides and the dashboard map. No embeddings and no
 * network, so it costs nothing per question, works the same on every install, and a wrong answer can be traced to what was found.
 *
 * Mirror side: PUBLIC (packages/api is mirrored).
 */
import type { DocChunk } from "./chunk.js";

const STOP = new Set(
  "a an and are as at be been but by can could did do does for from had has have how i if in into is it its me my of on or our so than that the their them then there these they this to us was we were what when where which who why will with would you your should shall may might just also about any all some not no get got let make like want need please help".split(" "),
);

/** Lower-case words, with the commonest English endings trimmed so "connecting", "connected" and "connect" meet. */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 2 || STOP.has(raw)) continue;
    out.push(stem(raw));
  }
  return out;
}

export function stem(w: string): string {
  let s = w;
  if (s.length > 4 && s.endsWith("ies")) s = s.slice(0, -3) + "y";
  else if (s.length > 5 && s.endsWith("ing")) s = s.slice(0, -3);
  else if (s.length > 4 && s.endsWith("ed")) s = s.slice(0, -2);
  else if (s.length > 4 && s.endsWith("es")) {
    s = s.slice(0, -2);
    // "statuses" -> "status", which must then meet "status" (itself trimmed to "statu"), not stay one step behind it.
    if (s.length > 3 && s.endsWith("s") && !s.endsWith("ss")) s = s.slice(0, -1);
  }
  else if (s.length > 3 && s.endsWith("s") && !s.endsWith("ss")) s = s.slice(0, -1);
  // "deletion" and "delete", "integration" and "integrate" should meet.
  if (s.length > 6 && s.endsWith("ion")) s = s.slice(0, -3);
  else if (s.length > 4 && s.endsWith("e")) s = s.slice(0, -1);
  return s;
}

export interface ScoredChunk {
  chunk: DocChunk;
  score: number;
  /**
   * 0 to 1: how much of the question's meaning this piece contains. Each word counts by how rare it is in the documentation, and a
   * word the documentation has never seen counts in full against the piece. BM25's own score cannot say "this question is not about
   * Loomail" (a common word like "write" scores well anywhere); coverage can, because "weather" and "poem" match nothing.
   */
  coverage: number;
}

const K1 = 1.4;
const B = 0.72;
/** A word in the heading says more about what a piece is than a word in its body. */
const HEADING_WEIGHT = 3;

export class DocIndex {
  private readonly docs: Array<{ chunk: DocChunk; tf: Map<string, number>; length: number }> = [];
  private readonly df = new Map<string, number>();
  private readonly avgLength: number;

  constructor(chunks: readonly DocChunk[]) {
    let total = 0;
    for (const chunk of chunks) {
      const tf = new Map<string, number>();
      let length = 0;
      for (const t of tokenize(chunk.text)) {
        tf.set(t, (tf.get(t) ?? 0) + 1);
        length++;
      }
      for (const t of tokenize(`${chunk.heading} ${chunk.source}`)) {
        tf.set(t, (tf.get(t) ?? 0) + HEADING_WEIGHT);
        length += HEADING_WEIGHT;
      }
      for (const t of tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
      this.docs.push({ chunk, tf, length });
      total += length;
    }
    this.avgLength = this.docs.length ? total / this.docs.length : 1;
  }

  get size(): number {
    return this.docs.length;
  }

  /** The best `limit` pieces for a question, best first, with their scores. Pieces that share no word with it are never returned. */
  search(query: string, limit = 5): ScoredChunk[] {
    const terms = [...new Set(tokenize(query))];
    if (terms.length === 0 || this.docs.length === 0) return [];
    const n = this.docs.length;
    const idfOf = (t: string) => {
      const df = this.df.get(t) ?? 0;
      return Math.log(1 + (n - df + 0.5) / (df + 0.5));
    };
    const totalMass = terms.reduce((sum, t) => sum + idfOf(t), 0);
    const scored: ScoredChunk[] = [];
    for (const d of this.docs) {
      let score = 0;
      let matched = 0;
      for (const t of terms) {
        const f = d.tf.get(t);
        if (!f) continue;
        const idf = idfOf(t);
        matched += idf;
        score += (idf * (f * (K1 + 1))) / (f + K1 * (1 - B + (B * d.length) / this.avgLength));
      }
      if (score > 0) scored.push({ chunk: d.chunk, score, coverage: totalMass > 0 ? matched / totalMass : 0 });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }
}
