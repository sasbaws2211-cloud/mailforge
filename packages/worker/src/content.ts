/**
 * Content generation worker - claims pending_generation messages, runs Brain
 * decide + draft + assess, and advances state.
 *
 * Scheduled every 5 minutes via pg-boss cron. Selects pending_generation
 * messages ordered by created_at ASC (FIFO). Uses FOR UPDATE SKIP LOCKED
 * for safe concurrency across multiple content workers.
 *
 * Processing order per message:
 *   1. Claim: pending_generation -> generating (atomic CTE with SKIP LOCKED).
 *   2. Resolve: look up the tenant's active LLM provider.
 *   3. Decide: call brain.decide() to determine action (contact | skip | wait).
 *      - skip/wait: mark as 'skipped', record reasoning. Terminal.
 *      - contact: advance to 'awaiting_content', proceed to draft.
 *   4. Draft: call brain.draft() to produce subject + body_markdown.
 *   5. Assess: call brain.assess() to gate the draft for value.
 *      - fail: mark as 'value_gated', preserve draft content + reasoning. Terminal.
 *      - pass: proceed.
 *      - error: leave at 'awaiting_content' for reap (transient, NOT value_gated).
 *   6. Render: convert markdown to HTML (sanitized), derive plain text.
 *   7. Write: advance to 'pending_approval' with CAS (WHERE status = 'awaiting_content').
 *
 * State machine:
 *   generating -> awaiting_content (decide returns "contact")
 *   awaiting_content -> pending_approval (draft + assess pass)
 *   awaiting_content -> value_gated (assess returns "fail") - terminal
 *   generating -> skipped (decide returns "skip" or "wait") - terminal
 *
 * Failure path: message stays at 'generating' (or 'awaiting_content'). The
 * reap worker (task 15) recovers stuck messages after REAP_STUCK_THRESHOLD_HOURS (2h).
 * 'value_gated' is terminal and is NOT recovered by reap.
 *
 * Mirror side: PUBLIC (packages/worker is mirrored).
 */
import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { marked, Renderer, Lexer, type Token } from "marked";
import {
  decide,
  draft,
  assess,
  type DecidePromptContext,
  type DraftPromptContext,
} from "@claros/brain-oss";
import { resolveTenantProvider } from "./provider-resolver.js";
import { assembleContext } from "./context-assembler.js";
import { applyBudgetForBothPaths, draftContextToDecideContext, checkAssessBudget } from "./context-budget.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Db = NodePgDatabase<Record<string, never>>;

/** A candidate message claimed from the content generation batch query. */
export interface ContentCandidate {
  id: string;
  tenantId: string;
  contactId: string;
  flowId: string;
  membershipId: string;
  flowStepOrder: number | null;
  brainActionType: string | null;
}

/** Stats returned by processContentTick for observability. */
export interface ContentTickResult {
  claimed: number;
  advanced: number;
  skipped: number;
  valueGated: number;
  errors: number;
}

// ---------------------------------------------------------------------------
// Batch claim (FOR UPDATE SKIP LOCKED + CAS in a single CTE)
// ---------------------------------------------------------------------------

/**
 * Claims a batch of pending_generation messages atomically.
 *
 * Uses a CTE with FOR UPDATE SKIP LOCKED to:
 *   1. Select eligible messages without blocking on rows another worker holds
 *   2. Atomically set their status to 'generating' in the same statement
 *
 * This guarantees two concurrent content workers get completely disjoint sets.
 * The claim (status = 'generating') happens inside the same SQL statement as
 * the lock, so no window exists between fetch and claim.
 *
 * Sort order: tenant_id ASC, created_at ASC (FIFO within tenant, round-robin
 * across tenants by natural ordering). Unlike drain, there is no flow_class or
 * priority ordering - the Brain processes all pending messages in FIFO order.
 *
 * Tenant scoping: only messages for the specified tenants are eligible. If
 * tenantIds is empty, no messages are claimed.
 *
 * @param db - Drizzle database instance.
 * @param now - Current time (injected for testability).
 * @param batchLimit - Max messages to claim per tick.
 * @param tenantIds - Tenant IDs to scope the claim to. Empty = no-op.
 */
