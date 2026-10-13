/**
 * Monthly renewal of top-ups the customer chose to repeat.
 *
 * Each month, for every enabled renewal that is behind the current calendar month (UTC), the
 * saved card is charged for that top-up at TODAY's price, and the result goes through exactly the
 * same verified-payment path as a manual purchase (amount and currency are checked, the units are
 * added once). Nothing is credited on the strength of the charge call alone.
 *
 * Safety, in the order it matters:
 *   - One charge per workspace, kind and month: the checkout row's reference is deterministic and
 *     unique, so two servers (or two overlapping sweeps) cannot both charge. The provider also
 *     refuses a reference it has already seen.
 *   - Only workspaces that can use the top-up are charged: not suspended or being deleted, and on a
 *     plan (a workspace whose trial ended or subscription lapsed is skipped, not charged).
 *   - A top-up is capped at MAX_REPEAT_PACKS packs, and the amount is recomputed from the current
 *     list price, never read from a stored number.
 *   - Two failed attempts switch the renewal off and the owner is told; a failure is retried at
 *     most once a day. The owner is also emailed after every successful renewal.
 *   - "Stop repeating" removes the stored card.
 *
 * Mirror side: PUBLIC (packages/api is mirrored).
 */
import { and, eq, sql } from "drizzle-orm";
import {
  ADDONS,
  addonCheckoutPlan,
  addonPriceUsd,
  addonUnits,
  chargeAmountMinor,
  entitlementsFor,
  isAddonKind,
  plansEnforced,
  startOfMonthUtc,
} from "@loomail/core";
import { decrypt, parseEncryptionKey } from "@loomail/adapters";
import { addonAutoRenewals, billingCheckouts } from "@loomail/db/schema";
import type { Db } from "../plugins/db.js";
import { getPlatformTransport, type PlatformTransport } from "../platform-mailer.js";
import { PaystackError, type PaystackClient } from "./paystack.js";
import { applyVerifiedPayment } from "./service.js";

export const MAX_RENEWAL_FAILURES = 2;
const RETRY_AFTER_MS = 24 * 3_600_000;

export interface RenewalConfig {
  client: PaystackClient;
  currency: string;
  usdRate: number;
}

export interface RenewalOptions {
  now?: Date;
  batch?: number;
  /** Test seam: defaults to the platform transport from the environment. */
  transport?: PlatformTransport | null;
  log?: { warn: (obj: object, msg: string) => void; info?: (obj: object, msg: string) => void };
}

export interface RenewalResult {
  considered: number;
  renewed: number;
  failed: number;
  skipped: number;
}

interface Row extends Record<string, unknown> {
  id: string;
  tenant_id: string;
  kind: string;
  packs: number;
  authorization_enc: string;
  payer_email: string;
  fail_count: number;
  last_attempt_at: Date | string | null;
  plan: string | null;
  trial_ends_at: Date | string | null;
  plan_paid_through: Date | string | null;
  tenant_name: string;
}

const yyyymm = (d: Date): string => `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}`;

export async function runAddonRenewals(db: Db, cfg: RenewalConfig, opts: RenewalOptions = {}): Promise<RenewalResult> {
  const result: RenewalResult = { considered: 0, renewed: 0, failed: 0, skipped: 0 };
  const now = opts.now ?? new Date();
  const month = startOfMonthUtc(now);
  const transport = opts.transport === undefined ? getPlatformTransport() : opts.transport;

  const due = await db.execute<Row>(sql`
    SELECT r.id, r.tenant_id, r.kind, r.packs, r.authorization_enc, r.payer_email, r.fail_count, r.last_attempt_at,
           t.plan, t.trial_ends_at, t.plan_paid_through, t.name AS tenant_name
    FROM addon_auto_renewals r
    JOIN tenants t ON t.id = r.tenant_id
    WHERE r.enabled = true
      AND r.last_period < ${month.toISOString()}::timestamptz
      AND t.suspended_at IS NULL
      AND t.deletion_scheduled_at IS NULL
    ORDER BY r.last_period
    LIMIT ${opts.batch ?? 50}`);

  for (const r of due.rows) {
    result.considered++;
    try {
      const out = await renewOne(db, cfg, r, now, month, transport, opts);
      result[out]++;
    } catch (err) {
      result.failed++;
      opts.log?.warn({ tenantId: r.tenant_id, kind: r.kind, err: err instanceof Error ? err.message : String(err) }, "top-up renewal errored");
    }
  }
  return result;
}

