/**
 * What the AI can and cannot use when it writes each email, in plain words.
 *
 * Shown under the prompt box in the flow editor, and mirrored in guide/FLOW-PROMPTS.md. It describes the
 * drafting context (packages/worker/src/context-assembler.ts): a flow whose prompt needs something that is
 * not in this list compiles into steps the AI cannot satisfy, and the quality check then holds every
 * draft back ("value_gated"). Keep this list in step with that context.
 *
 * Mirror side: PUBLIC (apps/dashboard is mirrored).
 */

/** Things the AI is given for every email it writes. */
export const AI_CAN_USE: readonly string[] = [
  "the contact's name, email and company (send them as name, email and company when you identify the user)",
  "the name of their plan, such as Growth (send it as plan when you identify the user, for example plan: \"Growth\")",
  "where they are in their lifecycle, how long they have been a contact, and how engaged they are",
  "their payment status: free, trial, paid, past due or cancelled",
  "how active they were this week compared with last week",
  "when they were last emailed, and what kind of email it was",
  "the names of their recent events and which features they use most (the names only)",
  "your Brain context from Settings and any knowledge-base entries that match the step",
];

/** Things the AI is never given. */
export const AI_CANNOT_USE: readonly string[] = [
  "the details inside an event, such as an amount, an order, a product name or which page was visited",
  "custom fields you send with identify, such as first_name or job_title (only name, email, company, plan and payment status are used)",
];

/** One example of a prompt that works and one that cannot, from the same idea. */
export const PROMPT_EXAMPLE_WORKS =
  "When a customer finishes onboarding, send one short friendly email that congratulates them by name, mentions their company, and suggests one next step.";

export const PROMPT_EXAMPLE_FAILS =
  "When a customer upgrades, thank them and mention the amount they paid.";

export const PROMPT_EXAMPLE_FAILS_WHY =
  "The amount is inside the event, which the AI cannot see, so it cannot include it and the quality check holds the email back. Say \"thank them for upgrading\" instead. To name their plan, identify the user with plan: \"Growth\" first and write \"mention their plan\".";
