/**
 * Background upkeep for managed sending, run every few minutes inside the server:
 *   - remove sending domains that no longer have an owner from the operator's Resend account
 *   - check each workspace's sender health and pause the ones hurting the shared account
 *
 * Does nothing at all unless managed sending is offered (the operator's Resend key is set).
 *
 * Mirror side: PUBLIC (packages/api is mirrored).
 */
import { managedSendingConfigFromEnv } from "@mailforge/core";
import type { Db } from "../plugins/db.js";
import { domainsClientFromEnv } from "./context.js";
import { sweepDomainCleanup } from "./domains.js";
import { checkSenderHealth, type HealthOptions } from "./health.js";

export function startSendingMonitor(db: Db, opts: HealthOptions & { intervalMs?: number; firstCheckMs?: number } = {}): () => void {
  const tick = () => {
    if (!managedSendingConfigFromEnv(opts.env ?? process.env).enabled) return;
    void sweepDomainCleanup(db, domainsClientFromEnv(opts.env ?? process.env), opts.log);
    void checkSenderHealth(db, new Date(), opts);
  };
  const first = setTimeout(tick, opts.firstCheckMs ?? 90_000);
  const every = setInterval(tick, opts.intervalMs ?? 5 * 60_000);
  first.unref();
  every.unref();
  return () => {
    clearTimeout(first);
    clearInterval(every);
  };
}
