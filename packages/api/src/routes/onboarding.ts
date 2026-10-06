/**
 * Onboarding routes: where a workspace stands on the way to its first delivered email.
 *
 *   GET   /v1/onboarding   the steps, which is next, progress, and the stored state
 *   PATCH /v1/onboarding   { dismissed: boolean }  "do this later" / bring the panel back
 *
 * Progress is worked out from what is actually in the workspace (an address saved, a flow
 * active, an event received), never from what someone clicked, so it cannot drift and it
 * is the same on every browser. `hosted` tells the dashboard whether this is a hosted
 * product (plans enforced) or a self-hosted install, which keeps its own setup screen.
 *
 * Mirror side: PUBLIC (packages/api is mirrored).
 */
import type { FastifyPluginAsync } from "fastify";
import { sql } from "drizzle-orm";
import { PlanLimitError, parseOnboardingPatch, plansEnforced } from "@mailforge/core";
import type { Db } from "../plugins/db.js";
import { createLimiter } from "../marketing/signup-logic.js";
import { processIdentifyEvent, processTrackEvent } from "./ingest.js";
import { loadOnboarding, markOnboardingCompleted, mergeOnboardingState } from "../onboarding/state.js";

/** The one contact every sample event is for, so repeated samples never pile up contacts. */
export const SAMPLE_USER_ID = "sample-event-user";
/** Samples per workspace per hour (in memory, per process). */
const SAMPLES_PER_HOUR = 5;

const onboardingRoutes: FastifyPluginAsync = async (app) => {
  const sampleLimiter = createLimiter({ windowMs: 3_600_000, max: SAMPLES_PER_HOUR });

  app.get("/", { config: { minRole: "member" } }, async (request, reply) => {
    const db: Db = request.server.db;
    const tenantId = request.tenant!.id;

    let snap = await loadOnboarding(db, tenantId);
    if (!snap) return reply.status(404).send({ error: "Workspace not found." });

    // The first time every step is done, remember when. Only for hosted workspaces,
    // where the date feeds the operator's activation numbers.
    if (snap.progress.complete && !snap.state.completed_at && plansEnforced()) {
      const set = await markOnboardingCompleted(db, tenantId);
      if (set) snap = (await loadOnboarding(db, tenantId)) ?? snap;
    }

    return {
      hosted: plansEnforced(),
      steps: snap.progress.steps,
      done: snap.progress.done,
      total: snap.progress.total,
      percent: snap.progress.percent,
      complete: snap.progress.complete,
      next: snap.progress.next,
      minutes_left: snap.progress.minutesLeft,
      has_ingest_key: snap.hasIngestKey,
      // What they said they wanted at signup, and the ready-made flows that fit it (if any).
      goal: snap.goal,
      goal_suggestion: snap.goalSuggestion
        ? { template_id: snap.goalSuggestion.templateId, name: snap.goalSuggestion.name, flow_count: snap.goalSuggestion.flowCount, applied: snap.goalSuggestion.applied }
        : null,
      // Approved email that cannot go out yet, and why (null reason = nothing wrong). Counted up to 100.
      waiting_emails: snap.waiting.count,
      waiting_reason: snap.waiting.reason,
      dismissed: Boolean(snap.state.dismissed_at),
      completed_at: snap.state.completed_at ?? null,
    };
  });

  /**
   * POST /v1/onboarding/sample-event
   *
   * Sends a real `signed_up` event for the signed-in person, with no API key needed, so a new
   * customer can watch the whole path (event, flow, email) before wiring up their own app.
   * It goes through the same code as POST /v1/track, so it counts against plan limits and starts
   * flows exactly like a real event.
   *
   * The contact is always the caller's own address: the endpoint can never be used to email
   * someone else. Limited to a few per workspace per hour.
   */
  app.post("/sample-event", { config: { minRole: "member" } }, async (request, reply) => {
    const db: Db = request.server.db;
    const tenantId = request.tenant!.id;

    const rl = sampleLimiter.hit(tenantId);
    if (!rl.allowed) {
      reply.header("Retry-After", String(rl.retryAfterSec));
      return reply.status(429).send({ error: "That is enough samples for now. Try again in a while.", retry_after_seconds: rl.retryAfterSec });
    }

    const who = await db.execute<{ email: string; name: string | null }>(
      sql`SELECT email, name FROM users WHERE id = ${request.tenant!.userId}::uuid LIMIT 1`,
    );
    const user = who.rows[0];
    if (!user) return reply.status(404).send({ error: "User not found." });

    const snap = await loadOnboarding(db, tenantId);
    const prior = await db.execute<{ n: string }>(sql`
      SELECT count(*)::text AS n FROM events e JOIN contacts c ON c.id = e.contact_id
      WHERE e.tenant_id = ${tenantId}::uuid AND c.external_id = ${SAMPLE_USER_ID} AND e.event_name = 'signed_up'
    `);

    const firstName = (user.name ?? "").trim().split(/\s+/)[0] ?? "";
    try {
      await processIdentifyEvent(db, tenantId, {
        userId: SAMPLE_USER_ID,
        traits: { email: user.email, name: user.name?.trim() || "Sample contact", ...(firstName ? { first_name: firstName } : {}) },
      });
      await processTrackEvent(db, request.server.enqueue, tenantId, {
        userId: SAMPLE_USER_ID,
        event: "signed_up",
        properties: { sample: true },
      });
    } catch (err) {
      if (err instanceof PlanLimitError) return reply.status(402).send(err.toJSON());
      throw err;
    }

    return {
      ok: true,
      sent_to: user.email,
      flow_active: snap?.facts.hasActiveFlow ?? false,
      sender_ready: snap?.facts.hasSender ?? false,
      repeat: Number(prior.rows[0]?.n ?? 0) > 0,
    };
  });

  app.patch("/", { config: { minRole: "member" } }, async (request, reply) => {
    const db: Db = request.server.db;
    const patch = parseOnboardingPatch(request.body);
    if (!patch) return reply.status(400).send({ error: "Send { dismissed: true | false }." });

    await mergeOnboardingState(db, request.tenant!.id, {
      dismissed_at: patch.dismissed ? new Date().toISOString() : null,
    });
    return { ok: true, dismissed: patch.dismissed };
  });
};

export default onboardingRoutes;
