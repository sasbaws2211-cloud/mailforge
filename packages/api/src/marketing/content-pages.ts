/**
 * The page layouts for the blog and the comparison pages: one article page and one listing page.
 *
 * Mirror side: PUBLIC (packages/api is mirrored).
 */
import { TRIAL_DAYS } from "@loomail/core";
import { esc, OG_IMAGE_PATH, renderPage, SITE_NAME, type SiteContext } from "./layout.js";
import { contentPath, entries, readingMinutes, related, type ContentEntry, type ContentKind } from "./content/index.js";
import { longDate } from "./content/html.js";

/** A JSON-LD block. "<" is escaped so the payload can never close its own script tag. */
function jsonLd(data: unknown): string {
  return `<script type="application/ld+json">${JSON.stringify(data).replace(/</g, "\\u003c")}</script>`;
}

const SECTION: Record<ContentKind, { name: string; path: string }> = {
  blog: { name: "Blog", path: "/blog" },
  alternative: { name: "Alternatives", path: "/alternatives" },
};

function articleData(ctx: SiteContext, e: ContentEntry): unknown {
  return {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: e.title,
    description: e.description,
    mainEntityOfPage: { "@type": "WebPage", "@id": `${ctx.siteUrl}${contentPath(e)}` },
    datePublished: e.published,
    dateModified: e.updated,
    image: [`${ctx.siteUrl}${OG_IMAGE_PATH}`],
    author: { "@type": "Organization", name: SITE_NAME, url: `${ctx.siteUrl}/` },
    publisher: { "@type": "Organization", name: SITE_NAME, logo: { "@type": "ImageObject", url: `${ctx.siteUrl}/apple-touch-icon.png` } },
  };
}

function breadcrumbs(ctx: SiteContext, items: Array<[string, string]>): unknown {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map(([name, path], i) => ({ "@type": "ListItem", position: i + 1, name, item: `${ctx.siteUrl}${path}` })),
  };
}

/** One blog post or comparison page. */
export function articlePage(ctx: SiteContext, e: ContentEntry): string {
  const section = SECTION[e.kind];
  const content = e.body(ctx);
  const minutes = readingMinutes(content);
  const others = related(e);
  const when = e.kind === "alternative" ? `Checked on ${longDate(e.updated)}` : `Published ${longDate(e.published)}`;
  const updated = e.kind === "blog" && e.updated !== e.published ? ` &middot; Updated ${esc(longDate(e.updated))}` : "";
  const disclosure =
    e.kind === "alternative"
      ? `<p class="disclosure"><b>Who wrote this.</b> We make ${SITE_NAME}, so we are not neutral. We looked at ${esc(e.competitor ?? "the other product")}'s own site on ${esc(longDate(e.updated))} and only state what it says there. Where we could not confirm something, we say so instead of guessing. Prices and features change: if anything here is out of date, write to <a href="mailto:${esc(ctx.supportEmail)}">${esc(ctx.supportEmail)}</a> and we will correct it.</p>`
      : "";

  const body = `
<div class="wrap"><article class="article">
  <p class="crumb"><a href="${section.path}">${section.name}</a></p>
  <h1>${esc(e.title)}</h1>
  <p class="meta">${esc(when)}${updated} &middot; ${minutes} min read</p>
  ${disclosure}
  ${content}
  <div class="cta">
    <p><b>Try ${SITE_NAME} free for ${TRIAL_DAYS} days.</b> No credit card. Describe your first flow and see what it does.</p>
    <a class="btn" href="/signup">Start free trial</a> &nbsp; <a href="/pricing">See pricing</a>
  </div>
  ${
    others.length
      ? `<div class="more"><h2>${e.kind === "blog" ? "Keep reading" : "More comparisons"}</h2><ul>${others.map((o) => `<li><a href="${contentPath(o)}">${esc(o.title)}</a></li>`).join("")}</ul></div>`
      : ""
  }
</article></div>`;

  return renderPage(
    ctx,
    {
      title: `${e.seoTitle} | ${SITE_NAME}`,
      description: e.description,
      path: contentPath(e),
      ogType: "article",
      headExtra: jsonLd(articleData(ctx, e)) + jsonLd(breadcrumbs(ctx, [[SITE_NAME, "/"], [section.name, section.path], [e.title, contentPath(e)]])),
    },
    body,
  );
}

/** The list of blog posts, or of comparison pages. */
export function contentIndexPage(ctx: SiteContext, kind: ContentKind): string {
  const section = SECTION[kind];
  const blog = kind === "blog";
  const list = entries(kind);
  const body = `
<div class="wrap"><div class="article">
  <h1>${blog ? "Lifecycle email, in practice" : "Alternatives and comparisons"}</h1>
  <p class="lead">${
    blog
      ? "Short, practical guides to onboarding, trials, retention and the emails around them."
      : `How ${SITE_NAME} compares with other tools, written fairly: where each one is the better choice, and what we could not confirm.`
  }</p>
  ${list
    .map(
      (e) => `<div class="card" style="margin:16px 0">
    <h2 style="font-size:1.2rem;margin:0 0 6px"><a href="${contentPath(e)}" style="color:inherit;text-decoration:none">${esc(e.title)}</a></h2>
    <p style="margin:0 0 8px">${esc(e.summary)}</p>
    <p class="meta" style="margin:0">${blog ? "" : "Checked "}${esc(longDate(e.updated))}</p>
  </div>`,
    )
    .join("\n")}
  ${blog ? "" : `<p class="meta">We make ${SITE_NAME}, so we are not neutral. Each page says what we checked, and when. Something wrong? <a href="mailto:${esc(ctx.supportEmail)}">Tell us</a>.</p>`}
</div></div>`;

  return renderPage(
    ctx,
    {
      title: blog ? `Lifecycle Email Guides for SaaS | ${SITE_NAME}` : `Alternatives and Comparisons | ${SITE_NAME}`,
      description: blog
        ? "Short, practical guides to onboarding emails, trial emails, retention and the difference between lifecycle, marketing and transactional email."
        : `Fair comparisons of ${SITE_NAME} with Customer.io, Loops, Dittofeed and Userlist: what each does, what it costs, and who should pick which.`,
      path: section.path,
      headExtra: jsonLd(breadcrumbs(ctx, [[SITE_NAME, "/"], [section.name, section.path]])),
    },
    body,
  );
}