export async function claimContentBatch(
  db: Db,
  now: Date,
  batchLimit: number,
  tenantIds: string[],
): Promise<ContentCandidate[]> {
  if (tenantIds.length === 0) return [];

  const tenantFilter = sql.join(tenantIds.map((id) => sql`${id}`), sql`, `);

  const rows = await db.execute<{
    id: string;
    tenant_id: string;
    contact_id: string;
    flow_id: string;
    membership_id: string;
    flow_step_order: number | null;
    brain_action_type: string | null;
  }>(sql`
    WITH candidates AS (
      SELECT lm.id
      FROM lifecycle_messages lm
      WHERE lm.status = 'pending_generation'
        AND lm.tenant_id IN (${tenantFilter})
      ORDER BY lm.created_at ASC
      LIMIT ${batchLimit}
      FOR UPDATE OF lm SKIP LOCKED
    ),
    claimed AS (
      UPDATE lifecycle_messages
      SET status = 'generating', updated_at = ${now}
      WHERE id IN (SELECT id FROM candidates)
      RETURNING id, tenant_id, contact_id, flow_id, membership_id, flow_step_order, brain_action_type
    )
    SELECT id, tenant_id, contact_id, flow_id, membership_id, flow_step_order, brain_action_type
    FROM claimed
  `);

  return rows.rows.map((row) => ({
    id: row.id,
    tenantId: row.tenant_id,
    contactId: row.contact_id,
    flowId: row.flow_id,
    membershipId: row.membership_id,
    flowStepOrder: row.flow_step_order,
    brainActionType: row.brain_action_type,
  }));
}

// ---------------------------------------------------------------------------
// Content tick processor
// ---------------------------------------------------------------------------

/**
 * Process a single content generation tick. Called by the pg-boss handler.
 *
 * Finds all tenants with pending_generation messages, claims a batch, and
 * processes each message through the decide -> draft -> render pipeline.
 *
 * @param db - Drizzle database instance.
 * @param now - Current time (injected for testability).
 * @param batchLimit - Max messages per tick (default 20).
 * @param tenantIds - Optional tenant scope. When provided, only these tenants
 *   are processed (skips the global discovery query). When omitted, all
 *   tenants with pending_generation messages are discovered and processed
 *   (production default).
 */
export async function processContentTick(
  db: Db,
  now: Date,
  batchLimit: number = 20,
  tenantIds?: string[],
): Promise<ContentTickResult> {
  const stats: ContentTickResult = {
    claimed: 0,
    advanced: 0,
    skipped: 0,
    valueGated: 0,
    errors: 0,
  };

  // Step 1: Determine target tenants - use provided list or discover globally.
  let resolvedTenantIds: string[];
  if (tenantIds && tenantIds.length > 0) {
    resolvedTenantIds = tenantIds;
  } else {
    const tenantRows = await db.execute<{ tenant_id: string }>(sql`
      SELECT DISTINCT tenant_id
      FROM lifecycle_messages
      WHERE status = 'pending_generation'
    `);

    if (tenantRows.rows.length === 0) return stats;
    resolvedTenantIds = tenantRows.rows.map((r) => r.tenant_id);
  }

  // Step 2: Claim batch atomically.
  const candidates = await claimContentBatch(db, now, batchLimit, resolvedTenantIds);
  stats.claimed = candidates.length;

  if (candidates.length === 0) return stats;

  // Step 3: Process each claimed message.
  for (const candidate of candidates) {
    const outcome = await processOneContentMessage(db, candidate, now);
    switch (outcome) {
      case "advanced":
        stats.advanced++;
        break;
      case "skipped":
        stats.skipped++;
        break;
      case "value_gated":
        stats.valueGated++;
        break;
      case "error":
        stats.errors++;
        break;
    }
  }

  return stats;
}

// ---------------------------------------------------------------------------
// Per-message processing
// ---------------------------------------------------------------------------

type ContentOutcome = "advanced" | "skipped" | "value_gated" | "error";

/**
 * Process a single claimed message through the full Brain pipeline:
 *   1. Resolve the tenant's LLM provider.
 *   2. Call decide() - branch on the action.
 *   3. If "contact": advance to awaiting_content, call draft(), render
 *      markdown, write subject + body_html + body_text, advance to
 *      pending_approval.
 *   4. If "skip" or "wait": mark as 'skipped' with reasoning.
 *
 * CAS on every write ensures concurrent actors (reap, another content worker)
 * cannot corrupt state.
 *
 * Failure path: on any error (provider resolution, LLM call, invalid output,
 * or CAS failure), the message remains at its current status and the reap
 * worker will recover it after the stuck threshold.
 */
