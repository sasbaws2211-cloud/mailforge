/**
 * Platform admin: the operator's own AI provider ("Mailforge AI").
 *
 *   GET  /v1/admin/ai                      both slots (never the key), this month's usage, heaviest workspaces
 *   PUT  /v1/admin/ai/:slot                set or change a provider (primary | fallback)
 *   POST /v1/admin/ai/:slot/enabled        kill switch: turn a slot off or on without losing its key
 *   POST /v1/admin/ai/:slot/test           make one tiny real call with the saved key
 *   POST /v1/admin/ai/:slot/remove         delete a slot and its key
 *
 * Registered inside the admin plugin, so the same gate applies: only platform
 * admins get in, everyone else sees a plain 404 (or 401 on the standalone console).
 *
 * Every change needs a written reason and is recorded in admin_audit_log in the
 * same transaction. The API key is encrypted at rest, never returned by any
 * route, and never written to the audit log.
 *
 * Customers on their own key never use these providers. Workspaces without one
 * use the primary, then the fallback if the primary fails, within their plan's
 * monthly token allowance.
 *
 * Mirror side: PUBLIC (packages/api is mirrored).
 */
import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { eq, sql } from "drizzle-orm";
import { MAX_AI_BUDGET_USD, PLATFORM_LLM_SLOTS, aiBudgetState, isPlatformLlmSlot, isValidAiBudgetUsd, isValidPriceUsdPerMtok, microsToUsd, startOfMonthUtc, type PlatformLlmSlot } from "@mailforge/core";
import { decrypt, encrypt, parseEncryptionKey } from "@mailforge/adapters";
import { adminAuditLog, platformLlmConfigs, platformSettings } from "@mailforge/db/schema";
import { AI_BUDGET_KEY, loadAiBudgetUsd } from "@mailforge/db/llm";
import type { Db } from "../plugins/db.js";
import { loadAiHealth } from "../ai/alerts.js";
import {
  KNOWN_LLM_PROVIDERS,
  isKnownLlmProvider,
  resolveLlmConfig,
  verifyLlmCredentials,
} from "../llm-providers.js";

const MAX_REASON = 300;

function cleanReason(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 && t.length <= MAX_REASON ? t : null;
}

const needReason = (reply: FastifyReply) =>
  reply.status(400).send({ error: `Give a reason (up to ${MAX_REASON} characters). It is kept in the audit log.`, code: "reason_required" });

interface StoredConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  embedding_model?: string;
  /** What the provider charges, US dollars per million tokens. Used to work out cost. */
  input_price?: number;
  output_price?: number;
}

/** The encryption key, or a reply explaining why there is none. */
function loadKey(reply: FastifyReply): Buffer | null {
  const env = process.env.ENCRYPTION_KEY;
  if (!env) {
    reply.status(503).send({ error: "ENCRYPTION_KEY is not configured. Set it before storing AI credentials.", code: "no_encryption_key" });
    return null;
  }
  try {
    return parseEncryptionKey(env);
  } catch (err) {
    reply.status(503).send({ error: `ENCRYPTION_KEY is invalid: ${err instanceof Error ? err.message : String(err)}`, code: "no_encryption_key" });
    return null;
  }
}

function readConfig(envelope: string, key: Buffer): StoredConfig | null {
  try {
    return JSON.parse(decrypt(envelope, key)) as StoredConfig;
  } catch {
    return null;
  }
}

const iso = (v: Date | string | null | undefined) => (v ? new Date(v).toISOString() : null);

