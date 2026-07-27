/**
 * Settings routes - transport configuration, LLM configuration, and tenant settings.
 *
 * All routes require session-cookie authentication (dashboard operator scope).
 * Registered under the /v1 prefix inside the authenticated scope.
 *
 * Transport endpoints:
 *   PUT  /v1/settings/transport
 *     Write or replace the active transport configuration for the calling tenant.
 *     Encrypts the credential and webhook secret with the envelope from
 *     @claros/adapters before storing. Deactivates any previous active row
 *     for this tenant in the same operation (upsert via deactivate + insert).
 *     Body: { provider, from_email, from_name?, api_key, webhook_secret?, daily_limit? }
 *
 *   GET  /v1/settings/transport
 *     Read the active transport configuration. Never returns api_key or
 *     webhook_secret in any form.
 *     Response: { id, provider, from_email, from_name, daily_limit,
 *                 dkim_verified, is_active, created_at } or null.
 *
 * LLM endpoints:
 *   PUT  /v1/settings/llm
 *     Write or replace the active LLM provider configuration for the calling tenant.
 *     Encrypts api_key, base_url, model (and optional embedding_model) with the
 *     same envelope as transport. Deactivates any previous active row for this
 *     tenant (deactivate + insert pattern, same as transport).
 *     Body: { provider, api_key, base_url, model, embedding_model? }
 *
 *   GET  /v1/settings/llm
 *     Read the active LLM configuration. Never returns api_key in any form.
 *     Response: { id, provider, is_active, created_at } or null.
 *     Note: base_url, model, and embedding_model are also credentials in the
 *     sense that they identify which provider and endpoint is in use; they are
 *     not returned here to keep the "never decrypt on read" invariant.
 *
 * Tenant settings endpoints:
 *   GET  /v1/settings/tenant
 *     Read current tenant settings (name, slug, plan, postal_address).
 *
 *   PATCH /v1/settings/tenant
 *     Update tenant settings. Currently supports postal_address.
 *     Other keys in tenants.settings (lifecycle, throttle, brain_context)
 *     are managed by the templates and future routes; this endpoint merges
 *     only the fields it owns to prevent clobbering template-applied settings.
 *     Body: { postal_address? }
 *
 * Encryption pattern:
 *   Follows the same convention as provider-resolver.ts / transport-resolver.ts.
 *   ENCRYPTION_KEY env var -> parseEncryptionKey -> encrypt(JSON.stringify(creds), key).
 *   On read: credentials are decrypted at use time only (resolver). This endpoint
 *   never decrypts on read - it returns only non-sensitive metadata columns.
 *
 *   [impl] Per-tenant credentials (LLM and transport API keys) live encrypted in the
 *   database. Only process-level keys stay in the environment: ENCRYPTION_KEY (decrypts
 *   the database) and UNSUBSCRIBE_SIGNING_KEY (belongs to the installation). No per-tenant
 *   credential should ever be in an environment variable.
 *
 * Provider validation:
 *   The KNOWN_PROVIDERS list matches what transport-resolver.ts implements or
 *   explicitly acknowledges. Storing an unimplemented provider is allowed because
 *   the resolver documents the safe fallback: null return, messages stay approved,
 *   no operator action required when the provider ships. Validation only rejects
 *   values that are clearly not a known provider identifier.
 *
 * Mirror side: PUBLIC (packages/api is mirrored).
 */
import type { FastifyPluginAsync } from "fastify";
import { eq, and, sql } from "drizzle-orm";
import { encrypt, parseEncryptionKey } from "@claros/adapters";
import { transportConfigs, llmConfigs, tenants } from "@claros/db/schema";
import type { Db } from "../plugins/db.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Known provider identifiers. "resend" is implemented. "ses" and "smtp" are
 * documented in transport-resolver.ts as pending - storing them is allowed;
 * the resolver returns null with a logged warning and messages stay approved.
 */
const KNOWN_PROVIDERS = ["resend", "ses", "smtp"] as const;
type KnownProvider = (typeof KNOWN_PROVIDERS)[number];

function isKnownProvider(v: string): v is KnownProvider {
  return (KNOWN_PROVIDERS as readonly string[]).includes(v);
}

/**
 * Known LLM provider identifiers. All use the OpenAI-compatible API shape.
 * "custom" is for any OpenAI-compatible endpoint not listed here.
 */
const KNOWN_LLM_PROVIDERS = ["openai", "anthropic", "ollama", "custom"] as const;
type KnownLlmProvider = (typeof KNOWN_LLM_PROVIDERS)[number];

function isKnownLlmProvider(v: string): v is KnownLlmProvider {
  return (KNOWN_LLM_PROVIDERS as readonly string[]).includes(v);
}

