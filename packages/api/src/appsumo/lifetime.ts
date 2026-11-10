/**
 * Lifetime deals: licences sold on AppSumo that unlock a lifetime tier for one workspace.
 *
 * AppSumo tells us what happened by signed webhook (purchase, activate, upgrade, downgrade, deactivate) and
 * we only ever react to those: a licence is never created, upgraded or refunded by hand (AppSumo forbids it).
 * The one exception is the codes Loomail generates itself (the CSV given to AppSumo): those are ours, so the
 * operator can refund one. A customer ties a licence to their workspace by activating it (the OAuth redirect),
 * by redeeming it on /redeem, or by pasting the key in Settings, Plan.
 *
 * Rules:
 *   - A workspace is on lifetime tier N while the licences it holds add up to N (a tier-2 licence counts as 2),
 *     to a maximum of MAX_LIFETIME_TIER. Every change recomputes the tier from the ledger, so the plan cannot
 *     drift from the licences.
 *   - A refund (deactivate) ends that licence at once; the workspace drops a tier, or onto no plan when it was the
 *     last. A licence already replaced by an upgrade is left alone.
 *   - A workspace with a live paid subscription cannot redeem (the subscription would overwrite the plan at its next
 *     charge): cancel it first, or redeem in a new workspace.
 *   - Limits live on the lifetime_1..3 plans and are monthly caps, never unlimited for anything that costs money.
 *   - Lifetime plans send through the customer's own provider: Loomail Sending is switched off on redemption.
 *
 * Mirror side: PUBLIC (packages/api is mirrored).
 */
import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { MAX_LIFETIME_TIER, isLifetimePlanId, lifetimePlanForTotal } from "@loomail/core";
import { appsumoEvents, lifetimeLicenses, managedSending, platformSettings, tenants } from "@loomail/db/schema";
import type { Db } from "../plugins/db.js";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Conn = Db | Tx;

export const BILLING_MODES = ["subscriptions", "lifetime", "both"] as const;
export type BillingMode = (typeof BILLING_MODES)[number];

export const DEFAULT_CAP = 100;
/** Log an operator alert once this many licences are sold. */
export const ALERT_AT = 90;
/** Codes we generate look like LM-XXXX-XXXX-XXXX. */
export const CODE_PREFIX = "LM";
/** No 0/O/1/I: easy to read out and retype. */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** A failure with an HTTP status and a sentence safe to show a customer. */
export class LifetimeError extends Error {
  constructor(
    readonly httpStatus: number,
    message: string,
  ) {
    super(message);
    this.name = "LifetimeError";
  }
}

// ---------------------------------------------------------------------------
// Operator settings: the billing mode and the number of licences to sell
// ---------------------------------------------------------------------------

const MODE_KEY = "billing_mode";
const CAP_KEY = "lifetime_cap";

async function getSetting(db: Conn, key: string): Promise<unknown> {
  const [row] = await db.select({ value: platformSettings.value }).from(platformSettings).where(eq(platformSettings.key, key)).limit(1);
  return row?.value;
}

async function putSetting(db: Conn, key: string, value: unknown, by: string): Promise<void> {
  await db
    .insert(platformSettings)
    .values({ key, value, updatedBy: by })
    .onConflictDoUpdate({ target: platformSettings.key, set: { value, updatedBy: by, updatedAt: new Date() } });
}

export async function getMode(db: Conn): Promise<BillingMode> {
  const v = await getSetting(db, MODE_KEY);
  return typeof v === "string" && (BILLING_MODES as readonly string[]).includes(v) ? (v as BillingMode) : "both";
}

export async function setMode(db: Conn, mode: string, by: string): Promise<BillingMode> {
  if (!(BILLING_MODES as readonly string[]).includes(mode)) {
    throw new LifetimeError(400, "Billing mode must be 'subscriptions', 'lifetime' or 'both'.");
  }
  await putSetting(db, MODE_KEY, mode, by);
  return mode as BillingMode;
}

export async function getCap(db: Conn): Promise<number> {
  const v = await getSetting(db, CAP_KEY);
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_CAP;
}

