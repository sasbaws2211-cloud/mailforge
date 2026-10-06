/**
 * Unsubscribe routes - public, unauthenticated.
 *
 * Three endpoints, all stateless-token-verified, all write a suppression row
 * on success, all idempotent (second call for an already-suppressed address
 * is a success, not an error).
 *
 * RFC 8058 one-click (mailbox provider automation):
 *   POST /unsubscribe/one-click
 *     Body: application/x-www-form-urlencoded  { List-Unsubscribe=One-Click }
 *     Query: ?token=<token>
 *     Caller: mailbox provider (Gmail, Yahoo, etc.)
 *     Returns: 200 JSON { unsubscribed: true }
 *     Contract: must be a plain POST with no redirect; the provider does not
 *     follow redirects and does not render responses.
 *
 * Browser-facing GET (human confirmation page):
 *   GET /unsubscribe
 *     Query: ?token=<token>
 *     Caller: human clicking the link in an email
 *     Returns: 200 HTML page confirming the action and showing a submit button.
 *     Contract: GET must NEVER suppress. A link preview, scanner, or crawler
 *     fetching the URL must not unsubscribe the contact. The human must click.
 *
 * Browser-facing POST (human submits the confirmation form):
 *   POST /unsubscribe
 *     Body: application/x-www-form-urlencoded  { token=<token> }
 *       OR  application/json  { token: "<token>" }
 *     Caller: browser submitting the form from the GET page
 *     Returns: 200 HTML confirmation page (or JSON { unsubscribed: true } for
 *     programmatic callers that send application/json).
 *
 * Distinguishing one-click POST from browser POST:
 *   - One-click: token is in the query string; body is the RFC 8058 sentinel
 *     { List-Unsubscribe: "One-Click" }. Route is /unsubscribe/one-click.
 *   - Browser POST: token is in the body (form field or JSON field). Route is
 *     /unsubscribe. Different paths, different callers, different bodies.
 *   - The two routes can share the internal "resolve and suppress" logic but
 *     must remain separate endpoints because their URL shapes are embedded in
 *     email headers and must never collide.
 *
 * Address resolution:
 *   The token encodes the message ID (not the contact ID). The address is
 *   resolved from lifecycle_messages.recipient_address - the address the drain
 *   prepared the message for, written before the send attempt. The endpoint
 *   additionally requires status = 'sent' to confirm delivery actually occurred.
 *   Writing recipient_address before the send covers the crash window where the
 *   provider accepted the message but the post-send DB write never completed;
 *   in that case reap will eventually recover the row to 'sent'. A token for a
 *   message at any other status (sending, failed, approved, etc.) is treated as
 *   invalid and nothing is suppressed. If the message row no longer exists
 *   (deleted or purged), the token is also treated as invalid - same opaque 400.
 *
 * Failure behavior:
 *   An invalid or unverifiable token returns 400 with { error: "Invalid unsubscribe link." }.
 *   The same response is returned for all failure reasons (malformed, bad_signature,
 *   invalid_payload, message not found, not status='sent', recipient_address absent)
 *   so callers cannot distinguish which part failed. No information about whether
 *   the underlying message or contact exists is revealed.
 *
 * Migration check:
 *   This implementation requires migration 0015 (recipient_address column on
 *   lifecycle_messages). That migration must be applied before this code runs.
 *
 * Mirror side: PUBLIC (packages/api is mirrored).
 */
import type { FastifyPluginAsync } from "fastify";
import { eq, and, sql } from "drizzle-orm";
import { lifecycleMessages, suppressions, tenants } from "@mailforge/db/schema";
import { verifyUnsubscribeToken } from "@mailforge/adapters";
import { DEFAULT_ACCENT, entitlementsFor, poweredByFor, type BrandSettings, type PoweredBy } from "@mailforge/core";
import type { Db } from "../plugins/db.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Suppression reason written by all unsubscribe endpoints. */
const UNSUBSCRIBE_REASON = "unsubscribe" as const;

/** Source for one-click RFC 8058 endpoint. */
const SOURCE_ONE_CLICK = "one_click" as const;

/** Source for browser-facing POST endpoint. */
const SOURCE_PAGE = "page" as const;

// ---------------------------------------------------------------------------
// Shared logic
// ---------------------------------------------------------------------------

/**
 * Resolve a token, look up the recipient_address from the message row,
 * confirm status = 'sent', write a suppression, return the email.
 *
 * Returns { ok: true, email } on success, or { ok: false } on any failure.
 * All failure modes return the same shape to avoid leaking which step failed.
 *
 * Status check: recipient_address is written before the send attempt, so it
 * may be set on messages that never completed delivery (status = 'sending',
 * 'failed', etc.). Requiring status = 'sent' ensures the token only resolves
 * for messages that actually went out.
 *
 * Normalization: the email is lowercased before insertion (same as the import
 * path). The functional unique index on (tenant_id, lower(email)) ensures
 * idempotency.
 */
