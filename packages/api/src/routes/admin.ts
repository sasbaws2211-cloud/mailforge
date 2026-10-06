/**
 * Platform admin console API: what the operator of the service sees and does
 * across ALL customer workspaces.
 *
 *   GET  /v1/admin/overview                     counts, signups, subscriptions, attention list
 *   GET  /v1/admin/funnel?days=7|30|90          signup funnel: how far new workspaces got
 *   GET  /v1/admin/tenants?q&status&limit&offset  find workspaces
 *   GET  /v1/admin/tenants/:id                  one workspace in full
 *   POST /v1/admin/tenants/:id/plan             put a workspace on a plan by hand
 *   POST /v1/admin/tenants/:id/trial            start or extend a trial
 *   POST /v1/admin/tenants/:id/suspend          switch a workspace off
 *   POST /v1/admin/tenants/:id/unsuspend        switch it back on
 *   POST /v1/admin/tenants/:id/cancel-subscription   stop a customer's charges
 *   GET  /v1/admin/audit?tenant_id&limit        what admins have changed
 *
 * Access: only signed-in users listed in MAILFORGE_PLATFORM_ADMINS. Everyone else,
 * including workspace owners, gets a plain 404 so the console does not advertise
 * itself. The console reads across tenants by design; it never shows message
 * bodies, contact lists or API keys, only counts and account facts.
 *
 * Every change needs a written reason and is recorded in admin_audit_log in the
 * same transaction as the change.
 *
 * Mirror side: PUBLIC (packages/api is mirrored).
 */
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { and, eq, inArray } from "drizzle-orm";
import { sql } from "drizzle-orm";
import {
  BILLING_GRACE_DAYS,
  PLANS,
  PLAN_IDS,
  TRIAL_PLAN_VALUE,
  entitlementsFor,
  isPlanId,
  startOfMonthUtc,
} from "@mailforge/core";
import { Readable } from "node:stream";
import { adminAuditLog, managedSending, subscriptions, tenants } from "@mailforge/db/schema";
import { purgeWorkspace } from "@mailforge/db/purge";
import type { Db } from "../plugins/db.js";
import type { BillingRuntime } from "../billing/config.js";
import { BillingError, cancelSubscriptionForTenant } from "../billing/service.js";
import { loadUsage } from "../plan/usage.js";
import { isPlatformAdmin } from "../admin/platform-admins.js";
import type { PlatformAdminActor } from "../types.js";
import { openWorkspaceExport } from "../account/export.js";
import { loadOnboardingFunnel, parseFunnelWindow, FUNNEL_WINDOWS } from "../admin/funnel.js";
import { loadNoticeContext, notifyDeletionCancelled, notifyDeletionScheduled, notifyWorkspaceErased } from "../account/notify.js";
import type { PlatformTransport } from "../platform-mailer.js";
import { cancelDeletion, deletionGraceDays, scheduleDeletion } from "../account/deletion.js";
import adminAiRoutes from "./admin-ai.js";
import { loadSendingRow } from "../sending/context.js";
import { buildSenderPausedEmail, buildSenderResumedEmail, mailEach, ownerEmails } from "../sending/health.js";
import { getPlatformTransport } from "../platform-mailer.js";

const DAY = 86_400_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_REASON = 300;
const MAX_TRIAL_DAYS = 90;
/** Largest hand-set monthly AI token allowance (fits the integer column, and is far beyond any plan). */
const MAX_AI_ALLOWANCE = 1_000_000_000;
const LIST_STATUSES = ["all", "trial", "free", "paid", "suspended"] as const;

function asDate(v: Date | string | null | undefined): Date | null {
  if (v === null || v === undefined) return null;
  return v instanceof Date ? v : new Date(v);
}
const iso = (v: Date | string | null | undefined) => asDate(v)?.toISOString() ?? null;

/** Plain-language reason, trimmed; null when missing or too long. */
function cleanReason(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 && t.length <= MAX_REASON ? t : null;
}

const needReason = (reply: FastifyReply) =>
  reply.status(400).send({ error: `Give a reason (up to ${MAX_REASON} characters). It is kept in the audit log.`, code: "reason_required" });

type TenantRow = {
  id: string;
  name: string;
  slug: string;
  plan: string | null;
  trial_ends_at: Date | string | null;
  plan_paid_through: Date | string | null;
  suspended_at: Date | string | null;
  suspended_reason: string | null;
  deletion_scheduled_at: Date | string | null;
  deletion_requested_by: string | null;
  ai_allowance_override: number | null;
  created_at: Date | string | null;
  owner_email: string | null;
  contacts: string;
  emails_this_month: string;
  members: string;
  sub_status: string | null;
  sub_plan: string | null;
  sub_interval: string | null;
};