async function processOneContentMessage(
  db: Db,
  candidate: ContentCandidate,
  now: Date,
): Promise<ContentOutcome> {
  try {
    // 1. Resolve tenant's LLM provider
    const providerResult = await resolveTenantProvider(db, candidate.tenantId);
    if (!providerResult.ok) {
      // No provider available - leave at generating for reap recovery.
      // Same handling as a provider error per spec.
      return "error";
    }
    const { provider } = providerResult;

    // 2. Assemble the full context packet for both LLM calls.
    const assembled = await assembleContext(db, candidate, now);
    if (assembled === null) {
      // Contact not found - data integrity issue. Leave at generating for reap.
      return "error";
    }

    // 3. Apply dual-path budget truncation.
    // The budget step measures both the decide and draft assembled messages
    // to ensure both fit within MAX_CONTEXT_TOKENS. If budget estimation is
    // not available (e.g., buildDraftMessages not loaded), the un-truncated
    // context is used - the LLM handles slight overruns gracefully.
    let decideCtx: DecidePromptContext = assembled.decideCtx;
    let draftCtx: DraftPromptContext = assembled.draftCtx;
    try {
      const actionType = candidate.brainActionType ?? "nurture_value";
      const truncResult = applyBudgetForBothPaths(
        assembled.draftCtx,
        actionType,
        assembled.lastSeen,
      );
      draftCtx = truncResult.ctx;
      decideCtx = draftContextToDecideContext(truncResult.ctx, actionType, assembled.lastSeen);

      if (truncResult.droppedSections.length > 0) {
        console.info(
          `[content] message ${candidate.id}: budget truncation dropped ` +
            `[${truncResult.droppedSections.join(", ")}]`,
        );
      }
    } catch {
      // Budget estimation unavailable (buildDraftMessages/buildDecideMessages
      // not loaded). Use the un-truncated contexts as-is. This path is hit
      // only in test environments where @claros/brain-oss is mocked.
    }

    // 4. Call decide()
    const decideResult = await decide(provider, decideCtx);
    if (!decideResult.ok) {
      // LLM error or invalid output - leave at generating for reap.
      return "error";
    }

    const { decision } = decideResult;

    // 4b. Branch on decision
    if (decision.action === "skip" || decision.action === "wait") {
      // Terminal: mark as skipped with reasoning.
      const reasoning = decision.reasoning
        ? `${decision.action}: ${decision.reasoning}`
        : decision.action;

      const skipResult = await db.execute<{ id: string }>(sql`
        UPDATE lifecycle_messages
        SET
          status = 'skipped',
          brain_reasoning = ${reasoning},
          updated_at = ${now}
        WHERE id = ${candidate.id}
          AND status = 'generating'
        RETURNING id
      `);

      if (skipResult.rows.length === 0) {
        // CAS failed - another actor moved the row.
        return "error";
      }

      return "skipped";
    }

    // decision.action === "contact" - proceed to draft.

    // 5. Advance to awaiting_content (CAS: must still be at generating)
    const awaitResult = await db.execute<{ id: string }>(sql`
      UPDATE lifecycle_messages
      SET
        status = 'awaiting_content',
        brain_reasoning = ${decision.reasoning ?? null},
        updated_at = ${now}
      WHERE id = ${candidate.id}
        AND status = 'generating'
      RETURNING id
    `);

    if (awaitResult.rows.length === 0) {
      // CAS failed - another actor moved the row.
      return "error";
    }

    // 6. Call draft()
    const draftResult = await draft(provider, draftCtx);
    if (!draftResult.ok) {
      // LLM error or invalid output - leave at awaiting_content for reap.
      return "error";
    }

    const { subject, body_markdown } = draftResult.draft;

    // 7. Assess budget: check the assess call fits after the actual draft body
    // is known. No re-truncation (would create incoherence); just a warning.
    checkAssessBudget(draftCtx, subject, body_markdown);

    // 8. Value gate: assess the draft for quality before pending_approval.
    //
    // A 'fail' verdict terminates the message at 'value_gated' (draft preserved
    // for audit). A gate call error leaves the message at 'awaiting_content' for
    // reap - it is NOT marked value_gated. Only a validated 'fail' verdict gates.
    const assessResult = await assess(provider, {
      draftCtx,
      subject,
      body_markdown,
    });

    if (!assessResult.ok) {
      // Gate call error (LLM failure, parse failure) - transient.
      // Leave at awaiting_content for reap; do NOT mark value_gated.
      return "error";
    }

    if (assessResult.assessment.verdict === "fail") {
      // Render the draft body for storage even though it won't be approved:
      // the draft content is preserved on the row for audit.
      const bodyHtml = renderMarkdownToHtml(body_markdown);
      const bodyText = markdownToText(body_markdown);
      const gateReasoning = `value_gated: ${assessResult.assessment.reasoning}`;

      const gatedResult = await db.execute<{ id: string }>(sql`
        UPDATE lifecycle_messages
        SET
          status = 'value_gated',
          subject = ${subject},
          body_html = ${bodyHtml},
          body_text = ${bodyText},
          brain_reasoning = ${gateReasoning},
          updated_at = ${now}
        WHERE id = ${candidate.id}
          AND status = 'awaiting_content'
        RETURNING id
      `);

      if (gatedResult.rows.length === 0) {
        // CAS failed - another actor moved the row.
        return "error";
      }

      return "value_gated";
    }

    // assessResult.assessment.verdict === "pass" - proceed to pending_approval.

    // 9. Render markdown to HTML and derive plain text
    const bodyHtml = renderMarkdownToHtml(body_markdown);
    const bodyText = markdownToText(body_markdown);

    // 10. Write content and advance to pending_approval (CAS: awaiting_content)
    const finalResult = await db.execute<{ id: string }>(sql`
      UPDATE lifecycle_messages
      SET
        status = 'pending_approval',
        subject = ${subject},
        body_html = ${bodyHtml},
        body_text = ${bodyText},
        updated_at = ${now}
      WHERE id = ${candidate.id}
        AND status = 'awaiting_content'
      RETURNING id
    `);

    if (finalResult.rows.length === 0) {
      // CAS failed - another actor moved the row.
      return "error";
    }

    return "advanced";
  } catch {
    // On any error, leave the message at its current status for reap recovery.
    return "error";
  }
}

