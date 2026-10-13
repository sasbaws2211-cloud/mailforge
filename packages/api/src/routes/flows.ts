/**
 * Flow CRUD routes.
 *
 * All routes require session-cookie authentication (dashboard operator scope).
 * They are registered under the /v1 prefix inside the authenticated scope in
 * app.ts, which enforces request.tenant !== null before any route handler runs.
 *
 * Scope separation reminder: these routes share the /v1 prefix with the
 * ingestion scope, but are in a different Fastify encapsulation boundary. The
 * ingest preHandler (bearer token) does not run here; the dashboard preHandler
 * (session cookie) does. A bearer-key-only request reaching these routes will
 * have request.tenant === null and be rejected by the outer /v1 preHandler
 * before this plugin is entered.
 *
 * Endpoints:
 *   POST   /v1/flows              create a flow
 *   GET    /v1/flows              list flows (excludes archived; ?include_archived=true)
 *   GET    /v1/flows/:id          get a single flow
 *   PATCH  /v1/flows/:id          update a flow (partial; status transitions validated)
 *   DELETE /v1/flows/:id          archive a flow (sets status = 'archived')
 *
 * Ownership rules:
 *   - prompt_source: writable by API (create and update when status is draft or paused)
 *   - compiled_plan, compiled_at: owned by the compile worker (task 11); never writable
 *     by the API client. If prompt_source changes (draft/paused only), compiled_plan and
 *     compiled_at are cleared to signal the plan is now stale.
 *   - status starts as 'draft' on create; transitions are validated against the table in
 *     @loomail/core (validateStatusTransition). archived is terminal.
 *
 * Cross-tenant isolation: any flow that exists but belongs to a different tenant
 * returns 404 (not 403) to avoid leaking information about other tenants.
 *
 * Mirror side: PUBLIC (packages/api is mirrored).
 */
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { eq, and, ne, sql } from "drizzle-orm";
import { flows, tenants, templates } from "@loomail/db/schema";
import {
  isValidDelay,
  validateStatusTransition,
  FLOW_TRIGGER_TYPES,
  FLOW_STATUSES,
  FLOW_CLASSES,
  REENTRY_POLICIES,
  FLOW_SOURCES,
  APPROVAL_MODES,
  CONTENT_MODES,
  QUEUE,
  compiledPlanSchema,
  type FlowStatus,
  flowHealth,
  renderTemplate,
  wrapInShell,
  wrapInTextShell,
} from "@loomail/core";
import { draft } from "@loomail/brain-oss";
import type { Db } from "../plugins/db.js";
import { loadAiStatus, resolveProviderForRequest } from "../ai/resolver.js";
import { createLimiter } from "../marketing/signup-logic.js";
import { resolveAuthTransport } from "./auth.js";
import { getPlatformTransport } from "../platform-mailer.js";
import { AI_UNAVAILABLE_MESSAGE, aiAllowanceMessage, NO_AI_PROVIDER_MESSAGE } from "@loomail/core";

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const flowStepSchema = z
  .object({
    order: z.number().int().min(1),
    action_type: z.string().min(1),
    delay: z.string().refine(isValidDelay, {
      message: "delay must be a non-negative integer followed by a unit: m, h, or d (e.g. '0m', '2h', '3d')",
    }),
    window_policy: z.enum(["immediate", "respect_window"]),
    template_ref: z.string().optional(),
    kb_ref: z.string().optional(),
    condition: z.unknown().optional(),
    exit_condition: z.unknown().optional(),
  })
  .passthrough(); // allow brain_instruction and any future fields from compilation

const createFlowSchema = z.object({
  name: z.string().min(1, "name is required"),
  description: z.string().optional(),
  priority: z.number().int().optional(),
  trigger_type: z.enum(
    FLOW_TRIGGER_TYPES as [string, ...string[]],
    { errorMap: () => ({ message: `trigger_type must be one of: ${FLOW_TRIGGER_TYPES.join(", ")}` }) },
  ),
  trigger_config: z.record(z.unknown()),
  steps: z.array(flowStepSchema).min(0),
  source: z
    .enum(FLOW_SOURCES as [string, ...string[]])
    .optional(),
  content_mode: z
    .enum(CONTENT_MODES as [string, ...string[]])
    .optional(),
  approval_mode: z
    .enum(APPROVAL_MODES as [string, ...string[]])
    .optional(),
  flow_class: z
    .enum(FLOW_CLASSES as [string, ...string[]])
    .optional(),
  reentry_policy: z
    .enum(REENTRY_POLICIES as [string, ...string[]])
    .optional(),
  reentry_cooldown_days: z.number().int().min(1).optional(),
  prompt_source: z.string().optional(),
});

