/**
 * Inbound sources: the places other systems send data to (see routes/webhooks/inbound.ts for the receiving side).
 *
 *   GET    /v1/inbound-sources              list (never returns a token or a signing secret)
 *   POST   /v1/inbound-sources              create; a generic source's token is returned ONCE
 *   PATCH  /v1/inbound-sources/:id          rename, enable or disable, change its settings or Stripe secret
 *   POST   /v1/inbound-sources/:id/rotate-token   a new token for a generic source (the old one stops working)
 *   DELETE /v1/inbound-sources/:id          delete it and its log
 *   GET    /v1/inbound-sources/:id/log      what it received lately, newest first (last 50)
 *
 * Dashboard operator scope (session cookie), any member, like API keys. The source's URL is
 * `<your host>/webhooks/in/<id>`; the id is not a secret, the token or Stripe signature is.
 *
 * Mirror side: PUBLIC (packages/api is mirrored).
 */
import type { FastifyPluginAsync } from "fastify";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { and, desc, eq, ne, sql } from "drizzle-orm";
import { sealWebhookSecret } from "@loomail/adapters";
import { inboundSources, inboundSourceLog } from "@loomail/db/schema";
import type { Db } from "../plugins/db.js";
import { genericConfigSchema, stripeConfigSchema } from "../inbound/mapping.js";
import { flutterwaveConfigSchema, paystackConfigSchema } from "../inbound/african-gateways.js";
import { sha256 } from "./webhooks/inbound.js";

export const MAX_INBOUND_SOURCES = 20;

const stripeSecretSchema = z
  .string()
  .trim()
  .regex(/^whsec_[A-Za-z0-9]{16,}$/, "That does not look like a Stripe signing secret. It starts with whsec_ and is on the endpoint's page in Stripe.");

const paystackKeySchema = z
  .string()
  .trim()
  .regex(/^sk_(test|live)_[A-Za-z0-9]{10,}$/, "That does not look like a Paystack secret key. It starts with sk_test_ or sk_live_.");

/** The secret a sender signs with (Shopify, Tally, WooCommerce, Cal.com...). Their formats differ, so only its size is checked. */
const signingSecretSchema = z.string().min(1, "Paste the signing secret.").max(500);

const createSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("generic"), name: z.string().trim().min(1).max(100), config: z.unknown(), signing_secret: signingSecretSchema.optional() }),
  z.object({ kind: z.literal("stripe"), name: z.string().trim().min(1).max(100), config: z.unknown().optional(), stripe_signing_secret: stripeSecretSchema }),
  z.object({ kind: z.literal("paystack"), name: z.string().trim().min(1).max(100), config: z.unknown().optional(), paystack_secret_key: paystackKeySchema.optional() }),
  z.object({ kind: z.literal("flutterwave"), name: z.string().trim().min(1).max(100), config: z.unknown().optional() }),
]);

/** The settings schema for each kind of source. */
const configSchemaFor = {
  generic: genericConfigSchema,
  stripe: stripeConfigSchema,
  paystack: paystackConfigSchema,
  flutterwave: flutterwaveConfigSchema,
} as const;

const patchSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    enabled: z.boolean().optional(),
    config: z.unknown().optional(),
    stripe_signing_secret: stripeSecretSchema.optional(),
    paystack_secret_key: paystackKeySchema.optional(),
    signing_secret: signingSecretSchema.optional(),
  })
  .strict();

function view(r: typeof inboundSources.$inferSelect) {
  return {
    id: r.id,
    name: r.name,
    kind: r.kind,
    enabled: r.enabled,
    config: r.config,
    token_prefix: r.tokenPrefix,
    has_signing_secret: r.secretSealed !== null,
    created_at: r.createdAt.toISOString(),
    last_received_at: r.lastReceivedAt ? r.lastReceivedAt.toISOString() : null,
  };
}

const newToken = () => `mf_in_${randomBytes(24).toString("base64url")}`;
const newFlutterwaveHash = () => `mf_fw_${randomBytes(24).toString("base64url")}`;

const issues = (error: z.ZodError) => error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));

