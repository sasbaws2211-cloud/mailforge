/**
 * Resend webhook for managed sending: bounces, complaints, deliveries, opens and clicks for
 * mail sent through the operator's own Resend account.
 *
 *   POST /webhooks/resend-platform
 *
 * One signing secret for the whole account (MAILFORGE_MANAGED_RESEND_WEBHOOK_SECRET), because
 * one Resend account sends for every managed workspace. Unlike the per-workspace endpoint, the
 * workspace is not in the URL: it is found from the message the event is about, and only
 * messages from workspaces that use managed sending are considered, so this endpoint can
 * never touch the mail of a workspace with a transport of its own.
 *
 * The signature is checked before anything is parsed, every failure answers the same 400 (so
 * nothing can be learned from it), and the suppressed address always comes from our own message
 * row, never from the payload: exactly as in the per-workspace endpoint, whose event handling
 * this reuses.
 *
 * Mirror side: PUBLIC (packages/api is mirrored).
 */
import type { FastifyPluginAsync } from "fastify";
import { sql } from "drizzle-orm";
import { managedSendingConfigFromEnv } from "@mailforge/core";
import type { Db } from "../../plugins/db.js";
import { processResendWebhookEvent, verifyResendWebhookSignature } from "./resend.js";

const resendPlatformWebhookRoute: FastifyPluginAsync = async (app) => {
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    done(null, body);
  });

  app.post("/", async (request, reply) => {
    const db: Db = request.server.db;
    const rawBody = request.body as string;
    const cfg = managedSendingConfigFromEnv();
    if (!cfg.enabled || !cfg.webhookSecret) {
      reply.status(400);
      return { error: "Invalid webhook signature." };
    }

    const verified = verifyResendWebhookSignature(
      rawBody,
      request.headers["svix-id"] as string | undefined,
      request.headers["svix-timestamp"] as string | undefined,
      request.headers["svix-signature"] as string | undefined,
      cfg.webhookSecret,
    );
    if (!verified.ok) {
      reply.status(400);
      return { error: "Invalid webhook signature." };
    }

    let event: { type: string; created_at?: string; data?: { email_id?: string } };
    try {
      event = JSON.parse(rawBody);
    } catch {
      reply.status(400);
      return { error: "Invalid JSON payload." };
    }

    const emailId = event.data?.email_id;
    if (typeof emailId === "string" && emailId !== "") {
      // Which workspace sent it? Only workspaces on managed sending count.
      const found = await db.execute<{ tenant_id: string }>(sql`
        SELECT m.tenant_id FROM lifecycle_messages m
        WHERE m.provider_message_id = ${emailId}
          AND EXISTS (SELECT 1 FROM managed_sending s WHERE s.tenant_id = m.tenant_id)
        LIMIT 1`);
      const tenantId = found.rows[0]?.tenant_id;
      if (tenantId) {
        await processResendWebhookEvent(db, event as never, tenantId, request.headers["svix-id"] as string | undefined);
      }
    }
    // Always acknowledge: unknown events and messages must not make Resend retry forever.
    reply.status(200);
    return { received: true };
  });
};

export default resendPlatformWebhookRoute;