async function resolveAndSuppress(
  db: Db,
  token: string,
  source: typeof SOURCE_ONE_CLICK | typeof SOURCE_PAGE,
): Promise<{ ok: true; email: string; tenantId: string } | { ok: false; missingKey?: true }> {
  // Step 1: verify the token.
  // verifyUnsubscribeToken throws when UNSUBSCRIBE_SIGNING_KEY is absent - that
  // is a server misconfiguration, not a bad token. Catch and surface as a
  // distinct missingKey flag so routes can return 503 rather than 500.
  let result: ReturnType<typeof verifyUnsubscribeToken>;
  try {
    result = verifyUnsubscribeToken(token);
  } catch {
    return { ok: false, missingKey: true };
  }
  if (!result.ok) {
    return { ok: false };
  }

  const { tenantId, messageId } = result.payload;

  // Step 2: resolve the message row - must exist, have status = 'sent', and
  // have a recipient_address set. recipient_address is written before the send
  // attempt, so it may be present on messages that failed or are still in
  // transit. The status = 'sent' check is the authoritative proof of delivery.
  const messageRows = await db
    .select({
      recipientAddress: lifecycleMessages.recipientAddress,
      status: lifecycleMessages.status,
    })
    .from(lifecycleMessages)
    .where(
      and(
        eq(lifecycleMessages.id, messageId),
        eq(lifecycleMessages.tenantId, tenantId),
      ),
    )
    .limit(1);

  if (messageRows.length === 0) {
    // Message row does not exist (purged, or token forged with a non-existent ID).
    // Return the same opaque failure - no enumeration.
    return { ok: false };
  }

  const { recipientAddress, status } = messageRows[0]!;

  if (status !== "sent") {
    // Message exists but was not successfully delivered. This covers:
    //   - status = 'approved' or 'sending': not yet sent (recipient_address may
    //     be null or set; either way delivery has not occurred)
    //   - status = 'failed': permanent transport failure; message never delivered
    //   - any other non-terminal status: also not delivered
    // Token is structurally valid but the message was not sent - reject.
    return { ok: false };
  }

  if (!recipientAddress || recipientAddress.trim().length === 0) {
    // Sent message with no recipient_address recorded - should not happen in
    // normal operation (drain always writes it before the send attempt), but
    // treat it as invalid for safety.
    return { ok: false };
  }

  // Normalize: lowercase the email before storage.
  const normalizedEmail = recipientAddress.toLowerCase();

  // Step 3: write the suppression - idempotent via ON CONFLICT DO NOTHING
  await db.execute(sql`
    INSERT INTO suppressions (tenant_id, email, reason, source)
    VALUES (${tenantId}::uuid, ${normalizedEmail}, ${UNSUBSCRIBE_REASON}, ${source})
    ON CONFLICT (tenant_id, lower(email)) DO NOTHING
  `);

  return { ok: true, email: normalizedEmail, tenantId };
}

// ---------------------------------------------------------------------------
// HTML helpers
// ---------------------------------------------------------------------------

/**
 * What the public pages show about the sender. Comes from the brand settings
 * of the tenant that sent the email (the same ones the email shell uses);
 * every field falls back to the Mailforge defaults so a page always renders,
 * even if the lookup fails.
 */
interface PageBrand {
  name: string;
  accent: string;
  logoUrl: string | null;
  logoHeight: number;
  /** Credit line for plans that carry the platform branding (Free). */
  poweredBy?: PoweredBy;
}

const DEFAULT_BRAND: PageBrand = {
  name: "Mailforge",
  accent: DEFAULT_ACCENT,
  logoUrl: null,
  logoHeight: 28,
};

/** Escape text for HTML content and double-quoted attribute positions. */
function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Accept #RGB or #RRGGBB only; anything else falls back to the default. */
function safeHex(color: string | undefined): string {
  if (color && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(color)) {
    return color.length === 4
      ? "#" + color.slice(1).split("").map((c) => c + c).join("")
      : color;
  }
  return DEFAULT_ACCENT;
}

/** White or near-black text, whichever contrasts better on the given hex. */
function readableOn(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  }) as [number, number, number];
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  // #1a1a1a has relative luminance ~0.010; pick the text with the higher contrast.
  const contrastWhite = 1.05 / (lum + 0.05);
  const contrastDark = (lum + 0.05) / 0.06;
  return contrastDark > contrastWhite ? "#1a1a1a" : "#ffffff";
}

