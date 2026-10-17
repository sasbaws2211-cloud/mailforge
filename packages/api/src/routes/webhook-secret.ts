/**
 * The secret a workspace's flow webhooks are signed with.
 *
 *   GET  /v1/webhook-secret          the secret (made on first read); owner only
 *   POST /v1/webhook-secret/rotate   replace it with a new one; owner only
 *
 * One secret per workspace, shared by all its flows (the worker signs every call with it; see
 * @loomail/adapters webhook-sender for how a receiver verifies). It is stored sealed (encrypted with
 * ENCRYPTION_KEY when the install has one) and is shown only to owners. After a rotation the old secret stops
 * working at once, so a receiver must be updated at the same time: calls already queued are signed with the
 * new secret when they are made.
 *
 * Mirror side: PUBLIC (packages/api is mirrored).
 */
import type { FastifyPluginAsync } from "fastify";
import { eq } from "drizzle-orm";
import { webhookSecrets } from "@loomail/db/schema";
import { generateWebhookSecret, openWebhookSecret, sealWebhookSecret } from "@loomail/adapters";
import type { Db } from "../plugins/db.js";

interface SecretView {
  secret: string;
  created_at: string;
  rotated_at: string | null;
}

async function readOrCreate(db: Db, tenantId: string): Promise<SecretView> {
  const read = async () => (await db.select().from(webhookSecrets).where(eq(webhookSecrets.tenantId, tenantId)).limit(1))[0];
  let row = await read();
  if (!row) {
    await db.insert(webhookSecrets).values({ tenantId, secretSealed: sealWebhookSecret(generateWebhookSecret()) }).onConflictDoNothing();
    row = await read();
  }
  return {
    secret: openWebhookSecret(row!.secretSealed),
    created_at: row!.createdAt.toISOString(),
    rotated_at: row!.rotatedAt ? row!.rotatedAt.toISOString() : null,
  };
}

const webhookSecretRoutes: FastifyPluginAsync = async (app) => {
  app.get("/", { config: { minRole: "owner" as const } }, async (request) => {
    return readOrCreate(request.server.db, request.tenant!.id);
  });

  app.post("/rotate", { config: { minRole: "owner" as const } }, async (request) => {
    const db: Db = request.server.db;
    const tenantId = request.tenant!.id;
    await readOrCreate(db, tenantId); // makes sure a row exists to replace
    await db
      .update(webhookSecrets)
      .set({ secretSealed: sealWebhookSecret(generateWebhookSecret()), rotatedAt: new Date() })
      .where(eq(webhookSecrets.tenantId, tenantId));
    return readOrCreate(db, tenantId);
  });
};

export default webhookSecretRoutes;
