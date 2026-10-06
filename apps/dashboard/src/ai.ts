/**
 * Pure rules for how the dashboard talks about AI: where a workspace's AI comes
 * from, how much of its Mailforge AI allowance is used, and what to tell the
 * customer about it.
 *
 * Mirror side: PUBLIC (apps/dashboard is mirrored).
 */
import type { AiSource, LlmAiInfo, PlanMeterState } from "./api.js";

/** Share of the allowance at which the customer is warned. Same as the plan meters. */
export const AI_NEAR_FRACTION = 0.8;

export function aiMeterState(limit: number | null, used: number): PlanMeterState {
  if (limit === null) return "unlimited";
  if (used > limit) return "over";
  if (used === limit) return "at_limit";
  if (limit > 0 && used / limit >= AI_NEAR_FRACTION) return "near";
  return "ok";
}

/** "1,500,000" */
export const tokens = (n: number): string => n.toLocaleString("en-US");

/** Whole percent of the allowance used, capped at 100, for drawing a bar. 0 when there is no cap. */
export function aiPercent(limit: number | null, used: number): number {
  if (limit === null || limit <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((used / limit) * 100)));
}

/** "Nov 1" style date for when the allowance resets. */
export function resetDay(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

export interface AiSummary {
  /** Short heading for the card. */
  heading: string;
  /** One or two plain sentences under it. */
  body: string;
  /** warning when something has stopped or is about to; info otherwise. */
  tone: "success" | "warning" | "info";
  /** Show the usage bar (Mailforge AI with a cap only). */
  showMeter: boolean;
}

/**
 * What to say about a workspace's AI. The customer never sees which vendor or
 * model sits behind Mailforge AI, only what it costs them in allowance.
 */
export function describeAi(ai: LlmAiInfo): AiSummary {
  const { source, allowance, name } = ai;
  if (source === "byok") {
    return {
      heading: "Using your own AI key",
      body: "Drafts, compiles and search run on your provider and are billed by them. No Mailforge AI allowance is used.",
      tone: "success",
      showMeter: false,
    };
  }
  if (source === "none") {
    return {
      heading: "No AI provider yet",
      body: "Add your own key to turn on AI drafting and flow compiling.",
      tone: "warning",
      showMeter: false,
    };
  }
  // platform
  if (ai.unavailable) {
    return {
      heading: `${name} is temporarily unavailable`,
      body: "AI drafting and compiling are paused for now. Add your own AI key to carry on straight away, or try again later. Nothing you have is deleted, and anything waiting for AI will continue when it is back.",
      tone: "warning",
      showMeter: false,
    };
  }
  if (allowance.limit === null) {
    return {
      heading: `${name} is on`,
      body: "It is included with your workspace. There is nothing to set up.",
      tone: "success",
      showMeter: false,
    };
  }
  if (allowance.spent) {
    return {
      heading: `${name} allowance used up`,
      body: `You have used all ${tokens(allowance.limit)} ${name} tokens included in your ${allowance.plan} plan this month. AI drafting and compiling are paused until ${resetDay(allowance.resets_at)}. Upgrade your plan or add your own key to carry on now. Nothing you have is deleted.`,
      tone: "warning",
      showMeter: true,
    };
  }
  const state = aiMeterState(allowance.limit, allowance.used);
  return {
    heading: `${name} is on`,
    body:
      state === "near"
        ? `Included with your ${allowance.plan} plan. You are close to this month's allowance; add your own key to avoid hitting it.`
        : `Included with your ${allowance.plan} plan. There is nothing to set up.`,
    tone: state === "near" ? "warning" : "success",
    showMeter: true,
  };
}

/** A short label for a source, for badges and tables. */
export const AI_SOURCE_LABEL: Record<AiSource, string> = {
  byok: "Own key",
  platform: "Mailforge AI",
  none: "None",
};