/**
 * Look up the sending tenant brand for the public pages. Read-only. Never
 * throws: a missing db, unknown tenant, or malformed settings all yield the
 * defaults.
 */
async function loadPageBrand(db: Db | undefined, tenantId: string): Promise<PageBrand> {
  if (!db) return DEFAULT_BRAND;
  try {
    const rows = await db
      .select({
        name: tenants.name,
        settings: tenants.settings,
        plan: tenants.plan,
        trialEndsAt: tenants.trialEndsAt,
        paidThrough: tenants.planPaidThrough,
      })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    if (rows.length === 0) return DEFAULT_BRAND;
    const settings = (rows[0]!.settings as Record<string, unknown> | null) ?? {};
    const brand = (settings.brand as BrandSettings | undefined) ?? {};
    const name = (brand.brand_name || rows[0]!.name || "").trim();
    const logoUrl =
      typeof brand.logo_url === "string" && /^https?:\/\//i.test(brand.logo_url)
        ? brand.logo_url
        : null;
    const h = brand.logo_height;
    // Free workspaces carry a small credit; paid plans and self-hosted installs do not.
    const poweredBy = poweredByFor(
      entitlementsFor({ plan: rows[0]!.plan, trialEndsAt: rows[0]!.trialEndsAt, paidThrough: rows[0]!.paidThrough }),
    );
    return {
      name: name || DEFAULT_BRAND.name,
      accent: safeHex(brand.accent_color),
      logoUrl,
      logoHeight: !h || h < 16 ? 28 : Math.min(Math.round(h), 64),
      ...(poweredBy ? { poweredBy } : {}),
    };
  } catch {
    return DEFAULT_BRAND;
  }
}

/** The Mailforge envelope mark (same geometry as the dashboard brand mark). */
const MARK_SVG =
  '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
  '<path d="M5 5 H19 A3 3 0 0 1 22 8 V16 A3 3 0 0 1 19 19 H5 A3 3 0 0 1 2 16 V8 A3 3 0 0 1 5 5 Z ' +
  'M4.4 8.1 L12 13.7 L19.6 8.1 L19.6 10.7 L12 16.3 L4.4 10.7 Z" fill="currentColor" fill-rule="evenodd"/></svg>';

/**
 * Shared page shell: branded header, card, mobile layout, dark mode.
 * Plain HTML and inline CSS only (no scripts, no external assets other than
 * the sender own logo) so it renders anywhere an email link opens.
 */
function pageShell(brand: PageBrand, title: string, bodyHtml: string): string {
  const name = escHtml(brand.name);
  const header = brand.logoUrl
    ? '<img class="logo" src="' + escHtml(brand.logoUrl) + '" alt="' + name +
      '" style="height:' + brand.logoHeight + 'px">'
    : '<span class="mark">' + MARK_SVG + '</span><span class="wordmark">' + name + "</span>";
  return [
    "<!DOCTYPE html>",
    '<html lang="en">',
    "<head>",
    '  <meta charset="UTF-8">',
    '  <meta name="viewport" content="width=device-width, initial-scale=1">',
    '  <meta name="robots" content="noindex">',
    "  <title>" + escHtml(title) + "</title>",
    "  <style>",
    "    :root { --accent: " + brand.accent + "; --accent-fg: " + readableOn(brand.accent) +
      "; --bg: #f7f5f2; --card: #ffffff; --fg: #1d1b19; --muted: #5c5750; --line: #e6e1da; }",
    "    @media (prefers-color-scheme: dark) { :root { --bg: #15171c; --card: #1e2128; --fg: #ece9e4; --muted: #a8a39b; --line: #2c3039; } }",
    "    * { box-sizing: border-box; }",
    "    body { margin: 0; min-height: 100vh; background: var(--bg); color: var(--fg); display: flex; align-items: flex-start; justify-content: center;",
    "           font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; line-height: 1.5; }",
    "    main { width: 100%; max-width: 440px; margin: 12vh 16px 32px; }",
    "    .brand { display: flex; align-items: center; gap: 8px; margin-bottom: 20px; color: var(--accent); }",
    "    .mark { display: flex; }",
    "    .wordmark { font-size: 1.15rem; font-weight: 700; letter-spacing: 0.01em; color: var(--fg); }",
    "    .logo { display: block; max-width: 220px; width: auto; }",
    "    .card { background: var(--card); border: 1px solid var(--line); border-top: 4px solid var(--accent); border-radius: 10px; padding: 28px 24px; }",
    "    h1 { font-size: 1.35rem; line-height: 1.25; margin: 0 0 8px; }",
    "    p { color: var(--muted); margin: 0 0 20px; }",
    "    p:last-child { margin-bottom: 0; }",
    "    .credit { text-align: center; font-size: 12px; margin: 16px 0 0; }",
    "    .credit a { color: var(--muted); text-decoration: none; }",
    "    button { width: 100%; background: var(--accent); color: var(--accent-fg); border: 0; border-radius: 8px; padding: 13px 20px;",
    "             font: inherit; font-weight: 600; cursor: pointer; }",
    "    button:hover { filter: brightness(0.93); }",
    "    button:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }",
    "  </style>",
    "</head>",
    "<body>",
    "  <main>",
    '    <div class="brand">' + header + "</div>",
    '    <div class="card">',
    bodyHtml,
    "    </div>",
    brand.poweredBy && /^https?:\/\//i.test(brand.poweredBy.url)
      ? '    <p class="credit"><a href="' + escHtml(brand.poweredBy.url) + '">Sent with ' + escHtml(brand.poweredBy.name) + "</a></p>"
      : "",
    "  </main>",
    "</body>",
    "</html>",
  ].join("\n");
}