function shapeTenant(r: TenantRow, now: Date) {
  const ent = entitlementsFor({
    plan: r.plan,
    trialEndsAt: asDate(r.trial_ends_at),
    paidThrough: asDate(r.plan_paid_through),
    aiTokensOverride: r.ai_allowance_override,
    now,
    enforced: true,
  });
  return {
    id: r.id,
    name: r.name,
    slug: r.slug,
    owner_email: r.owner_email,
    created_at: iso(r.created_at),
    stored_plan: r.plan ?? "free",
    effective_plan: { id: ent.plan, name: PLANS[ent.plan].name },
    on_trial: ent.onTrial,
    trial_ends_at: iso(r.trial_ends_at),
    payment_status: ent.paymentStatus,
    paid_through: iso(r.plan_paid_through),
    suspended: r.suspended_at !== null,
    suspended_at: iso(r.suspended_at),
    suspended_reason: r.suspended_reason,
    deletion_scheduled_at: iso(r.deletion_scheduled_at),
    deletion_requested_by: r.deletion_requested_by,
    // A hand-set Mailforge AI token allowance: null = the plan's, -1 = no cap.
    ai_allowance_override: r.ai_allowance_override,
    contacts: Number(r.contacts),
    emails_this_month: Number(r.emails_this_month),
    members: Number(r.members),
    subscription: r.sub_status ? { status: r.sub_status, plan: r.sub_plan, interval: r.sub_interval } : null,
  };
}

/** Columns shared by the list and the detail view. */
function tenantSelect(monthStart: Date) {
  return sql`
    SELECT t.id, t.name, t.slug, t.plan, t.trial_ends_at, t.plan_paid_through,
           t.suspended_at, t.suspended_reason, t.deletion_scheduled_at, t.deletion_requested_by, t.ai_allowance_override, t.created_at,
           (SELECT u.email FROM users u WHERE u.tenant_id = t.id AND u.role = 'owner'
              ORDER BY u.created_at ASC LIMIT 1) AS owner_email,
           (SELECT count(*) FROM contacts c WHERE c.tenant_id = t.id)::text AS contacts,
           (SELECT count(*) FROM lifecycle_messages m
              WHERE m.tenant_id = t.id AND m.status = 'sent'
                AND m.sent_at >= ${monthStart.toISOString()}::timestamptz)::text AS emails_this_month,
           (SELECT count(*) FROM users u WHERE u.tenant_id = t.id AND u.deactivated_at IS NULL)::text AS members,
           (SELECT s.status FROM subscriptions s WHERE s.tenant_id = t.id AND s.status IN ('active','cancelled') LIMIT 1) AS sub_status,
           (SELECT s.plan FROM subscriptions s WHERE s.tenant_id = t.id AND s.status IN ('active','cancelled') LIMIT 1) AS sub_plan,
           (SELECT s.interval FROM subscriptions s WHERE s.tenant_id = t.id AND s.status IN ('active','cancelled') LIMIT 1) AS sub_interval
    FROM tenants t`;
}

export interface AdminRouteOptions {
  billing?: BillingRuntime;
  dashboardUrl?: string;
  noticeTransports?: PlatformTransport[];
  /**
   * Who is calling, or null. Defaults to the signed-in workspace user when their email is
   * on the platform admin list (the console inside the customer app). The standalone
   * console passes its own, based on its own session.
   */
  resolveActor?: (request: FastifyRequest) => Promise<PlatformAdminActor | null> | PlatformAdminActor | null;
  /** What to answer an unknown caller: 404 hides the console, 401 tells the console to sign in. */
  denyStatus?: 401 | 404;
}

/** Is this admin a member of that workspace? Used to stop an admin locking themselves out. */
async function adminBelongsTo(db: Db, email: string, tenantId: string): Promise<boolean> {
  const r = await db.execute<{ n: string }>(sql`
    SELECT count(*)::text AS n FROM users
    WHERE tenant_id = ${tenantId}::uuid AND lower(email) = ${email.toLowerCase()} AND deactivated_at IS NULL`);
  return Number(r.rows[0]?.n ?? 0) > 0;
}

const defaultActor = (request: FastifyRequest): PlatformAdminActor | null =>
  request.tenant && isPlatformAdmin(request.tenant.userEmail) ? { email: request.tenant.userEmail, id: request.tenant.userId } : null;

