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
 *     @claros/core (validateStatusTransition). archived is terminal.
 *
 * Cross-tenant isolation: any flow that exists but belongs to a different tenant
 * returns 404 (not 403) to avoid leaking information about other tenants.
 *
 * Mirror side: PUBLIC (packages/api is mirrored).
 */
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { eq, and, ne } from "drizzle-orm";
import { flows, llmConfigs } from "@claros/db/schema";
import {
  isValidDelay,
  validateStatusTransition,
  FLOW_TRIGGER_TYPES,
  FLOW_STATUSES,
  FLOW_CLASSES,
  REENTRY_POLICIES,
  FLOW_SOURCES,
  APPROVAL_MODES,
  QUEUE,
  type FlowStatus,
} from "@claros/core";
import type { Db } from "../plugins/db.js";

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
  /**
   * POST /v1/flows
   * Create a new flow. Always starts with status = 'draft'.
   */
  app.post<{ Body: CreateFlowBody }>("/", async (request, reply) => {
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
        status: "draft",
        approvalMode: body.approval_mode ?? "require",
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
   * GET /v1/flows/:id
   * Get a single flow. Returns 404 if not found or owned by another tenant.
   */
  app.get<{ Params: { id: string } }>("/:id", async (request, reply) => {
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
  app.delete<{ Params: { id: string } }>("/:id", async (request, reply) => {
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
  app.post<{ Params: { id: string } }>("/:id/compile", async (request, reply) => {
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

    // Precondition: tenant has an active LLM configuration.
    // This is a user-resolvable error (go to Settings, add an LLM key), not an
    // async job failure. Check synchronously so the operator learns immediately.
    const llmRows = await db
      .select({ id: llmConfigs.id })
      .from(llmConfigs)
      .where(and(eq(llmConfigs.tenantId, tenantId), eq(llmConfigs.isActive, true)))
      .limit(1);

    if (llmRows.length === 0) {
      reply.status(422);
      return { error: "No LLM configuration found. Add an LLM provider in Settings before compiling flows." };
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