async function renewOne(
  db: Db,
  cfg: RenewalConfig,
  r: Row,
  now: Date,
  month: Date,
  transport: PlatformTransport | null,
  opts: RenewalOptions,
): Promise<"renewed" | "failed" | "skipped"> {
  if (!isAddonKind(r.kind)) return "skipped";
  const kind = r.kind;

  // A workspace on no plan cannot use a top-up: do not charge it (and do not count it as a failure).
  const ent = entitlementsFor({
    plan: r.plan,
    trialEndsAt: r.trial_ends_at ? new Date(r.trial_ends_at) : null,
    paidThrough: r.plan_paid_through ? new Date(r.plan_paid_through) : null,
    now,
    enforced: true,
  });
  if (ent.plan === "free") return "skipped";

  // Retry a failed attempt at most once a day.
  if (r.last_attempt_at && now.getTime() - new Date(r.last_attempt_at).getTime() < RETRY_AFTER_MS && r.fail_count > 0) return "skipped";

  const keyEnv = process.env.ENCRYPTION_KEY;
  if (!keyEnv) return "skipped";
  let code: string;
  try {
    code = (JSON.parse(decrypt(r.authorization_enc, parseEncryptionKey(keyEnv))) as { code: string }).code;
  } catch {
    await fail(db, r, "The saved card could not be read.", true, now, transport, opts, cfg);
    return "failed";
  }

  const usd = addonPriceUsd(kind, r.packs);
  const amountCents = chargeAmountMinor(usd, cfg.currency, cfg.usdRate);
  const txRef = `mfr_${r.tenant_id.slice(0, 8)}_${kind}_${yyyymm(month)}_${r.fail_count}`;

  // Claim this month's charge. If the row already exists, another process (or an earlier sweep)
  // has it: do not charge again.
  const claimed = await db
    .insert(billingCheckouts)
    .values({
      tenantId: r.tenant_id,
      txRef,
      plan: addonCheckoutPlan(kind),
      interval: `x${r.packs}`,
      amountCents,
      currency: cfg.currency,
      providerPlanId: null,
      customerEmail: r.payer_email,
      status: "pending",
      repeatMonthly: false,
    })
    .onConflictDoNothing()
    .returning({ id: billingCheckouts.id });
  if (claimed.length === 0) return "skipped";

  await db.update(addonAutoRenewals).set({ lastAttemptAt: now, updatedAt: now }).where(eq(addonAutoRenewals.id, r.id));

  let reason = "The card was declined.";
  try {
    await cfg.client.chargeAuthorization({
      email: r.payer_email,
      amount: amountCents,
      currency: cfg.currency,
      authorizationCode: code,
      reference: txRef,
      metadata: { tenant_id: r.tenant_id, addon: kind, packs: r.packs, renewal: true, description: `${ADDONS[kind].label}, monthly renewal` },
    });
  } catch (err) {
    // The call may have failed after the charge went through, so confirm with the provider below.
    reason = err instanceof PaystackError ? err.message : "The payment provider could not be reached.";
  }

  // Believe only what the provider says about OUR reference.
  try {
    const tx = await cfg.client.verifyTransaction(txRef);
    if (tx.reference === txRef) {
      const applied = await applyVerifiedPayment(db, cfg.client, tx, now);
      if (tx.status === "success" && (applied.outcome === "applied_initial" || applied.outcome === "duplicate")) {
        await db
          .update(addonAutoRenewals)
          .set({ lastPeriod: month, failCount: 0, lastError: null, updatedAt: now })
          .where(eq(addonAutoRenewals.id, r.id));
        await notify(transport, r, "renewed", { kind, packs: r.packs, usd, tenantName: r.tenant_name, cfg }, opts);
        return "renewed";
      }
      if (tx.status !== "success") reason = "The card was declined.";
    }
  } catch (err) {
    reason = err instanceof PaystackError ? err.message : reason;
  }

  await db.update(billingCheckouts).set({ status: "failed", completedAt: now }).where(and(eq(billingCheckouts.txRef, txRef), eq(billingCheckouts.status, "pending")));
  await fail(db, r, reason, false, now, transport, opts, cfg);
  return "failed";
}

async function fail(
  db: Db,
  r: Row,
  reason: string,
  switchOff: boolean,
  now: Date,
  transport: PlatformTransport | null,
  opts: RenewalOptions,
  cfg: RenewalConfig,
): Promise<void> {
  const failCount = r.fail_count + 1;
  const off = switchOff || failCount >= MAX_RENEWAL_FAILURES;
  await db
    .update(addonAutoRenewals)
    .set({ failCount, lastError: reason.slice(0, 200), lastAttemptAt: now, enabled: off ? false : true, updatedAt: now })
    .where(eq(addonAutoRenewals.id, r.id));
  if (isAddonKind(r.kind)) {
    await notify(transport, r, off ? "stopped" : "failed", { kind: r.kind, packs: r.packs, usd: addonPriceUsd(r.kind, r.packs), tenantName: r.tenant_name, cfg }, opts);
  }
}

