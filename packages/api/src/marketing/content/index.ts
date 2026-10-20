/**
 * The blog and the comparison pages: what exists, in what order, and how to find one. See ./types.ts for the rules a page must follow.
 *
 * Adding a page: add a record here and write its body in blog/<slug>.ts or alternatives/<slug>.ts (each exports `body`).
 *
 * Mirror side: PUBLIC (packages/api is mirrored).
 */
import type { ContentEntry, ContentKind } from "./types.js";
import { body as lifecycleVsMarketing } from "./blog/lifecycle-vs-marketing-vs-transactional-email.js";
import { body as onboardingSequence } from "./blog/saas-onboarding-email-sequence.js";
import { body as trialSequence } from "./blog/trial-to-paid-email-sequence.js";
import { body as retentionGrid } from "./blog/retention-grid-explained.js";
import { body as customerIo, CHECKED as customerIoChecked } from "./alternatives/customer-io.js";
import { body as loops, CHECKED as loopsChecked } from "./alternatives/loops.js";
import { body as dittofeed, CHECKED as dittofeedChecked } from "./alternatives/dittofeed.js";
import { body as userlist, CHECKED as userlistChecked } from "./alternatives/userlist.js";

export type { ContentEntry, ContentKind } from "./types.js";

export const BLOG: readonly ContentEntry[] = [
  {
    kind: "blog",
    slug: "lifecycle-vs-marketing-vs-transactional-email",
    title: "Lifecycle vs Marketing vs Transactional Email",
    seoTitle: "Lifecycle vs Marketing vs Transactional Email",
    description: "What separates lifecycle, marketing and transactional email, why it matters for opt-outs and deliverability, and which one to build first.",
    summary: "Three kinds of email that get mixed up, what each is for, and why keeping them apart makes your emails easier to write and safer to send.",
    published: "2026-10-20",
    updated: "2026-10-20",
    body: lifecycleVsMarketing,
  },
  {
    kind: "blog",
    slug: "saas-onboarding-email-sequence",
    title: "A SaaS Onboarding Email Sequence: What to Send and When",
    seoTitle: "SaaS Onboarding Email Sequence: What to Send",
    description: "A practical onboarding email sequence for software products: define activation, send four emails, branch on what people do, and measure the result.",
    summary: "Define the first useful action, send a short sequence that stops when someone reaches it, and branch on what people actually do.",
    published: "2026-10-20",
    updated: "2026-10-20",
    body: onboardingSequence,
  },
  {
    kind: "blog",
    slug: "trial-to-paid-email-sequence",
    title: "A Trial-to-Paid Email Sequence for SaaS",
    seoTitle: "Trial-to-Paid Email Sequence for SaaS",
    description: "A seven-day trial email sequence that helps people reach value first and is clear about what happens next: who gets what, and how to measure it.",
    summary: "A seven-day timeline for trial emails, with different messages for people who are active, stalled or have not started.",
    published: "2026-10-20",
    updated: "2026-10-20",
    body: trialSequence,
  },
  {
    kind: "blog",
    slug: "retention-grid-explained",
    title: "The Retention Grid, Explained",
    seoTitle: "The Retention Grid Explained: Tenure by Recency",
    description: "A retention grid crosses how long people have been with you with how recently they were active. How to read it, and what to do with each cell.",
    summary: "Why one retention number hides what matters, and how a four-by-four grid shows who to act on.",
    published: "2026-10-20",
    updated: "2026-10-20",
    body: retentionGrid,
  },
];

export const ALTERNATIVES: readonly ContentEntry[] = [
  {
    kind: "alternative",
    slug: "customer-io",
    title: "Customer.io Alternative: Loomail vs Customer.io",
    seoTitle: "Customer.io Alternative: A Fair Comparison",
    description: "Loomail vs Customer.io compared fairly: channels, price, free trial and self-hosting, and who should pick which. Checked on 20 October 2026.",
    summary: "The same starting price, very different scope: a multi-channel platform against open-source lifecycle email.",
    published: "2026-10-20",
    updated: customerIoChecked,
    competitor: "Customer.io",
    body: customerIo,
  },
  {
    kind: "alternative",
    slug: "loops",
    title: "Loops Alternative: Loomail vs Loops",
    seoTitle: "Loops Alternative: A Fair Comparison",
    description: "Loomail vs Loops compared fairly: its free plan against our open source, how each is priced, and who should pick which. Checked on 20 October 2026.",
    summary: "A free plan and a $49 paid plan against open-source software you can host yourself.",
    published: "2026-10-20",
    updated: loopsChecked,
    competitor: "Loops",
    body: loops,
  },
  {
    kind: "alternative",
    slug: "dittofeed",
    title: "Dittofeed Alternative: Loomail vs Dittofeed",
    seoTitle: "Dittofeed Alternative: A Fair Comparison",
    description: "Loomail vs Dittofeed compared fairly: two open-source options, one multi-channel and one focused on email. Prices checked on 20 October 2026.",
    summary: "Two open-source options: one covers more channels, the other focuses on email and plain-language flows.",
    published: "2026-10-20",
    updated: dittofeedChecked,
    competitor: "Dittofeed",
    body: dittofeed,
  },
  {
    kind: "alternative",
    slug: "userlist",
    title: "Userlist Alternative: Loomail vs Userlist",
    seoTitle: "Userlist Alternative: A Fair Comparison",
    description: "Loomail vs Userlist compared fairly: company accounts and in-app messages against one open-source plan. Checked on 20 October 2026.",
    summary: "Email automation built around company accounts, compared with a smaller open-source tool for lifecycle email.",
    published: "2026-10-20",
    updated: userlistChecked,
    competitor: "Userlist",
    body: userlist,
  },
];

const KINDS: Record<ContentKind, readonly ContentEntry[]> = { blog: BLOG, alternative: ALTERNATIVES };

/** The address of a page. */
export const contentPath = (e: Pick<ContentEntry, "kind" | "slug">): string => `/${e.kind === "blog" ? "blog" : "alternatives"}/${e.slug}`;

/** Newest first (by date published, then title), so the listing page and the sitemap are stable. */
export function entries(kind: ContentKind): ContentEntry[] {
  return [...KINDS[kind]].sort((a, b) => b.published.localeCompare(a.published) || a.title.localeCompare(b.title));
}

export function getEntry(kind: ContentKind, slug: string): ContentEntry | undefined {
  return KINDS[kind].find((e) => e.slug === slug);
}

/** Other pages of the same kind, newest first: the "keep reading" list at the end of a page. */
export function related(entry: ContentEntry, limit = 3): ContentEntry[] {
  return entries(entry.kind).filter((e) => e.slug !== entry.slug).slice(0, limit);
}

/** Text without tags, entities decoded for counting, whitespace collapsed. */
export function plainText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&[a-z]+;|&#\d+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const WORDS_PER_MINUTE = 200;

/** Minutes to read, from the words on the page (at least 1). */
export function readingMinutes(html: string): number {
  return Math.max(1, Math.round(plainText(html).split(" ").filter(Boolean).length / WORDS_PER_MINUTE));
}

/**
 * Comparison pages whose facts were last checked more than `maxDays` ago. A comparison goes stale when the other product changes its
 * prices or features, so these need re-checking against the other product's own site before they are left up.
 */
export function staleAlternatives(now: Date = new Date(), maxDays = 90): ContentEntry[] {
  const limit = maxDays * 86_400_000;
  return ALTERNATIVES.filter((e) => now.getTime() - Date.parse(`${e.updated}T00:00:00Z`) > limit);
}
