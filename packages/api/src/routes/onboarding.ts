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
import { PlanLimitError, parseOnboardingPatch, plansEnforced } from "@loomail/core";
import type { Db } from "../plugins/db.js";
import { createLimiter } from "../marketing/signup-logic.js";
import { processIdentifyEvent, processTrackEvent } from "./ingest.js";
import { getPlatformTransport } from "../platform-mailer.js";
import { buildTestEmail, type TransactionalEmailInput } from "../transactional-email.js";
import { loadOnboarding, markOnboardingCompleted, mergeOnboardingState } from "../onboarding/state.js";
import { addDemoData, clearDemoData, hasDemoData } from "../onboarding/demo-data.js";

/** The one contact every sample event is for, so repeated samples never pile up contacts. */
export const SAMPLE_USER_ID = "sample-event-user";
/** Samples per workspace per hour (in memory, per process). */
const SAMPLES_PER_HOUR = 5;

const onboardingRoutes: FastifyPluginAsync = async (app) => {
  const sampleLimiter = createLimiter({ windowMs: 3_600_000, max: SAMPLES_PER_HOUR });
  const testEmailLimiter = createLimiter({ windowMs: 3_600_000, max: 3 });

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
      has_demo_data: await hasDemoData(db, tenantId),
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

  /**
   * POST /v1/onboarding/test-email
   *
   * Sends one sample email to the signed-in person's own address from the platform sender, so a
   * new customer can see how a message arrives before they have connected a sending domain. It
   * can only ever go to the caller's own address. Limited to a few per workspace per hour.
   */
  app.post("/test-email", { config: { minRole: "member" } }, async (request, reply) => {
    const db: Db = request.server.db;
    const tenantId = request.tenant!.id;
    const transport = getPlatformTransport();
    if (!transport) return reply.status(503).send({ error: "Test email is not available on this install." });

    const rl = testEmailLimiter.hit(tenantId);
    if (!rl.allowed) {
      reply.header("Retry-After", String(rl.retryAfterSec));
      return reply.status(429).send({ error: "That is enough test emails for now. Try again in a while.", retry_after_seconds: rl.retryAfterSec });
    }

    const who = await db.execute<{ email: string; name: string; settings: Record<string, unknown> | null }>(sql`
      SELECT u.email, t.name, t.settings FROM users u JOIN tenants t ON t.id = u.tenant_id
      WHERE u.id = ${request.tenant!.userId}::uuid LIMIT 1`);
    const row = who.rows[0];
    if (!row) return reply.status(404).send({ error: "User not found." });

    const dashboardUrl = (process.env.DASHBOARD_URL ?? process.env.BASE_URL ?? "").replace(/\/+$/, "");
    const email = buildTestEmail({
      brand: ((row.settings ?? {}).brand as TransactionalEmailInput["brand"] | undefined) ?? {},
      tenantName: row.name,
      continueUrl: `${dashboardUrl}/home`,
    });
    const r = await transport.adapter.send({
      to: row.email,
      from: transport.fromEmail,
      fromName: transport.fromName ?? undefined,
      subject: email.subject,
      bodyHtml: email.html,
      bodyText: email.text,
      headers: {},
      messageId: `test-email-${tenantId}-${Date.now()}`,
    });
    if (!r.success) {
      request.log.warn({ tenantId, error: r.error }, "test email not delivered");
      return reply.status(502).send({ error: "We could not send the test email right now. Please try again in a moment." });
    }
    return { ok: true, sent_to: row.email };
  });

  /**
   * POST   /v1/onboarding/demo-data   add made-up customers so the grid, People and Lifecycle have
   *                                   something to show. They have no email address, never count
   *                                   against plan limits, and never receive anything.
   * DELETE /v1/onboarding/demo-data   remove exactly those customers.
   */
  app.post("/demo-data", { config: { minRole: "member" } }, async (request) => {
    const added = await addDemoData(request.server.db as Db, request.tenant!.id);
    return { ok: true, added };
  });

  app.delete("/demo-data", { config: { minRole: "member" } }, async (request) => {
    const removed = await clearDemoData(request.server.db as Db, request.tenant!.id);
    return { ok: true, removed };
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