const inboundSourcesRoutes: FastifyPluginAsync = async (app) => {
  app.get("/", { config: { minRole: "member" } }, async (request) => {
    const db: Db = request.server.db;
    const rows = await db.select().from(inboundSources).where(and(eq(inboundSources.tenantId, request.tenant!.id), ne(inboundSources.kind, "warehouse"))).orderBy(desc(inboundSources.createdAt));
    return { sources: rows.map(view) };
  });

  app.post<{ Body: unknown }>("/", { config: { minRole: "member" } }, async (request, reply) => {
    const db: Db = request.server.db;
    const tenantId = request.tenant!.id;
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: "Validation failed", issues: issues(parsed.error) };
    }
    const count = (await db.select({ n: sql<number>`count(*)::int` }).from(inboundSources).where(and(eq(inboundSources.tenantId, tenantId), ne(inboundSources.kind, "warehouse"))))[0]!.n;
    if (count >= MAX_INBOUND_SOURCES) {
      reply.status(409);
      return { error: `A workspace can have at most ${MAX_INBOUND_SOURCES} sources.` };
    }

    if (parsed.data.kind === "generic") {
      const config = genericConfigSchema.safeParse(parsed.data.config ?? {});
      if (!config.success) {
        reply.status(400);
        return { error: "Validation failed", issues: issues(config.error).map((i) => ({ ...i, path: `config.${i.path}` })) };
      }
      if (config.data.verification === "signature") {
        // Checked by the sender's signature: Loomail holds the shared secret (sealed) and makes no token.
        if (!parsed.data.signing_secret) {
          reply.status(400);
          return { error: "Validation failed", issues: [{ path: "signing_secret", message: "Signature checking needs the signing secret the sender uses. Or choose the token instead." }] };
        }
        const [row] = await db
          .insert(inboundSources)
          .values({ tenantId, name: parsed.data.name, kind: "generic", config: config.data, secretSealed: sealWebhookSecret(parsed.data.signing_secret) })
          .returning();
        reply.status(201);
        return { source: view(row!) };
      }
      if (parsed.data.signing_secret) {
        reply.status(400);
        return { error: "Validation failed", issues: [{ path: "signing_secret", message: "A signing secret only applies when calls are checked by signature." }] };
      }
      const token = newToken();
      const [row] = await db
        .insert(inboundSources)
        .values({ tenantId, name: parsed.data.name, kind: "generic", config: config.data, tokenHash: sha256(token), tokenPrefix: token.slice(0, 10) })
        .returning();
      reply.status(201);
      return { source: view(row!), token };
    }

    if (parsed.data.kind === "paystack") {
      const config = paystackConfigSchema.safeParse(parsed.data.config ?? {});
      if (!config.success) {
        reply.status(400);
        return { error: "Validation failed", issues: issues(config.error).map((i) => ({ ...i, path: `config.${i.path}` })) };
      }
      if (config.data.verification === "signature") {
        if (!parsed.data.paystack_secret_key) {
          reply.status(400);
          return { error: "Validation failed", issues: [{ path: "paystack_secret_key", message: "Signature checking needs your Paystack secret key (sk_test_... or sk_live_...). Or choose the address token instead." }] };
        }
        const [row] = await db
          .insert(inboundSources)
          .values({ tenantId, name: parsed.data.name, kind: "paystack", config: config.data, secretSealed: sealWebhookSecret(parsed.data.paystack_secret_key) })
          .returning();
        reply.status(201);
        return { source: view(row!) };
      }
      const token = newToken();
      const [row] = await db
        .insert(inboundSources)
        .values({ tenantId, name: parsed.data.name, kind: "paystack", config: config.data, tokenHash: sha256(token), tokenPrefix: token.slice(0, 10) })
        .returning();
      reply.status(201);
      return { source: view(row!), token };
    }

    if (parsed.data.kind === "flutterwave") {
      const config = flutterwaveConfigSchema.safeParse(parsed.data.config ?? {});
      if (!config.success) {
        reply.status(400);
        return { error: "Validation failed", issues: issues(config.error).map((i) => ({ ...i, path: `config.${i.path}` })) };
      }
      // The "secret hash" Flutterwave sends back in the verif-hash header. Loomail makes it, so it is random, and only its hash is kept.
      const token = newFlutterwaveHash();
      const [row] = await db
        .insert(inboundSources)
        .values({ tenantId, name: parsed.data.name, kind: "flutterwave", config: config.data, tokenHash: sha256(token), tokenPrefix: token.slice(0, 10) })
        .returning();
      reply.status(201);
      return { source: view(row!), token };
    }

    const config = stripeConfigSchema.safeParse(parsed.data.config ?? {});
    if (!config.success) {
      reply.status(400);
      return { error: "Validation failed", issues: issues(config.error).map((i) => ({ ...i, path: `config.${i.path}` })) };
    }
    const [row] = await db
      .insert(inboundSources)
      .values({ tenantId, name: parsed.data.name, kind: "stripe", config: config.data, secretSealed: sealWebhookSecret(parsed.data.stripe_signing_secret) })
      .returning();
    reply.status(201);
    return { source: view(row!) };
  });

  const own = async (db: Db, tenantId: string, id: string) => {
    if (!z.string().uuid().safeParse(id).success) return undefined;
    return (await db.select().from(inboundSources).where(and(eq(inboundSources.id, id), eq(inboundSources.tenantId, tenantId), ne(inboundSources.kind, "warehouse"))).limit(1))[0];
  };

  app.patch<{ Params: { id: string }; Body: unknown }>("/:id", { config: { minRole: "member" } }, async (request, reply) => {
    const db: Db = request.server.db;
    const tenantId = request.tenant!.id;
    const existing = await own(db, tenantId, request.params.id);
    if (!existing) {
      reply.status(404);
      return { error: "Source not found." };
    }
    const parsed = patchSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: "Validation failed", issues: issues(parsed.error) };
    }
    const set: Partial<typeof inboundSources.$inferInsert> = {};
    if (parsed.data.name !== undefined) set.name = parsed.data.name;
    if (parsed.data.enabled !== undefined) set.enabled = parsed.data.enabled;
    if (parsed.data.config !== undefined) {
      const schema = configSchemaFor[existing.kind as keyof typeof configSchemaFor] ?? genericConfigSchema;
      const config = schema.safeParse(parsed.data.config);
      if (!config.success) {
        reply.status(400);
        return { error: "Validation failed", issues: issues(config.error).map((i) => ({ ...i, path: `config.${i.path}` })) };
      }
      // How a Paystack source checks calls decides what it holds (a key, or a token), so it is fixed once made.
      const was = (existing.config as { verification?: string }).verification;
      if (existing.kind === "paystack" && (config.data as { verification?: string }).verification !== was) {
        reply.status(400);
        return { error: "Validation failed", issues: [{ path: "config.verification", message: "A Paystack source cannot change how it verifies calls. Add a new source instead." }] };
      }
      if (existing.kind === "generic") {
        const wasMode = (existing.config as { verification?: string }).verification ?? "token";
        const nowMode = (config.data as { verification?: string }).verification ?? "token";
        if (nowMode !== wasMode) {
          reply.status(400);
          return { error: "Validation failed", issues: [{ path: "config.verification", message: "A source cannot change how it checks calls. Add a new source instead." }] };
        }
      }
      set.config = config.data;
    }
    if (parsed.data.signing_secret !== undefined) {
      if (existing.kind !== "generic" || (existing.config as { verification?: string }).verification !== "signature") {
        reply.status(400);
        return { error: "Validation failed", issues: [{ path: "signing_secret", message: "Only a source that checks signatures holds a signing secret." }] };
      }
      set.secretSealed = sealWebhookSecret(parsed.data.signing_secret);
    }
    if (parsed.data.stripe_signing_secret !== undefined) {
      if (existing.kind !== "stripe") {
        reply.status(400);
        return { error: "Validation failed", issues: [{ path: "stripe_signing_secret", message: "Only a Stripe source has a signing secret." }] };
      }
      set.secretSealed = sealWebhookSecret(parsed.data.stripe_signing_secret);
    }
    if (parsed.data.paystack_secret_key !== undefined) {
      if (existing.kind !== "paystack" || (existing.config as { verification?: string }).verification !== "signature") {
        reply.status(400);
        return { error: "Validation failed", issues: [{ path: "paystack_secret_key", message: "Only a Paystack source that checks signatures holds a secret key." }] };
      }
      set.secretSealed = sealWebhookSecret(parsed.data.paystack_secret_key);
    }
    if (Object.keys(set).length === 0) return { source: view(existing) };
    const [row] = await db.update(inboundSources).set(set).where(eq(inboundSources.id, existing.id)).returning();
    return { source: view(row!) };
  });

  app.post<{ Params: { id: string } }>("/:id/rotate-token", { config: { minRole: "member" } }, async (request, reply) => {
    const db: Db = request.server.db;
    const existing = await own(db, request.tenant!.id, request.params.id);
    if (!existing) {
      reply.status(404);
      return { error: "Source not found." };
    }
    if (!existing.tokenHash) {
      reply.status(400);
      return { error: "This source has no token: it is checked by the provider's signature." };
    }
    const token = existing.kind === "flutterwave" ? newFlutterwaveHash() : newToken();
    const [row] = await db.update(inboundSources).set({ tokenHash: sha256(token), tokenPrefix: token.slice(0, 10) }).where(eq(inboundSources.id, existing.id)).returning();
    return { source: view(row!), token };
  });

  app.delete<{ Params: { id: string } }>("/:id", { config: { minRole: "member" } }, async (request, reply) => {
    const db: Db = request.server.db;
    const existing = await own(db, request.tenant!.id, request.params.id);
    if (!existing) {
      reply.status(404);
      return { error: "Source not found." };
    }
    await db.delete(inboundSources).where(eq(inboundSources.id, existing.id));
    return { deleted: true };
  });

  app.get<{ Params: { id: string } }>("/:id/log", { config: { minRole: "member" } }, async (request, reply) => {
    const db: Db = request.server.db;
    const existing = await own(db, request.tenant!.id, request.params.id);
    if (!existing) {
      reply.status(404);
      return { error: "Source not found." };
    }
    const rows = await db
      .select({ id: inboundSourceLog.id, status: inboundSourceLog.status, summary: inboundSourceLog.summary, created_at: inboundSourceLog.createdAt })
      .from(inboundSourceLog)
      .where(eq(inboundSourceLog.sourceId, existing.id))
      .orderBy(desc(inboundSourceLog.createdAt), desc(inboundSourceLog.id))
      .limit(50);
    return { log: rows.map((r) => ({ ...r, created_at: r.created_at.toISOString() })) };
  });
};

export default inboundSourcesRoutes;