export async function setCap(db: Conn, cap: number, by: string): Promise<number> {
  const n = Math.max(0, Math.min(100_000, Math.floor(Number(cap) || 0)));
  await putSetting(db, CAP_KEY, n, by);
  return n;
}

/** Licences in use: bought and not refunded, and not replaced by an upgrade (an upgrade is one customer, not two). */
export async function sold(db: Conn): Promise<number> {
  const r = await db.execute<{ n: string }>(sql`
    SELECT count(*)::text AS n FROM lifetime_licenses
    WHERE status IN ('inactive', 'active') AND (source <> 'code' OR tenant_id IS NOT NULL)`);
  return Number(r.rows[0]?.n ?? 0);
}

export async function spots(db: Conn): Promise<{ cap: number; sold: number; left: number }> {
  const [cap, n] = await Promise.all([getCap(db), sold(db)]);
  return { cap, sold: n, left: Math.max(0, cap - n) };
}

export function buyUrl(env: Record<string, string | undefined> = process.env): string {
  return (env.APPSUMO_BUY_URL ?? "").trim();
}

/** Which AppSumo settings are present, never their values. */
export function appsumoStatus(env: Record<string, string | undefined> = process.env) {
  return {
    api_key: Boolean(env.APPSUMO_API_KEY?.trim()),
    oauth: Boolean(env.APPSUMO_CLIENT_ID?.trim() && env.APPSUMO_CLIENT_SECRET?.trim()),
    redirect_url: (env.APPSUMO_REDIRECT_URL ?? "").trim(),
    buy_url: buyUrl(env),
  };
}

// ---------------------------------------------------------------------------
// Webhook signature
// ---------------------------------------------------------------------------

export const MAX_SKEW_SECONDS = 15 * 60;

export function signWebhook(apiKey: string, timestamp: string, body: string | Buffer): string {
  return createHmac("sha256", apiKey).update(timestamp).update(body).digest("hex");
}

/** AppSumo signs `timestamp + body` with HMAC-SHA256 under our API key; a stale timestamp is refused. */
export function verifyWebhook(apiKey: string, timestamp: string, signature: string, body: string | Buffer, nowMs: number = Date.now()): boolean {
  if (!apiKey || !timestamp || !signature) return false;
  let ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  if (ts > 1e12) ts /= 1000; // milliseconds
  if (Math.abs(nowMs / 1000 - ts) > MAX_SKEW_SECONDS) return false;
  const want = Buffer.from(signWebhook(apiKey, timestamp, body), "utf8");
  const got = Buffer.from(signature.trim().toLowerCase(), "utf8");
  return want.length === got.length && timingSafeEqual(want, got);
}

// ---------------------------------------------------------------------------
// Keys and codes
// ---------------------------------------------------------------------------

