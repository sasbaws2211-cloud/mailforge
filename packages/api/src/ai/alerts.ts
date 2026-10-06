/**
 * Operator alert: Mailforge AI is failing.
 *
 * When most calls on the operator's own provider fail (a revoked key, an unpaid
 * provider bill, an outage), every workspace without its own key loses AI at
 * once, and nobody would otherwise notice until a customer complained. This
 * looks at the last few minutes of calls and emails every platform admin.
 *
 * One email per incident, then a reminder after the cooldown while it lasts; the
 * state is kept in platform_alert_state so a restart does not repeat it. The
 * admin console shows the same health live (GET /v1/admin/ai), whether or not
 * email is configured.
 *
 * Only calls on the operator's provider count. A customer's broken own key is
 * the customer's problem and never pages the operator.
 *
 * Mirror side: PUBLIC (packages/api is mirrored).
 */
import { eq, sql } from "drizzle-orm";
import {
  AI_ALERT_COOLDOWN_MINUTES,
  AI_ALERT_FAIL_RATE,
  AI_ALERT_MIN_CALLS,
  AI_ALERT_WINDOW_MINUTES,
  aiBudgetState,
  aiHealth,
  startOfMonthUtc,
  shouldSendAiAlert,
  type AiHealth,
} from "@mailforge/core";
import { platformAlertState } from "@mailforge/db/schema";
import { loadAiBudgetStatus } from "@mailforge/db/llm";
import type { Db } from "../plugins/db.js";
import { getPlatformTransport, type PlatformTransport } from "../platform-mailer.js";
import { platformAdminEmails } from "../admin/platform-admins.js";

export const AI_ALERT_KEY = "ai_failure_rate";

