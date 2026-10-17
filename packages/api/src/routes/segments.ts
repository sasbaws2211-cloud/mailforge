/**
 * Segment routes: saved groups of contacts, described by rules.
 *
 *   GET    /v1/segments              list (live ones; ?include_archived=true adds archived)
 *   POST   /v1/segments              create { name, description?, definition }
 *   GET    /v1/segments/:id          one, with the flows that use it
 *   PATCH  /v1/segments/:id          rename / re-describe / change the rules (and recount)
 *   POST   /v1/segments/:id/refresh  recount now
 *   DELETE /v1/segments/:id          archive; refused while a flow still uses it
 *   POST   /v1/segments/preview      count and sample a definition that is not saved yet
 *
 * A segment is a definition (core's segmentDefinitionSchema), not a list of people: who is in it is worked out
 * from the rules whenever needed. member_count is a cache of the last count, with the time it was taken.
 * See ../segments/run.ts for how a segment is run against contacts, within a time limit.
 *
 * The People list filters by a segment with GET /v1/contacts?segment_id=.
 */
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { and, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { flows, segments } from "@loomail/db/schema";
import { segmentDefinitionSchema, segmentEventNames, type SegmentDefinition } from "@loomail/core";
import type { Db } from "../plugins/db.js";
import { createLimiter } from "../marketing/signup-logic.js";
import {
  SegmentTooSlowError,
  countMembers,
  neverSentEvents,
  sampleMembers,
  type SegmentCount,
} from "../segments/run.js";

/** A workspace can keep this many live segments. A guard against runaway automation, not a plan limit. */
export const MAX_SEGMENTS_PER_WORKSPACE = 200;

const nameSchema = z.string().trim().min(1, "A segment needs a name.").max(100, "Keep the name under 100 characters.");
const descriptionSchema = z.string().trim().max(500, "Keep the description under 500 characters.");

const createSchema = z.object({
  name: nameSchema,
  // null is accepted (and means none) because a form with an empty box naturally sends it
  description: descriptionSchema.nullable().optional(),
  definition: segmentDefinitionSchema,
});

const updateSchema = z
  .object({
    name: nameSchema.optional(),
    description: descriptionSchema.nullable().optional(),
    definition: segmentDefinitionSchema.optional(),
  })
  .refine((b) => b.name !== undefined || b.description !== undefined || b.definition !== undefined, {
    message: "Nothing to change.",
  });

const previewSchema = z.object({ definition: segmentDefinitionSchema });

function isUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

/** zod reports a rule that fits none of the known shapes as a bare "Invalid input"; say what it means. */
function issuesOf(error: z.ZodError) {
  return error.issues.map((i) => {
    const path = i.path.join(".");
    return {
      path,
      message:
        i.message === "Invalid input" && /(^|\.)(definition\.)?rules(\.|$)/.test(path)
          ? "not a rule the segment builder understands"
          : i.message,
    };
  });
}

function validationError(reply: { status: (n: number) => unknown }, error: z.ZodError) {
  reply.status(400);
  return { error: "Validation failed", issues: issuesOf(error) };
}

type SegmentRow = typeof segments.$inferSelect;

function serialize(row: SegmentRow, usedBy?: Array<{ id: string; name: string; status: string | null }>) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    definition: row.definition,
    member_count: row.memberCount,
    count_capped: row.countCapped,
    counted_at: row.countedAt,
    archived: row.archivedAt !== null,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
    ...(usedBy ? { used_by_flows: usedBy } : {}),
  };
}

/** Flows that start from this segment and are not archived. */
async function flowsUsing(db: Db, tenantId: string, segmentIds: string[]) {
  if (segmentIds.length === 0) return [] as Array<{ id: string; name: string; status: string | null; segmentId: string }>;
  const rows = await db
    .select({
      id: flows.id,
      name: flows.name,
      status: flows.status,
      segmentId: sql<string>`${flows.triggerConfig} ->> 'segment_id'`,
    })
    .from(flows)
    .where(
      and(
        eq(flows.tenantId, tenantId),
        eq(flows.triggerType, "segment"),
        ne(flows.status, "archived"),
        inArray(sql`${flows.triggerConfig} ->> 'segment_id'`, segmentIds),
      ),
    );
  return rows;
}

function isNameConflict(err: unknown): boolean {
  const e = err as { code?: string; constraint?: string; cause?: { code?: string; constraint?: string } } | null;
  const code = e?.code ?? e?.cause?.code;
  const constraint = e?.constraint ?? e?.cause?.constraint;
  return code === "23505" && constraint === "uq_segments_tenant_name";
}

