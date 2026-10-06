/**
 * Managed sending, for the workspace owner: let Mailforge send the workspace's email
 * through the operator's Resend account, optionally from the workspace's own domain.
 *
 *   GET    /v1/sending                  where things stand (and re-checks a domain that is still verifying)
 *   POST   /v1/sending/enable           turn managed sending on        (owner)
 *   DELETE /v1/sending                  turn it off                    (owner)
 *   PATCH  /v1/sending                  from-name, from-address start, reply-to   (owner)
 *   PUT    /v1/sending/domain           set the sending domain: returns the DNS records to create   (owner)
 *   POST   /v1/sending/domain/verify    ask Resend to check the DNS records now   (owner)
 *   DELETE /v1/sending/domain           remove the domain (back to the shared address)   (owner)
 *
 * A workspace with a transport of its own uses that instead; managed sending waits. Until a
 * domain is verified, mail goes from the operator's shared address (if one is offered) at a low
 * daily volume, with the workspace's brand as the sender name and its own address as Reply-To.
 *
 * Mirror side: PUBLIC (packages/api is mirrored).
 */
import type { FastifyPluginAsync } from "fastify";
import { sql, eq } from "drizzle-orm";
import {
  isValidReplyAddress,
  managedSendingConfigFromEnv,
  sanitizeDisplayName,
  validateFromLocalPart,
  validateSendingDomain,
} from "@mailforge/core";
import { managedSending } from "@mailforge/db/schema";
import type { Db } from "../plugins/db.js";
import { domainsClientFromEnv, loadSendingRow, senderFor, type SendingRow } from "../sending/context.js";
import { applyDomainState, refreshDomainIfDue, removeResendDomain } from "../sending/domains.js";

/** Domain changes per workspace per hour (in memory, per process). Resend's own limits are low, and it stops churn. */
const DOMAIN_CHANGES_PER_HOUR = 6;
const domainChanges = new Map<string, number[]>();

function tooManyDomainChanges(tenantId: string, now = Date.now()): boolean {
  const recent = (domainChanges.get(tenantId) ?? []).filter((t) => now - t < 3_600_000);
  if (recent.length >= DOMAIN_CHANGES_PER_HOUR) {
    domainChanges.set(tenantId, recent);
    return true;
  }
  recent.push(now);
  domainChanges.set(tenantId, recent);
  return false;
}

/** The operator's own domains, which no customer may claim. */
function platformDomains(env: NodeJS.ProcessEnv, sharedFrom: string | null): string[] {
  const hosts = [env.BASE_URL, env.MAILFORGE_SITE_URL, env.MAILFORGE_ADMIN_URL, env.DASHBOARD_URL].map((u) => {
    try {
      return u ? new URL(u).hostname : "";
    } catch {
      return "";
    }
  });
  const mails = [env.PLATFORM_FROM_EMAIL, sharedFrom, env.MAILFORGE_SUPPORT_EMAIL].map((a) => (a && a.includes("@") ? a.split("@")[1]! : ""));
  const own = [...hosts, ...mails].map((h) => h.trim().toLowerCase()).filter((h) => h !== "" && h !== "localhost");
  // The operator owns the parent of any subdomain it uses (mail.example.com -> example.com), so that is off limits too.
  const parents = own.filter((h) => h.split(".").length >= 3).map((h) => h.split(".").slice(1).join("."));
  return [...new Set([...own, ...parents])];
}

const NOT_OFFERED = { error: "Mailforge Sending is not available on this service.", code: "managed_unavailable" };

