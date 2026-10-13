/**
 * Library flows routes - install pre-built flows with templates.
 *
 * All routes require session-cookie authentication (dashboard operator scope).
 * Registered under the /v1 prefix inside the authenticated scope.
 *
 * Endpoints:
 *   GET   /v1/library              list available library flows
 *   POST  /v1/library/install      install the welcome flow set for the tenant
 *
 * Installing creates templates and a flow in "draft" status. The user must
 * explicitly activate the flow to start enrollment. No LLM is required.
 *
 * Mirror side: PUBLIC (packages/api is mirrored).
 */
import type { FastifyPluginAsync } from "fastify";
import { sql } from "drizzle-orm";
import type { Db } from "../plugins/db.js";
import { LIBRARY_CATALOG, libraryEntry, type InstallResult } from "@loomail/core";

// ---------------------------------------------------------------------------
// Route plugin
// ---------------------------------------------------------------------------

const libraryRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /v1/library
   *
   * The ready-made flows, each with whether this workspace already has it.
   */
  app.get("/", { config: { minRole: "member" } }, async (request) => {
    const db: Db = request.server.db;
    const installed = await db.execute<{ id: string; name: string; status: string }>(sql`
      SELECT id, name, status FROM flows
      WHERE tenant_id = ${request.tenant!.id}::uuid AND source = 'library'`);
    const byName = new Map(installed.rows.map((r) => [r.name, r]));
    return {
      flows: LIBRARY_CATALOG.map((e) => {
        const have = byName.get(e.flow.name);
        return {
          id: e.id,
          name: e.flow.name,
          description: e.flow.description,
          tagline: e.tagline,
          when: e.when,
          needs_event: e.needsEvent,
          span: e.span,
          emails: e.flow.steps.length,
          trigger: e.needsEvent ? `${e.needsEvent} event` : e.when,
          installed: Boolean(have),
          flow_id: have?.id ?? null,
          flow_status: have?.status ?? null,
          templates: e.templates.map((t) => ({ slug: t.slug, name: t.name, subject: t.subject })),
        };
      }),
    };
  });

  /**
   * POST /v1/library/install   { id?: string }   (default "welcome-onboarding")
   *
   * Install one library flow and its templates for the calling tenant. Templates use
   * ON CONFLICT DO NOTHING (idempotent on slug). The flow is created in "draft" status with
   * compile_status = "ready" (pre-compiled plan, no LLM needed).
   *
   * Returns 400 for an unknown id and 409 if the flow already exists for this tenant.
   */
  app.post<{ Body: { id?: unknown } | undefined }>("/install", { config: { minRole: "member" } }, async (request, reply) => {
    const db: Db = request.server.db;
    const tenantId = request.tenant!.id;
    const wanted = typeof request.body?.id === "string" ? request.body.id : "welcome-onboarding";
    const entry = libraryEntry(wanted);
    if (!entry) {
      reply.status(400);
      return { error: "Unknown library flow.", code: "unknown_library_flow" };
    }
    const LIBRARY_FLOW = entry.flow;

    // Check if already installed (by flow name + source = library)
    const existing = await db.execute<{ id: string }>(sql`
      SELECT id FROM flows
      WHERE tenant_id = ${tenantId}
        AND name = ${LIBRARY_FLOW.name}
        AND source = 'library'
      LIMIT 1
    `);

    if (existing.rows.length > 0) {
      reply.status(409);
      return {
        error: "Library flow already installed.",
        flowId: existing.rows[0]!.id,
      };
    }

    // Install templates (idempotent via ON CONFLICT DO NOTHING on tenant_id + slug)
    let templatesCreated = 0;
    for (const tmpl of entry.templates) {
      const result = await db.execute<{ id: string }>(sql`
        INSERT INTO templates (tenant_id, name, slug, subject, body_html, body_text, variables, category)
        VALUES (
          ${tenantId},
          ${tmpl.name},
          ${tmpl.slug},
          ${tmpl.subject},
          ${tmpl.bodyHtml},
          ${tmpl.bodyText},
          ${sql`ARRAY[${sql.join(tmpl.variables.map(v => sql`${v}`), sql`, `)}]::text[]`},
          ${tmpl.category}
        )
        ON CONFLICT (tenant_id, slug) DO NOTHING
        RETURNING id
      `);
      if (result.rows.length > 0) {
        templatesCreated++;
      }
    }

    // Create the flow with pre-compiled plan (compile_status = 'ready')
    const flowResult = await db.execute<{ id: string }>(sql`
      INSERT INTO flows (
        tenant_id, name, description, trigger_type, trigger_config, steps,
        source, status, approval_mode, flow_class, reentry_policy,
        reentry_cooldown_days, priority, compiled_plan, compile_status, compiled_at
      )
      VALUES (
        ${tenantId},
        ${LIBRARY_FLOW.name},
        ${LIBRARY_FLOW.description},
        ${LIBRARY_FLOW.triggerType},
        ${JSON.stringify(LIBRARY_FLOW.triggerConfig)}::jsonb,
        ${JSON.stringify(LIBRARY_FLOW.steps)}::jsonb,
        ${LIBRARY_FLOW.source},
        'draft',
        ${LIBRARY_FLOW.approvalMode},
        ${LIBRARY_FLOW.flowClass},
        ${LIBRARY_FLOW.reentryPolicy},
        ${LIBRARY_FLOW.reentryCooldownDays},
        ${LIBRARY_FLOW.priority},
        ${JSON.stringify(LIBRARY_FLOW.compiledPlan)}::jsonb,
        'ready',
        ${new Date()}
      )
      RETURNING id
    `);

    const flowId = flowResult.rows[0]!.id;

    const result: InstallResult = {
      flowId,
      templatesCreated,
      flowCreated: true,
    };

    return {
      message: "Library flow installed successfully. Set status to 'active' to begin enrollment.",
      ...result,
    };
  });
};

export default libraryRoutes;
