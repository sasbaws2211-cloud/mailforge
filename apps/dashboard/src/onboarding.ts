/**
 * Onboarding hooks and the small pure rules the onboarding UI uses.
 *
 * The server decides what is done (GET /v1/onboarding looks at what is actually in the
 * workspace). This file only fetches that, saves "do this later", and turns it into the
 * few words the screen shows.
 *
 * Mirror side: PUBLIC (apps/dashboard is mirrored).
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "./api.js";

export type OnboardingGoal = "welcome" | "convert_trials" | "upgrade_free" | "explore";

export type WaitingReason = "no_sender" | "needs_domain" | "paused" | "no_address";

export interface OnboardingStep {
  id: string;
  title: string;
  description: string;
  done: boolean;
  href: string;
  cta: string;
  minutes: number;
}

export interface OnboardingInfo {
  /** False on a self-hosted install: it keeps its own setup screen. */
  hosted: boolean;
  steps: OnboardingStep[];
  done: number;
  total: number;
  percent: number;
  complete: boolean;
  next: string | null;
  minutes_left: number;
  has_ingest_key: boolean;
  /** Approved email that cannot go out yet (counted up to 100). */
  waiting_emails: number;
  /** Why it cannot go out, or null when nothing is wrong with the setup. */
  waiting_reason: WaitingReason | null;
  /** What they said they wanted at signup, or null. */
  goal: OnboardingGoal | null;
  /** The ready-made flows that fit the goal, and whether a template has already been applied. */
  goal_suggestion: { template_id: string; name: string; flow_count: number; applied: boolean } | null;
  /** The customer chose "later". */
  dismissed: boolean;
  completed_at: string | null;
}

export const ONBOARDING_QUERY_KEY = ["onboarding"] as const;

async function fetchOnboarding(): Promise<OnboardingInfo> {
  const res = await apiFetch("/v1/onboarding");
  if (!res.ok) throw new Error(`/v1/onboarding returned ${res.status}`);
  return res.json() as Promise<OnboardingInfo>;
}

async function setDismissed(dismissed: boolean): Promise<void> {
  const res = await apiFetch("/v1/onboarding", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dismissed }),
  });
  if (!res.ok) throw new Error(`/v1/onboarding returned ${res.status}`);
}

/** Progress is refreshed often: the customer is busy changing the things it measures. */
export function useOnboarding() {
  return useQuery({
    queryKey: ONBOARDING_QUERY_KEY,
    queryFn: fetchOnboarding,
    staleTime: 10_000,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });
}

export function useDismissOnboarding() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (dismissed: boolean) => setDismissed(dismissed),
    onSuccess: () => qc.invalidateQueries({ queryKey: ONBOARDING_QUERY_KEY }),
  });
}

export type StepState = "done" | "next" | "todo";

/** How each step is drawn: done, the one to do now, or still ahead. */
export function stepStates(info: Pick<OnboardingInfo, "steps" | "next">): Array<{ step: OnboardingStep; state: StepState }> {
  return info.steps.map((step) => ({
    step,
    state: step.done ? "done" : step.id === info.next ? "next" : "todo",
  }));
}

/** "About 17 minutes left", "About 1 minute left", or null when nothing is left. */
export function timeLeftLabel(minutes: number): string | null {
  if (minutes <= 0) return null;
  return `About ${minutes} minute${minutes === 1 ? "" : "s"} left`;
}

/** The headline over the checklist: gets warmer as the customer gets closer. */
export function onboardingHeadline(info: Pick<OnboardingInfo, "done" | "total" | "complete">, workspaceName: string | null): string {
  if (info.complete) return "You are live";
  if (info.done <= 1) return workspaceName ? `Welcome, ${workspaceName}` : "Welcome";
  if (info.total - info.done === 1) return "One step left";
  return "You are getting there";
}

/** The sentence under the headline. */
export function onboardingSubline(info: Pick<OnboardingInfo, "done" | "total" | "complete" | "minutes_left">): string {
  if (info.complete) return "Your first email has been delivered. Everything is set up.";
  const left = timeLeftLabel(info.minutes_left);
  const base = `${info.done} of ${info.total} done.`;
  return left ? `${base} ${left} to your first delivered email.` : base;
}

/** A step's link when it only scrolls the current page (href like "/home#welcome-flow"). */
export function hashTarget(href: string, currentPath = "/home"): string | null {
  const i = href.indexOf("#");
  if (i < 0) return null;
  return href.slice(0, i) === currentPath ? href.slice(i + 1) : null;
}

/** How long the "you are live" card stays on Home after the last step is done. */
export const COMPLETION_CARD_DAYS = 3;