/**
 * Unsubscribe confirmation page (GET).
 * Shows a button the human must click; does not auto-submit.
 */
function unsubscribePageHtml(token: string, brand: PageBrand): string {
  // Escape token for HTML attribute (base64url chars are safe, but be explicit)
  const safeToken = token.replace(/[^A-Za-z0-9._~-]/g, "");
  const name = escHtml(brand.name);
  return pageShell(
    brand,
    "Unsubscribe",
    [
      "      <h1>Unsubscribe from " + name + "</h1>",
      "      <p>Click the button below to stop receiving emails from " + name + ".</p>",
      '      <form method="POST" action="/unsubscribe">',
      '        <input type="hidden" name="token" value="' + safeToken + '">',
      '        <button type="submit">Unsubscribe me</button>',
      "      </form>",
    ].join("\n"),
  );
}

/** HTML shown after a successful unsubscribe. */
function unsubscribeSuccessHtml(brand: PageBrand): string {
  const name = escHtml(brand.name);
  return pageShell(
    brand,
    "Unsubscribed",
    [
      "      <h1>You are unsubscribed</h1>",
      "      <p>Unsubscribed from " + name + ". You will no longer receive emails from this sender.</p>",
      "      <p>If this was a mistake, reply to any earlier email from " + name + " and ask to be added back.</p>",
    ].join("\n"),
  );
}

/** HTML shown when the token is invalid or resolution fails. */
function unsubscribeErrorHtml(): string {
  return pageShell(
    DEFAULT_BRAND,
    "Invalid link",
    [
      "      <h1>Invalid link</h1>",
      "      <p>This unsubscribe link is invalid. It may have been corrupted or is no longer valid.</p>",
    ].join("\n"),
  );
}

// ---------------------------------------------------------------------------
// Route plugin
// ---------------------------------------------------------------------------

/**
 * Public unsubscribe routes.
 *
 * Registered outside the /v1 authenticated scope in app.ts.
 * No session cookie required. No tenant resolved from session.
 * Tenant is resolved entirely from the token payload.
 */
