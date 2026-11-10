/**
 * @loomail/api - HTTP API layer (Fastify routes, plugins, middleware).
 * Depends on @loomail/core, @loomail/adapters, @loomail/db.
 *
 * Mirror side: PUBLIC (packages/api is in the mirror whitelist).
 */
export { buildApp } from "./app.js";
export { buildAdminApp } from "./admin/standalone.js";
export type { AdminAppOptions } from "./admin/standalone.js";
export { ADMIN_SESSION_COOKIE } from "./admin/auth-routes.js";
export { platformAdminEmails, isPlatformAdmin } from "./admin/platform-admins.js";
export { startSendingMonitor } from "./sending/monitor.js";
export { startOnboardingNudgeMonitor, sweepOnboardingNudges } from "./onboarding/nudge.js";
export { startTrialReminderMonitor, sweepTrialReminders } from "./onboarding/trial-reminders.js";
export { startAddonRenewalMonitor, runAddonRenewals } from "./billing/addon-renewals.js";
export { billingRuntimeFromEnv } from "./billing/config.js";
export { checkSenderHealth } from "./sending/health.js";
export { startAiAlertMonitor, checkAiAlert, checkAiBudgetAlert } from "./ai/alerts.js";
export type { BuildAppOptions } from "./app.js";
export type { TenantContext } from "./types.js";
export type { Db } from "./plugins/db.js";
export { SESSION_COOKIE_NAME } from "./routes/auth.js";
export { hashApiKey, createIngestAuthPlugin } from "./plugins/ingest-auth.js";
export type { IngestTenantContext } from "./plugins/ingest-auth.js";