const routes: FastifyPluginAsync = async (app) => {
  const env = process.env;

  async function hasOwnTransport(db: Db, tenantId: string): Promise<boolean> {
    const r = await db.execute<{ n: string }>(sql`SELECT count(*)::text AS n FROM transport_configs WHERE tenant_id = ${tenantId}::uuid AND is_active = true`);
    return Number(r.rows[0]?.n ?? 0) > 0;
  }

  /** Everything the dashboard needs, in one answer. */
  async function view(db: Db, tenantId: string) {
    const cfg = managedSendingConfigFromEnv(env);
    const row = await loadSendingRow(db, tenantId);
    const own = await hasOwnTransport(db, tenantId);
    const sender = row ? senderFor(row, cfg) : null;
    const active = cfg.enabled && row !== null && row.enabled && row.pausedAt === null && sender?.ok === true;
    return {
      // Is managed sending offered on this service at all?
      available: cfg.enabled,
      // What mail goes out through: the workspace's own transport wins, then managed sending.
      uses: own ? "own_transport" : active ? "managed" : "nothing",
      shared: { offered: cfg.sharedFrom !== null, daily_limit: cfg.sharedFrom ? cfg.sharedDailyLimit : null },
      managed: row
        ? {
            enabled: row.enabled,
            domain: row.domain,
            domain_status: row.domainStatus,
            dns_records: row.dnsRecords ?? [],
            domain_verified_at: row.domainVerifiedAt?.toISOString() ?? null,
            from_local: row.fromLocal,
            from_name: row.fromName,
            reply_to: row.replyTo,
            // Who mail would be sent as right now. The shared address is shown only as "shared".
            sender: sender && sender.ok ? { mode: sender.mode, from_email: sender.mode === "shared" ? null : sender.fromEmail, from_name: sender.fromName, reply_to: sender.replyTo } : null,
            // Why it is not sending, in the workspace's terms. Never says who paused it or the exact numbers.
            paused: row.pausedAt ? { at: row.pausedAt.toISOString(), reason: row.pausedReason, automatic: row.pausedBy === "auto" } : null,
            needs_domain: sender !== null && !sender.ok,
          }
        : null,
    };
  }

  // ---------------------------------------------------------------------------
  app.get("/", { config: { minRole: "member" } }, async (request) => {
    const db: Db = request.server.db;
    const tenantId = request.tenant!.id;
    const client = domainsClientFromEnv(env);
    const row = await loadSendingRow(db, tenantId);
    // A domain that is still verifying is re-read from Resend as the page is opened, so a customer who
    // just added the DNS records sees it turn green without pressing anything.
    if (client && row) await refreshDomainIfDue(db, client, row);
    return view(db, tenantId);
  });

  // ---------------------------------------------------------------------------
  app.post("/enable", { config: { minRole: "owner" as const } }, async (request, reply) => {
    const db: Db = request.server.db;
    const tenantId = request.tenant!.id;
    if (!managedSendingConfigFromEnv(env).enabled) return reply.status(503).send(NOT_OFFERED);
    await db
      .insert(managedSending)
      .values({ tenantId })
      .onConflictDoUpdate({ target: managedSending.tenantId, set: { enabled: true, updatedAt: new Date() } });
    return view(db, tenantId);
  });

  app.delete("/", { config: { minRole: "owner" as const } }, async (request) => {
    const db: Db = request.server.db;
    const tenantId = request.tenant!.id;
    await db.update(managedSending).set({ enabled: false, updatedAt: new Date() }).where(eq(managedSending.tenantId, tenantId));
    return view(db, tenantId);
  });

  // ---------------------------------------------------------------------------
  app.patch<{ Body: { from_local?: unknown; from_name?: unknown; reply_to?: unknown } }>(
    "/",
    { config: { minRole: "owner" as const } },
    async (request, reply) => {
      const db: Db = request.server.db;
      const tenantId = request.tenant!.id;
      const row = await loadSendingRow(db, tenantId);
      if (!row) return reply.status(409).send({ error: "Turn on Mailforge Sending first.", code: "not_enabled" });
      const b = request.body ?? {};
      const set: Partial<typeof managedSending.$inferInsert> = { updatedAt: new Date() };

      if (b.from_local !== undefined) {
        const v = validateFromLocalPart(b.from_local);
        if (!v.ok) return reply.status(400).send({ error: v.error, code: "invalid_from_local" });
        set.fromLocal = v.local;
      }
      if (b.from_name !== undefined) {
        if (b.from_name === null || b.from_name === "") set.fromName = null;
        else {
          const name = sanitizeDisplayName(b.from_name);
          if (!name) return reply.status(400).send({ error: "Enter a sender name, for example your company name.", code: "invalid_from_name" });
          set.fromName = name;
        }
      }
      if (b.reply_to !== undefined) {
        if (b.reply_to === null || b.reply_to === "") set.replyTo = null;
        else if (typeof b.reply_to === "string" && isValidReplyAddress(b.reply_to.trim())) set.replyTo = b.reply_to.trim();
        else return reply.status(400).send({ error: "Enter a single email address for replies.", code: "invalid_reply_to" });
      }
      await db.update(managedSending).set(set).where(eq(managedSending.tenantId, tenantId));
      return view(db, tenantId);
    },
  );

  // ---------------------------------------------------------------------------
  app.put<{ Body: { domain?: unknown; from_local?: unknown } }>("/domain", { config: { minRole: "owner" as const } }, async (request, reply) => {
    const db: Db = request.server.db;
    const tenantId = request.tenant!.id;
    const cfg = managedSendingConfigFromEnv(env);
    const client = domainsClientFromEnv(env);
    if (!cfg.enabled || !client) return reply.status(503).send(NOT_OFFERED);

    const checked = validateSendingDomain(request.body?.domain, platformDomains(env, cfg.sharedFrom));
    if (!checked.ok) return reply.status(400).send({ error: checked.error, code: "invalid_domain" });
    let fromLocal: string | undefined;
    if (request.body?.from_local !== undefined) {
      const l = validateFromLocalPart(request.body.from_local);
      if (!l.ok) return reply.status(400).send({ error: l.error, code: "invalid_from_local" });
      fromLocal = l.local;
    }

    const existing = await loadSendingRow(db, tenantId);
    if (existing?.pausedAt) {
      return reply.status(409).send({ error: "Sending is paused for this workspace. Contact support before changing the domain.", code: "paused" });
    }
    if (existing?.domain === checked.domain) {
      if (fromLocal) await db.update(managedSending).set({ fromLocal, updatedAt: new Date() }).where(eq(managedSending.tenantId, tenantId));
      return view(db, tenantId); // already set: nothing to create
    }

    // Another workspace already has it (a domain exists once in the operator's Resend account).
    const taken = await db.execute<{ tenant_id: string }>(sql`SELECT tenant_id FROM managed_sending WHERE lower(domain) = ${checked.domain} LIMIT 1`);
    if (taken.rows.length > 0) {
      return reply.status(409).send({ error: "That domain is already connected to another workspace. If it is yours, contact support.", code: "domain_taken" });
    }
    if (tooManyDomainChanges(tenantId)) {
      return reply.status(429).send({ error: "You have changed the domain several times in the last hour. Try again later.", code: "too_many_changes" });
    }

    const created = await client.createDomain(checked.domain);
    if (!created.ok) {
      request.log.warn({ tenantId, kind: created.kind, status: created.status }, "Resend createDomain failed");
      if (created.kind === "exists") {
        return reply.status(409).send({ error: "That domain is already connected to another workspace. If it is yours, contact support.", code: "domain_taken" });
      }
      if (created.kind === "invalid") return reply.status(400).send({ error: created.message, code: "invalid_domain" });
      if (created.kind === "rate_limited") return reply.status(429).send({ error: created.message, code: "rate_limited" });
      // Our own credentials or Resend being down: not the customer's doing and not theirs to fix.
      return reply.status(502).send({ error: "Mailforge Sending could not set up that domain right now. Try again shortly.", code: "sending_unavailable" });
    }

    const oldId = existing?.resendDomainId ?? null;
    const oldDomain = existing?.domain ?? null;
    const now = new Date();
    try {
      await db
        .insert(managedSending)
        .values({
          tenantId,
          domain: checked.domain,
          resendDomainId: created.value.id,
          domainStatus: created.value.status,
          dnsRecords: created.value.records,
          domainAddedAt: now,
          domainCheckedAt: now,
          ...(fromLocal ? { fromLocal } : {}),
        })
        .onConflictDoUpdate({
          target: managedSending.tenantId,
          set: {
            enabled: true,
            domain: checked.domain,
            resendDomainId: created.value.id,
            domainStatus: created.value.status,
            dnsRecords: created.value.records,
            domainAddedAt: now,
            domainVerifiedAt: null,
            domainCheckedAt: now,
            ...(fromLocal ? { fromLocal } : {}),
            updatedAt: now,
          },
        });
    } catch (err) {
      // Lost a race for the same domain: take back what we just created at Resend.
      await removeResendDomain(db, client, created.value.id, checked.domain);
      if ((err as { code?: string }).code === "23505") {
        return reply.status(409).send({ error: "That domain is already connected to another workspace. If it is yours, contact support.", code: "domain_taken" });
      }
      throw err;
    }
    // The domain this workspace had before is no longer used.
    if (oldId) await removeResendDomain(db, client, oldId, oldDomain);
    return view(db, tenantId);
  });

  // ---------------------------------------------------------------------------
  app.post("/domain/verify", { config: { minRole: "owner" as const } }, async (request, reply) => {
    const db: Db = request.server.db;
    const tenantId = request.tenant!.id;
    const client = domainsClientFromEnv(env);
    if (!client) return reply.status(503).send(NOT_OFFERED);
    const row = await loadSendingRow(db, tenantId);
    if (!row?.resendDomainId) return reply.status(409).send({ error: "Add a domain first.", code: "no_domain" });
    if (tooManyDomainChanges(`verify:${tenantId}`)) {
      return reply.status(429).send({ error: "You have asked to verify several times in the last hour. DNS changes can take a while: try again later.", code: "too_many_checks" });
    }
    const started = await client.verifyDomain(row.resendDomainId);
    if (!started.ok && started.kind !== "not_found") {
      request.log.warn({ tenantId, kind: started.kind }, "Resend verifyDomain failed");
      return reply.status(502).send({ error: "Mailforge Sending could not check that domain right now. Try again shortly.", code: "sending_unavailable" });
    }
    // Verification is asynchronous at Resend: read back what it says now (usually still "pending").
    const now = await client.getDomain(row.resendDomainId);
    if (now.ok) await applyDomainState(db, tenantId, now.value);
    return view(db, tenantId);
  });

  app.delete("/domain", { config: { minRole: "owner" as const } }, async (request) => {
    const db: Db = request.server.db;
    const tenantId = request.tenant!.id;
    const row = await loadSendingRow(db, tenantId);
    if (row?.resendDomainId) await removeResendDomain(db, domainsClientFromEnv(env), row.resendDomainId, row.domain);
    if (row) {
      await db
        .update(managedSending)
        .set({ domain: null, resendDomainId: null, domainStatus: "none", dnsRecords: null, domainVerifiedAt: null, domainAddedAt: null, domainCheckedAt: null, updatedAt: new Date() })
        .where(eq(managedSending.tenantId, tenantId));
    }
    return view(db, tenantId);
  });
};

export default routes;
export type { SendingRow };
