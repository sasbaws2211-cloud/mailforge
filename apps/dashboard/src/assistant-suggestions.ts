/**
 * Starter questions for the assistant that fit the page the person is on. No dependencies, so the API's tests can check that each one
 * really finds an answer in the documentation.
 *
 * Mirror side: PUBLIC (apps/dashboard is mirrored).
 */
/** Starter questions that fit the page the person is on. */
export function suggestionsFor(pathname: string): string[] {
  if (pathname.startsWith("/integrate")) return ["How do I send my first event?", "How do I connect a form or a payment tool?", "How do I read data from my database?"];
  if (pathname.startsWith("/flows")) return ["How do I create my first flow?", "Why is my flow not sending anything?", "What is the approval queue?"];
  if (pathname.startsWith("/people")) return ["How do I import my contacts?", "Why can I not email this person?", "What are lifecycle states?"];
  if (pathname.startsWith("/segments")) return ["What is a segment?", "How do I start a flow from a segment?"];
  if (pathname.startsWith("/approvals")) return ["What is this page for?", "Why is nothing waiting here?"];
  if (pathname.startsWith("/settings")) return ["Why are my emails not sending?", "How do I set up email sending?", "What does the postal address do?"];
  if (pathname.startsWith("/sent")) return ["What do the statuses mean?", "Why was an address suppressed?"];
  return ["How do I get started?", "Why are my emails not sending?", "How do I connect my data?"];
}