const segmentsRoutes: FastifyPluginAsync = async (app) => {
  // Counting reads the contacts table, so a runaway client is limited per workspace.
  const countLimiter = createLimiter({ windowMs: 60_000, max: 60 });

  /** Count a definition, or answer the request with why it cannot be counted. */
  async function countOr(
    request: { server: { db: Db } },
    reply: { status: (n: number) => unknown; header: (k: string, v: string) => unknown },
    tenantId: string,
    definition: SegmentDefinition,
  ): Promise<SegmentCount | { error: string; status: number; retryAfter?: number }> {
    const rl = countLimiter.hit(tenantId);
    if (!rl.allowed) {
      reply.header("Retry-After", String(rl.retryAfterSec));
      return { error: "That is a lot of counting for one minute. Try again shortly.", status: 429, retryAfter: rl.retryAfterSec };
    }
    try {
      return await countMembers(request.server.db, tenantId, definition);
    } catch (err) {
      if (err instanceof SegmentTooSlowError) return { error: err.message, status: 422 };
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // POST /preview: count and sample a definition that is not saved yet
  // ---------------------------------------------------------------------------
  app.post("/preview", { config: { minRole: "member" } }, async (request, reply) => {
    const parsed = previewSchema.safeParse(request.body);
    if (!parsed.success) return validationError(reply, parsed.error);

    const db: Db = request.server.db;
    const tenantId = request.tenant!.id;
    const { definition } = parsed.data;

    const counted = await countOr(request, reply, tenantId, definition);
    if ("error" in counted) {
      reply.status(counted.status);
      return { error: counted.error, ...(counted.retryAfter ? { retry_after_seconds: counted.retryAfter } : {}) };
    }
    try {
      const [sample, unknown] = await Promise.all([
        sampleMembers(db, tenantId, definition),
        neverSentEvents(db, tenantId, segmentEventNames(definition)),
      ]);
      return { count: counted.count, capped: counted.capped, reachable: counted.reachable, sample, never_sent_events: unknown };
    } catch (err) {
      if (err instanceof SegmentTooSlowError) {
        reply.status(422);
        return { error: err.message };
      }
      throw err;
    }
  });

  // ---------------------------------------------------------------------------
  // GET /: list
  // ---------------------------------------------------------------------------
  app.get<{ Querystring: { include_archived?: string } }>("/", { config: { minRole: "member" } }, async (request) => {
    const db: Db = request.server.db;
    const tenantId = request.tenant!.id;
    const includeArchived = request.query.include_archived === "true";

    const rows = await db
      .select()
      .from(segments)
      .where(and(eq(segments.tenantId, tenantId), includeArchived ? undefined : isNull(segments.archivedAt)))
      .orderBy(desc(segments.createdAt), desc(segments.id));

    const using = await flowsUsing(db, tenantId, rows.map((r) => r.id));
    const counts = new Map<string, number>();
    for (const f of using) counts.set(f.segmentId, (counts.get(f.segmentId) ?? 0) + 1);

    return { segments: rows.map((r) => ({ ...serialize(r), flow_count: counts.get(r.id) ?? 0 })) };
  });

  // ---------------------------------------------------------------------------
  // POST /: create
  // ---------------------------------------------------------------------------
  app.post("/", { config: { minRole: "member" } }, async (request, reply) => {
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) return validationError(reply, parsed.error);

    const db: Db = request.server.db;
    const tenantId = request.tenant!.id;
    const body = parsed.data;

    const [{ n }] = (
      await db.execute<{ n: string }>(sql`SELECT count(*) AS n FROM segments WHERE tenant_id = ${tenantId}::uuid AND archived_at IS NULL`)
    ).rows as [{ n: string }];
    if (Number(n) >= MAX_SEGMENTS_PER_WORKSPACE) {
      reply.status(422);
      return { error: `A workspace can have up to ${MAX_SEGMENTS_PER_WORKSPACE} segments. Archive one you no longer use.` };
    }

    // Count first: a segment that cannot be counted is too slow to use, and better refused now than later.
    const counted = await countOr(request, reply, tenantId, body.definition);
    if ("error" in counted) {
      reply.status(counted.status);
      return { error: counted.error };
    }

    try {
      const [row] = await db
        .insert(segments)
        .values({
          tenantId,
          name: body.name,
          description: body.description || null,
          definition: body.definition,
          memberCount: counted.count,
          countCapped: counted.capped,
          countedAt: new Date(),
        })
        .returning();
      reply.status(201);
      return serialize(row!, []);
    } catch (err) {
      if (isNameConflict(err)) {
        reply.status(409);
        return { error: "You already have a segment with that name." };
      }
      throw err;
    }
  });

  // ---------------------------------------------------------------------------
  // GET /:id
  // ---------------------------------------------------------------------------
  app.get<{ Params: { id: string } }>("/:id", { config: { minRole: "member" } }, async (request, reply) => {
    const db: Db = request.server.db;
    const tenantId = request.tenant!.id;
    if (!isUuid(request.params.id)) {
      reply.status(404);
      return { error: "Segment not found." };
    }
    const [row] = await db
      .select()
      .from(segments)
      .where(and(eq(segments.id, request.params.id), eq(segments.tenantId, tenantId)))
      .limit(1);
    if (!row) {
      reply.status(404);
      return { error: "Segment not found." };
    }
    const using = await flowsUsing(db, tenantId, [row.id]);
    return serialize(row, using.map((f) => ({ id: f.id, name: f.name, status: f.status })));
  });

  // ---------------------------------------------------------------------------
  // PATCH /:id
  // ---------------------------------------------------------------------------
  app.patch<{ Params: { id: string } }>("/:id", { config: { minRole: "member" } }, async (request, reply) => {
    const parsed = updateSchema.safeParse(request.body);
    if (!parsed.success) return validationError(reply, parsed.error);

    const db: Db = request.server.db;
    const tenantId = request.tenant!.id;
    if (!isUuid(request.params.id)) {
      reply.status(404);
      return { error: "Segment not found." };
    }
    const [current] = await db
      .select()
      .from(segments)
      .where(and(eq(segments.id, request.params.id), eq(segments.tenantId, tenantId)))
      .limit(1);
    if (!current) {
      reply.status(404);
      return { error: "Segment not found." };
    }
    if (current.archivedAt !== null) {
      reply.status(422);
      return { error: "An archived segment cannot be changed." };
    }

    const body = parsed.data;
    const set: Partial<typeof segments.$inferInsert> = { updatedAt: new Date() };
    if (body.name !== undefined) set.name = body.name;
    if (body.description !== undefined) set.description = body.description || null;
    if (body.definition !== undefined) {
      const counted = await countOr(request, reply, tenantId, body.definition);
      if ("error" in counted) {
        reply.status(counted.status);
        return { error: counted.error };
      }
      set.definition = body.definition;
      set.memberCount = counted.count;
      set.countCapped = counted.capped;
      set.countedAt = new Date();
    }

    try {
      const [row] = await db
        .update(segments)
        .set(set)
        .where(and(eq(segments.id, current.id), eq(segments.tenantId, tenantId), isNull(segments.archivedAt)))
        .returning();
      if (!row) {
        reply.status(422);
        return { error: "An archived segment cannot be changed." };
      }
      const using = await flowsUsing(db, tenantId, [row.id]);
      return serialize(row, using.map((f) => ({ id: f.id, name: f.name, status: f.status })));
    } catch (err) {
      if (isNameConflict(err)) {
        reply.status(409);
        return { error: "You already have a segment with that name." };
      }
      throw err;
    }
  });

  // ---------------------------------------------------------------------------
  // POST /:id/refresh
  // ---------------------------------------------------------------------------
  app.post<{ Params: { id: string } }>("/:id/refresh", { config: { minRole: "member" } }, async (request, reply) => {
    const db: Db = request.server.db;
    const tenantId = request.tenant!.id;
    if (!isUuid(request.params.id)) {
      reply.status(404);
      return { error: "Segment not found." };
    }
    const [current] = await db
      .select()
      .from(segments)
      .where(and(eq(segments.id, request.params.id), eq(segments.tenantId, tenantId), isNull(segments.archivedAt)))
      .limit(1);
    if (!current) {
      reply.status(404);
      return { error: "Segment not found." };
    }
    const parsed = segmentDefinitionSchema.safeParse(current.definition);
    if (!parsed.success) {
      reply.status(422);
      return { error: "This segment's rules can no longer be read. Edit and save it again." };
    }
    const counted = await countOr(request, reply, tenantId, parsed.data);
    if ("error" in counted) {
      reply.status(counted.status);
      return { error: counted.error };
    }
    const [row] = await db
      .update(segments)
      .set({ memberCount: counted.count, countCapped: counted.capped, countedAt: new Date() })
      .where(and(eq(segments.id, current.id), eq(segments.tenantId, tenantId)))
      .returning();
    const using = await flowsUsing(db, tenantId, [current.id]);
    return serialize(row!, using.map((f) => ({ id: f.id, name: f.name, status: f.status })));
  });

  // ---------------------------------------------------------------------------
  // DELETE /:id: archive
  // ---------------------------------------------------------------------------
  app.delete<{ Params: { id: string } }>("/:id", { config: { minRole: "member" } }, async (request, reply) => {
    const db: Db = request.server.db;
    const tenantId = request.tenant!.id;
    if (!isUuid(request.params.id)) {
      reply.status(404);
      return { error: "Segment not found." };
    }
    const [current] = await db
      .select()
      .from(segments)
      .where(and(eq(segments.id, request.params.id), eq(segments.tenantId, tenantId)))
      .limit(1);
    if (!current) {
      reply.status(404);
      return { error: "Segment not found." };
    }
    if (current.archivedAt !== null) return serialize(current); // already archived: nothing to do

    const using = await flowsUsing(db, tenantId, [current.id]);
    if (using.length > 0) {
      reply.status(422);
      return {
        error: `${using.length === 1 ? "A flow still starts from" : `${using.length} flows still start from`} this segment. Archive or change ${using.length === 1 ? "it" : "them"} first.`,
        flows: using.map((f) => ({ id: f.id, name: f.name, status: f.status })),
      };
    }
    const [row] = await db
      .update(segments)
      .set({ archivedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(segments.id, current.id), eq(segments.tenantId, tenantId)))
      .returning();
    return serialize(row!);
  });
};

export default segmentsRoutes;
