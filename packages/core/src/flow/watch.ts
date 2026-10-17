/**
 * Which events can make a flow condition newly true.
 *
 * A contact in a flow may be waiting on something (a wait-until fork, a goal, a plan-level exit). When an event
 * arrives, only the memberships whose conditions mention that event need looking at right away; the rest are
 * left to the 15-minute scan. These helpers say which event names a condition is waiting on.
 *
 * Only events that can turn a condition TRUE count: "did X" (and the original "X happened since this step").
 * "Did not do X" can only get falser when X arrives, so it is not watched. Conditions about a contact's facts or
 * lifecycle stage are not about events, so they are not watched either and stay on the scan.
 *
 * Reads leniently (a stored condition may be a shape the engine no longer knows) and never throws.
 *
 * Mirror side: PUBLIC (packages/core is mirrored).
 */

function collect(condition: unknown, into: Set<string>, depth: number): void {
  if (depth > 6 || condition === null || typeof condition !== "object") return;
  const c = condition as Record<string, unknown>;
  if (Array.isArray(c.all)) {
    for (const child of c.all) collect(child, into, depth + 1);
    return;
  }
  if (Array.isArray(c.any)) {
    for (const child of c.any) collect(child, into, depth + 1);
    return;
  }
  if (c.field === "event" && c.op === "performed" && typeof c.name === "string") into.add(c.name);
  else if (typeof c.event_since_step === "string") into.add(c.event_since_step);
}

/** Event names a condition is waiting on (see the file comment for what counts). */
export function conditionEventNames(condition: unknown): Set<string> {
  const names = new Set<string>();
  collect(condition, names, 0);
  return names;
}

/** Event names a plan-level exit condition is waiting on. Handles all four exit shapes. */
export function planExitEventNames(exit: unknown): Set<string> {
  if (exit === null || typeof exit !== "object") return new Set();
  const e = exit as Record<string, unknown>;
  if ("condition" in e) return conditionEventNames(e.condition);
  if (typeof e.event === "string") return new Set([e.event]); // { event } and { event, lifecycle_state_change }
  return new Set();
}