// ---------------------------------------------------------------------------
// Route plugin
// ---------------------------------------------------------------------------

const settingsRoutes: FastifyPluginAsync = async (app) => {
  // -------------------------------------------------------------------------
  // PUT /v1/settings/transport
  // -------------------------------------------------------------------------

  /**
   * PUT /v1/settings/transport
   * Write or replace the active transport configuration.
   *
   * Encryption requires ENCRYPTION_KEY to be set. Returns 503 if absent.
   * Returns 400 for unknown provider or missing required fields.
   *
   * The operation is: deactivate all existing active rows for this tenant,
   * then insert a fresh row. This keeps a history of previous configs
   * (is_active = false) while ensuring only one active row per tenant.
   */
  app.put<{
    Body: {
      provider: string;
      from_email: string;
      from_name?: string;
      api_key: string;
      webhook_secret?: string;
      daily_limit?: number;
    };
  }>(
    "/transport",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            provider: { type: "string" },
            from_email: { type: "string", format: "email" },
            from_name: { type: "string" },
            api_key: { type: "string", minLength: 1 },
            webhook_secret: { type: "string" },
            daily_limit: { type: "integer", minimum: 1 },
          },
          required: ["provider", "from_email", "api_key"],
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const db: Db = request.server.db;
      const tenantId = request.tenant!.id;
      const { provider, from_email, from_name, api_key, webhook_secret, daily_limit } =
        request.body;

      // Validate provider
      if (!isKnownProvider(provider)) {
        reply.status(400);
        return {
          error: `Unknown provider: "${provider}". Valid values: ${KNOWN_PROVIDERS.join(", ")}.`,
        };
      }

      // Require ENCRYPTION_KEY
      const encryptionKeyEnv = process.env.ENCRYPTION_KEY;
      if (!encryptionKeyEnv) {
        reply.status(503);
        return {
          error:
            "ENCRYPTION_KEY is not configured. " +
            "Set ENCRYPTION_KEY before storing transport credentials.",
        };
      }

      let key: Buffer;
      try {
        key = parseEncryptionKey(encryptionKeyEnv);
      } catch (err) {
        reply.status(503);
        return {
          error: `ENCRYPTION_KEY is invalid: ${err instanceof Error ? err.message : String(err)}`,
        };
      }

      // Build credential object and encrypt it
      const credentials: { apiKey: string; webhookSecret?: string } = { apiKey: api_key };
      if (webhook_secret !== undefined && webhook_secret !== "") {
        credentials.webhookSecret = webhook_secret;
      }

      const encryptedConfig = encrypt(JSON.stringify(credentials), key);

      // Deactivate existing active rows, then insert a fresh one.
      // Both operations run sequentially in application code. They are not
      // wrapped in an explicit transaction because:
      //   - A window between deactivate and insert leaves the tenant with no
      //     active config, which is safe (drain skips, no messages lost).
      //   - Postgres does not have serializable default isolation anyway;
      //     the deactivate-then-insert pattern is idiomatic here.
      //   - If insert fails, the tenant is left with no active config.
      //     The operator retries the PUT. This is the safer failure mode
      //     vs. wrapping in a transaction and rolling back the deactivation.
      await db
        .update(transportConfigs)
        .set({ isActive: false })
        .where(
          and(eq(transportConfigs.tenantId, tenantId), eq(transportConfigs.isActive, true)),
        );

      const [inserted] = await db
        .insert(transportConfigs)
        .values({
          tenantId,
          provider,
          config: sql`${encryptedConfig}::jsonb`,
          isActive: true,
          fromEmail: from_email,
          fromName: from_name ?? null,
          dailyLimit: daily_limit ?? null,
        })
        .returning({
          id: transportConfigs.id,
          provider: transportConfigs.provider,
          fromEmail: transportConfigs.fromEmail,
          fromName: transportConfigs.fromName,
          dailyLimit: transportConfigs.dailyLimit,
          dkimVerified: transportConfigs.dkimVerified,
          isActive: transportConfigs.isActive,
          createdAt: transportConfigs.createdAt,
        });

      reply.status(200);
      return {
        transport: {
          id: inserted!.id,
          provider: inserted!.provider,
          from_email: inserted!.fromEmail,
          from_name: inserted!.fromName,
          daily_limit: inserted!.dailyLimit,
          dkim_verified: inserted!.dkimVerified,
          is_active: inserted!.isActive,
          created_at: inserted!.createdAt,
        },
      };
    },
  );

  // -------------------------------------------------------------------------
  // GET /v1/settings/transport
  // -------------------------------------------------------------------------

  /**
   * GET /v1/settings/transport
   * Read the active transport configuration without credentials.
   *
   * Returns { transport: {...} } if an active config exists, or { transport: null }.
   * The response never includes api_key, webhook_secret, or the raw config envelope
   * in any form - not masked, not partially shown.
   */
  app.get("/transport", async (request) => {
    const db: Db = request.server.db;
    const tenantId = request.tenant!.id;

    const rows = await db
      .select({
        id: transportConfigs.id,
        provider: transportConfigs.provider,
        fromEmail: transportConfigs.fromEmail,
        fromName: transportConfigs.fromName,
        dailyLimit: transportConfigs.dailyLimit,
        dkimVerified: transportConfigs.dkimVerified,
        isActive: transportConfigs.isActive,
        createdAt: transportConfigs.createdAt,
      })
      .from(transportConfigs)
      .where(
        and(eq(transportConfigs.tenantId, tenantId), eq(transportConfigs.isActive, true)),
      )
      .limit(1);

    if (rows.length === 0) {
      return { transport: null };
    }

    const row = rows[0]!;
    return {
      transport: {
        id: row.id,
        provider: row.provider,
        from_email: row.fromEmail,
        from_name: row.fromName,
        daily_limit: row.dailyLimit,
        dkim_verified: row.dkimVerified,
        is_active: row.isActive,
        created_at: row.createdAt,
      },
    };
  });

  // -------------------------------------------------------------------------
  // PUT /v1/settings/llm
  // -------------------------------------------------------------------------

  /**
   * PUT /v1/settings/llm
   * Write or replace the active LLM provider configuration.
   *
   * Encryption requires ENCRYPTION_KEY to be set. Returns 503 if absent.
   * Returns 400 for unknown provider or missing required fields.
   *
   * The operation is: deactivate all existing active rows for this tenant,
   * then insert a fresh row. Same pattern as PUT /v1/settings/transport.
   *
   * The entire credential object (api_key, base_url, model, embedding_model)
   * is encrypted together. Read-back never returns any of these fields.
   *
   * embedding_model is optional; if omitted, the embedding client defaults to
   * "text-embedding-3-small". Setting it here controls which model is used for
   * KB entry indexing and similarity search queries.
   */
  app.put<{
    Body: {
      provider: string;
      api_key: string;
      base_url: string;
      model: string;
      embedding_model?: string;
    };
  }>(
    "/llm",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            provider: { type: "string" },
            api_key: { type: "string" },
            base_url: { type: "string", minLength: 1 },
            model: { type: "string", minLength: 1 },
            embedding_model: { type: "string" },
          },
          required: ["provider", "api_key", "base_url", "model"],
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const db: Db = request.server.db;
      const tenantId = request.tenant!.id;
      const { provider, api_key, base_url, model, embedding_model } = request.body;

      // Validate provider
      if (!isKnownLlmProvider(provider)) {
        reply.status(400);
        return {
          error: `Unknown provider: "${provider}". Valid values: ${KNOWN_LLM_PROVIDERS.join(", ")}.`,
        };
      }

      // Require ENCRYPTION_KEY
      const encryptionKeyEnv = process.env.ENCRYPTION_KEY;
      if (!encryptionKeyEnv) {
        reply.status(503);
        return {
          error:
            "ENCRYPTION_KEY is not configured. " +
            "Set ENCRYPTION_KEY before storing LLM credentials.",
        };
      }

      let key: Buffer;
      try {
        key = parseEncryptionKey(encryptionKeyEnv);
      } catch (err) {
        reply.status(503);
        return {
          error: `ENCRYPTION_KEY is invalid: ${err instanceof Error ? err.message : String(err)}`,
        };
      }

      // Build credential object and encrypt it.
      // The entire config - api_key, base_url, model, and embedding_model - is
      // encrypted together. None of these fields are stored in plaintext columns
      // because they all identify the tenant's provider and must be kept confidential.
      const credentials: {
        apiKey: string;
        baseUrl: string;
        model: string;
        embedding_model?: string;
      } = { apiKey: api_key, baseUrl: base_url, model };
      if (embedding_model !== undefined && embedding_model !== "") {
        credentials.embedding_model = embedding_model;
      }

      const encryptedConfig = encrypt(JSON.stringify(credentials), key);

      // Deactivate existing active rows, then insert a fresh one.
      // Same pattern as transport: safer than a transaction because the
      // failure mode (no active config) is recoverable with a retry PUT.
      await db
        .update(llmConfigs)
        .set({ isActive: false })
        .where(
          and(eq(llmConfigs.tenantId, tenantId), eq(llmConfigs.isActive, true)),
        );

      const [inserted] = await db
        .insert(llmConfigs)
        .values({
          tenantId,
          provider,
          config: encryptedConfig,
          isActive: true,
        })
        .returning({
          id: llmConfigs.id,
          provider: llmConfigs.provider,
          isActive: llmConfigs.isActive,
          createdAt: llmConfigs.createdAt,
        });

      reply.status(200);
      return {
        llm: {
          id: inserted!.id,
          provider: inserted!.provider,
          is_active: inserted!.isActive,
          created_at: inserted!.createdAt,
        },
      };
    },
  );

  // -------------------------------------------------------------------------
  // GET /v1/settings/llm
  // -------------------------------------------------------------------------

  /**
   * GET /v1/settings/llm
   * Read the active LLM configuration without credentials.
   *
   * Returns { llm: {...} } if an active config exists, or { llm: null }.
   * The response never includes api_key, base_url, model, or embedding_model.
   * These fields are encrypted in the database and decrypted only at use time
   * (provider-resolver.ts, embedding-client.ts). This endpoint never decrypts.
   */
  app.get("/llm", async (request) => {
    const db: Db = request.server.db;
    const tenantId = request.tenant!.id;

    const rows = await db
      .select({
        id: llmConfigs.id,
        provider: llmConfigs.provider,
        isActive: llmConfigs.isActive,
        createdAt: llmConfigs.createdAt,
      })
      .from(llmConfigs)
      .where(
        and(eq(llmConfigs.tenantId, tenantId), eq(llmConfigs.isActive, true)),
      )
      .limit(1);

    if (rows.length === 0) {
      return { llm: null };
    }

    const row = rows[0]!;
    return {
      llm: {
        id: row.id,
        provider: row.provider,
        is_active: row.isActive,
        created_at: row.createdAt,
      },
    };
  });

  // -------------------------------------------------------------------------
  // GET /v1/settings/tenant
  // -------------------------------------------------------------------------

  /**
   * GET /v1/settings/tenant
   * Read current tenant metadata and settings.
   *
   * Returns name, slug, plan, and the operator-configurable settings keys:
   * postal_address. Does not return lifecycle/throttle/brain_context because
   * those are managed by the templates route and the future flow compiler.
   */
  app.get("/tenant", async (request, reply) => {
    const db: Db = request.server.db;
    const tenantId = request.tenant!.id;

    const rows = await db
      .select({
        id: tenants.id,
        name: tenants.name,
        slug: tenants.slug,
        plan: tenants.plan,
        settings: tenants.settings,
        createdAt: tenants.createdAt,
      })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);

    if (rows.length === 0) {
      reply.status(404);
      return { error: "Tenant not found." };
    }

    const row = rows[0]!;
    const settings = (row.settings as Record<string, unknown> | null) ?? {};

    return {
      tenant: {
        id: row.id,
        name: row.name,
        slug: row.slug,
        plan: row.plan,
        postal_address: (settings.postal_address as string | undefined) ?? null,
        created_at: row.createdAt,
      },
    };
  });

  // -------------------------------------------------------------------------
  // PATCH /v1/settings/tenant
  // -------------------------------------------------------------------------

  /**
   * PATCH /v1/settings/tenant
   * Update operator-managed tenant settings.
   *
   * Currently supports: postal_address.
   * Merges over existing settings - does not overwrite lifecycle/throttle/brain_context
   * that the templates route writes.
   *
   * Returns 400 if postal_address is an empty string after trimming (callers
   * that want to clear the address must supply a non-empty replacement; clearing
   * would block the drain and is likely a mistake).
   */
  app.patch<{
    Body: {
      postal_address?: string;
    };
  }>(
    "/tenant",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            postal_address: { type: "string" },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const db: Db = request.server.db;
      const tenantId = request.tenant!.id;
      const { postal_address } = request.body;

      // Nothing to update
      if (postal_address === undefined) {
        reply.status(400);
        return { error: "No updatable fields provided. Supported: postal_address." };
      }

      // Reject empty postal address - clearing it would block the drain
      if (postal_address.trim().length === 0) {
        reply.status(400);
        return {
          error:
            "postal_address must be a non-empty string. " +
            "An empty postal address would block outgoing mail (CAN-SPAM compliance).",
        };
      }

      const trimmed = postal_address.trim();

      // Read current settings, merge, write back
      const tenantRows = await db
        .select({ settings: tenants.settings })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1);

      if (tenantRows.length === 0) {
        reply.status(404);
        return { error: "Tenant not found." };
      }

      const existing = (tenantRows[0]!.settings as Record<string, unknown> | null) ?? {};
      const updated: Record<string, unknown> = {
        ...existing,
        postal_address: trimmed,
      };

      await db.update(tenants).set({ settings: updated }).where(eq(tenants.id, tenantId));

      reply.status(200);
      return {
        tenant: {
          postal_address: trimmed,
        },
      };
    },
  );
};

export default settingsRoutes;
