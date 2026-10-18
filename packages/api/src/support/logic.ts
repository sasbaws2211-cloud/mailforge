/**
 * Support requests: the rules shared by the customer routes and the admin console. No database, no network.
 *
 * Mirror side: PUBLIC (packages/api is mirrored).
 */
import { z } from "zod";

export const TICKET_CATEGORIES = ["question", "bug", "billing", "feature", "other"] as const;
export type TicketCategory = (typeof TICKET_CATEGORIES)[number];

export const TICKET_STATUSES = ["open", "answered", "closed"] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const MAX_SUBJECT = 150;
export const MAX_MESSAGE = 5000;
/** Most requests a workspace can have waiting for an answer at once (open or answered), so a loop or a flood cannot fill the console. */
export const MAX_ACTIVE_PER_WORKSPACE = 20;
/** Most messages in one thread. */
export const MAX_MESSAGES_PER_TICKET = 200;
/** New requests per person per hour, and replies per person per hour. */
export const NEW_TICKETS_PER_HOUR = 5;
export const REPLIES_PER_HOUR = 30;

const text = (min: number, max: number, what: string) =>
  z
    .string({ required_error: `${what} is required.`, invalid_type_error: `${what} must be text.` })
    .transform((s) => s.replace(/\r\n/g, "\n").trim())
    .pipe(z.string().min(min, min === 1 ? `${what} is required.` : `${what} is too short (at least ${min} characters).`).max(max, `${what} is too long (at most ${max} characters).`));

/** Only a path inside the dashboard is kept ("/flows/123"); anything else is dropped, so nothing odd is ever shown as a link. */
export function cleanPagePath(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return /^\/[A-Za-z0-9\-._~!$&'()*+,;=:@%/?#]{0,299}$/.test(t) && !t.startsWith("//") ? t : null;
}

export const newTicketSchema = z
  .object({
    subject: text(3, MAX_SUBJECT, "The subject").transform((s) => s.replace(/\s*\n\s*/g, " ")),
    message: text(5, MAX_MESSAGE, "The message"),
    category: z.enum(TICKET_CATEGORIES).default("question"),
    page_url: z.unknown().optional(),
  })
  .strict();

export const replySchema = z.object({ message: text(1, MAX_MESSAGE, "The message") }).strict();

export const adminReplySchema = z.object({ message: text(1, MAX_MESSAGE, "The message"), close: z.boolean().optional() }).strict();

export const statusSchema = z.object({ status: z.enum(["open", "closed"]) }).strict();

export const CATEGORY_LABEL: Record<TicketCategory, string> = {
  question: "Question",
  bug: "Something is broken",
  billing: "Billing",
  feature: "Feature request",
  other: "Other",
};

export const isUuid = (v: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