const unsubscribeRoutes: FastifyPluginAsync = async (app) => {
  // Register form body parser for this scope (needed for browser POST and one-click).
  // application/x-www-form-urlencoded for browser form submissions and RFC 8058.
  // JSON is handled by Fastify's built-in parser.
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_req, body, done) => {
      // Parse key=value pairs manually (no new dependency).
      const parsed: Record<string, string> = {};
      if (typeof body === "string" && body.length > 0) {
        for (const pair of body.split("&")) {
          const eqIdx = pair.indexOf("=");
          if (eqIdx === -1) continue;
          const key = decodeURIComponent(pair.slice(0, eqIdx).replace(/\+/g, " "));
          const value = decodeURIComponent(pair.slice(eqIdx + 1).replace(/\+/g, " "));
          parsed[key] = value;
        }
      }
      done(null, parsed);
    },
  );

  // ---------------------------------------------------------------------------
  // POST /unsubscribe/one-click  (RFC 8058 - mailbox provider automation)
  // ---------------------------------------------------------------------------

  app.post<{
    Querystring: { token?: string };
  }>("/one-click", async (request, reply) => {
    if (!request.server.db) {
      reply.status(503);
      return { error: "Service unavailable." };
    }

    const db: Db = request.server.db;
    const token = request.query.token;

    if (!token || token.length === 0) {
      reply.status(400);
      return { error: "Invalid unsubscribe link." };
    }

    const outcome = await resolveAndSuppress(db, token, SOURCE_ONE_CLICK);

    if (!outcome.ok) {
      if (outcome.missingKey) {
        // UNSUBSCRIBE_SIGNING_KEY not configured - server misconfiguration.
        // Return 503 so the provider knows to retry rather than treating this
        // as a permanent invalid-token response.
        reply.status(503);
        return { error: "Service unavailable." };
      }
      // Do not reveal which part failed or whether the message exists.
      reply.status(400);
      return { error: "Invalid unsubscribe link." };
    }

    reply.status(200);
    return { unsubscribed: true };
  });

  // ---------------------------------------------------------------------------
  // GET /unsubscribe  (browser confirmation page)
  // ---------------------------------------------------------------------------
  // MUST NOT suppress. A link preview, bot, or scanner fetching this URL
  // must not unsubscribe the human. Only the POST performs the action.

  app.get<{
    Querystring: { token?: string };
  }>("/", async (request, reply) => {
    const token = request.query.token ?? "";

    // Validate the token structurally (so we show the error page immediately
    // for obviously invalid links) but do NOT perform any DB write.
    // We also do not reveal whether the token is valid or the message exists -
    // both a valid token and an invalid one render the form (valid) or the
    // error page (invalid).
    if (!token || token.length === 0) {
      reply.status(400).header("Content-Type", "text/html; charset=utf-8");
      return reply.send(unsubscribeErrorHtml());
    }

    // Verify the token structure/signature only - no DB lookup here.
    // verifyUnsubscribeToken throws if UNSUBSCRIBE_SIGNING_KEY is absent.
    // In that case render the error page (503 would confuse a human; 400 is
    // accurate from the user's view since no valid page can be shown).
    let verifyResult: ReturnType<typeof verifyUnsubscribeToken>;
    try {
      verifyResult = verifyUnsubscribeToken(token);
    } catch {
      reply.status(503).header("Content-Type", "text/html; charset=utf-8");
      return reply.send(unsubscribeErrorHtml());
    }
    if (!verifyResult.ok) {
      reply.status(400).header("Content-Type", "text/html; charset=utf-8");
      return reply.send(unsubscribeErrorHtml());
    }

    // Read-only brand lookup for a signature-valid token. Still no write.
    const brand = await loadPageBrand(request.server.db, verifyResult.payload.tenantId);
    reply.status(200).header("Content-Type", "text/html; charset=utf-8");
    return reply.send(unsubscribePageHtml(token, brand));
  });

  // ---------------------------------------------------------------------------
  // POST /unsubscribe  (browser form submission)
  // ---------------------------------------------------------------------------

  app.post<{
    Body: Record<string, string> | { token?: string };
  }>("/", async (request, reply) => {
    if (!request.server.db) {
      reply.status(503);
      return { error: "Service unavailable." };
    }

    const db: Db = request.server.db;

    // Extract token from body (form field or JSON field)
    const body = request.body as Record<string, unknown>;
    const token = typeof body?.token === "string" ? body.token : "";

    if (!token || token.length === 0) {
      const contentType = (request.headers["content-type"] ?? "").toLowerCase();
      if (contentType.includes("application/json")) {
        reply.status(400);
        return { error: "Invalid unsubscribe link." };
      }
      reply.status(400).header("Content-Type", "text/html; charset=utf-8");
      return reply.send(unsubscribeErrorHtml());
    }

    const outcome = await resolveAndSuppress(db, token, SOURCE_PAGE);

    const contentType = (request.headers["content-type"] ?? "").toLowerCase();
    const wantsJson = contentType.includes("application/json");

    if (!outcome.ok) {
      if (outcome.missingKey) {
        // UNSUBSCRIBE_SIGNING_KEY not configured - server misconfiguration.
        if (wantsJson) {
          reply.status(503);
          return { error: "Service unavailable." };
        }
        reply.status(503).header("Content-Type", "text/html; charset=utf-8");
        return reply.send(unsubscribeErrorHtml());
      }
      if (wantsJson) {
        reply.status(400);
        return { error: "Invalid unsubscribe link." };
      }
      reply.status(400).header("Content-Type", "text/html; charset=utf-8");
      return reply.send(unsubscribeErrorHtml());
    }

    if (wantsJson) {
      reply.status(200);
      return { unsubscribed: true };
    }

    const brand = await loadPageBrand(db, outcome.tenantId);
    reply.status(200).header("Content-Type", "text/html; charset=utf-8");
    return reply.send(unsubscribeSuccessHtml(brand));
  });
};

export default unsubscribeRoutes;