/** Accept a code typed with spaces, in lower case or without dashes. */
export function normalizeCode(raw: string): string {
  const flat = (raw ?? "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  if (flat.startsWith(CODE_PREFIX) && flat.length === 14) return `${CODE_PREFIX}-${flat.slice(2, 6)}-${flat.slice(6, 10)}-${flat.slice(10, 14)}`;
  return (raw ?? "").trim();
}

function newCode(): string {
  let body = "";
  for (let i = 0; i < 12; i++) body += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return `${CODE_PREFIX}-${body.slice(0, 4)}-${body.slice(4, 8)}-${body.slice(8)}`;
}

export function planCodeForTier(tier: number): string {
  return `lifetime_${Math.max(1, Math.min(MAX_LIFETIME_TIER, Math.floor(Number(tier) || 1)))}`;
}

function tierOf(payload: Record<string, unknown>): number {
  const n = Math.floor(Number(payload.tier));
  return Number.isFinite(n) ? Math.max(1, Math.min(MAX_LIFETIME_TIER, n)) : 1;
}

export async function getLicense(db: Conn, key: string) {
  const [row] = await db.select().from(lifetimeLicenses).where(eq(lifetimeLicenses.licenseKey, key)).limit(1);
  return row ?? null;
}

/** A licence by the key as typed, or as normalised (a code typed without dashes, in lower case). */
export async function findLicense(db: Conn, key: string) {
  const k = (key ?? "").trim();
  if (!k) return null;
  const direct = (await getLicense(db, k)) ?? (await getLicense(db, normalizeCode(k)));
  if (direct) return direct;
  // Last resort: a key typed or pasted in a different case. Licence keys are UUIDs and codes are upper case,
  // so two keys that differ only by case are never two different licences.
  const [row] = await db.select().from(lifetimeLicenses).where(sql`lower(${lifetimeLicenses.licenseKey}) = lower(${k})`).limit(1);
  return row ?? null;
}

/** The licence a workspace currently holds (the highest tier if it somehow has several). */
export async function licenseForTenant(db: Conn, tenantId: string) {
  const [row] = await db
    .select()
    .from(lifetimeLicenses)
    .where(and(eq(lifetimeLicenses.tenantId, tenantId), inArray(lifetimeLicenses.status, ["inactive", "active"])))
    .orderBy(desc(lifetimeLicenses.tier), desc(lifetimeLicenses.claimedAt))
    .limit(1);
  return row ?? null;
}

/** How many tiers' worth of licences this workspace holds (a tier-2 licence counts as 2). */
export async function workspaceTotal(db: Conn, tenantId: string): Promise<number> {
  const r = await db.execute<{ n: string }>(sql`
    SELECT COALESCE(sum(tier), 0)::text AS n FROM lifetime_licenses
    WHERE tenant_id = ${tenantId}::uuid AND status IN ('inactive', 'active')`);
  return Number(r.rows[0]?.n ?? 0);
}

// ---------------------------------------------------------------------------
// Granting and ending a plan
// ---------------------------------------------------------------------------

async function grant(db: Conn, tenantId: string, plan: string): Promise<void> {
  await db.update(tenants).set({ plan, trialEndsAt: null, planPaidThrough: null }).where(eq(tenants.id, tenantId));
  // Lifetime plans send through the customer's own provider.
  await db.update(managedSending).set({ enabled: false, updatedAt: new Date() }).where(eq(managedSending.tenantId, tenantId));
}

/** End lifetime access: only a workspace that is on a lifetime plan falls back to no plan. */
async function revoke(db: Conn, tenantId: string): Promise<void> {
  const [t] = await db.select({ plan: tenants.plan }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  if (t && isLifetimePlanId(t.plan)) await db.update(tenants).set({ plan: "free" }).where(eq(tenants.id, tenantId));
}

/** Set the workspace's plan from the licences it holds: 1 = tier 1, 2 = tier 2, 3 or more = tier 3, none = ended. */
export async function applyTotal(db: Conn, tenantId: string): Promise<number> {
  const total = await workspaceTotal(db, tenantId);
  const plan = lifetimePlanForTotal(total);
  if (plan) await grant(db, tenantId, plan);
  else await revoke(db, tenantId);
  return total;
}

// ---------------------------------------------------------------------------
// A customer claims a licence
// ---------------------------------------------------------------------------

export interface ClaimResult {
  license_key: string;
  tier: number;
  plan_code: string;
  codes: number;
}

/** Tie a licence to a workspace and unlock its tier. Idempotent for the same workspace; another licence stacks. */
export async function claimLicense(db: Db, tenantId: string, licenseKey: string, now: Date = new Date()): Promise<ClaimResult> {
  return db.transaction(async (tx) => {
    // Serialise everything that changes this workspace's plan.
    const [tenant] = await tx.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, tenantId)).for("update").limit(1);
    if (!tenant) throw new LifetimeError(404, "Workspace not found.");

    const row = await findLicense(tx, licenseKey);
    if (!row) {
      throw new LifetimeError(
        404,
        "We do not recognise that code. Check it for typos, or find it on your AppSumo account. If you only just bought it, wait a minute and try again.",
      );
    }
    if (row.status === "deactivated" || row.status === "superseded") {
      throw new LifetimeError(400, "That code is no longer active (it was refunded or replaced).");
    }
    if (row.tenantId && row.tenantId !== tenantId) throw new LifetimeError(409, "That code is already used by another workspace.");

    if (row.tenantId !== tenantId) {
      const live = await tx.execute<{ n: string }>(sql`
        SELECT count(*)::text AS n FROM subscriptions
        WHERE tenant_id = ${tenantId}::uuid AND status IN ('active', 'cancelled') AND current_period_end > ${now.toISOString()}::timestamptz`);
      if (Number(live.rows[0]?.n ?? 0) > 0) {
        throw new LifetimeError(409, "This workspace has a paid subscription. Cancel it first, or redeem your code in a new workspace.");
      }
      if ((await workspaceTotal(tx, tenantId)) >= MAX_LIFETIME_TIER) {
        throw new LifetimeError(409, `This workspace already has the most you can stack (tier ${MAX_LIFETIME_TIER}). Use this code on another workspace.`);
      }
      await tx
        .update(lifetimeLicenses)
        .set({ tenantId, claimedAt: row.claimedAt ?? now, updatedAt: now })
        .where(eq(lifetimeLicenses.licenseKey, row.licenseKey));
    }
    const total = await applyTotal(tx, tenantId);
    const tier = Math.min(total, MAX_LIFETIME_TIER);
    return { license_key: row.licenseKey, tier, plan_code: planCodeForTier(tier), codes: total };
  });
}