// ---------------------------------------------------------------------------
// Markdown rendering helpers
// ---------------------------------------------------------------------------

/**
 * Escape HTML special characters to entity references.
 * Used to neutralise raw HTML that passes through the marked token pipeline.
 */
function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Return true for URL schemes that are safe to render as href/src values.
 * Rejects javascript:, data:, vbscript:, and any other non-HTTP schemes.
 */
function isSafeUrl(url: string): boolean {
  return (
    /^(?:https?|mailto):/i.test(url) ||
    url.startsWith("/") ||
    url.startsWith("#") ||
    url.startsWith(".")
  );
}

/**
 * Build a marked Renderer that disables raw HTML passthrough and blocks
 * dangerous URL schemes in link/image href attributes.
 *
 * marked v18 produces one token type for all raw HTML, regardless of position:
 * block-level HTML (e.g. a bare <script> tag) and inline HTML inside a
 * paragraph, list item, or link text all produce a token of type "html" with
 * a "block" boolean field distinguishing them. The renderer's html() method is
 * invoked for both. Overriding it once is sufficient to cover every path.
 *
 * The only other attribute values that marked's renderer writes from markdown
 * input are: href/src (overridden below), and title/alt (escaped by marked's
 * internal O() function which encodes & < > " ' to entity references, making
 * attribute boundary escape impossible). No post-render string pass is needed.
 */
function buildSafeRenderer(): Renderer {
  const renderer = new Renderer();

  // Escape all raw HTML tokens (block and inline) to entity references.
  // This covers: <script>, <iframe>, <img onerror=...>, inline <b onclick=...>,
  // and any other tag the model emits, wherever it appears in the document.
  renderer.html = ({ raw }: { raw: string }): string => escapeHtml(raw);

  // Sanitise dangerous URL schemes in link href.
  const origLink = renderer.link.bind(renderer);
  renderer.link = (token: Parameters<Renderer["link"]>[0]): string => {
    const safeHref = isSafeUrl(token.href ?? "") ? token.href : "#";
    return origLink({ ...token, href: safeHref });
  };

  // Sanitise dangerous URL schemes in image src.
  const origImage = renderer.image.bind(renderer);
  renderer.image = (token: Parameters<Renderer["image"]>[0]): string => {
    const safeHref = isSafeUrl(token.href ?? "") ? token.href : "";
    return origImage({ ...token, href: safeHref });
  };

  return renderer;
}

/**
 * Render markdown string to sanitised HTML.
 *
 * Security model: `body_markdown` is model-generated text. Although the draft
 * prompt requests markdown-only output, there is no schema-level enforcement
 * preventing the model from emitting HTML (script tags, event handlers,
 * iframes, javascript: hrefs). Two renderer-level overrides handle this:
 *
 *   1. html() override: all raw HTML tokens - block and inline - are escaped
 *      to entity references. Model-emitted tags become visible text, not
 *      markup. This covers every position: bare block tags, tags mid-paragraph,
 *      tags inside list items, and tags inside link or image text.
 *   2. link/image overrides: hrefs using non-HTTP schemes (javascript:, data:,
 *      vbscript:, ...) are replaced with safe fallbacks ('#' for links, '' for
 *      images).
 *
 * No post-render string pass is applied. All dangerous content originates from
 * raw HTML tokens (handled by override 1) or href values (handled by override
 * 2). marked's own renderer encodes title and alt attribute values with its
 * internal escape function (& < > " ' -> entities), so no attribute boundary
 * escape is possible from those paths.
 *
 * Normal markdown constructs (headings, bold, italic, lists, code, links with
 * https:// hrefs) are rendered to HTML unchanged.
 */