/** True while the customer has just finished: complete, with a recent completion date. */
export function justCompleted(info: Pick<OnboardingInfo, "complete" | "completed_at">, now: Date = new Date()): boolean {
  if (!info.complete || !info.completed_at) return false;
  const at = new Date(info.completed_at).getTime();
  if (Number.isNaN(at)) return false;
  const age = now.getTime() - at;
  return age >= 0 && age < COMPLETION_CARD_DAYS * 86_400_000;
}

export interface WaitingNotice {
  title: string;
  body: string;
  to: string;
  cta: string;
}

/** What to tell the customer when approved email cannot go out. Null = say nothing. */
export function waitingNotice(info: Pick<OnboardingInfo, "waiting_emails" | "waiting_reason">): WaitingNotice | null {
  const n = info.waiting_emails;
  if (n <= 0 || !info.waiting_reason) return null;
  const count = n >= 100 ? "100+" : String(n);
  const title = n === 1 ? "1 email is waiting to be sent" : `${count} emails are waiting to be sent`;
  switch (info.waiting_reason) {
    case "no_sender":
      return { title, body: "Nothing is set up to send them yet. They will go out as soon as sending is set up.", to: "/settings/transport", cta: "Set up sending" };
    case "needs_domain":
      return { title, body: "Mailforge Sending needs a verified domain before it can send. Add your domain and the DNS records.", to: "/settings/transport", cta: "Add a domain" };
    case "paused":
      return { title, body: "Sending is paused for this workspace, so nothing is going out. Open sending to see why.", to: "/settings/transport", cta: "See why" };
    case "no_address":
      return { title, body: "They cannot be sent until your business address is saved. It is required in every email footer.", to: "/settings/postal", cta: "Add address" };
  }
}

export interface GoalCard {
  title: string;
  body: string;
  button: string;
  templateId: string;
}

const GOAL_SENTENCE: Record<string, string> = {
  convert_trials: "turn trial users into paying customers",
  upgrade_free: "move free users to a paid plan",
};

/**
 * The card that picks up the goal chosen at signup, once the Welcome flow is on. Null when the goal has
 * no matching flows, they are already applied, or the Welcome flow is not on yet (one thing at a time).
 */
export function goalCard(info: Pick<OnboardingInfo, "goal" | "goal_suggestion" | "steps">): GoalCard | null {
  const s = info.goal_suggestion;
  if (!info.goal || !s || s.applied) return null;
  if (!(info.steps.find((x) => x.id === "flow")?.done ?? false)) return null;
  const sentence = GOAL_SENTENCE[info.goal];
  if (!sentence) return null;
  return {
    title: `You said you want to ${sentence}`,
    body: `Add the ${s.name} flows: ${s.flow_count} ready-made drafts. Nothing sends until you review, compile and switch each one on.`,
    button: `Add ${s.flow_count} draft flows`,
    templateId: s.template_id,
  };
}

// ---------------------------------------------------------------------------
// Sample event (no API key needed)
// ---------------------------------------------------------------------------

export interface SampleResult {
  ok: true;
  sent_to: string;
  flow_active: boolean;
  sender_ready: boolean;
  /** An earlier sample was sent from this workspace. */
  repeat: boolean;
}

/** Thrown with a sentence safe to show. */
export class SampleError extends Error {}

async function sendSample(): Promise<SampleResult> {
  const res = await apiFetch("/v1/onboarding/sample-event", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  if (res.ok) return res.json() as Promise<SampleResult>;
  let body: { error?: string; code?: string } = {};
  try {
    body = (await res.json()) as typeof body;
  } catch {
    /* no body */
  }
  if (res.status === 402) throw new SampleError("Your workspace is at its contact limit, so a sample contact cannot be added. See Plan & usage.");
  throw new SampleError(body.error ?? `The sample could not be sent (${res.status}).`);
}

export function useSendSample() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: sendSample,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ONBOARDING_QUERY_KEY });
      void qc.invalidateQueries({ queryKey: ["ingestion"] });
    },
  });
}

/** What to tell the customer after a sample: what happened, and what is still missing. */
export function sampleMessage(r: Pick<SampleResult, "sent_to" | "flow_active" | "sender_ready" | "repeat">): { tone: "ok" | "warn"; text: string } {
  if (!r.flow_active) {
    return { tone: "warn", text: "Sample event received, but no flow is turned on yet, so no email will go out. Turn on the Welcome flow first, then send another." };
  }
  if (!r.sender_ready) {
    return { tone: "warn", text: "Sample event received and the flow started, but nothing is set up to send email yet, so the email will wait until sending is set up." };
  }
  if (r.repeat) {
    return { tone: "ok", text: `Sample sent again. Most flows only run once for the same contact, so you may not get another email at ${r.sent_to}.` };
  }
  return { tone: "ok", text: `Sample sent. Check ${r.sent_to} in a few seconds for the first email.` };
}