/** A licence was refunded: it stops counting, and its workspace drops a tier or ends. */
export async function deactivateLicense(db: Db, key: string, event = "deactivate", now: Date = new Date()): Promise<string> {
  return db.transaction(async (tx) => {
    const row = await findLicense(tx, key);
    if (!row) return "unknown";
    if (row.status === "superseded") return "superseded: nothing to end";
    if (row.tenantId) await tx.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, row.tenantId)).for("update");
    await tx
      .update(lifetimeLicenses)
      .set({ status: "deactivated", lastEvent: event, deactivatedAt: now, updatedAt: now })
      .where(eq(lifetimeLicenses.licenseKey, row.licenseKey));
    if (row.tenantId) await applyTotal(tx, row.tenantId);
    return "deactivated" + (row.tenantId ? " (workspace updated)" : "");
  });
}

// ---------------------------------------------------------------------------
// AppSumo webhooks
// ---------------------------------------------------------------------------

async function record(db: Conn, payload: Record<string, unknown>, outcome: string): Promise<void> {
  await db.insert(appsumoEvents).values({
    licenseKey: String(payload.license_key ?? "").slice(0, 80),
    event: String(payload.event ?? "").slice(0, 20),
    payload,
    outcome: outcome.slice(0, 200),
  });
}

/** Apply one verified webhook. Returns a short outcome for the audit log. Safe to receive twice. */
export async function handleEvent(db: Db, payload: Record<string, unknown>, log?: { warn: (msg: string) => void }): Promise<string> {
  const ev = String(payload.event ?? "");
  const key = String(payload.license_key ?? "").trim();
  if (payload.test) {
    await record(db, payload, "test: no change");
    return "test";
  }
  if (payload.parent_license_key || ev === "migrate") {
    await record(db, payload, "add-on event ignored (Loomail sells no add-ons)");
    return "ignored";
  }
  if (!key) {
    await record(db, payload, "no licence key");
    return "ignored";
  }
  const tier = tierOf(payload);
  const plan = planCodeForTier(tier);
  const now = new Date();
  let out: string;

  if (ev === "purchase") {
    await db
      .insert(lifetimeLicenses)
      .values({ licenseKey: key, tier, planCode: plan, status: "inactive", lastEvent: "purchase" })
      .onConflictDoUpdate({
        target: lifetimeLicenses.licenseKey,
        set: { tier, planCode: plan, lastEvent: "purchase", updatedAt: now },
        setWhere: eq(lifetimeLicenses.status, "inactive"),
      });
    out = "purchase stored";
    const sp = await spots(db);
    if (sp.cap && sp.sold >= Math.min(ALERT_AT, sp.cap)) {
      log?.warn(`OPERATOR ALERT [lifetime] ${sp.sold} of ${sp.cap} founding licences sold: end the AppSumo deal at ${sp.cap}`);
    }
  } else if (ev === "activate") {
    await db
      .insert(lifetimeLicenses)
      .values({ licenseKey: key, tier, planCode: plan, status: "active", lastEvent: "activate", activatedAt: now })
      .onConflictDoUpdate({
        target: lifetimeLicenses.licenseKey,
        set: { status: "active", lastEvent: "activate", activatedAt: sql`COALESCE(${lifetimeLicenses.activatedAt}, now())`, updatedAt: now },
        setWhere: inArray(lifetimeLicenses.status, ["inactive", "active"]),
      });
    out = "activated";
  } else if (ev === "upgrade" || ev === "downgrade") {
    const prev = String(payload.prev_license_key ?? "").trim();
    const prevRow = prev ? await getLicense(db, prev) : null;
    const tenantId = prevRow?.tenantId ?? null;
    await db.transaction(async (tx) => {
      await tx
        .insert(lifetimeLicenses)
        .values({
          licenseKey: key,
          tier,
          planCode: plan,
          status: "active",
          tenantId,
          prevLicenseKey: prev || null,
          lastEvent: ev,
          activatedAt: now,
          claimedAt: tenantId ? now : null,
        })
        .onConflictDoUpdate({
          target: lifetimeLicenses.licenseKey,
          set: {
            tier,
            planCode: plan,
            status: "active",
            tenantId: sql`COALESCE(${lifetimeLicenses.tenantId}, ${tenantId})`,
            prevLicenseKey: prev || null,
            lastEvent: ev,
            updatedAt: now,
          },
        });
      if (prevRow) {
        await tx.update(lifetimeLicenses).set({ status: "superseded", lastEvent: ev, updatedAt: now }).where(eq(lifetimeLicenses.licenseKey, prev));
      }
      // The customer keeps working on the new tier straight away.
      if (tenantId) await applyTotal(tx, tenantId);
    });
    out = `${ev}: ${prev.slice(0, 8) || "?"} -> ${key.slice(0, 8)}` + (tenantId ? " (workspace moved)" : " (not yet claimed)");
  } else if (ev === "deactivate") {
    if (await getLicense(db, key)) {
      out = await deactivateLicense(db, key);
    } else {
      await db
        .insert(lifetimeLicenses)
        .values({ licenseKey: key, tier, planCode: plan, status: "deactivated", lastEvent: "deactivate", deactivatedAt: now })
        .onConflictDoNothing();
      out = "deactivate for an unknown licence stored";
    }
  } else {
    out = `unknown event '${ev}' ignored`;
  }
  await record(db, payload, out);
  return out;
}