// Update: all create fields optional, plus status
const updateFlowSchema = createFlowSchema
  .partial()
  .extend({
    status: z
      .enum(FLOW_STATUSES as [string, ...string[]])
      .optional(),
  });

export type CreateFlowBody = z.infer<typeof createFlowSchema>;
export type UpdateFlowBody = z.infer<typeof updateFlowSchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Return 400 with Zod validation issues.
 */
function validationError(reply: any, issues: z.ZodIssue[]) {
  reply.status(400);
  return {
    error: "Validation failed",
    issues: issues.map((i) => ({
      path: i.path.join("."),
      message: i.message,
    })),
  };
}

/**
 * Validate that step.order values are unique within the array.
 * Returns an error string if duplicate orders exist, null otherwise.
 */
function validateStepOrders(steps: Array<{ order: number }>): string | null {
  const seen = new Set<number>();
  for (const step of steps) {
    if (seen.has(step.order)) {
      return `Duplicate step order: ${step.order}. Each step must have a unique order value.`;
    }
    seen.add(step.order);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Route plugin
// ---------------------------------------------------------------------------

const flowsRoutes: FastifyPluginAsync = async (app) => {
  const testSendLimiter = createLimiter({ windowMs: 3_600_000, max: 10 });
  /**
   * POST /v1/flows
   * Create a new flow. Always starts with status = 'draft'.
   */
  app.post<{ Body: CreateFlowBody }>("/", { config: { minRole: "member" } }, async (request, reply) => {
    const parsed = createFlowSchema.safeParse(request.body);
    if (!parsed.success) {
      return validationError(reply, parsed.error.issues);
    }

    const body = parsed.data;
    const db: Db = request.server.db;
    const tenantId = request.tenant!.id;

    // Validate step order uniqueness
    if (body.steps.length > 0) {
      const orderError = validateStepOrders(body.steps);
      if (orderError) {
        reply.status(400);
        return { error: orderError };
      }
    }

    const [inserted] = await db
      .insert(flows)
      .values({
        tenantId,
        name: body.name,
        description: body.description ?? null,
        priority: body.priority ?? 0,
        triggerType: body.trigger_type,
        triggerConfig: body.trigger_config,
        steps: body.steps,
        source: body.source ?? "manual",
        contentMode: body.content_mode ?? "ai_drafted",
        status: "draft",
        approvalMode: body.approval_mode ?? (body.content_mode === "fixed_content" ? "auto" : "require"),
        flowClass: body.flow_class ?? "nurture",
        reentryPolicy: body.reentry_policy ?? "cooldown",
        reentryCooldownDays: body.reentry_cooldown_days ?? 30,
        promptSource: body.prompt_source ?? null,
        compiledPlan: null,
        compiledAt: null,
      })
      .returning();

    reply.status(201);
    return serializeFlow(inserted!);
  });

  /**
   * GET /v1/flows
   * List flows for the tenant. Excludes archived by default.
   * ?include_archived=true to include them.
   */
  app.get<{ Querystring: { include_archived?: string } }>(
    "/",
    { config: { minRole: "member" } },
    async (request) => {
      const db: Db = request.server.db;
      const tenantId = request.tenant!.id;
      const includeArchived = request.query.include_archived === "true";

      const rows = includeArchived
        ? await db
            .select()
            .from(flows)
            .where(eq(flows.tenantId, tenantId))
            .orderBy(flows.createdAt)
        : await db
            .select()
            .from(flows)
            .where(
              and(
                eq(flows.tenantId, tenantId),
                ne(flows.status, "archived"),
              ),
            )
            .orderBy(flows.createdAt);

      return { flows: rows.map(serializeFlow) };
    },
  );

  /**
   * POST /v1/flows/:id/steps/:order/test-send
   *
   * Sends one step of a flow, as it would read, to the signed-in person's own address. It uses
   * the workspace's own email sender when it has one (so a test also proves the sender works),
   * and the platform sender otherwise. Only steps with fixed copy (a template) can be tested:
   * an AI-written step has no text until it is sent, so use the draft preview for those.
   *
   * It can never go to anyone else, bypasses nothing a real send relies on (no contact is
   * created, no flow is entered), and is limited to a few per workspace per hour.
   */
  app.post<{ Params: { id: string; order: string } }>(
    "/:id/steps/:order/test-send",
    { config: { minRole: "member" } },
    async (request, reply) => {
      const db: Db = request.server.db;
      const tenantId = request.tenant!.id;
      const order = Number.parseInt(request.params.order, 10);
      if (!Number.isInteger(order) || order < 1) return reply.status(400).send({ error: "Invalid step.", code: "invalid_step" });

      const [flow] = await db.select().from(flows).where(and(eq(flows.id, request.params.id), eq(flows.tenantId, tenantId))).limit(1);
      if (!flow) return reply.status(404).send({ error: "Flow not found.", code: "flow_not_found" });

      const planSteps = (flow.compiledPlan as { steps?: Array<{ order: number; template_ref?: string }> } | null)?.steps;
      const rawSteps = Array.isArray(planSteps) ? planSteps : (flow.steps as Array<{ order: number; template_ref?: string }> | null) ?? [];
      const step = rawSteps.find((s) => s.order === order);
      if (!step) return reply.status(404).send({ error: "That step does not exist in this flow.", code: "step_not_found" });
      if (!step.template_ref) {
        return reply.status(422).send({
          error: "This step is written by AI at send time, so there is no fixed text to test. Use the draft preview to see an example.",
          code: "ai_step",
        });
      }

      const rl = testSendLimiter.hit(tenantId);
      if (!rl.allowed) {
        reply.header("Retry-After", String(rl.retryAfterSec));
        return reply.status(429).send({ error: "That is enough test emails for now. Try again in a while.", retry_after_seconds: rl.retryAfterSec });
      }

      const [tmpl] = await db
        .select()
        .from(templates)
        .where(and(eq(templates.tenantId, tenantId), eq(templates.slug, step.template_ref)))
        .limit(1);
      if (!tmpl) return reply.status(422).send({ error: `The template "${step.template_ref}" no longer exists.`, code: "template_missing" });

      const who = await db.execute<{ email: string; name: string | null; tenant_name: string; settings: Record<string, unknown> | null }>(sql`
        SELECT u.email, u.name, t.name AS tenant_name, t.settings
        FROM users u JOIN tenants t ON t.id = u.tenant_id WHERE u.id = ${request.tenant!.userId}::uuid LIMIT 1`);
      const me = who.rows[0];
      if (!me) return reply.status(404).send({ error: "User not found." });
      const [first, ...rest] = (me.name ?? "").trim().split(/\s+/);

      const rendered = renderTemplate(tmpl.subject, tmpl.bodyHtml, tmpl.bodyText ?? null, {
        contact: { first_name: first || null, last_name: rest.join(" ") || null, email: me.email, external_id: "test-send", properties: null },
        tenant: { name: me.tenant_name },
        flow: { name: flow.name },
      });
      if (!rendered.ok) return reply.status(422).send({ error: rendered.reason, code: "render_failed" });

      const transport = (await resolveAuthTransport(db, tenantId)) ?? getPlatformTransport();
      if (!transport) {
        return reply.status(503).send({ error: "No email sender is set up yet. Connect one in Settings, under Email sending, then try again.", code: "no_sender" });
      }

      const note = `This is a test of step ${order} of "${flow.name}". Nothing was sent to anyone else.`;
      const brand = ((me.settings ?? {}).brand as Record<string, string> | undefined) ?? {};
      const html = wrapInShell({
        bodyHtml: `${rendered.bodyHtml}<hr style="border:0;border-top:1px solid #e3e5ea;margin:24px 0" /><p style="font-size:12px;color:#585d68;">${note}</p>`,
        brand,
        tenantName: me.tenant_name,
        complianceFooterHtml: "",
      });
      const text = wrapInTextShell({
        bodyText: `${rendered.bodyText}

---
${note}`,
        brand,
        tenantName: me.tenant_name,
        complianceFooterText: "",
      });
      const r = await transport.adapter.send({
        to: me.email,
        from: transport.fromEmail,
        fromName: transport.fromName ?? undefined,
        subject: `[Test] ${rendered.subject}`,
        bodyHtml: html,
        bodyText: text,
        headers: {},
        messageId: `flow-test-${flow.id}-${order}-${Date.now()}`,
      });
      if (!r.success) {
        request.log.warn({ tenantId, flowId: flow.id, error: r.error }, "flow test send not delivered");
        return reply.status(502).send({ error: "The email could not be sent. Check your sender settings and try again.", code: "send_failed" });
      }
      return { ok: true, sent_to: me.email, subject: `[Test] ${rendered.subject}` };
    },
  );

  /**
   * GET /v1/flows/stats
   * What each flow has done lately, for the flows list: emails sent (7 and 30 days), opens,
   * clicks, bounces, spam complaints, people currently in the flow, when it last sent, and a
   * one-word health with its reason. Keyed by flow id.
   */
  app.get("/stats", { config: { minRole: "member" } }, async (request) => {
    const db: Db = request.server.db;
    const tenantId = request.tenant!.id;
    const now = new Date();

    const msgs = await db.execute<{
      flow_id: string;
      sent30: number;
      sent7: number;
      opened30: number;
      clicked30: number;
      bounced30: number;
      complained30: number;
      last_sent_at: Date | string | null;
    }>(sql`
      SELECT flow_id,
             count(*) FILTER (WHERE sent_at IS NOT NULL AND sent_at >= now() - interval '30 days')::int AS sent30,
             count(*) FILTER (WHERE sent_at IS NOT NULL AND sent_at >= now() - interval '7 days')::int AS sent7,
             count(*) FILTER (WHERE feedback IN ('opened','clicked') AND created_at >= now() - interval '30 days')::int AS opened30,
             count(*) FILTER (WHERE feedback = 'clicked' AND created_at >= now() - interval '30 days')::int AS clicked30,
             count(*) FILTER (WHERE feedback = 'bounced' AND created_at >= now() - interval '30 days')::int AS bounced30,
             count(*) FILTER (WHERE feedback = 'complained' AND created_at >= now() - interval '30 days')::int AS complained30,
             max(sent_at) AS last_sent_at
      FROM lifecycle_messages
      WHERE tenant_id = ${tenantId}::uuid AND flow_id IS NOT NULL
      GROUP BY flow_id`);
    const members = await db.execute<{ flow_id: string; active: number; total: number }>(sql`
      SELECT flow_id,
             count(*) FILTER (WHERE status = 'active')::int AS active,
             count(*)::int AS total
      FROM flow_memberships
      WHERE tenant_id = ${tenantId}::uuid
      GROUP BY flow_id`);
    const flowRows = await db
      .select({ id: flows.id, status: flows.status, createdAt: flows.createdAt, updatedAt: flows.updatedAt })
      .from(flows)
      .where(and(eq(flows.tenantId, tenantId), ne(flows.status, "archived")));

    const mBy = new Map(msgs.rows.map((r) => [r.flow_id, r]));
    const pBy = new Map(members.rows.map((r) => [r.flow_id, r]));
    const stats: Record<string, unknown> = {};
    for (const f of flowRows) {
      const m = mBy.get(f.id);
      const p = pBy.get(f.id);
      const health = flowHealth({
        status: f.status ?? "draft",
        sent30: m?.sent30 ?? 0,
        sent7: m?.sent7 ?? 0,
        bounced30: m?.bounced30 ?? 0,
        complained30: m?.complained30 ?? 0,
        activeSince: f.updatedAt ?? f.createdAt ?? null,
        now,
      });
      stats[f.id] = {
        sent_30d: m?.sent30 ?? 0,
        sent_7d: m?.sent7 ?? 0,
        opened_30d: m?.opened30 ?? 0,
        clicked_30d: m?.clicked30 ?? 0,
        bounced_30d: m?.bounced30 ?? 0,
        complained_30d: m?.complained30 ?? 0,
        in_flow: p?.active ?? 0,
        entered_total: p?.total ?? 0,
        last_sent_at: m?.last_sent_at ? new Date(m.last_sent_at).toISOString() : null,
        health: health.state,
        health_note: health.note,
      };
    }
    return { stats };
  });

  /**
   * GET /v1/flows/:id
   * Get a single flow. Returns 404 if not found or owned by another tenant.
   */
  app.get<{ Params: { id: string } }>("/:id", { config: { minRole: "member" } }, async (request, reply) => {
    const db: Db = request.server.db;
    const tenantId = request.tenant!.id;

    const rows = await db
      .select()
      .from(flows)
      .where(and(eq(flows.id, request.params.id), eq(flows.tenantId, tenantId)))
      .limit(1);

    if (rows.length === 0) {
      reply.status(404);
      return { error: "Flow not found." };
    }

    return serializeFlow(rows[0]!);
  });

  /**
   * PATCH /v1/flows/:id
   * Partial update. Validates status transitions and prompt_source editability.
   *
   * Restrictions:
   *   - status transitions validated against FLOW_STATUS_TRANSITIONS
   *   - prompt_source is only editable when status is 'draft' or 'paused';
   *     editing it on an active flow returns 422 (pause the flow first)
   *   - compiled_plan and compiled_at are never accepted from the request body;
   *     they are owned by the compile worker (task 11)
   *   - if prompt_source changes and status allows it, compiled_plan and
   *     compiled_at are cleared (the old plan is stale)
   */
  app.patch<{ Params: { id: string }; Body: UpdateFlowBody }>(
    "/:id",
    { config: { minRole: "member" } },
    async (request, reply) => {
      const parsed = updateFlowSchema.safeParse(request.body);
      if (!parsed.success) {
        return validationError(reply, parsed.error.issues);
      }

      const body = parsed.data;
      const db: Db = request.server.db;
      const tenantId = request.tenant!.id;

      // Fetch current flow (tenant-scoped)
      const rows = await db
        .select()
        .from(flows)
        .where(and(eq(flows.id, request.params.id), eq(flows.tenantId, tenantId)))
        .limit(1);

      if (rows.length === 0) {
        reply.status(404);
        return { error: "Flow not found." };
      }

      const current = rows[0]!;
      const currentStatus = current.status as FlowStatus;

      // Validate status transition if requested
      if (body.status !== undefined && body.status !== currentStatus) {
        const transitionError = validateStatusTransition(
          currentStatus,
          body.status as FlowStatus,
        );
        if (transitionError) {
          reply.status(422);
          return { error: transitionError };
        }

        // [impl] Refuse activation without a compiled plan. A flow that is
        // active but has no compiled_plan cannot be executed by the enrollment
        // engine - contacts would be enrolled into an empty plan. Prevent the
        // invalid state at the API layer rather than tolerating it silently.
        if (body.status === "active") {
          if (current.compileStatus !== "ready" || current.compiledPlan === null) {
            reply.status(422);
            return {
              error:
                "Cannot activate a flow without a compiled plan. " +
                "Compile the flow first (POST /v1/flows/:id/compile) and wait for compile_status = 'ready'.",
            };
          }
        }
      }

      // prompt_source is only editable in draft or paused
      if (
        body.prompt_source !== undefined &&
        body.prompt_source !== current.promptSource
      ) {
        if (currentStatus !== "draft" && currentStatus !== "paused") {
          reply.status(422);
          return {
            error: `prompt_source cannot be edited while the flow is '${currentStatus}'. Pause the flow first.`,
          };
        }
      }

      // Validate step order uniqueness if steps are being updated
      if (body.steps !== undefined && body.steps.length > 0) {
        const orderError = validateStepOrders(body.steps);
        if (orderError) {
          reply.status(400);
          return { error: orderError };
        }
      }

      // Build the SET clause; never include compiled_plan or compiled_at
      const setClauses: Record<string, unknown> = {
        updatedAt: new Date(),
      };

      if (body.name !== undefined)              setClauses.name = body.name;
      if (body.description !== undefined)       setClauses.description = body.description;
      if (body.priority !== undefined)          setClauses.priority = body.priority;
      if (body.trigger_type !== undefined)      setClauses.triggerType = body.trigger_type;
      if (body.trigger_config !== undefined)    setClauses.triggerConfig = body.trigger_config;
      if (body.steps !== undefined)             setClauses.steps = body.steps;
      if (body.source !== undefined)            setClauses.source = body.source;
      if (body.content_mode !== undefined)      setClauses.contentMode = body.content_mode;
      if (body.approval_mode !== undefined)     setClauses.approvalMode = body.approval_mode;
      if (body.flow_class !== undefined)        setClauses.flowClass = body.flow_class;
      if (body.reentry_policy !== undefined)    setClauses.reentryPolicy = body.reentry_policy;
      if (body.reentry_cooldown_days !== undefined) {
        setClauses.reentryCooldownDays = body.reentry_cooldown_days;
      }
      if (body.status !== undefined)            setClauses.status = body.status;

      // prompt_source: update and clear stale compiled_plan/compiled_at
      if (
        body.prompt_source !== undefined &&
        body.prompt_source !== current.promptSource
      ) {
        setClauses.promptSource = body.prompt_source;
        setClauses.compiledPlan = null;
        setClauses.compiledAt = null;
        setClauses.compileStatus = null;
        setClauses.compileError = null;
      }

      // CAS: when status is being changed, guard on current status to prevent
      // a concurrent PATCH from causing an invalid double-transition.
      const whereConditions = [
        eq(flows.id, request.params.id),
        eq(flows.tenantId, tenantId),
      ];
      if (body.status !== undefined && body.status !== currentStatus) {
        whereConditions.push(eq(flows.status, currentStatus));
      }

      const [updated] = await db
        .update(flows)
        .set(setClauses as any)
        .where(and(...whereConditions))
        .returning();

      if (!updated) {
        // CAS failed: status was changed by a concurrent request.
        reply.status(409);
        return { error: "Flow status was modified concurrently. Retry the request." };
      }

      return serializeFlow(updated);
    },
  );

  /**
   * DELETE /v1/flows/:id
   * Archive a flow (sets status = 'archived'). Not a physical delete.
   *
   * The compiled_plan is preserved on archive: task 12 or an audit may want
   * to inspect what plan was running when the flow was archived.
   *
   * If the flow is already archived, this is a no-op (idempotent).
   * Returns 404 if the flow does not exist for this tenant.
   */
  app.delete<{ Params: { id: string } }>("/:id", { config: { minRole: "member" } }, async (request, reply) => {
    const db: Db = request.server.db;
    const tenantId = request.tenant!.id;

    // Fetch current flow (tenant-scoped)
    const rows = await db
      .select()
      .from(flows)
      .where(and(eq(flows.id, request.params.id), eq(flows.tenantId, tenantId)))
      .limit(1);

    if (rows.length === 0) {
      reply.status(404);
      return { error: "Flow not found." };
    }

    const current = rows[0]!;

    // Idempotent: already archived
    if (current.status === "archived") {
      return serializeFlow(current);
    }

    const [updated] = await db
      .update(flows)
      .set({ status: "archived", updatedAt: new Date() })
      .where(and(eq(flows.id, request.params.id), eq(flows.tenantId, tenantId)))
      .returning();

    return serializeFlow(updated!);
  });

  /**
   * POST /v1/flows/:id/compile
   * Enqueue a flow compilation job. Returns 202 Accepted.
   *
   * Preconditions:
   *   - Flow must exist for this tenant.
   *   - Flow must have a prompt_source (otherwise there is nothing to compile).
   *   - Flow must not be archived.
   *
   * The route sets compile_status = 'pending' and enqueues the job.
   * If a compile is already pending (singletonKey dedup), the enqueue is a
   * silent no-op and the route still returns 202 (idempotent).
   *
   * Returns 422 if preconditions are not met.
   * Returns 503 if the job queue is unavailable.
   */
  app.post<{ Params: { id: string } }>("/:id/compile", { config: { minRole: "member" } }, async (request, reply) => {
    const db: Db = request.server.db;
    const enqueue = request.server.enqueue;
    const tenantId = request.tenant!.id;

    if (!enqueue) {
      reply.status(503);
      return { error: "Job queue is not available." };
    }

    // Fetch flow
    const rows = await db
      .select()
      .from(flows)
      .where(and(eq(flows.id, request.params.id), eq(flows.tenantId, tenantId)))
      .limit(1);

    if (rows.length === 0) {
      reply.status(404);
      return { error: "Flow not found." };
    }

    const flow = rows[0]!;

    // Precondition: not archived
    if (flow.status === "archived") {
      reply.status(422);
      return { error: "Cannot compile an archived flow." };
    }

    // Precondition: has prompt_source
    if (!flow.promptSource) {
      reply.status(422);
      return { error: "Flow has no prompt_source. Set a prompt before compiling." };
    }

    // Precondition: the workspace has AI to use: its own key, or Loomail AI
    // with tokens left this month. These are user-resolvable errors (go to
    // Settings, add a key or upgrade), not async job failures, so they are
    // checked synchronously and the operator learns immediately.
    const ai = await loadAiStatus(db, tenantId);
    if (ai.source === "none") {
      reply.status(422);
      return { error: NO_AI_PROVIDER_MESSAGE };
    }
    if (ai.unavailable) {
      reply.status(503);
      return { error: AI_UNAVAILABLE_MESSAGE, code: "ai_unavailable" };
    }
    if (ai.spent && ai.allowance.limit !== null) {
      reply.status(402);
      return { error: aiAllowanceMessage(ai.allowance.planName, ai.allowance.limit), code: "ai_allowance" };
    }

    // Set compile_status = 'pending' and clear any previous error
    await db
      .update(flows)
      .set({
        compileStatus: "pending",
        compileError: null,
        updatedAt: new Date(),
      })
      .where(and(eq(flows.id, request.params.id), eq(flows.tenantId, tenantId)));

    // Enqueue the compile job. singletonKey ensures only one compile per flow.
    await enqueue(
      QUEUE.COMPILE,
      { flow_id: flow.id, tenant_id: tenantId },
      {
        singletonKey: flow.id,
        expireInMinutes: 10,
        retryLimit: 2,
        retryDelay: 30,
      },
    );

    reply.status(202);
    return { message: "Compilation queued.", flow_id: flow.id, compile_status: "pending" };
  });
  /**
   * POST /v1/flows/:id/plan
   * Save a hand-authored compiled plan for a fixed_content flow.
   *
   * This is the path for person-written flows: the dashboard builds the
   * compiled plan from the step editor UI and submits it here. For each step
   * with email content, a template row is created/upserted, and template_ref
   * is set so the execution engine uses the deterministic template path.
   *
   * Body: { steps: Array<{ order, delay, action_type, window_policy, subject,
   *         body_html, body_text? }>, exit_conditions?: [...] }
   *
   * On success: creates templates, builds a compiled plan, sets
   * compile_status = "ready". The flow can then be activated.
   */
  app.post<{ Params: { id: string }; Body: unknown }>(
    "/:id/plan",
    { config: { minRole: "member" } },
    async (request, reply) => {
      const db: Db = request.server.db;
      const tenantId = request.tenant!.id;

      // Validate request body
      const stepContentSchema = z.object({
        order: z.number().int().min(1),
        delay: z.string().regex(/^\d+(m|h|d)$/),
        action_type: z.string().min(1),
        window_policy: z.enum(["immediate", "respect_window"]),
        subject: z.string().min(1, "Subject is required"),
        body_html: z.string().min(1, "Body HTML is required"),
        body_text: z.string().optional(),
      });

      const planBodySchema = z.object({
        steps: z.array(stepContentSchema).min(1, "At least one step is required"),
        exit_conditions: z.array(z.unknown()).optional(),
      });

      const parsed = planBodySchema.safeParse(request.body);
      if (!parsed.success) {
        reply.status(400);
        return {
          error: "Invalid plan data.",
          issues: parsed.error.issues.map((i) => ({
            path: i.path.join("."),
            message: i.message,
          })),
        };
      }

      const { steps, exit_conditions } = parsed.data;

      // Fetch flow
      const flowRows = await db
        .select()
        .from(flows)
        .where(and(eq(flows.id, request.params.id), eq(flows.tenantId, tenantId)))
        .limit(1);

      if (flowRows.length === 0) {
        reply.status(404);
        return { error: "Flow not found." };
      }

      const flow = flowRows[0]!;

      if (flow.status === "archived") {
        reply.status(422);
        return { error: "Cannot update the plan of an archived flow." };
      }

      if ((flow.contentMode ?? "ai_drafted") !== "fixed_content") {
        reply.status(422);
        return {
          error: "Only fixed_content flows accept a hand-authored plan. " +
            "AI-drafted flows use POST /v1/flows/:id/compile instead.",
        };
      }

      // Create/upsert templates for each step
      const flowId = request.params.id;
      const templateVariables = [
        "contact.first_name",
        "contact.name",
        "contact.email",
        "contact.company",
        "tenant.name",
      ];

      for (const step of steps) {
        const slug = `flow-${flowId}-step-${step.order}`;
        const name = `${flow.name} - Step ${step.order}`;

        // Upsert template: ON CONFLICT (tenant_id, slug) DO UPDATE
        await db
          .insert(templates)
          .values({
            tenantId,
            name,
            slug,
            subject: step.subject,
            bodyHtml: step.body_html,
            bodyText: step.body_text ?? null,
            variables: templateVariables,
            category: "flow",
            isActive: true,
          })
          .onConflictDoUpdate({
            target: [templates.tenantId, templates.slug],
            set: {
              name,
              subject: step.subject,
              bodyHtml: step.body_html,
              bodyText: step.body_text ?? null,
              variables: templateVariables,
              isActive: true,
            },
          });
      }

      // Build the compiled plan
      const compiledPlan = {
        trigger: {
          type: flow.triggerType,
          condition: flow.triggerConfig as Record<string, unknown>,
        },
        steps: steps.map((s) => ({
          order: s.order,
          action_type: s.action_type,
          delay: s.delay,
          window_policy: s.window_policy,
          template_ref: `flow-${flowId}-step-${s.order}`,
        })),
        ...(exit_conditions && exit_conditions.length > 0
          ? { exit_conditions }
          : {}),
      };

      // Validate against the schema to be sure
      const planParsed = compiledPlanSchema.safeParse(compiledPlan);
      if (!planParsed.success) {
        reply.status(500);
        return {
          error: "Internal error: generated plan failed validation.",
          issues: planParsed.error.issues.map((i) => ({
            path: i.path.join("."),
            message: i.message,
          })),
        };
      }

      // Write the plan to the flow
      const [updated] = await db
        .update(flows)
        .set({
          compiledPlan: planParsed.data as unknown as Record<string, unknown>,
          compiledAt: new Date(),
          compileStatus: "ready",
          compileError: null,
          steps: steps.map((s) => ({
            order: s.order,
            action_type: s.action_type,
            delay: s.delay,
            window_policy: s.window_policy,
            template_ref: `flow-${flowId}-step-${s.order}`,
          })),
          updatedAt: new Date(),
        })
        .where(and(eq(flows.id, flowId), eq(flows.tenantId, tenantId)))
        .returning();

      return serializeFlow(updated!);
    },
  );

  /**
   * POST /v1/flows/:id/draft-step
   * Ask the AI to draft copy for a single step in a fixed_content flow.
   *
   * The result is returned to the dashboard for the person to edit. It is
   * never stored automatically - the person owns the final copy.
   *
   * Body: { step_order: number, subject?: string, body_html?: string, context?: string }
   *   - step_order: which step to draft for (used for positioning context)
   *   - subject/body_html: existing content (if any) - the AI sees it as "current draft"
   *   - context: optional extra instructions from the person
   *
   * Returns: { subject: string, body_html: string }
   *
   * Requires an active LLM configuration.
   */
  app.post<{ Params: { id: string }; Body: unknown }>(
    "/:id/draft-step",
    { config: { minRole: "member" } },
    async (request, reply) => {
      const db: Db = request.server.db;
      const tenantId = request.tenant!.id;

      const bodySchema = z.object({
        step_order: z.number().int().min(1),
        subject: z.string().optional(),
        body_html: z.string().optional(),
        context: z.string().optional(),
      });

      const parsed = bodySchema.safeParse(request.body);
      if (!parsed.success) {
        return validationError(reply, parsed.error.issues);
      }

      const { step_order, subject, body_html, context } = parsed.data;

      // Fetch flow
      const flowRows = await db
        .select()
        .from(flows)
        .where(and(eq(flows.id, request.params.id), eq(flows.tenantId, tenantId)))
        .limit(1);

      if (flowRows.length === 0) {
        reply.status(404);
        return { error: "Flow not found." };
      }

      const flow = flowRows[0]!;

      // Resolve the AI provider: the workspace's own key, else Loomail AI.
      const resolved = await resolveProviderForRequest(db, tenantId, "ai_draft");
      if (!resolved.ok) {
        reply.status(resolved.status);
        return resolved.code ? { error: resolved.error, code: resolved.code } : { error: resolved.error };
      }
      const provider = resolved.provider;

      // Fetch tenant name for product context
      const tenantRows = await db
        .select({ name: tenants.name })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1);

      const productName = tenantRows[0]?.name ?? undefined;

      // Build the steps array for context
      const compiledPlan = flow.compiledPlan as Record<string, unknown> | null;
      const steps = compiledPlan && Array.isArray(compiledPlan.steps)
        ? compiledPlan.steps as Array<Record<string, unknown>>
        : (Array.isArray(flow.steps) ? flow.steps as Array<Record<string, unknown>> : []);

      const currentStep = steps.find(
        (s) => typeof s.order === "number" && s.order === step_order,
      );
      const delay = currentStep?.delay as string | undefined;
      const actionType = currentStep?.action_type as string | undefined;

      // Build brain_instruction for the draft
      const parts: string[] = [];
      parts.push(`You are writing email step ${step_order} of ${steps.length || "a"} in a flow.`);
      if (flow.name) parts.push(`Flow name: "${flow.name}".`);
      if (flow.triggerType) parts.push(`Trigger: ${flow.triggerType} (${JSON.stringify(flow.triggerConfig)}).`);
      if (delay) parts.push(`This email sends ${delay === "0m" ? "immediately" : `after a ${delay} delay`}.`);
      if (actionType) parts.push(`Action type: ${actionType}.`);
      if (step_order > 1) parts.push(`This is a follow-up. The contact has already received ${step_order - 1} earlier email(s) in this flow.`);
      parts.push("Use {{contact.first_name|there}}, {{contact.name}}, {{contact.company}}, {{contact.email}} where personalisation belongs.");
      parts.push("The output must contain {{variable}} syntax for personalisation - do not use placeholder text like [Name].");
      if (subject) parts.push(`The person has written this subject so far: "${subject}". Improve or replace it.`);
      if (body_html) parts.push(`The person has written this body so far:\n${body_html}\nImprove or replace it.`);
      if (context) parts.push(`Additional instructions from the person: ${context}`);

      const brainInstruction = parts.join("\n");

      // Call the brain
      const result = await draft(provider, {
        brain_instruction: brainInstruction,
        action_type: actionType,
        product_name: productName,
        first_contact: step_order === 1,
      });

      if (!result.ok) {
        reply.status(502);
        return { error: `AI draft failed: ${result.error}` };
      }

      // Convert markdown body to simple HTML (paragraphs)
      const bodyMarkdown = result.draft.body_markdown;
      const htmlBody = bodyMarkdown
        .split(/\n\n+/)
        .map((p: string) => `<p>${p.replace(/\n/g, "<br>")}</p>`)
        .join("\n");

      return {
        subject: result.draft.subject,
        body_html: htmlBody,
      };
    },
  );
};

// ---------------------------------------------------------------------------
// Serializer
// ---------------------------------------------------------------------------

/**
 * Map a DB row to the API response shape.
 * Renames camelCase DB columns to snake_case for the wire format.
 * compiled_plan and compiled_at are included so the dashboard can show
 * compilation state.
 */
function serializeFlow(row: typeof flows.$inferSelect) {
  return {
    id: row.id,
    tenant_id: row.tenantId,
    name: row.name,
    description: row.description,
    priority: row.priority,
    trigger_type: row.triggerType,
    trigger_config: row.triggerConfig,
    steps: row.steps,
    source: row.source,
    content_mode: row.contentMode ?? "ai_drafted",
    status: row.status,
    approval_mode: row.approvalMode,
    flow_class: row.flowClass,
    reentry_policy: row.reentryPolicy,
    reentry_cooldown_days: row.reentryCooldownDays,
    prompt_source: row.promptSource,
    compiled_plan: row.compiledPlan,
    compiled_at: row.compiledAt,
    compile_status: row.compileStatus,
    compile_error: row.compileError,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

export default flowsRoutes;