const adminRoutes: FastifyPluginAsync<AdminRouteOptions> = async (app, opts) => {
  const billing = opts.billing;

  // Everyone who is not a platform admin is turned away: a 404 (as if the route did not exist)
  // inside the customer app, a 401 on the standalone console so it can show its sign-in page.
  const resolveActor = opts.resolveActor ?? defaultActor;
  const denyStatus = opts.denyStatus ?? 404;
  app.decorateRequest("platformAdmin", null);
  app.addHook("preHandler", async (request: FastifyRequest, reply: FastifyReply) => {
    const actor = await resolveActor(request);
    if (!actor) {
      reply.status(denyStatus).send(denyStatus === 401 ? { error: "Authentication required." } : { error: "Not found." });
      return;
    }
    request.platformAdmin = actor;
  });

  // The operator's own AI provider (Mailforge AI): same gate, same audit log.
  await app.register(adminAiRoutes);

  /** Find a workspace or answer 404. */
  async function loadTenant(db: Db, id: string, now: Date) {
    if (!UUID_RE.test(id)) return null;
    const r = await db.execute<TenantRow>(sql`${tenantSelect(startOfMonthUtc(now))} WHERE t.id = ${id}::uuid LIMIT 1`);
    return r.rows[0] ?? null;
  }

  async function liveSubscription(db: Db, tenantId: string) {
    const [sub] = await db
      .select()
      .from(subscriptions)
      .where(and(eq(subscriptions.tenantId, tenantId), inArray(subscriptions.status, ["active", "cancelled"])))
      .limit(1);
    return sub ?? null;
  }

  /** Apply a change and its audit row in one transaction. */
  async function audited(
    db: Db,
    request: FastifyRequest,
    action: string,
    tenantId: string,
    detail: Record<string, unknown>,
    change: (tx: Parameters<Parameters<Db["transaction"]>[0]>[0]) => Promise<void>,
  ) {
    await db.transaction(async (tx) => {
      await change(tx);
      await tx.insert(adminAuditLog).values({
        actorUserId: request.platformAdmin!.id,
        actorEmail: request.platformAdmin!.email,
        action,
        tenantId,
        detail,
      });
    });
  }

  // -------------------------------------------------------------------------
  // Overview
  // -------------------------------------------------------------------------
  app.get("/overview", { config: { minRole: "member" } }, async (request) => {
    const db: Db = request.server.db;
    const now = new Date();
    const monthStart = startOfMonthUtc(now).toISOString();
    const t = now.toISOString();
    const [counts, subs, usage, attention] = await Promise.all([
      db.execute<Record<string, string>>(sql`
        SELECT count(*)::text AS total,
               count(*) FILTER (WHERE suspended_at IS NOT NULL)::text AS suspended,
               count(*) FILTER (WHERE created_at >= ${t}::timestamptz - interval '7 days')::text AS signups_7d,
               count(*) FILTER (WHERE created_at >= ${t}::timestamptz - interval '30 days')::text AS signups_30d,
               count(*) FILTER (WHERE plan = ${TRIAL_PLAN_VALUE} AND trial_ends_at > ${t}::timestamptz)::text AS on_trial,
               count(*) FILTER (WHERE plan = ${TRIAL_PLAN_VALUE} AND (trial_ends_at IS NULL OR trial_ends_at <= ${t}::timestamptz))::text AS trial_ended,
               count(*) FILTER (WHERE plan = 'free' OR plan IS NULL)::text AS free,
               count(*) FILTER (WHERE plan = 'starter')::text AS starter,
               count(*) FILTER (WHERE plan = 'growth')::text AS growth,
               count(*) FILTER (WHERE plan = 'scale')::text AS scale
        FROM tenants`),
      db.execute<Record<string, string>>(sql`
        SELECT count(*) FILTER (WHERE status = 'active')::text AS active,
               count(*) FILTER (WHERE status = 'cancelled' AND current_period_end > ${t}::timestamptz)::text AS cancelling,
               COALESCE(sum(CASE WHEN status = 'active'
                                 THEN CASE interval WHEN 'yearly' THEN amount_cents / 12.0 ELSE amount_cents END
                            END), 0)::bigint::text AS mrr_cents
        FROM subscriptions WHERE currency = 'USD'`),
      db.execute<Record<string, string>>(sql`
        SELECT (SELECT count(*) FROM contacts)::text AS contacts,
               (SELECT count(*) FROM lifecycle_messages WHERE status = 'sent' AND sent_at >= ${monthStart}::timestamptz)::text AS emails_this_month`),
      db.execute<Record<string, string>>(sql`
        SELECT count(*) FILTER (WHERE plan IN ('starter','growth','scale') AND plan_paid_through IS NOT NULL
                                  AND plan_paid_through <= ${t}::timestamptz
                                  AND plan_paid_through + (${BILLING_GRACE_DAYS} * interval '1 day') > ${t}::timestamptz)::text AS overdue,
               count(*) FILTER (WHERE plan IN ('starter','growth','scale') AND plan_paid_through IS NOT NULL
                                  AND plan_paid_through + (${BILLING_GRACE_DAYS} * interval '1 day') <= ${t}::timestamptz)::text AS lapsed,
               count(*) FILTER (WHERE plan = ${TRIAL_PLAN_VALUE} AND trial_ends_at > ${t}::timestamptz
                                  AND trial_ends_at <= ${t}::timestamptz + interval '3 days')::text AS trials_ending
        FROM tenants`),
    ]);
    const c = counts.rows[0] ?? {};
    const s = subs.rows[0] ?? {};
    const u = usage.rows[0] ?? {};
    const a = attention.rows[0] ?? {};
    const n = (v: string | undefined) => Number(v ?? 0);
    return {
      workspaces: {
        total: n(c.total),
        suspended: n(c.suspended),
        signups_7d: n(c.signups_7d),
        signups_30d: n(c.signups_30d),
        by_stored_plan: {
          trial_running: n(c.on_trial),
          trial_ended: n(c.trial_ended),
          free: n(c.free),
          starter: n(c.starter),
          growth: n(c.growth),
          scale: n(c.scale),
        },
      },
      revenue: {
        currency: "USD",
        // Active subscriptions only, yearly plans counted as a twelfth. Cancelled ones are not renewing.
        mrr_usd: n(s.mrr_cents) / 100,
        active_subscriptions: n(s.active),
        cancelling_subscriptions: n(s.cancelling),
      },
      usage: { contacts: n(u.contacts), emails_this_month: n(u.emails_this_month) },
      attention: {
        payments_overdue: n(a.overdue),
        subscriptions_lapsed: n(a.lapsed),
        trials_ending_in_3_days: n(a.trials_ending),
      },
      billing_enabled: billing?.enabled === true,
      generated_at: t,
    };
  });

  // -------------------------------------------------------------------------
  // Signup funnel
  // -------------------------------------------------------------------------
  app.get<{ Querystring: { days?: string } }>("/funnel", { config: { minRole: "member" } }, async (request, reply) => {
    const days = parseFunnelWindow(request.query.days);
    if (days === null) return reply.status(400).send({ error: `days must be one of ${FUNNEL_WINDOWS.join(", ")}.` });
    return loadOnboardingFunnel(request.server.db as Db, days);
  });

  // -------------------------------------------------------------------------
  // Find workspaces
  // -------------------------------------------------------------------------
  app.get<{ Querystring: { q?: string; status?: string; limit?: string; offset?: string } }>(
    "/tenants",
    { config: { minRole: "member" } },
    async (request, reply) => {
      const db: Db = request.server.db;
      const now = new Date();
      const q = (request.query.q ?? "").trim().slice(0, 100);
      const status = request.query.status ?? "all";
      if (!(LIST_STATUSES as readonly string[]).includes(status)) {
        return reply.status(400).send({ error: `status must be one of ${LIST_STATUSES.join(", ")}.` });
      }
      const limit = Math.min(100, Math.max(1, Number.parseInt(request.query.limit ?? "25", 10) || 25));
      const offset = Math.max(0, Number.parseInt(request.query.offset ?? "0", 10) || 0);

      const conds = [sql`TRUE`];
      if (q) {
        // Escape LIKE wildcards so a search for "50%" means 50%.
        const like = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
        conds.push(sql`(t.name ILIKE ${like} OR t.slug ILIKE ${like} OR EXISTS (
          SELECT 1 FROM users u WHERE u.tenant_id = t.id AND u.email ILIKE ${like}))`);
      }
      if (status === "trial") conds.push(sql`t.plan = ${TRIAL_PLAN_VALUE}`);
      if (status === "free") conds.push(sql`(t.plan = 'free' OR t.plan IS NULL)`);
      if (status === "paid") conds.push(sql`t.plan IN ('starter','growth','scale')`);
      if (status === "suspended") conds.push(sql`t.suspended_at IS NOT NULL`);
      const where = sql.join(conds, sql` AND `);

      const [rows, total] = await Promise.all([
        db.execute<TenantRow>(sql`${tenantSelect(startOfMonthUtc(now))} WHERE ${where}
          ORDER BY t.created_at DESC NULLS LAST, t.id LIMIT ${limit} OFFSET ${offset}`),
        db.execute<{ n: string }>(sql`SELECT count(*)::text AS n FROM tenants t WHERE ${where}`),
      ]);
      return {
        tenants: rows.rows.map((r) => shapeTenant(r, now)),
        total: Number(total.rows[0]?.n ?? 0),
        limit,
        offset,
      };
    },
  );

  // -------------------------------------------------------------------------
  // One workspace
  // -------------------------------------------------------------------------
  app.get<{ Params: { id: string } }>("/tenants/:id", { config: { minRole: "member" } }, async (request, reply) => {
    const db: Db = request.server.db;
    const now = new Date();
    const row = await loadTenant(db, request.params.id, now);
    if (!row) return reply.status(404).send({ error: "Workspace not found." });
    const id = row.id;

    const [usage, members, subs, events, audit, activity, aiUse, sendingRow] = await Promise.all([
      loadUsage(db, id, now),
      db.execute<{ id: string; email: string; name: string | null; role: string; last_login_at: Date | string | null; deactivated_at: Date | string | null }>(sql`
        SELECT id, email, name, role, last_login_at, deactivated_at FROM users
        WHERE tenant_id = ${id}::uuid ORDER BY created_at ASC`),
      db.execute<Record<string, string | number | boolean | Date | null>>(sql`
        SELECT plan, interval, amount_cents, currency, status, customer_email, current_period_end,
               cancel_at_period_end, last_payment_at, created_at
        FROM subscriptions WHERE tenant_id = ${id}::uuid ORDER BY created_at DESC LIMIT 10`),
      db.execute<{ event_type: string; outcome: string; created_at: Date | string }>(sql`
        SELECT event_type, outcome, created_at FROM billing_events
        WHERE tenant_id = ${id}::uuid ORDER BY created_at DESC LIMIT 20`),
      db.execute<{ actor_email: string; action: string; detail: unknown; created_at: Date | string }>(sql`
        SELECT actor_email, action, detail, created_at FROM admin_audit_log
        WHERE tenant_id = ${id}::uuid ORDER BY created_at DESC LIMIT 20`),
      db.execute<{ last_sent_at: Date | string | null; flows: string; transport: boolean }>(sql`
        SELECT (SELECT max(sent_at) FROM lifecycle_messages WHERE tenant_id = ${id}::uuid AND status = 'sent') AS last_sent_at,
               (SELECT count(*) FROM flows WHERE tenant_id = ${id}::uuid)::text AS flows,
               EXISTS (SELECT 1 FROM transport_configs WHERE tenant_id = ${id}::uuid AND is_active = true) AS transport`),
      // AI this month, split by where it was served from, and whether the workspace has its own key.
      db.execute<{ platform_tokens: string; byok_tokens: string; calls: string; own_key: boolean; cost_micros: string }>(sql`
        SELECT COALESCE(sum(total_tokens) FILTER (WHERE source = 'platform'), 0)::text AS platform_tokens,
               COALESCE(sum(cost_micros) FILTER (WHERE source = 'platform'), 0)::text AS cost_micros,
               COALESCE(sum(total_tokens) FILTER (WHERE source = 'byok'), 0)::text AS byok_tokens,
               count(*)::text AS calls,
               EXISTS (SELECT 1 FROM llm_configs WHERE tenant_id = ${id}::uuid AND is_active = true) AS own_key
        FROM llm_usage WHERE tenant_id = ${id}::uuid AND created_at >= ${startOfMonthUtc(now).toISOString()}::timestamptz`),
      loadSendingRow(db, id),
    ]);

    const act = activity.rows[0];
    return {
      workspace: shapeTenant(row, now),
      usage: {
        contacts: usage.contacts,
        emails_this_month: usage.emailsThisMonth,
        members: usage.members,
        pending_invites: usage.pendingInvites,
      },
      // Managed sending (through the operator's Resend): null when the workspace never turned it on.
      sending: sendingRow
        ? {
            enabled: sendingRow.enabled,
            domain: sendingRow.domain,
            domain_status: sendingRow.domainStatus,
            paused: sendingRow.pausedAt
              ? { at: sendingRow.pausedAt.toISOString(), reason: sendingRow.pausedReason, by: sendingRow.pausedBy }
              : null,
            warned_at: sendingRow.warnedAt?.toISOString() ?? null,
          }
        : null,
      ai: {
        // byok = the workspace's own key; platform = Mailforge AI (or nothing, if none is set up)
        source: aiUse.rows[0]?.own_key ? "byok" : "platform",
        platform_tokens_this_month: Number(aiUse.rows[0]?.platform_tokens ?? 0),
        byok_tokens_this_month: Number(aiUse.rows[0]?.byok_tokens ?? 0),
        calls_this_month: Number(aiUse.rows[0]?.calls ?? 0),
        // What this workspace's Mailforge AI use cost you this month.
        platform_cost_usd: Number(aiUse.rows[0]?.cost_micros ?? 0) / 1_000_000,
        // A hand-set allowance, or null when the plan's applies; -1 means no cap.
        allowance_override: row.ai_allowance_override,
        allowance_tokens: entitlementsFor({
          plan: row.plan,
          trialEndsAt: asDate(row.trial_ends_at),
          paidThrough: asDate(row.plan_paid_through),
          aiTokensOverride: row.ai_allowance_override,
          now,
          enforced: true,
        }).limits.aiTokensPerMonth,
      },
      activity: {
        last_email_sent_at: iso(act?.last_sent_at),
        flows: Number(act?.flows ?? 0),
        has_email_transport: act?.transport === true,
      },
      members: members.rows.map((m) => ({
        email: m.email,
        name: m.name,
        role: m.role,
        last_login_at: iso(m.last_login_at),
        deactivated: m.deactivated_at !== null,
      })),
      subscriptions: subs.rows.map((s) => ({
        plan: s.plan,
        interval: s.interval,
        amount_usd: Number(s.amount_cents) / 100,
        currency: s.currency,
        status: s.status,
        payer_email: s.customer_email,
        current_period_end: iso(s.current_period_end as Date | string),
        cancel_at_period_end: s.cancel_at_period_end === true,
        last_payment_at: iso(s.last_payment_at as Date | string | null),
        created_at: iso(s.created_at as Date | string),
      })),
      billing_events: events.rows.map((e) => ({ type: e.event_type, outcome: e.outcome, at: iso(e.created_at) })),
      audit: audit.rows.map((a) => ({ actor: a.actor_email, action: a.action, detail: a.detail, at: iso(a.created_at) })),
      billing_enabled: billing?.enabled === true,
    };
  });

  // -------------------------------------------------------------------------
  // Changes
  // -------------------------------------------------------------------------
  app.post<{ Params: { id: string }; Body: { plan?: unknown; reason?: unknown } }>(
    "/tenants/:id/plan",
    { config: { minRole: "member" } },
    async (request, reply) => {
      const db: Db = request.server.db;
      const now = new Date();
      const row = await loadTenant(db, request.params.id, now);
      if (!row) return reply.status(404).send({ error: "Workspace not found." });
      const plan = request.body?.plan;
      if (!isPlanId(plan)) return reply.status(400).send({ error: `plan must be one of ${PLAN_IDS.join(", ")}.`, code: "invalid_plan" });
      const reason = cleanReason(request.body?.reason);
      if (!reason) return needReason(reply);
      if (await liveSubscription(db, row.id)) {
        return reply.status(409).send({
          error: "This workspace has a live paid subscription, which would overwrite a hand-set plan at its next charge. Cancel the subscription first.",
          code: "has_subscription",
        });
      }
      const before = { plan: row.plan, trial_ends_at: iso(row.trial_ends_at), paid_through: iso(row.plan_paid_through) };
      await audited(db, request, "set_plan", row.id, { reason, before, after: { plan } }, async (tx) => {
        // Granted by hand: no paid-through date, so it never lapses. A running trial is replaced.
        await tx.update(tenants).set({ plan, trialEndsAt: null, planPaidThrough: null }).where(eq(tenants.id, row.id));
      });
      return { ok: true, workspace: shapeTenant((await loadTenant(db, row.id, now))!, now) };
    },
  );

  app.post<{ Params: { id: string }; Body: { tokens?: unknown; reason?: unknown } }>(
    "/tenants/:id/ai-allowance",
    { config: { minRole: "member" } },
    async (request, reply) => {
      const db: Db = request.server.db;
      const now = new Date();
      const row = await loadTenant(db, request.params.id, now);
      if (!row) return reply.status(404).send({ error: "Workspace not found." });
      // A whole number of tokens a month, "unlimited", or null to go back to the plan's allowance.
      const t = request.body?.tokens;
      let value: number | null;
      if (t === null) value = null;
      else if (t === "unlimited") value = -1;
      else if (typeof t === "number" && Number.isInteger(t) && t >= 0 && t <= MAX_AI_ALLOWANCE) value = t;
      else {
        return reply
          .status(400)
          .send({ error: `tokens must be a whole number from 0 to ${MAX_AI_ALLOWANCE.toLocaleString("en-US")}, "unlimited", or null for the plan's allowance.`, code: "invalid_tokens" });
      }
      const reason = cleanReason(request.body?.reason);
      if (!reason) return needReason(reply);
      const before = { ai_allowance_override: row.ai_allowance_override };
      await audited(db, request, "set_ai_allowance", row.id, { reason, before, after: { ai_allowance_override: value } }, async (tx) => {
        await tx.update(tenants).set({ aiAllowanceOverride: value }).where(eq(tenants.id, row.id));
      });
      return { ok: true, workspace: shapeTenant((await loadTenant(db, row.id, now))!, now) };
    },
  );

  // Pause or resume a workspace's managed sending (it keeps its settings; its mail waits, untouched).
  app.post<{ Params: { id: string }; Body: { action?: unknown; reason?: unknown } }>(
    "/tenants/:id/managed-sending",
    { config: { minRole: "member" } },
    async (request, reply) => {
      const db: Db = request.server.db;
      const now = new Date();
      const row = await loadTenant(db, request.params.id, now);
      if (!row) return reply.status(404).send({ error: "Workspace not found." });
      const action = request.body?.action;
      if (action !== "pause" && action !== "resume") {
        return reply.status(400).send({ error: 'action must be "pause" or "resume".', code: "invalid_action" });
      }
      const reason = cleanReason(request.body?.reason);
      if (!reason) return needReason(reply);
      const sending = await loadSendingRow(db, row.id);
      if (!sending) return reply.status(409).send({ error: "This workspace has not turned on managed sending.", code: "not_enabled" });
      if (action === "pause" && sending.pausedAt) return reply.status(409).send({ error: "Sending is already paused for this workspace.", code: "already_paused" });
      if (action === "resume" && !sending.pausedAt) return reply.status(409).send({ error: "Sending is not paused for this workspace.", code: "not_paused" });

      await audited(
        db,
        request,
        action === "pause" ? "managed_sending_pause" : "managed_sending_resume",
        row.id,
        { reason, before: { paused: sending.pausedAt !== null, paused_reason: sending.pausedReason, paused_by: sending.pausedBy } },
        async (tx) => {
          await tx
            .update(managedSending)
            .set(
              action === "pause"
                ? { pausedAt: now, pausedReason: reason, pausedBy: request.platformAdmin!.email, updatedAt: now }
                : { pausedAt: null, pausedReason: null, pausedBy: null, warnedAt: null, updatedAt: now },
            )
            .where(eq(managedSending.tenantId, row.id));
        },
      );
      // Tell the workspace's owners, best effort: the change is already made.
      const transport = opts.noticeTransports?.[0] ?? getPlatformTransport();
      const mail = action === "pause" ? buildSenderPausedEmail(row.name, [reason], false) : buildSenderResumedEmail(row.name);
      await mailEach(transport, await ownerEmails(db, row.id), mail, `managed-sending-${action}-${row.id}-${now.getTime()}`, request.log);
      return { ok: true };
    },
  );

  app.post<{ Params: { id: string }; Body: { days?: unknown; reason?: unknown } }>(
    "/tenants/:id/trial",
    { config: { minRole: "member" } },
    async (request, reply) => {
      const db: Db = request.server.db;
      const now = new Date();
      const row = await loadTenant(db, request.params.id, now);
      if (!row) return reply.status(404).send({ error: "Workspace not found." });
      const days = request.body?.days;
      if (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > MAX_TRIAL_DAYS) {
        return reply.status(400).send({ error: `days must be a whole number from 1 to ${MAX_TRIAL_DAYS}.`, code: "invalid_days" });
      }
      const reason = cleanReason(request.body?.reason);
      if (!reason) return needReason(reply);
      if (await liveSubscription(db, row.id)) {
        return reply.status(409).send({ error: "This workspace has a live paid subscription. Cancel it before giving a trial.", code: "has_subscription" });
      }
      // From now, not stacked on a running trial: "days" is the time left afterwards.
      const endsAt = new Date(now.getTime() + days * DAY);
      const before = { plan: row.plan, trial_ends_at: iso(row.trial_ends_at), paid_through: iso(row.plan_paid_through) };
      await audited(db, request, "extend_trial", row.id, { reason, before, after: { plan: TRIAL_PLAN_VALUE, trial_ends_at: endsAt.toISOString() } }, async (tx) => {
        await tx.update(tenants).set({ plan: TRIAL_PLAN_VALUE, trialEndsAt: endsAt, planPaidThrough: null }).where(eq(tenants.id, row.id));
      });
      return { ok: true, workspace: shapeTenant((await loadTenant(db, row.id, now))!, now) };
    },
  );

  app.post<{ Params: { id: string }; Body: { reason?: unknown } }>(
    "/tenants/:id/suspend",
    { config: { minRole: "member" } },
    async (request, reply) => {
      const db: Db = request.server.db;
      const now = new Date();
      const row = await loadTenant(db, request.params.id, now);
      if (!row) return reply.status(404).send({ error: "Workspace not found." });
      const reason = cleanReason(request.body?.reason);
      if (!reason) return needReason(reply);
      if (await adminBelongsTo(db, request.platformAdmin!.email, row.id)) {
        return reply.status(400).send({ error: "You cannot suspend your own workspace.", code: "own_workspace" });
      }
      if (row.suspended_at !== null) return reply.status(409).send({ error: "Already suspended.", code: "already_suspended" });
      await audited(db, request, "suspend", row.id, { reason }, async (tx) => {
        await tx.update(tenants).set({ suspendedAt: now, suspendedReason: reason }).where(eq(tenants.id, row.id));
      });
      return { ok: true, workspace: shapeTenant((await loadTenant(db, row.id, now))!, now) };
    },
  );

  app.post<{ Params: { id: string }; Body: { reason?: unknown } }>(
    "/tenants/:id/unsuspend",
    { config: { minRole: "member" } },
    async (request, reply) => {
      const db: Db = request.server.db;
      const now = new Date();
      const row = await loadTenant(db, request.params.id, now);
      if (!row) return reply.status(404).send({ error: "Workspace not found." });
      const reason = cleanReason(request.body?.reason);
      if (!reason) return needReason(reply);
      if (row.suspended_at === null) return reply.status(409).send({ error: "This workspace is not suspended.", code: "not_suspended" });
      await audited(db, request, "unsuspend", row.id, { reason, was_suspended_for: row.suspended_reason }, async (tx) => {
        await tx.update(tenants).set({ suspendedAt: null, suspendedReason: null }).where(eq(tenants.id, row.id));
      });
      return { ok: true, workspace: shapeTenant((await loadTenant(db, row.id, now))!, now) };
    },
  );

  app.post<{ Params: { id: string }; Body: { reason?: unknown } }>(
    "/tenants/:id/cancel-subscription",
    { config: { minRole: "member" } },
    async (request, reply) => {
      const db: Db = request.server.db;
      const now = new Date();
      const row = await loadTenant(db, request.params.id, now);
      if (!row) return reply.status(404).send({ error: "Workspace not found." });
      const reason = cleanReason(request.body?.reason);
      if (!reason) return needReason(reply);
      if (!billing?.enabled || !billing.client) {
        return reply.status(503).send({ error: "Online billing is not configured on this install.", code: "billing_disabled" });
      }
      try {
        const summary = await cancelSubscriptionForTenant(db, billing.client, row.id, now);
        await db.insert(adminAuditLog).values({
          actorUserId: request.platformAdmin!.id,
          actorEmail: request.platformAdmin!.email,
          action: "cancel_subscription",
          tenantId: row.id,
          detail: { reason, plan: summary.plan, plan_until: summary.currentPeriodEnd.toISOString() },
        });
        return { ok: true, workspace: shapeTenant((await loadTenant(db, row.id, now))!, now) };
      } catch (err) {
        if (err instanceof BillingError) return reply.status(err.httpStatus).send(err.toJSON());
        throw err;
      }
    },
  );

  // -------------------------------------------------------------------------
  // Data export and deletion
  // -------------------------------------------------------------------------
  app.get<{ Params: { id: string } }>("/tenants/:id/export", { config: { minRole: "member" } }, async (request, reply) => {
    const db: Db = request.server.db;
    const row = await loadTenant(db, request.params.id, new Date());
    if (!row) return reply.status(404).send({ error: "Workspace not found." });
    const exp = await openWorkspaceExport(db, row.id);
    if (!exp) return reply.status(404).send({ error: "Workspace not found." });
    await db.insert(adminAuditLog).values({
      actorUserId: request.platformAdmin!.id,
      actorEmail: request.platformAdmin!.email,
      action: "export_data",
      tenantId: row.id,
      detail: { reason: "Export downloaded from the admin console" },
    });
    reply
      .header("Content-Type", "application/json; charset=utf-8")
      .header("Content-Disposition", `attachment; filename="${exp.filename}"`)
      .header("Cache-Control", "no-store");
    return reply.send(Readable.from(exp.chunks));
  });

  /**
   * Delete a workspace. By default this schedules it (grace period, undoable). With
   * immediate: true it is erased now and cannot be undone. Either way the admin must
   * type the workspace slug, as a guard against the wrong row.
   */
  app.post<{ Params: { id: string }; Body: { confirm?: unknown; reason?: unknown; immediate?: unknown } }>(
    "/tenants/:id/delete",
    { config: { minRole: "member" } },
    async (request, reply) => {
      const db: Db = request.server.db;
      const now = new Date();
      const row = await loadTenant(db, request.params.id, now);
      if (!row) return reply.status(404).send({ error: "Workspace not found." });
      const reason = cleanReason(request.body?.reason);
      if (!reason) return needReason(reply);
      if (typeof request.body?.confirm !== "string" || request.body.confirm.trim() !== row.slug) {
        return reply.status(400).send({ error: "Type the workspace slug exactly to confirm.", code: "confirmation_mismatch" });
      }
      if (await adminBelongsTo(db, request.platformAdmin!.email, row.id)) {
        return reply.status(400).send({ error: "You cannot delete your own workspace.", code: "own_workspace" });
      }
      const immediate = request.body?.immediate === true;
      if (!immediate && row.deletion_scheduled_at !== null) {
        return reply.status(409).send({ error: "Deletion is already scheduled.", code: "already_scheduled" });
      }

      // Stop charging first, in both cases. If the provider fails nothing is deleted.
      try {
        const scheduledAt = immediate
          ? await scheduleDeletion(db, billing, { tenantId: row.id, requestedBy: request.platformAdmin!.email, now, graceDays: 1 })
          : await scheduleDeletion(db, billing, { tenantId: row.id, requestedBy: request.platformAdmin!.email, now });
        void scheduledAt;
      } catch (err) {
        if (err instanceof BillingError) return reply.status(502).send({ ...err.toJSON(), error: `Could not cancel the subscription, so nothing was deleted: ${err.message}` });
        throw err;
      }

      if (!immediate) {
        const [t] = await db.select({ s: tenants.deletionScheduledAt }).from(tenants).where(eq(tenants.id, row.id)).limit(1);
        await db.insert(adminAuditLog).values({
          actorUserId: request.platformAdmin!.id,
          actorEmail: request.platformAdmin!.email,
          action: "schedule_deletion",
          tenantId: row.id,
          detail: { reason, scheduled_at: t?.s?.toISOString() ?? null, grace_days: deletionGraceDays() },
        });
        if (t?.s) {
          await notifyDeletionScheduled(db, {
            tenantId: row.id,
            scheduledAt: t.s,
            requestedBy: request.platformAdmin!.email,
            byAdmin: true,
            dashboardUrl: opts.dashboardUrl ?? process.env.DASHBOARD_URL ?? "",
            log: request.log,
            transports: opts.noticeTransports,
          });
        }
        return { ok: true, deleted: false, workspace: shapeTenant((await loadTenant(db, row.id, now))!, now) };
      }

      // The erase destroys the owners, their email transport and the name. Capture them first.
      const noticeCtx = await loadNoticeContext(db, { tenantId: row.id, transports: opts.noticeTransports }).catch(() => null);
      const result = await purgeWorkspace(db, row.id, "admin_immediate");
      await db.insert(adminAuditLog).values({
        actorUserId: request.platformAdmin!.id,
        actorEmail: request.platformAdmin!.email,
        action: "delete_workspace",
        tenantId: null,
        detail: { reason, immediate: true, workspace_name: row.name, workspace_slug: row.slug, workspace_deleted: true, rows_erased: result?.rowCounts ?? {} },
      });
      if (result) {
        await notifyWorkspaceErased(noticeCtx, {
          erasedBy: request.platformAdmin!.email,
          supportEmail: process.env.MAILFORGE_SUPPORT_EMAIL?.trim() || null,
          log: request.log,
        });
      }
      return { ok: true, deleted: true };
    },
  );

  app.post<{ Params: { id: string }; Body: { reason?: unknown } }>(
    "/tenants/:id/cancel-deletion",
    { config: { minRole: "member" } },
    async (request, reply) => {
      const db: Db = request.server.db;
      const now = new Date();
      const row = await loadTenant(db, request.params.id, now);
      if (!row) return reply.status(404).send({ error: "Workspace not found." });
      const reason = cleanReason(request.body?.reason);
      if (!reason) return needReason(reply);
      if (row.deletion_scheduled_at === null) return reply.status(409).send({ error: "No deletion is scheduled.", code: "not_scheduled" });
      await audited(db, request, "cancel_deletion", row.id, { reason }, async (tx) => {
        await cancelDeletion(tx as unknown as Pick<Db, "execute">, row.id);
      });
      await notifyDeletionCancelled(db, {
        tenantId: row.id,
        requestedBy: request.platformAdmin!.email,
        byAdmin: true,
        dashboardUrl: opts.dashboardUrl ?? process.env.DASHBOARD_URL ?? "",
        log: request.log,
        transports: opts.noticeTransports,
      });
      return { ok: true, workspace: shapeTenant((await loadTenant(db, row.id, now))!, now) };
    },
  );

  // -------------------------------------------------------------------------
  // Audit trail
  // -------------------------------------------------------------------------
  app.get<{ Querystring: { tenant_id?: string; limit?: string } }>(
    "/audit",
    { config: { minRole: "member" } },
    async (request, reply) => {
      const db: Db = request.server.db;
      const limit = Math.min(200, Math.max(1, Number.parseInt(request.query.limit ?? "50", 10) || 50));
      const tenantId = request.query.tenant_id;
      if (tenantId !== undefined && !UUID_RE.test(tenantId)) return reply.status(400).send({ error: "tenant_id is not valid." });
      const r = await db.execute<{ actor_email: string; action: string; tenant_id: string | null; tenant_name: string | null; detail: unknown; created_at: Date | string }>(sql`
        SELECT a.actor_email, a.action, a.tenant_id, t.name AS tenant_name, a.detail, a.created_at
        FROM admin_audit_log a LEFT JOIN tenants t ON t.id = a.tenant_id
        ${tenantId ? sql`WHERE a.tenant_id = ${tenantId}::uuid` : sql``}
        ORDER BY a.created_at DESC LIMIT ${limit}`);
      return {
        entries: r.rows.map((e) => ({
          actor: e.actor_email,
          action: e.action,
          tenant_id: e.tenant_id,
          tenant_name: e.tenant_name,
          detail: e.detail,
          at: iso(e.created_at),
        })),
      };
    },
  );
};

export default adminRoutes;
