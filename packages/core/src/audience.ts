/**
 * Flow audience - an optional "only enroll contacts where..." filter on a trigger.
 *
 * Stored inside flows.trigger_config under the key `audience`:
 *
 *   { "from": "engaged", "to": "at_risk",
 *     "audience": { "conditions": [
 *       { "field": "payment_status", "op": "is", "value": "paid" },
 *       { "field": "plan", "op": "is", "value": "Pro" },
 *       { "field": "trait", "key": "country", "op": "is", "value": "Ghana" } ] } }
 *
 * All conditions must hold (AND). It applies to lifecycle_transition and event triggers, checked at the
 * moment the trigger fires: a contact who does not match then is not enrolled for that occurrence.
 *
 * Evaluation is pure and in memory against the contact row enrollment already loads, so there is no SQL to
 * build and nothing to inject. A present-but-unreadable audience FAILS CLOSED (no enrollment), because
 * silently ignoring a filter someone set would mail the wrong people.
 *
 * Mirror side: PUBLIC (packages/core is mirrored).
 */
import { z } from "zod";

export const AUDIENCE_MAX_CONDITIONS = 5;

export const AUDIENCE_PAYMENT_STATUSES = ["free", "trial", "paid", "past_due", "cancelled"] as const;
export const AUDIENCE_ENGAGEMENT_DEPTHS = ["power", "regular", "casual", "minimal"] as const;

/** Trait keys are literal top-level keys of contacts.properties (no paths). */
const TRAIT_KEY = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;

const isOps = z.enum(["is", "is_not"]);
const paymentStatus = z.enum(AUDIENCE_PAYMENT_STATUSES);
const engagementDepth = z.enum(AUDIENCE_ENGAGEMENT_DEPTHS);
const traitKey = z.string().regex(TRAIT_KEY, "trait key must be 1-64 letters, digits, _ . or -");
const scalar = z.union([z.string().min(1).max(200), z.number().finite(), z.boolean()]);

export const audienceConditionSchema = z.union([
  z.object({ field: z.literal("payment_status"), op: isOps, value: paymentStatus }).strict(),
  z.object({ field: z.literal("payment_status"), op: z.literal("in"), value: z.array(paymentStatus).min(1).max(5) }).strict(),
  z.object({ field: z.literal("engagement_depth"), op: isOps, value: engagementDepth }).strict(),
  z.object({ field: z.literal("engagement_depth"), op: z.literal("in"), value: z.array(engagementDepth).min(1).max(4) }).strict(),
  z.object({ field: z.literal("plan"), op: isOps, value: z.string().min(1).max(100) }).strict(),
  z.object({ field: z.literal("has_email"), op: z.literal("is"), value: z.boolean() }).strict(),
  z.object({ field: z.literal("trait"), key: traitKey, op: isOps, value: scalar }).strict(),
  z.object({ field: z.literal("trait"), key: traitKey, op: z.literal("contains"), value: z.string().min(1).max(200) }).strict(),
  z.object({ field: z.literal("trait"), key: traitKey, op: z.enum(["gt", "lt"]), value: z.number().finite() }).strict(),
  z.object({ field: z.literal("trait"), key: traitKey, op: z.enum(["is_set", "is_not_set"]) }).strict(),
]);

export const audienceSchema = z
  .object({ conditions: z.array(audienceConditionSchema).min(1).max(AUDIENCE_MAX_CONDITIONS) })
  .strict();

export type AudienceCondition = z.infer<typeof audienceConditionSchema>;
export type Audience = z.infer<typeof audienceSchema>;

/** The slice of a contact an audience can look at. */
export interface AudienceContact {
  paymentStatus: string | null;
  engagementDepth: string | null;
  email: string | null;
  properties: unknown;
}

export type AudienceResult =
  | { outcome: "match" }
  | { outcome: "no_match"; failed: AudienceCondition }
  | { outcome: "invalid"; message: string };

/** Trigger types an audience is allowed on. */
export const AUDIENCE_TRIGGER_TYPES = ["lifecycle_transition", "event"] as const;

/** The audience stored on a trigger config, or undefined when there is none. Does not validate it. */
export function readAudience(triggerConfig: unknown): unknown {
  if (!triggerConfig || typeof triggerConfig !== "object") return undefined;
  return (triggerConfig as Record<string, unknown>).audience;
}