const adminAiRoutes: FastifyPluginAsync = async (app) => {
  const slotParam = (reply: FastifyReply, slot: string): slot is PlatformLlmSlot => {
    if (isPlatformLlmSlot(slot)) return true;
    reply.status(400).send({ error: `slot must be one of ${PLATFORM_LLM_SLOTS.join(", ")}.`, code: "invalid_slot" });
    return false;
  };

  // -------------------------------------------------------------------------
  // Overview: providers and usage
  // -------------------------------------------------------------------------
  app.get("/ai", { config: { minRole: "member" } }, async (request) => {
    const db: Db = request.server.db;
    const now = new Date();
    const monthStart = startOfMonthUtc(now).toISOString();

    const rows = await db.select().from(platformLlmConfigs);
    const envKey = process.env.ENCRYPTION_KEY;
    let key: Buffer | null = null;
    if (envKey) {
      try {
        key = parseEncryptionKey(envKey);
      } catch {
        key = null;
      }
    }

    const providers = PLATFORM_LLM_SLOTS.map((slot) => {
      const row = rows.find((r) => r.slot === slot);
      if (!row) return { slot, configured: false as const };
      const cfg = key ? readConfig(row.config, key) : null;
      return {
        slot,
        configured: true as const,
        provider: row.provider,
        enabled: row.enabled,
        // Non-secret details; null if the stored key can no longer be decrypted.
        model: cfg?.model ?? null,
        base_url: cfg?.baseUrl ?? null,
        embedding_model: cfg?.embedding_model ?? null,
        input_price: cfg?.input_price ?? null,
        output_price: cfg?.output_price ?? null,
        readable: cfg !== null,
        updated_by: row.updatedBy,
        updated_at: iso(row.updatedAt),
      };
    });

    const [totals, byFeature, top, health, budgetUsd] = await Promise.all([
      db.execute<Record<string, string>>(sql`
        SELECT COALESCE(sum(total_tokens) FILTER (WHERE source = 'platform'), 0)::text AS platform_tokens,
               COALESCE(sum(total_tokens) FILTER (WHERE source = 'byok'), 0)::text AS byok_tokens,
               count(*) FILTER (WHERE source = 'platform')::text AS platform_calls,
               count(*) FILTER (WHERE source = 'platform' AND NOT ok)::text AS platform_failed,
               count(DISTINCT tenant_id) FILTER (WHERE source = 'platform')::text AS platform_workspaces,
               COALESCE(sum(cost_micros) FILTER (WHERE source = 'platform'), 0)::text AS platform_cost_micros
        FROM llm_usage WHERE created_at >= ${monthStart}::timestamptz`),
      db.execute<{ feature: string; tokens: string; calls: string; cost: string }>(sql`
        SELECT feature, COALESCE(sum(total_tokens), 0)::text AS tokens, count(*)::text AS calls,
               COALESCE(sum(cost_micros), 0)::text AS cost
        FROM llm_usage WHERE source = 'platform' AND created_at >= ${monthStart}::timestamptz
        GROUP BY feature ORDER BY sum(total_tokens) DESC`),
      db.execute<{ id: string; name: string; slug: string; plan: string | null; tokens: string; calls: string; failed: string; cost: string }>(sql`
        SELECT t.id, t.name, t.slug, t.plan,
               COALESCE(sum(u.total_tokens), 0)::text AS tokens,
               COALESCE(sum(u.cost_micros), 0)::text AS cost,
               count(*)::text AS calls,
               count(*) FILTER (WHERE NOT u.ok)::text AS failed
        FROM llm_usage u JOIN tenants t ON t.id = u.tenant_id
        WHERE u.source = 'platform' AND u.created_at >= ${monthStart}::timestamptz
        GROUP BY t.id, t.name, t.slug, t.plan
        ORDER BY sum(u.total_tokens) DESC, t.name ASC
        LIMIT 10`),
      loadAiHealth(db, now),
      loadAiBudgetUsd(db),
    ]);
    const t = totals.rows[0] ?? {};
    const n = (v: string | undefined) => Number(v ?? 0);
    const spentUsd = microsToUsd(n(t.platform_cost_micros));

    return {
      encryption_configured: key !== null,
      known_providers: KNOWN_LLM_PROVIDERS,
      providers,
      // At least one switched-on provider is what lets workspaces without their own key use AI.
      available: providers.some((p) => p.configured && p.enabled),
      // The monthly dollar budget: at 100% Mailforge AI pauses for every workspace on it (own-key workspaces carry on).
      budget: { monthly_usd: budgetUsd, spent_usd: spentUsd, state: aiBudgetState(budgetUsd, spentUsd), max_usd: MAX_AI_BUDGET_USD },
      // True when a switched-on provider has no prices, so the dollar figures below undercount.
      prices_missing: providers.some((p) => p.configured && p.enabled && (p.input_price === null || p.output_price === null)),
      // How the operator's provider has done in the last few minutes. Customers' own keys never count.
      health: {
        window_minutes: health.windowMinutes,
        calls: health.calls,
        failed: health.failed,
        rate: health.rate,
        unhealthy: health.unhealthy,
      },
      usage: {
        since: monthStart,
        platform_tokens: n(t.platform_tokens),
        platform_calls: n(t.platform_calls),
        platform_failed_calls: n(t.platform_failed),
        platform_workspaces: n(t.platform_workspaces),
        // What Mailforge AI cost you this month, from the prices set on each provider. Chat calls only:
        // knowledge-base embeddings are counted in tokens but not priced.
        platform_cost_usd: microsToUsd(n(t.platform_cost_micros)),
        // Tokens on customers' own keys: not our cost, shown so the picture is complete.
        byok_tokens: n(t.byok_tokens),
        by_feature: byFeature.rows.map((r) => ({ feature: r.feature, tokens: n(r.tokens), calls: n(r.calls), cost_usd: microsToUsd(n(r.cost)) })),
      },
      top_workspaces: top.rows.map((r) => ({
        id: r.id,
        name: r.name,
        slug: r.slug,
        plan: r.plan ?? "free",
        tokens: n(r.tokens),
        cost_usd: microsToUsd(n(r.cost)),
        calls: n(r.calls),
        failed_calls: n(r.failed),
      })),
    };
  });

  // -------------------------------------------------------------------------
  // Monthly dollar budget
  // -------------------------------------------------------------------------
  app.put<{ Body: { monthly_usd?: unknown; reason?: unknown } }>("/ai/budget", { config: { minRole: "member" } }, async (request, reply) => {
    const db: Db = request.server.db;
    const v = request.body?.monthly_usd;
    if (v !== null && !isValidAiBudgetUsd(v)) {
      return reply
        .status(400)
        .send({ error: `monthly_usd must be a positive number up to ${MAX_AI_BUDGET_USD.toLocaleString("en-US")}, or null to remove the budget.`, code: "invalid_budget" });
    }
    const reason = cleanReason(request.body?.reason);
    if (!reason) return needReason(reply);
    const before = await loadAiBudgetUsd(db);
    await db.transaction(async (tx) => {
      if (v === null) {
        await tx.delete(platformSettings).where(eq(platformSettings.key, AI_BUDGET_KEY));
      } else {
        const value = { monthly_usd: v };
        await tx
          .insert(platformSettings)
          .values({ key: AI_BUDGET_KEY, value, updatedBy: request.platformAdmin!.email })
          .onConflictDoUpdate({ target: platformSettings.key, set: { value, updatedBy: request.platformAdmin!.email, updatedAt: new Date() } });
      }
      await tx.insert(adminAuditLog).values({
        actorUserId: request.platformAdmin!.id,
        actorEmail: request.platformAdmin!.email,
        action: v === null ? "ai_budget_clear" : "ai_budget_set",
        tenantId: null,
        detail: { reason, before: { monthly_usd: before }, after: { monthly_usd: v } },
      });
    });
    return { ok: true, monthly_usd: v };
  });

  // -------------------------------------------------------------------------
  // Set or change a provider
  // -------------------------------------------------------------------------
  app.put<{
    Params: { slot: string };
    Body: { provider?: unknown; api_key?: unknown; base_url?: unknown; model?: unknown; embedding_model?: unknown; input_price?: unknown; output_price?: unknown; reason?: unknown };
  }>("/ai/:slot", { config: { minRole: "member" } }, async (request, reply) => {
    const db: Db = request.server.db;
    const { slot } = request.params;
    if (!slotParam(reply, slot)) return;
    const body = request.body ?? {};
    const reason = cleanReason(body.reason);
    if (!reason) return needReason(reply);

    const provider = typeof body.provider === "string" ? body.provider : "";
    if (!isKnownLlmProvider(provider)) {
      return reply.status(400).send({ error: `provider must be one of ${KNOWN_LLM_PROVIDERS.join(", ")}.`, code: "invalid_provider" });
    }
    const str = (v: unknown) => (typeof v === "string" ? v : undefined);
    const key = loadKey(reply);
    if (!key) return;

    // Leaving the key blank keeps the one already saved for this slot (so the model can be
    // changed without pasting the key again), but only when the provider is unchanged.
    const [existing] = await db.select().from(platformLlmConfigs).where(eq(platformLlmConfigs.slot, slot)).limit(1);
    let apiKey = str(body.api_key)?.trim() ?? "";
    const kept = existing && existing.provider === provider ? readConfig(existing.config, key) : null;
    if (apiKey === "" && kept) apiKey = kept.apiKey ?? "";

    // Prices (US dollars per million tokens): left out keeps the saved ones for the same provider, null clears them.
    const priceOf = (v: unknown, saved: number | undefined): number | undefined | "invalid" => {
      if (v === undefined) return saved;
      if (v === null || v === "") return undefined;
      const num = typeof v === "number" ? v : Number(v);
      return isValidPriceUsdPerMtok(num) ? num : "invalid";
    };
    const inputPrice = priceOf(body.input_price, kept?.input_price);
    const outputPrice = priceOf(body.output_price, kept?.output_price);
    if (inputPrice === "invalid" || outputPrice === "invalid") {
      return reply.status(400).send({ error: "Prices are dollars per million tokens: a number from 0 to 1000.", code: "invalid_price" });
    }

    const resolved = resolveLlmConfig(provider, {
      apiKey,
      baseUrl: str(body.base_url),
      model: str(body.model),
      embeddingModel: str(body.embedding_model),
    });
    if (!resolved.ok) return reply.status(400).send({ error: resolved.error, code: "invalid_config" });
    const eff = resolved.config;

    // Check the key with a real call before saving: a bad key here would break AI for every customer.
    const verification = await verifyLlmCredentials({ baseUrl: eff.baseUrl, apiKey: eff.apiKey, model: eff.model });
    if (!verification.ok) {
      const said = verification.detail !== "" ? `: ${verification.detail}` : "";
      const what =
        verification.kind === "http"
          ? `${eff.baseUrl} rejected the credentials (HTTP ${verification.status})`
          : verification.kind === "timeout"
            ? `${eff.baseUrl} did not answer within 10 seconds`
            : `${eff.baseUrl} could not be reached`;
      return reply.status(422).send({ error: `${what}${said}. Nothing was saved.`, code: "verification_failed" });
    }

    const stored: StoredConfig = { apiKey: eff.apiKey, baseUrl: eff.baseUrl, model: eff.model };
    if (eff.embeddingModel !== null) stored.embedding_model = eff.embeddingModel;
    if (inputPrice !== undefined) stored.input_price = inputPrice;
    if (outputPrice !== undefined) stored.output_price = outputPrice;
    const envelope = encrypt(JSON.stringify(stored), key);
    const now = new Date();

    await db.transaction(async (tx) => {
      await tx
        .insert(platformLlmConfigs)
        .values({ slot, provider, config: envelope, enabled: true, updatedBy: request.platformAdmin!.email })
        .onConflictDoUpdate({
          target: platformLlmConfigs.slot,
          set: { provider, config: envelope, enabled: true, updatedBy: request.platformAdmin!.email, updatedAt: now },
        });
      await tx.insert(adminAuditLog).values({
        actorUserId: request.platformAdmin!.id,
        actorEmail: request.platformAdmin!.email,
        action: existing ? "ai_provider_change" : "ai_provider_set",
        tenantId: null,
        // Never the key.
        detail: { reason, slot, provider, model: eff.model, base_url: eff.baseUrl, input_price: inputPrice ?? null, output_price: outputPrice ?? null, before: existing ? { provider: existing.provider, enabled: existing.enabled } : null },
      });
    });
    return { ok: true, slot, provider, model: eff.model, base_url: eff.baseUrl, embedding_model: eff.embeddingModel, input_price: inputPrice ?? null, output_price: outputPrice ?? null, enabled: true };
  });

  // -------------------------------------------------------------------------
  // Kill switch
  // -------------------------------------------------------------------------
  app.post<{ Params: { slot: string }; Body: { enabled?: unknown; reason?: unknown } }>(
    "/ai/:slot/enabled",
    { config: { minRole: "member" } },
    async (request, reply) => {
      const db: Db = request.server.db;
      const { slot } = request.params;
      if (!slotParam(reply, slot)) return;
      const enabled = request.body?.enabled;
      if (typeof enabled !== "boolean") return reply.status(400).send({ error: "enabled must be true or false.", code: "invalid_enabled" });
      const reason = cleanReason(request.body?.reason);
      if (!reason) return needReason(reply);
      const [row] = await db.select().from(platformLlmConfigs).where(eq(platformLlmConfigs.slot, slot)).limit(1);
      if (!row) return reply.status(404).send({ error: "That slot has no provider.", code: "not_configured" });
      await db.transaction(async (tx) => {
        await tx.update(platformLlmConfigs).set({ enabled, updatedBy: request.platformAdmin!.email, updatedAt: new Date() }).where(eq(platformLlmConfigs.slot, slot));
        await tx.insert(adminAuditLog).values({
          actorUserId: request.platformAdmin!.id,
          actorEmail: request.platformAdmin!.email,
          action: enabled ? "ai_provider_enable" : "ai_provider_disable",
          tenantId: null,
          detail: { reason, slot, provider: row.provider, before: { enabled: row.enabled }, after: { enabled } },
        });
      });
      return { ok: true, slot, enabled };
    },
  );

  // -------------------------------------------------------------------------
  // Test the saved key
  // -------------------------------------------------------------------------
  app.post<{ Params: { slot: string } }>("/ai/:slot/test", { config: { minRole: "member" } }, async (request, reply) => {
    const db: Db = request.server.db;
    const { slot } = request.params;
    if (!slotParam(reply, slot)) return;
    const key = loadKey(reply);
    if (!key) return;
    const [row] = await db.select().from(platformLlmConfigs).where(eq(platformLlmConfigs.slot, slot)).limit(1);
    if (!row) return reply.status(404).send({ error: "That slot has no provider.", code: "not_configured" });
    const cfg = readConfig(row.config, key);
    if (!cfg) {
      return reply.status(422).send({ ok: false, error: "The saved key cannot be read (the encryption key changed). Save the provider again.", code: "unreadable" });
    }
    const result = await verifyLlmCredentials({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model });
    if (result.ok) return { ok: true };
    return { ok: false, kind: result.kind, status: result.status, detail: result.detail };
  });

  // -------------------------------------------------------------------------
  // Remove
  // -------------------------------------------------------------------------
  app.post<{ Params: { slot: string }; Body: { reason?: unknown } }>(
    "/ai/:slot/remove",
    { config: { minRole: "member" } },
    async (request, reply) => {
      const db: Db = request.server.db;
      const { slot } = request.params;
      if (!slotParam(reply, slot)) return;
      const reason = cleanReason(request.body?.reason);
      if (!reason) return needReason(reply);
      const [row] = await db.select().from(platformLlmConfigs).where(eq(platformLlmConfigs.slot, slot)).limit(1);
      if (!row) return reply.status(404).send({ error: "That slot has no provider.", code: "not_configured" });
      await db.transaction(async (tx) => {
        await tx.delete(platformLlmConfigs).where(eq(platformLlmConfigs.slot, slot));
        await tx.insert(adminAuditLog).values({
          actorUserId: request.platformAdmin!.id,
          actorEmail: request.platformAdmin!.email,
          action: "ai_provider_remove",
          tenantId: null,
          detail: { reason, slot, provider: row.provider, was_enabled: row.enabled },
        });
      });
      return { ok: true, slot };
    },
  );
};

export default adminAiRoutes;