// ---------------------------------------------------------------------------
// Codes Loomail generates (the CSV given to AppSumo)
// ---------------------------------------------------------------------------

/** Make `n` new unused codes (one workspace redeems each; they stack on one workspace up to the top tier). */
export async function generateCodes(db: Db, n: number, tier = 1): Promise<string[]> {
  const count = Math.max(1, Math.min(Math.floor(n) || 1, 10_000));
  const t = Math.max(1, Math.min(MAX_LIFETIME_TIER, Math.floor(tier) || 1));
  const plan = planCodeForTier(t);
  const made: string[] = [];
  while (made.length < count) {
    const batch = [...new Set(Array.from({ length: Math.min(250, count - made.length) }, newCode))];
    const rows = await db
      .insert(lifetimeLicenses)
      .values(batch.map((licenseKey) => ({ licenseKey, tier: t, planCode: plan, status: "inactive", lastEvent: "generated", source: "code" })))
      .onConflictDoNothing()
      .returning({ licenseKey: lifetimeLicenses.licenseKey });
    made.push(...rows.map((r) => r.licenseKey));
  }
  return made;
}

/** The file AppSumo asks for: plain text, one code per line, one column, no header. */
export async function codesCsv(db: Db, onlyUnclaimed = true): Promise<string> {
  const rows = await db
    .select({ key: lifetimeLicenses.licenseKey })
    .from(lifetimeLicenses)
    .where(
      onlyUnclaimed
        ? sql`${lifetimeLicenses.source} = 'code' AND ${lifetimeLicenses.status} = 'inactive' AND ${lifetimeLicenses.tenantId} IS NULL`
        : sql`${lifetimeLicenses.source} = 'code'`,
    )
    .orderBy(lifetimeLicenses.createdAt, lifetimeLicenses.licenseKey);
  return rows.map((r) => `${r.key}\n`).join("");
}

