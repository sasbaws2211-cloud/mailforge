/**
 * Signup logic: input validation, slug generation, and a small in-memory
 * rate limiter. Pure functions, no I/O, so each is easy to test.
 *
 * Mirror side: PUBLIC (packages/api is mirrored).
 */
import { randomBytes } from "node:crypto";
import { isPlanId, parseGoal, TRIAL_PLAN, type OnboardingGoal, type PlanId } from "@mailforge/core";

export interface SignupInput {
  workspace: string;
  email: string;
  plan: PlanId;
  /** What they said they want to do first. Optional; an unknown value is ignored, never an error. */
  goal: OnboardingGoal | null;
}

export type SignupValidation =
  | { ok: true; value: SignupInput }
  /** A bot filled the honeypot: pretend success, do nothing. */
  | { ok: false; kind: "bot" }
  /** A human-fixable problem; message is safe to show. */
  | { ok: false; kind: "invalid"; message: string };

/** Throwaway-mailbox domains. Signing up with one is refused with a clear message. */
const DISPOSABLE_DOMAINS = new Set([
  "mailinator.com",
  "guerrillamail.com",
  "guerrillamail.net",
  "10minutemail.com",
  "yopmail.com",
  "tempmail.com",
  "temp-mail.org",
  "trashmail.com",
  "sharklasers.com",
  "getnada.com",
  "dispostable.com",
  "maildrop.cc",
  "throwawaymail.com",
  "fakeinbox.com",
]);

const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]{2,}$/;

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/** Coerce a form or JSON value to a trimmed string. */
function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

export function validateSignup(body: unknown): SignupValidation {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;

  // Honeypot: real people never see this field.
  if (str(b.website) !== "") return { ok: false, kind: "bot" };

  const workspace = str(b.workspace).replace(/\s+/g, " ");
  if (workspace.length < 2 || workspace.length > 60) {
    return { ok: false, kind: "invalid", message: "Enter a workspace name between 2 and 60 characters." };
  }

  const email = normalizeEmail(str(b.email));
  if (email.length > 254 || !EMAIL_RE.test(email)) {
    return { ok: false, kind: "invalid", message: "Enter a valid email address." };
  }
  const domain = email.slice(email.lastIndexOf("@") + 1);
  if (DISPOSABLE_DOMAINS.has(domain)) {
    return { ok: false, kind: "invalid", message: "Please use a work or personal email address, not a disposable one." };
  }

  const accepted = b.terms === true || b.terms === "yes" || b.terms === "on" || b.terms === "true";
  if (!accepted) {
    return { ok: false, kind: "invalid", message: "Please accept the Terms and Privacy Policy to continue." };
  }

  const plan = isPlanId(b.plan) ? b.plan : TRIAL_PLAN;
  return { ok: true, value: { workspace, email, plan, goal: parseGoal(b.goal) } };
}

/** URL-safe slug from a workspace name. Never empty. */
export function slugify(name: string): string {
  const base = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return base || "workspace";
}

/** Slug with a short random suffix, for when the plain slug is taken. */
export function slugWithSuffix(name: string): string {
  return `${slugify(name)}-${randomBytes(3).toString("hex")}`;
}

// ---------------------------------------------------------------------------
// Rate limiter
// ---------------------------------------------------------------------------

export interface Limiter {
  /** Record an attempt for `key`. allowed=false once the window's budget is spent. */
  hit(key: string, now?: number): { allowed: boolean; retryAfterSec: number };
}

/**
 * Fixed-window counter held in memory. Good enough for a single instance: a
 * restart resets it, and several instances each keep their own count (so the
 * effective limit is multiplied). Put a shared store behind this interface if
 * you scale out.
 */
export function createLimiter(opts: { windowMs: number; max: number }): Limiter {
  const buckets = new Map<string, { count: number; resetAt: number }>();
  let lastSweep = 0;

  return {
    hit(key, now = Date.now()) {
      // Drop expired buckets now and then so the map cannot grow without bound.
      if (now - lastSweep > opts.windowMs) {
        for (const [k, v] of buckets) if (v.resetAt <= now) buckets.delete(k);
        lastSweep = now;
      }
      let b = buckets.get(key);
      if (!b || b.resetAt <= now) {
        b = { count: 0, resetAt: now + opts.windowMs };
        buckets.set(key, b);
      }
      b.count += 1;
      return {
        allowed: b.count <= opts.max,
        retryAfterSec: Math.max(1, Math.ceil((b.resetAt - now) / 1000)),
      };
    },
  };
}