function numberFromEnv(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

/** Thresholds, with optional overrides: MAILFORGE_AI_ALERT_MIN_CALLS, _FAIL_RATE (0 to 1), _WINDOW_MINUTES. */
export function aiAlertSettings(env: NodeJS.ProcessEnv = process.env) {
  return {
    minCalls: Math.round(numberFromEnv(env.MAILFORGE_AI_ALERT_MIN_CALLS, AI_ALERT_MIN_CALLS, 1, 100_000)),
    failRate: numberFromEnv(env.MAILFORGE_AI_ALERT_FAIL_RATE, AI_ALERT_FAIL_RATE, 0.01, 1),
    windowMinutes: Math.round(numberFromEnv(env.MAILFORGE_AI_ALERT_WINDOW_MINUTES, AI_ALERT_WINDOW_MINUTES, 1, 1440)),
    cooldownMinutes: Math.round(numberFromEnv(env.MAILFORGE_AI_ALERT_COOLDOWN_MINUTES, AI_ALERT_COOLDOWN_MINUTES, 1, 10_080)),
  };
}

/** How the operator's provider has been doing lately. */
export async function loadAiHealth(db: Db, now: Date = new Date(), env: NodeJS.ProcessEnv = process.env): Promise<AiHealth> {
  const s = aiAlertSettings(env);
  const since = new Date(now.getTime() - s.windowMinutes * 60_000);
  const r = await db.execute<{ calls: string; failed: string }>(sql`
    SELECT count(*)::text AS calls, count(*) FILTER (WHERE NOT ok)::text AS failed
    FROM llm_usage WHERE source = 'platform' AND created_at >= ${since.toISOString()}::timestamptz`);
  return aiHealth(Number(r.rows[0]?.calls ?? 0), Number(r.rows[0]?.failed ?? 0), {
    minCalls: s.minCalls,
    failRate: s.failRate,
    windowMinutes: s.windowMinutes,
  });
}

export function buildAiAlertEmail(health: AiHealth, consoleUrl: string): { subject: string; text: string; html: string } {
  const pct = Math.round(health.rate * 100);
  const subject = `Mailforge AI is failing: ${pct}% of calls in the last ${health.windowMinutes} minutes`;
  const lines = [
    `${health.failed} of ${health.calls} Mailforge AI calls failed in the last ${health.windowMinutes} minutes (${pct}%).`,
    "",
    "Every workspace that has no AI key of its own is affected: AI drafting and flow compiling are failing for them,",
    "and emails waiting for AI-written content are stuck. Customers on their own key are not affected.",
    "",
    "Usual causes: the provider key was revoked or ran out of credit, the provider is having an outage, or you hit its rate limit.",
    "What to do: open the AI providers page, press Test key on each provider, and switch on a fallback from a different vendor if you have none.",
    "",
    consoleUrl,
    "",
    "You will get one reminder an hour while this lasts, and nothing once it recovers.",
  ];
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const html =
    `<p><strong>${esc(lines[0]!)}</strong></p>` +
    `<p>${esc(lines.slice(2, 4).join(" "))}</p>` +
    `<p>${esc(lines[5]!)}<br>${esc(lines[6]!)}</p>` +
    `<p><a href="${esc(consoleUrl)}">Open AI providers</a></p>` +
    `<p style="color:#666">${esc(lines[10]!)}</p>`;
  return { subject, text: lines.join("\n"), html };
}

// ---------------------------------------------------------------------------
// Monthly dollar budget alerts
// ---------------------------------------------------------------------------

const usd = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function buildAiBudgetEmail(
  kind: "near" | "reached",
  budgetUsd: number,
  spentUsd: number,
  consoleUrl: string,
  resetsOn: string,
): { subject: string; text: string; html: string } {
  const pct = Math.round((spentUsd / budgetUsd) * 100);
  const subject =
    kind === "near"
      ? `Mailforge AI spend: ${pct}% of your ${usd(budgetUsd)} monthly budget used`
      : `Mailforge AI is paused: your ${usd(budgetUsd)} monthly budget is used up`;
  const lines =
    kind === "near"
      ? [
          `Mailforge AI has cost ${usd(spentUsd)} this month, ${pct}% of your ${usd(budgetUsd)} budget.`,
          "",
          "At 100% Mailforge AI pauses for every workspace that has no AI key of its own. Customers on their own key are not affected.",
          `If you expect more use this month, raise the budget now. It resets on ${resetsOn}.`,
        ]
      : [
          `Mailforge AI has cost ${usd(spentUsd)} this month and reached your ${usd(budgetUsd)} budget, so it is now paused.`,
          "",
          "Workspaces without their own AI key cannot draft, compile or generate emails until you raise the budget or the month rolls over.",
          "Nothing is lost: emails waiting for AI-written content stay queued and carry on automatically. Customers on their own key are not affected.",
          `It resets on ${resetsOn}.`,
        ];
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const body = lines.filter((l) => l !== "");
  const html =
    `<p><strong>${esc(body[0]!)}</strong></p>` +
    body.slice(1).map((l) => `<p>${esc(l)}</p>`).join("") +
    `<p><a href="${esc(consoleUrl)}">Open AI providers</a></p>`;
  return { subject, text: [...lines, "", consoleUrl].join("\n"), html };
}

/** Why Mailforge AI is back after a budget pause. */
export type AiResumeCause = "raised" | "removed" | "new_month";

export function buildAiResumedEmail(
  cause: AiResumeCause,
  budgetUsd: number | null,
  spentUsd: number,
  consoleUrl: string,
): { subject: string; text: string; html: string } {
  const why =
    cause === "removed"
      ? "The monthly budget was removed, so Mailforge AI is back on."
      : cause === "new_month"
        ? "A new month has begun, so the budget has reset and Mailforge AI is back on."
        : `The monthly budget was raised to ${usd(budgetUsd ?? 0)} (${usd(spentUsd)} spent so far), so Mailforge AI is back on.`;
  const lines = [
    why,
    "",
    "Workspaces without their own AI key can draft, compile and generate emails again. Emails that were waiting for AI-written content are carrying on by themselves, and nothing needs doing.",
  ];
  const esc = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return {
    subject: "Mailforge AI is back on",
    text: [...lines, "", consoleUrl].join("\n"),
    html: `<p><strong>${esc(lines[0]!)}</strong></p><p>${esc(lines[2]!)}</p><p><a href="${esc(consoleUrl)}">Open AI providers</a></p>`,
  };
}

/** Set while Mailforge AI is paused for the budget, so the email that says it is back goes out exactly once. */
export const AI_BUDGET_PAUSED_KEY = "ai_budget_paused";

/**
 * Warn at 80% of the monthly dollar budget, again when it is used up (which is
 * also when Mailforge AI pauses), and say when it is back (budget raised or
 * removed, or the month rolled over). The two warnings fire once per month per
 * budget amount: raising the budget lets the next threshold alert again. The
 * "back on" email fires once per pause. Nothing is marked as sent unless an
 * email really went out, so a missing sender or a failed delivery is retried at
 * the next check. Never throws.
 */
export async function checkAiBudgetAlert(
  db: Db,
  now: Date = new Date(),
  opts: AiAlertOptions = {},
): Promise<{ state: string; sent: number; resumed: boolean }> {
  const env = opts.env ?? process.env;
  try {
    const { budgetUsd, spentUsd } = await loadAiBudgetStatus(db, startOfMonthUtc(now));
    const state = aiBudgetState(budgetUsd, spentUsd);
    const month = now.toISOString().slice(0, 7);
    const base = (env.MAILFORGE_ADMIN_URL || env.BASE_URL || "").replace(/\/+$/, "");
    const consoleUrl = `${base}/admin/ai`;

    const mark = (k: string, active: boolean, at: Date | null) =>
      db
        .insert(platformAlertState)
        .values({ key: k, active, lastSentAt: at, updatedAt: now })
        .onConflictDoUpdate({ target: platformAlertState.key, set: { active, lastSentAt: at, updatedAt: now } });

    /** Email every platform admin. Returns how many got it, or null when there is no way to send at all. */
    const emailAdmins = async (mail: { subject: string; text: string; html: string }, idBase: string, what: string): Promise<number | null> => {
      const transport = opts.transport === undefined ? getPlatformTransport(env) : opts.transport;
      const admins = opts.admins ?? platformAdminEmails(env);
      if (!transport || admins.length === 0) {
        opts.log?.warn({ state, budgetUsd, spentUsd }, `${what} not sent: no platform email sender or no platform admins configured`);
        return null;
      }
      let sent = 0;
      for (const to of admins) {
        try {
          const r = await transport.adapter.send({
            to,
            from: transport.fromEmail,
            fromName: transport.fromName ?? undefined,
            subject: mail.subject,
            bodyHtml: mail.html,
            bodyText: mail.text,
            headers: {},
            messageId: `${idBase}-${to}`,
          });
          if (r.success) sent++;
          else opts.log?.warn({ to, error: r.error }, `${what} not delivered`);
        } catch (err) {
          opts.log?.warn({ to, error: err instanceof Error ? err.message : String(err) }, `${what} not delivered`);
        }
      }
      return sent;
    };

    let total = 0;
    let resumed = false;

    // Is Mailforge AI paused for the budget right now, and was it before?
    const [paused] = await db.select().from(platformAlertState).where(eq(platformAlertState.key, AI_BUDGET_PAUSED_KEY)).limit(1);
    if (state === "reached") {
      // Remember when the pause began (once), whether or not anyone could be emailed about it.
      if (!paused?.active) await mark(AI_BUDGET_PAUSED_KEY, true, now);
    } else if (paused?.active) {
      const cause: AiResumeCause =
        budgetUsd === null ? "removed" : paused.lastSentAt && paused.lastSentAt.toISOString().slice(0, 7) !== month ? "new_month" : "raised";
      const n = await emailAdmins(buildAiResumedEmail(cause, budgetUsd, spentUsd, consoleUrl), `ai-budget-resumed-${now.getTime()}`, "AI resumed notice");
      if (n !== null && n > 0) {
        await mark(AI_BUDGET_PAUSED_KEY, false, now);
        total += n;
        resumed = true;
        opts.log?.info({ cause, sent: n }, "AI resumed notice sent");
      }
    }

    if (budgetUsd === null || (state !== "near" && state !== "reached")) return { state, sent: total, resumed };

    const key = `ai_budget_${state}:${month}:${budgetUsd}`;
    const [done] = await db.select().from(platformAlertState).where(eq(platformAlertState.key, key)).limit(1);
    if (done) return { state, sent: total, resumed };

    const resets = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
    const mail = buildAiBudgetEmail(state, budgetUsd, spentUsd, consoleUrl, resets);
    const sent = await emailAdmins(mail, `ai-budget-${state}-${month}`, "AI budget alert");
    if (sent !== null && sent > 0) {
      await mark(key, true, now);
      // Passing 100% also covers the 80% warning, which would only be noise now.
      if (state === "reached") await mark(`ai_budget_near:${month}:${budgetUsd}`, true, now);
      opts.log?.info({ state, sent, budgetUsd, spentUsd }, "AI budget alert sent");
      total += sent;
    }
    return { state, sent: total, resumed };
  } catch (err) {
    opts.log?.warn({ error: err instanceof Error ? err.message : String(err) }, "AI budget alert check failed");
    return { state: "error", sent: 0, resumed: false };
  }
}

export interface AiAlertOptions {
  transport?: PlatformTransport | null;
  admins?: string[];
  consoleUrl?: string;
  env?: NodeJS.ProcessEnv;
  log?: { warn: (o: unknown, m?: string) => void; info: (o: unknown, m?: string) => void };
}

export interface AiAlertResult {
  health: AiHealth;
  /** Emails sent this check. */
  sent: number;
}

/**
 * Look at the last few minutes and email the platform admins if the provider is
 * failing and they have not been told recently. Never throws.
 */
export async function checkAiAlert(db: Db, now: Date = new Date(), opts: AiAlertOptions = {}): Promise<AiAlertResult> {
  const env = opts.env ?? process.env;
  const health = await loadAiHealth(db, now, env);
  try {
    const [state] = await db.select().from(platformAlertState).where(eq(platformAlertState.key, AI_ALERT_KEY)).limit(1);

    if (!health.unhealthy) {
      // Recovered: forget the incident so the next one alerts straight away.
      if (state?.active) {
        await db.update(platformAlertState).set({ active: false, updatedAt: now }).where(eq(platformAlertState.key, AI_ALERT_KEY));
      }
      return { health, sent: 0 };
    }

    const cooldown = aiAlertSettings(env).cooldownMinutes;
    if (!shouldSendAiAlert(health, state ? { active: state.active, lastSentAt: state.lastSentAt } : null, now, cooldown)) {
      return { health, sent: 0 };
    }

    const transport = opts.transport === undefined ? getPlatformTransport(env) : opts.transport;
    const admins = opts.admins ?? platformAdminEmails(env);
    if (!transport || admins.length === 0) {
      opts.log?.warn({ health }, "Mailforge AI is failing but no alert was sent: no platform email sender or no platform admins configured");
      return { health, sent: 0 };
    }

    const base = (env.MAILFORGE_ADMIN_URL || env.BASE_URL || "").replace(/\/+$/, "");
    const mail = buildAiAlertEmail(health, `${base}/admin/ai`);
    let sent = 0;
    for (const to of admins) {
      try {
        const r = await transport.adapter.send({
          to,
          from: transport.fromEmail,
          fromName: transport.fromName ?? undefined,
          subject: mail.subject,
          bodyHtml: mail.html,
          bodyText: mail.text,
          headers: {},
          messageId: `ai-alert-${now.getTime()}-${to}`,
        });
        if (r.success) sent++;
        else opts.log?.warn({ to, error: r.error }, "AI failure alert not delivered");
      } catch (err) {
        opts.log?.warn({ to, error: err instanceof Error ? err.message : String(err) }, "AI failure alert not delivered");
      }
    }
    // Only count it as told when someone actually was; otherwise try again at the next check.
    if (sent > 0) {
      await db
        .insert(platformAlertState)
        .values({ key: AI_ALERT_KEY, active: true, lastSentAt: now, updatedAt: now })
        .onConflictDoUpdate({ target: platformAlertState.key, set: { active: true, lastSentAt: now, updatedAt: now } });
      opts.log?.info({ sent, health }, "AI failure alert sent");
    }
    return { health, sent };
  } catch (err) {
    opts.log?.warn({ error: err instanceof Error ? err.message : String(err) }, "AI failure alert check failed");
    return { health, sent: 0 };
  }
}

/** Check every few minutes for as long as the process runs. Returns a function that stops it. */
export function startAiAlertMonitor(
  db: Db,
  opts: AiAlertOptions & { intervalMs?: number; firstCheckMs?: number } = {},
): () => void {
  const interval = opts.intervalMs ?? 5 * 60_000;
  const tick = () => {
    void checkAiAlert(db, new Date(), opts);
    void checkAiBudgetAlert(db, new Date(), opts);
  };
  const first = setTimeout(tick, opts.firstCheckMs ?? 60_000);
  const every = setInterval(tick, interval);
  // Never keep the process alive just for this.
  first.unref();
  every.unref();
  return () => {
    clearTimeout(first);
    clearInterval(every);
  };
}