export function renderMarkdownToHtml(markdown: string): string {
  const renderer = buildSafeRenderer();
  return marked.parse(markdown, { async: false, renderer }) as string;
}

// ---------------------------------------------------------------------------
// Plain-text derivation (from markdown source, not from rendered HTML)
// ---------------------------------------------------------------------------

/**
 * Decode the small set of HTML entities that marked encodes in token text
 * fields (it only encodes &, <, >, ", ' in text nodes).
 */
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

/**
 * Recursively convert a marked token list to a plain-text string.
 *
 * Design choices:
 * - Derived from the markdown token tree, not from rendered HTML, so raw
 *   HTML blocks in the source are discarded rather than partially stripped.
 * - Links: rendered as "text (url)" so the URL survives in the plain-text
 *   version (important for email clients that render the text/plain part).
 * - Lists: unordered items get a "- " prefix; ordered items get "N. ".
 * - Headings: text only, no "#" markers - headings are structurally a
 *   paragraph boundary in plain-text email.
 * - Code blocks: content preserved verbatim.
 * - Raw HTML tokens (type "html"): discarded entirely.
 */
function tokensToText(tokens: Token[]): string {
  let out = "";
  for (const token of tokens) {
    switch (token.type) {
      case "heading":
        out += tokensToText(token.tokens ?? []) + "\n\n";
        break;

      case "paragraph":
        out += tokensToText(token.tokens ?? []) + "\n\n";
        break;

      case "strong":
      case "em":
      case "del":
        out += tokensToText(token.tokens ?? []);
        break;

      case "text":
        // text tokens can have sub-tokens (e.g., inside a list item)
        if (token.tokens && token.tokens.length > 0) {
          out += tokensToText(token.tokens);
        } else {
          out += decodeEntities(token.text);
        }
        break;

      case "link": {
        const linkText = tokensToText(token.tokens ?? []);
        if (token.href && token.href !== linkText) {
          out += `${linkText} (${token.href})`;
        } else {
          out += linkText;
        }
        break;
      }

      case "image":
        if (token.href) {
          out += `${token.text} (${token.href})`;
        } else {
          out += token.text;
        }
        break;

      case "list": {
        for (let i = 0; i < token.items.length; i++) {
          const item = token.items[i]!;
          const prefix = token.ordered ? `${(token.start as number) + i}. ` : "- ";
          out += prefix + tokensToText(item.tokens ?? []).trim() + "\n";
        }
        out += "\n";
        break;
      }

      case "blockquote": {
        const quoted = tokensToText(token.tokens ?? []).trim();
        out +=
          quoted
            .split("\n")
            .map((l) => (l ? "> " + l : ">"))
            .join("\n") + "\n\n";
        break;
      }

      case "code":
        out += token.text + "\n\n";
        break;

      case "codespan":
        out += token.text;
        break;

      case "br":
        out += "\n";
        break;

      case "hr":
        out += "---\n\n";
        break;

      case "html":
        // Discard raw HTML blocks in plain text output.
        break;

      case "space":
        // Blank lines between blocks are handled by the "\n\n" each block emits.
        break;

      default:
        // Unknown token type: fall back to sub-tokens if present, then text.
        if ("tokens" in token && Array.isArray((token as { tokens?: Token[] }).tokens)) {
          out += tokensToText((token as { tokens: Token[] }).tokens);
        } else if ("text" in token && typeof (token as { text?: string }).text === "string") {
          out += decodeEntities((token as { text: string }).text);
        }
    }
  }
  return out;
}

/**
 * Derive a plain-text version of the email body from the original markdown
 * source.
 *
 * Deriving from markdown rather than from rendered HTML avoids re-processing
 * any HTML the model may have injected - those tokens are simply discarded.
 * The result is suitable for the text/plain MIME part of the outgoing email.
 *
 * Link targets are preserved as "(url)" suffixes so recipients using
 * plain-text clients still have the URLs. List structure uses "- " (unordered)
 * or "N. " (ordered) prefixes. Heading levels are collapsed to plain text
 * paragraph boundaries.
 */
export function markdownToText(markdown: string): string {
  const tokens = Lexer.lex(markdown);
  return tokensToText(tokens)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

