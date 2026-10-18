/**
 * Turning the guides into searchable pieces for the in-app assistant. No database, no network.
 *
 * The assistant answers from documentation it is handed at question time, so what goes into that documentation matters:
 * the guides are written for several audiences, and a customer's assistant must only know the customer-facing parts. Each guide is
 * listed with the sections it may use; a piece that mentions an operator setting (an environment variable) is always dropped.
 *
 * Mirror side: PUBLIC (packages/api is mirrored).
 */

export interface DocChunk {
  /** Stable within a build: "<guide>#<n>". */
  id: string;
  /** Where it came from, shown to the customer: "Ingestion guide". */
  source: string;
  /** The heading it sits under, with its parents: "Receiving events from other tools > Stripe". */
  heading: string;
  text: string;
  /** A dashboard page that does what this describes, so the answer can point to it. */
  path?: string;
}

export interface GuideConfig {
  file: string;
  /** Shown as the source of every piece from this guide. */
  source: string;
  /** Only sections whose heading matches (any level, including its parents' text) are kept. Omit to allow all. */
  include?: RegExp;
  /** Sections whose heading matches are dropped. */
  exclude?: RegExp;
}

/**
 * Which guides the assistant may read, and which parts. Left out entirely, because they are for whoever runs the service: the
 * admin console, installation, deployment, Render, go-live, billing setup, and the quickstart and onboarding runbooks.
 */
export const GUIDES: readonly GuideConfig[] = [
  { file: "CONCEPTS.md", source: "Concepts guide" },
  { file: "FLOW-PROMPTS.md", source: "Flow prompt library" },
  { file: "INGESTION.md", source: "Ingestion guide" },
  { file: "WAREHOUSES.md", source: "Data warehouse guide", exclude: /for the operator/i },
  { file: "DATA.md", source: "Data export and deletion guide", include: /for customers|what erasure|known limits/i, exclude: /platform admins|by hand/i },
  { file: "FAQ.md", source: "FAQ", include: /sending problems/i },
  { file: "SENDING.md", source: "Managed sending guide", include: /how it works|what customers do/i },
];

/** Environment variables and similar settings belong to whoever runs the service, never to a customer's assistant. */
export const OPERATOR_ONLY = /\b(?:ENCRYPTION_KEY|DATABASE_URL|LOOMAIL_[A-Z_]{3,}|PLATFORM_[A-Z_]{3,}|PAYSTACK_[A-Z_]{3,}|RESEND_API_KEY|UNSUBSCRIBE_SIGNING_KEY)\b/;

export const MAX_CHUNK_CHARS = 1400;
export const MIN_CHUNK_CHARS = 60;

interface Section {
  path: string[];
  lines: string[];
}

/** Split markdown into sections at each heading. A heading inside a code fence is not a heading. */
export function splitSections(md: string): Section[] {
  const sections: Section[] = [];
  const stack: Array<{ level: number; text: string }> = [];
  let current: Section = { path: [], lines: [] };
  let fence = false;
  for (const line of md.replace(/\r\n/g, "\n").split("\n")) {
    if (/^\s*```/.test(line)) fence = !fence;
    const m = !fence ? /^(#{1,4})\s+(.+?)\s*#*\s*$/.exec(line) : null;
    if (m) {
      sections.push(current);
      const level = m[1]!.length;
      while (stack.length > 0 && stack[stack.length - 1]!.level >= level) stack.pop();
      stack.push({ level, text: m[2]!.replace(/[`*_]/g, "").trim() });
      current = { path: stack.map((s) => s.text), lines: [] };
    } else {
      current.lines.push(line);
    }
  }
  sections.push(current);
  return sections;
}

/** Cut a long section into pieces at paragraph breaks, never inside a code fence. */
export function splitLong(text: string, max: number = MAX_CHUNK_CHARS): string[] {
  const t = text.trim();
  if (t.length <= max) return t ? [t] : [];
  const blocks: string[] = [];
  let buf: string[] = [];
  let fence = false;
  for (const line of t.split("\n")) {
    if (/^\s*```/.test(line)) fence = !fence;
    buf.push(line);
    if (!fence && line.trim() === "") {
      blocks.push(buf.join("\n").trim());
      buf = [];
    }
  }
  if (buf.length) blocks.push(buf.join("\n").trim());
  const out: string[] = [];
  let acc = "";
  for (const b of blocks.filter(Boolean)) {
    if (acc && acc.length + b.length + 2 > max) {
      out.push(acc);
      acc = "";
    }
    // One block that is itself too long (a huge code sample or table) is cut at a line boundary.
    if (b.length > max) {
      if (acc) {
        out.push(acc);
        acc = "";
      }
      let piece = "";
      for (const line of b.split("\n")) {
        if (piece && piece.length + line.length + 1 > max) {
          out.push(piece);
          piece = "";
        }
        piece += (piece ? "\n" : "") + line;
      }
      if (piece) out.push(piece);
    } else {
      acc += (acc ? "\n\n" : "") + b;
    }
  }
  if (acc) out.push(acc);
  return out;
}

/** Plain text for matching and for the model: links keep their words, images and HTML comments go. */
export function cleanText(s: string): string {
  return s
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\((?:[^)]*)\)/g, "$1")
    .replace(/^\s*>\s?/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function chunkGuide(config: GuideConfig, md: string): DocChunk[] {
  const chunks: DocChunk[] = [];
  const name = config.file.replace(/\.md$/i, "");
  let n = 0;
  for (const section of splitSections(md)) {
    const headingText = section.path.join(" > ");
    if (config.include && !config.include.test(headingText)) continue;
    if (config.exclude && config.exclude.test(headingText)) continue;
    const body = cleanText(section.lines.join("\n"));
    if (body.length < MIN_CHUNK_CHARS) continue;
    for (const piece of splitLong(body)) {
      if (piece.length < MIN_CHUNK_CHARS || OPERATOR_ONLY.test(piece)) continue;
      chunks.push({ id: `${name}#${n++}`, source: config.source, heading: headingText || config.source, text: piece });
    }
  }
  return chunks;
}