type Outcome = "renewed" | "failed" | "stopped";

async function notify(
  transport: PlatformTransport | null,
  r: Row,
  outcome: Outcome,
  d: { kind: keyof typeof ADDONS; packs: number; usd: number; tenantName: string; cfg: RenewalConfig },
  opts: RenewalOptions,
): Promise<void> {
  if (!transport) return;
  const what = `${ADDONS[d.kind].label.toLowerCase()} (+${addonUnits(d.kind, d.packs).toLocaleString("en-US")})`;
  const price = `$${d.usd % 1 === 0 ? d.usd : d.usd.toFixed(2)}`;
  const dashboard = (process.env.DASHBOARD_URL ?? process.env.BASE_URL ?? "").replace(/\/+$/, "");
  const planUrl = dashboard ? `${dashboard}/settings/plan` : "";
  const copy: Record<Outcome, { subject: string; body: string }> = {
    renewed: {
      subject: `Your monthly top-up renewed: ${what}`,
      body: `Your monthly top-up for ${d.tenantName} renewed: ${what} for ${price}. It is active for this calendar month. You can stop it any time from Settings, under Plan.`,
    },
    failed: {
      subject: `We could not renew your monthly top-up`,
      body: `We tried to renew ${what} for ${d.tenantName} (${price}) and the card was declined. We will try once more. Nothing was charged. You can also buy it again from Settings, under Plan.`,
    },
    stopped: {
      subject: `Your monthly top-up has stopped`,
      body: `We could not renew ${what} for ${d.tenantName} (${price}), so it will no longer repeat and nothing more will be charged. You can buy it again from Settings, under Plan, whenever you need it.`,
    },
  };
  const c = copy[outcome];
  const text = `${c.body}${planUrl ? `\n\n${planUrl}` : ""}`;
  const html = `<p>${c.body.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</p>${planUrl ? `<p><a href="${planUrl}">Open your plan settings</a></p>` : ""}`;
  try {
    await transport.adapter.send({
      to: r.payer_email,
      from: transport.fromEmail,
      fromName: transport.fromName ?? undefined,
      subject: c.subject,
      bodyHtml: html,
      bodyText: text,
      headers: {},
      messageId: `topup-${outcome}-${r.id}-${Date.now()}`,
    });
  } catch (err) {
    opts.log?.warn({ tenantId: r.tenant_id, err: err instanceof Error ? err.message : String(err) }, "top-up notice not delivered");
  }
}

/** Run the renewal sweep every 30 minutes inside the server. Does nothing unless billing is on. */
export function startAddonRenewalMonitor(
  db: Db,
  getConfig: () => RenewalConfig | null,
  opts: RenewalOptions & { intervalMs?: number; firstCheckMs?: number } = {},
): () => void {
  const tick = () => {
    if (!plansEnforced()) return;
    const cfg = getConfig();
    if (!cfg) return;
    runAddonRenewals(db, cfg, opts)
      .then((r) => {
        if (r.renewed > 0 || r.failed > 0) opts.log?.info?.(r, "top-up renewals ran");
      })
      .catch((err) => opts.log?.warn({ err: err instanceof Error ? err.message : String(err) }, "top-up renewal sweep failed"));
  };
  const first = setTimeout(tick, opts.firstCheckMs ?? 180_000);
  const every = setInterval(tick, opts.intervalMs ?? 1_800_000);
  first.unref();
  every.unref();
  return () => {
    clearTimeout(first);
    clearInterval(every);
  };
}

/** Stop a repeating top-up and forget the saved card. Returns whether one existed. */
export async function stopAddonRenewal(db: Db, tenantId: string, kind: string): Promise<boolean> {
  const del = await db
    .delete(addonAutoRenewals)
    .where(and(eq(addonAutoRenewals.tenantId, tenantId), eq(addonAutoRenewals.kind, kind)))
    .returning({ id: addonAutoRenewals.id });
  return del.length > 0;
}

/** This workspace's repeating top-ups, for the plan page. */
export async function listAddonRenewals(db: Db, tenantId: string) {
  const rows = await db
    .select({
      kind: addonAutoRenewals.kind,
      packs: addonAutoRenewals.packs,
      cardBrand: addonAutoRenewals.cardBrand,
      cardLast4: addonAutoRenewals.cardLast4,
      enabled: addonAutoRenewals.enabled,
      lastError: addonAutoRenewals.lastError,
    })
    .from(addonAutoRenewals)
    .where(eq(addonAutoRenewals.tenantId, tenantId));
  return rows;
}
