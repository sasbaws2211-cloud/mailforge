/**
 * Public site layout: the shell shared by the landing, pricing, legal and
 * signup pages. Server-rendered HTML with inline CSS, no framework and no
 * required JavaScript, so pages are fast and readable by search engines.
 *
 * Brand tokens match the dashboard (ember orange accent, warm neutrals,
 * dark mode via prefers-color-scheme).
 *
 * Mirror side: PUBLIC (packages/api is mirrored).
 */

export const SITE_NAME = "Mailforge";

/** Escape text for HTML content and double-quoted attribute positions. */
export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Mailforge envelope mark, painted with currentColor. */
export const MARK_SVG =
  '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
  '<path d="M5 5 H19 A3 3 0 0 1 22 8 V16 A3 3 0 0 1 19 19 H5 A3 3 0 0 1 2 16 V8 A3 3 0 0 1 5 5 Z ' +
  'M4.4 8.1 L12 13.7 L19.6 8.1 L19.6 10.7 L12 16.3 L4.4 10.7 Z" fill="currentColor" fill-rule="evenodd"/></svg>';

export interface SiteContext {
  /** Absolute origin of the site, no trailing slash. Used for canonical URLs and the sitemap. */
  siteUrl: string;
  /** Contact address shown in the footer and legal pages. */
  supportEmail: string;
  /** Legal entity name for the legal pages. */
  legalName: string;
}

export interface PageOptions {
  title: string;
  description: string;
  /** Path of this page, for the canonical URL and active nav state. */
  path: string;
  /** Extra tags for the head (for example JSON-LD). Trusted markup only. */
  headExtra?: string;
  /** Hide the marketing nav links (used on the signup page). */
  minimalNav?: boolean;
  /** Mark a page as not for search engines. */
  noindex?: boolean;
}