/** trigger_config without its audience: what the AI compiler and the compiled plan should see. */
export function stripAudience<T>(triggerConfig: T): T {
  if (!triggerConfig || typeof triggerConfig !== "object" || Array.isArray(triggerConfig)) return triggerConfig;
  if (!("audience" in (triggerConfig as Record<string, unknown>))) return triggerConfig;
  const { audience: _audience, ...rest } = triggerConfig as Record<string, unknown>;
  return rest as T;
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

function lower(v: unknown): string {
  return String(v).trim().toLowerCase();
}

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function traits(properties: unknown): Record<string, unknown> {
  return properties && typeof properties === "object" && !Array.isArray(properties)
    ? (properties as Record<string, unknown>)
    : {};
}

function isPresent(v: unknown): boolean {
  return v !== undefined && v !== null && !(typeof v === "string" && v.trim() === "");
}

/** Equality between a stored trait and the expected value. Text is case-insensitive; numbers and booleans may be stored as text. */
function equals(actual: unknown, expected: string | number | boolean): boolean {
  if (!isPresent(actual)) return false;
  if (typeof expected === "string") {
    return (typeof actual === "string" || typeof actual === "number" || typeof actual === "boolean") && lower(actual) === lower(expected);
  }
  if (typeof expected === "number") {
    if (typeof actual === "number") return actual === expected;
    return typeof actual === "string" && actual.trim() !== "" && Number(actual) === expected;
  }
  if (typeof actual === "boolean") return actual === expected;
  return typeof actual === "string" && lower(actual) === String(expected);
}

function asNumber(actual: unknown): number | null {
  if (typeof actual === "number") return Number.isFinite(actual) ? actual : null;
  if (typeof actual === "string" && actual.trim() !== "") {
    const n = Number(actual);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Does one audience condition hold for this contact? (Used for conditions inside flows too.) */
export function audienceConditionHolds(c: AudienceCondition, contact: AudienceContact): boolean {
  return holds(c, contact);
}

function holds(c: AudienceCondition, contact: AudienceContact): boolean {
  switch (c.field) {
    case "payment_status": {
      const actual = contact.paymentStatus;
      if (c.op === "in") return actual !== null && (c.value as string[]).includes(actual);
      return c.op === "is" ? actual === c.value : actual !== c.value;
    }
    case "engagement_depth": {
      const actual = contact.engagementDepth;
      if (c.op === "in") return actual !== null && (c.value as string[]).includes(actual);
      return c.op === "is" ? actual === c.value : actual !== c.value;
    }
    case "has_email":
      return Boolean(contact.email && contact.email.trim()) === c.value;
    case "plan": {
      const p = traits(contact.properties);
      const has = hasOwn(p, "plan") && isPresent(p.plan);
      const same = has && lower(p.plan) === lower(c.value);
      return c.op === "is" ? same : !same;
    }
    case "trait": {
      const p = traits(contact.properties);
      const present = hasOwn(p, c.key) && isPresent(p[c.key]);
      const actual = hasOwn(p, c.key) ? p[c.key] : undefined;
      switch (c.op) {
        case "is_set":
          return present;
        case "is_not_set":
          return !present;
        case "is":
          return equals(actual, c.value as string | number | boolean);
        case "is_not":
          return !equals(actual, c.value as string | number | boolean);
        case "contains": {
          const needle = lower(c.value);
          if (Array.isArray(actual)) return actual.some((item) => typeof item !== "object" && isPresent(item) && lower(item) === needle);
          return (typeof actual === "string" || typeof actual === "number") && lower(actual).includes(needle);
        }
        case "gt": {
          const n = asNumber(actual);
          return n !== null && n > (c.value as number);
        }
        case "lt": {
          const n = asNumber(actual);
          return n !== null && n < (c.value as number);
        }
      }
    }
  }
  return false;
}

/**
 * Does the contact satisfy the audience? No audience (undefined or null) means everyone matches.
 * An audience that does not parse is reported as invalid, and callers must not enroll on it.
 */
export function evaluateAudience(rawAudience: unknown, contact: AudienceContact): AudienceResult {
  if (rawAudience === undefined || rawAudience === null) return { outcome: "match" };
  const parsed = audienceSchema.safeParse(rawAudience);
  if (!parsed.success) {
    return { outcome: "invalid", message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
  }
  for (const condition of parsed.data.conditions) {
    if (!holds(condition, contact)) return { outcome: "no_match", failed: condition };
  }
  return { outcome: "match" };
}
