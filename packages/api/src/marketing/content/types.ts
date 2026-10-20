/**
 * The blog and the comparison ("alternatives") pages: one record per page, plus a body written as HTML in its own file.
 *
 * Rules for a comparison page (tests/marketing-content.test.ts enforces what it can):
 *   - Say only what the other product says about itself on its own site, or what could be checked there, and give the date it
 *     was checked. Quote its own words.
 *   - Where something could not be confirmed (a price, a limit), say so instead of quoting a third party or guessing.
 *   - Be fair: spell out where the other product is the better choice. No reviews, no claims about how a company treats customers.
 *   - Loomail's own prices and limits come from PLANS and ADDONS, never typed in, so a page cannot disagree with the pricing page.
 *   - Do not claim features Loomail does not have. It is email only: no SMS, push or in-app messages.
 *
 * Mirror side: PUBLIC (packages/api is mirrored).
 */
import type { SiteContext } from "../layout.js";

export type ContentKind = "blog" | "alternative";

export interface ContentEntry {
  kind: ContentKind;
  /** The last part of the address: lower case words joined by hyphens. */
  slug: string;
  /** The page heading and the Article headline. */
  title: string;
  /** The title tag before " | Loomail": at most 51 characters so the whole title fits in 60. */
  seoTitle: string;
  /** The meta description: 70 to 155 characters. */
  description: string;
  /** One or two sentences for the listing page. */
  summary: string;
  /** "YYYY-MM-DD". */
  published: string;
  /** "YYYY-MM-DD". For a comparison page this is also the day the other product was last checked. */
  updated: string;
  /** For a comparison page: the other product's name. */
  competitor?: string;
  /** The page body (everything between the heading and the call to action), as trusted HTML. */
  body: (ctx: SiteContext) => string;
}