const CSS = `
:root{--bg:#fbf9f6;--surface:#ffffff;--ink:#1d1b19;--muted:#5c5750;--line:#e8e2da;--accent:#b8541a;--accent-fg:#ffffff;--accent-soft:#f8ebe1;--ok:#2f7d4f;--shadow:0 1px 2px rgba(29,27,25,.06),0 8px 24px rgba(29,27,25,.06)}
@media (prefers-color-scheme:dark){:root{--bg:#14161b;--surface:#1c1f26;--ink:#ece9e4;--muted:#a8a39b;--line:#2b2f38;--accent:#e08a52;--accent-fg:#1a1a1a;--accent-soft:#2a211c;--ok:#6fcf97;--shadow:0 1px 2px rgba(0,0,0,.4),0 8px 24px rgba(0,0,0,.35)}}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;line-height:1.6;-webkit-font-smoothing:antialiased}
a{color:var(--accent)}
img,svg{max-width:100%}
.wrap{max-width:1120px;margin:0 auto;padding:0 20px}
.skip{position:absolute;left:-999px}.skip:focus{left:12px;top:12px;background:var(--surface);padding:8px 12px;border-radius:8px;z-index:50}
/* nav */
.nav{position:sticky;top:0;z-index:20;background:color-mix(in srgb,var(--bg) 88%,transparent);backdrop-filter:saturate(1.4) blur(10px);border-bottom:1px solid var(--line)}
.nav .wrap{display:flex;align-items:center;gap:24px;height:64px}
.logo{display:flex;align-items:center;gap:8px;color:var(--accent);text-decoration:none}
.logo b{color:var(--ink);font-size:1.15rem;letter-spacing:.01em}
.nav .links{display:flex;gap:22px;margin-left:12px}
.nav .links a{color:var(--muted);text-decoration:none;font-size:.95rem}
.nav .links a:hover,.nav .links a[aria-current]{color:var(--ink)}
.nav .right{margin-left:auto;display:flex;align-items:center;gap:14px}
.nav .signin{color:var(--muted);text-decoration:none;font-size:.95rem}
.nav .signin:hover{color:var(--ink)}
/* buttons */
.btn{display:inline-block;background:var(--accent);color:var(--accent-fg);text-decoration:none;font-weight:600;border-radius:10px;padding:12px 22px;border:1px solid transparent;font:inherit;font-weight:600;cursor:pointer;line-height:1.2}
.btn:hover{filter:brightness(.94)}
.btn:focus-visible,a:focus-visible,summary:focus-visible,input:focus-visible,select:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
.btn.sm{padding:9px 16px;font-size:.92rem}
.btn.ghost{background:transparent;color:var(--ink);border-color:var(--line)}
.btn.ghost:hover{border-color:var(--muted);filter:none}
.btn.block{display:block;width:100%;text-align:center}
/* sections */
section{padding:72px 0}
.eyebrow{color:var(--accent);font-weight:700;letter-spacing:.08em;text-transform:uppercase;font-size:.78rem;margin:0 0 10px}
h1,h2,h3{line-height:1.15;letter-spacing:-.02em;margin:0}
h1{font-size:clamp(2.2rem,5.2vw,3.7rem);font-weight:800}
h2{font-size:clamp(1.7rem,3.4vw,2.4rem);font-weight:800}
h3{font-size:1.1rem;letter-spacing:-.01em}
.lead{font-size:1.2rem;color:var(--muted);max-width:640px;margin:18px 0 0}
.center{text-align:center}.center .lead{margin-left:auto;margin-right:auto}
.muted{color:var(--muted)}
/* hero */
.hero{padding:72px 0 56px;background:radial-gradient(900px 380px at 78% -10%,color-mix(in srgb,var(--accent) 16%,transparent),transparent 70%)}
.hero .grid{display:grid;grid-template-columns:1.05fr .95fr;gap:48px;align-items:center}
.hero .cta{display:flex;flex-wrap:wrap;gap:12px;margin-top:30px}
.hero .fine{font-size:.9rem;color:var(--muted);margin-top:14px}
.hl{color:var(--accent)}
/* flow mock */
.mock{background:var(--surface);border:1px solid var(--line);border-radius:16px;box-shadow:var(--shadow);padding:18px;font-size:.92rem}
.mock .row{border:1px solid var(--line);border-radius:12px;padding:12px 14px;margin:0 0 10px;background:var(--bg)}
.mock .row:last-child{margin-bottom:0}
.mock .tag{display:inline-block;font-size:.7rem;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:var(--accent);margin-bottom:4px}
.mock .arrow{text-align:center;color:var(--muted);margin:-2px 0 8px;font-size:.85rem}
.mock .plan{list-style:none;margin:6px 0 0;padding:0}
.mock .plan li{display:flex;gap:8px;align-items:baseline;padding:2px 0}
.mock .plan code{background:var(--accent-soft);color:var(--accent);border-radius:6px;padding:1px 7px;font-size:.8rem;white-space:nowrap}
.mock .mail{background:var(--surface)}
.mock .mail b{display:block}
/* cards */
.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:18px;margin-top:40px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:16px;padding:24px}
.card p{margin:8px 0 0;color:var(--muted)}
.card .ico{width:38px;height:38px;border-radius:10px;background:var(--accent-soft);color:var(--accent);display:flex;align-items:center;justify-content:center;font-weight:800;margin-bottom:14px}
.steps{display:grid;grid-template-columns:repeat(3,1fr);gap:18px;margin-top:40px;counter-reset:s}
.step{position:relative;padding:24px;border-left:3px solid var(--accent);background:var(--surface);border-radius:0 16px 16px 0;border-top:1px solid var(--line);border-right:1px solid var(--line);border-bottom:1px solid var(--line)}
.step:before{counter-increment:s;content:counter(s);display:block;font-weight:800;color:var(--accent);font-size:1.4rem;margin-bottom:6px}
.step p{margin:8px 0 0;color:var(--muted)}
.band{background:var(--surface);border-top:1px solid var(--line);border-bottom:1px solid var(--line)}
/* pricing */
.toggle{display:inline-flex;border:1px solid var(--line);border-radius:999px;padding:4px;background:var(--surface);margin-top:26px}
.toggle button{border:0;background:transparent;color:var(--muted);font:inherit;font-weight:600;padding:8px 18px;border-radius:999px;cursor:pointer}
.toggle button[aria-pressed=true]{background:var(--accent);color:var(--accent-fg)}
.save{font-size:.78rem;font-weight:700;color:var(--ok);margin-left:6px}
.plans{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin-top:36px;align-items:stretch}
.plan-card{background:var(--surface);border:1px solid var(--line);border-radius:16px;padding:24px;display:flex;flex-direction:column}
.plan-card.rec{border:2px solid var(--accent);box-shadow:var(--shadow);position:relative}
.badge{position:absolute;top:-12px;left:20px;background:var(--accent);color:var(--accent-fg);font-size:.72rem;font-weight:800;letter-spacing:.06em;text-transform:uppercase;border-radius:999px;padding:3px 10px}
.price{font-size:2.5rem;font-weight:800;letter-spacing:-.03em;margin:14px 0 0}
.price small{font-size:.95rem;font-weight:500;color:var(--muted);letter-spacing:0}
.billed{min-height:1.4em;font-size:.85rem;color:var(--muted)}
.plan-card ul{list-style:none;padding:0;margin:20px 0 24px;flex:1}
.plan-card li{padding:5px 0 5px 24px;position:relative;font-size:.95rem}
.plan-card li:before{content:"";position:absolute;left:2px;top:12px;width:12px;height:7px;border-left:2px solid var(--accent);border-bottom:2px solid var(--accent);transform:rotate(-45deg)}
.note{max-width:760px;margin:28px auto 0;text-align:center;color:var(--muted);font-size:.95rem}
/* faq */
.faq{max-width:760px;margin:36px auto 0}
details{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:0 18px;margin:0 0 10px}
summary{cursor:pointer;font-weight:600;padding:16px 0;list-style:none;display:flex;justify-content:space-between;gap:12px}
summary::-webkit-details-marker{display:none}
summary:after{content:"+";color:var(--accent);font-weight:800}
details[open] summary:after{content:"\\2212"}
details p{margin:0 0 16px;color:var(--muted)}
/* cta band */
.cta-band{text-align:center;background:var(--accent-soft);border:1px solid var(--line);border-radius:20px;padding:48px 24px}
.cta-band p{color:var(--muted);margin:12px 0 24px}
/* forms */
.form-card{background:var(--surface);border:1px solid var(--line);border-radius:16px;padding:28px;box-shadow:var(--shadow)}
label{display:block;font-weight:600;font-size:.92rem;margin:0 0 6px}
input[type=text],input[type=email]{width:100%;font:inherit;color:var(--ink);background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin:0 0 16px}
.check{display:flex;gap:10px;align-items:flex-start;font-weight:400;font-size:.9rem;color:var(--muted);margin:4px 0 20px}
.check input{margin-top:4px}
.goals{border:0;padding:0;margin:0 0 18px;min-width:0}
.goals legend{font-weight:600;font-size:.92rem;padding:0;margin:0 0 8px}
.goals legend span{font-weight:400;color:var(--muted)}
.goal{display:flex;gap:10px;align-items:flex-start;font-weight:400;border:1px solid var(--line);border-radius:10px;padding:10px 12px;margin:0 0 8px;cursor:pointer;background:var(--bg)}
.goal:has(input:checked){border-color:var(--accent);background:var(--accent-soft)}
.goal input{margin-top:4px}
.goal b{display:block;font-weight:600;font-size:.92rem}
.goal small{display:block;color:var(--muted);font-size:.84rem;margin-top:1px}
.err{background:color-mix(in srgb,#d33 12%,var(--surface));border:1px solid color-mix(in srgb,#d33 45%,var(--line));color:var(--ink);border-radius:10px;padding:12px 14px;margin:0 0 18px;font-size:.93rem}
.hp{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}
.signup{display:grid;grid-template-columns:1fr 1fr;gap:56px;align-items:start;padding:56px 0}
.perks{list-style:none;padding:0;margin:26px 0 0}
.perks li{padding:8px 0 8px 30px;position:relative;color:var(--muted)}
.perks li:before{content:"";position:absolute;left:4px;top:15px;width:13px;height:7px;border-left:2px solid var(--accent);border-bottom:2px solid var(--accent);transform:rotate(-45deg)}
/* legal */
.legal{max-width:760px;margin:0 auto;padding:56px 0}
.legal h1{font-size:2.2rem}.legal h2{font-size:1.25rem;margin:32px 0 8px;letter-spacing:-.01em}
.legal p,.legal li{color:var(--muted)}
.legal .upd{font-size:.9rem;color:var(--muted);margin:10px 0 24px}
/* footer */
footer{border-top:1px solid var(--line);padding:40px 0;color:var(--muted);font-size:.92rem}
footer .cols{display:flex;flex-wrap:wrap;gap:24px 48px;justify-content:space-between}
footer a{color:var(--muted);text-decoration:none}footer a:hover{color:var(--ink)}
footer .fl{display:flex;gap:20px;flex-wrap:wrap}
@media (max-width:960px){.plans{grid-template-columns:repeat(2,1fr)}.cards,.steps{grid-template-columns:1fr 1fr}}
@media (max-width:760px){
  section{padding:52px 0}.hero{padding:44px 0 36px}
  .hero .grid,.signup{grid-template-columns:1fr;gap:32px}
  .nav .links{display:none}.nav .wrap{gap:12px}
  .cards,.steps,.plans{grid-template-columns:1fr}
  .signup{padding:36px 0}
}
@media (prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
`;