export async function codesSummary(db: Db): Promise<{ total: number; unused: number; redeemed: number; refunded: number }> {
  const r = await db.execute<Record<string, string>>(sql`
    SELECT count(*) FILTER (WHERE source = 'code')::text AS total,
           count(*) FILTER (WHERE source = 'code' AND status = 'inactive' AND tenant_id IS NULL)::text AS unused,
           count(*) FILTER (WHERE source = 'code' AND tenant_id IS NOT NULL AND status IN ('inactive', 'active'))::text AS redeemed,
           count(*) FILTER (WHERE source = 'code' AND status = 'deactivated')::text AS refunded
    FROM lifetime_licenses`);
  const row = r.rows[0] ?? {};
  return { total: Number(row.total ?? 0), unused: Number(row.unused ?? 0), redeemed: Number(row.redeemed ?? 0), refunded: Number(row.refunded ?? 0) };
}

/** Licences that have been bought, claimed or refunded (an unclaimed generated code is not shown), newest first. */
export async function recentLicenses(db: Db, limit = 100) {
  const r = await db.execute<{
    license_key: string;
    tier: number;
    status: string;
    tenant_id: string | null;
    tenant_name: string | null;
    last_event: string;
    created_at: Date | string;
    claimed_at: Date | string | null;
    deactivated_at: Date | string | null;
    source: string;
  }>(sql`
    SELECT l.license_key, l.tier, l.status, l.tenant_id, t.name AS tenant_name, l.last_event, l.created_at, l.claimed_at, l.deactivated_at, l.source
    FROM lifetime_licenses l LEFT JOIN tenants t ON t.id = l.tenant_id
    WHERE NOT (l.source = 'code' AND l.tenant_id IS NULL AND l.status = 'inactive')
    ORDER BY l.updated_at DESC LIMIT ${limit}`);
  const iso = (v: Date | string | null) => (v ? new Date(v).toISOString() : null);
  return r.rows.map((x) => ({
    license_key: x.license_key,
    // A generated code is ours, so it is shown whole; AppSumo's own keys are abbreviated.
    license_key_short: x.source === "code" ? x.license_key : `${x.license_key.slice(0, 8)}…${x.license_key.slice(-4)}`,
    tier: x.tier,
    status: x.status,
    workspace_id: x.tenant_id,
    workspace_name: x.tenant_name,
    last_event: x.last_event,
    created_at: iso(x.created_at),
    claimed_at: iso(x.claimed_at),
    deactivated_at: iso(x.deactivated_at),
    source: x.source,
  }));
}

/** This workspace's standing, for the plan page. */
export async function workspaceView(db: Db, tenantId: string) {
  const lic = await licenseForTenant(db, tenantId);
  const total = await workspaceTotal(db, tenantId);
  return {
    license: lic ? { tier: Math.min(total, MAX_LIFETIME_TIER) || lic.tier, status: lic.status, key_hint: `${lic.licenseKey.slice(0, 8)}…`, codes: total } : null,
    max_tier: MAX_LIFETIME_TIER,
    total,
  };
}

/** Whether this workspace has a live paid subscription (which blocks redeeming a licence). */
export async function hasLiveSubscription(db: Conn, tenantId: string, now: Date = new Date()): Promise<boolean> {
  const r = await db.execute<{ n: string }>(sql`
    SELECT count(*)::text AS n FROM subscriptions
    WHERE tenant_id = ${tenantId}::uuid AND status IN ('active', 'cancelled') AND current_period_end > ${now.toISOString()}::timestamptz`);
  return Number(r.rows[0]?.n ?? 0) > 0;
}