function nav(opts: PageOptions): string {
  const cur = (p: string): string => (opts.path === p ? ' aria-current="page"' : "");
  const links = opts.minimalNav
    ? ""
    : `<nav class="links" aria-label="Main"><a href="/#features">Features</a><a href="/#how">How it works</a><a href="/pricing"${cur("/pricing")}>Pricing</a></nav>`;
  return `<header class="nav"><div class="wrap">
<a class="logo" href="/" aria-label="${SITE_NAME} home">${MARK_SVG}<b>${SITE_NAME.toLowerCase()}</b></a>
${links}
<div class="right"><a class="signin" href="/login">Sign in</a><a class="btn sm" href="/signup">Start free trial</a></div>
</div></header>`;
}

function footer(ctx: SiteContext): string {
  const year = new Date().getUTCFullYear();
  return `<footer><div class="wrap cols">
<div><a class="logo" href="/" style="margin-bottom:8px">${MARK_SVG}<b>${SITE_NAME.toLowerCase()}</b></a><br>Lifecycle email for software products.<br>&copy; ${year} ${esc(ctx.legalName)}</div>
<div class="fl"><a href="/pricing">Pricing</a><a href="/terms">Terms</a><a href="/privacy">Privacy</a><a href="mailto:${esc(ctx.supportEmail)}">${esc(ctx.supportEmail)}</a></div>
</div></footer>`;
}

/** Render a full HTML document around a page body. */
export function renderPage(ctx: SiteContext, opts: PageOptions, body: string): string {
  const canonical = `${ctx.siteUrl}${opts.path === "/" ? "/" : opts.path}`;
  const robots = opts.noindex ? '<meta name="robots" content="noindex,nofollow">' : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(opts.title)}</title>
<meta name="description" content="${esc(opts.description)}">
<link rel="canonical" href="${esc(canonical)}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<meta name="theme-color" content="#b8541a">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${SITE_NAME}">
<meta property="og:title" content="${esc(opts.title)}">
<meta property="og:description" content="${esc(opts.description)}">
<meta property="og:url" content="${esc(canonical)}">
<meta name="twitter:card" content="summary">
${robots}
<style>${CSS}</style>
${opts.headExtra ?? ""}
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
${nav(opts)}
<main id="main">
${body}
</main>
${footer(ctx)}
</body>
</html>`;
}
