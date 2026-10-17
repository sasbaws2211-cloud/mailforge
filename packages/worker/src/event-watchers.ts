/**
 * React to an event right away for contacts who are waiting on it.
 *
 * Without this, a contact waiting for "created a project" (a wait-until fork), a flow goal, or a plan-level
 * "exit when X happens" notices only on the 15-minute scan. When a tracked event arrives, this finds the
 * contact's memberships whose conditions are waiting on that event name and:
 *
 *   - for people still in the flow: returns their membership ids so the caller sends each through the normal
 *     advance job (the same engine the scan uses; running it twice is harmless);
 *   - for people who already left the flow but are still inside a goal's window: checks the goal here and
 *     records the conversion.
 *
 * Only conditions about events are watched (see core's conditionEventNames). Conditions about a contact's facts
 * or lifecycle stage still wait for the scan, which also remains the safety net if a job is lost.
 *
 * Bounded: at most MAX_WATCHED_MEMBERSHIPS memberships are looked at per event.
 *
 * Mirror side: PUBLIC (packages/worker is mirrored).
 */
import { and, eq, ne, or, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { contacts, flowMemberships, flows } from "@loomail/db/schema";
import { conditionEventNames, planExitEventNames, readFlowGoal, GOAL_MAX_WINDOW_DAYS } from "@loomail/core";
import { checkGoal, eventCheckerFor, extractBranches, extractExitConditions, extractVersion } from "./advance-core.js";

type Db = NodePgDatabase<Record<string, never>>;

export const MAX_WATCHED_MEMBERSHIPS = 50;

export interface WatchResult {
  /** Active memberships that are waiting on this event: send each through the advance job. */
  advanceMembershipIds: string[];
  /** Conversions recorded here for people who had already left their flow. */
  conversionsRecorded: number;
}

export async function handleEventWatchers(db: Db, tenantId: string, contactId: string, eventName: string, now: Date): Promise<WatchResult> {
  const result: WatchResult = { advanceMembershipIds: [], conversionsRecorded: 0 };

  // This contact's memberships that could be waiting on something: still in the flow, or (with a goal) recent enough
  // that the goal window may still be open. One indexed lookup by contact.
  const rows = await db
    .select({
      id: flowMemberships.id,
      flowId: flowMemberships.flowId,
      status: flowMemberships.status,
      currentStep: flowMemberships.currentStep,
      enteredAt: flowMemberships.enteredAt,
      flowStatus: flows.status,
      goal: flows.goal,
      compiledPlan: flows.compiledPlan,
    })
    .from(flowMemberships)
    .innerJoin(flows, eq(flows.id, flowMemberships.flowId))
    .where(
      and(
        eq(flowMemberships.tenantId, tenantId),
        eq(flowMemberships.contactId, contactId),
        ne(flows.status, "archived"),
        or(
          eq(flowMemberships.status, "active"),
          sql`(${flows.goal} IS NOT NULL AND ${flowMemberships.enteredAt} >= ${new Date(now.getTime() - GOAL_MAX_WINDOW_DAYS * 86_400_000)})`,
        ),
      ),
    )
    .orderBy(sql`${flowMemberships.enteredAt} DESC`)
    .limit(MAX_WATCHED_MEMBERSHIPS);
  if (rows.length === 0) return result;

  let contactState: { lifecycleState: string; paymentStatus: string | null; engagementDepth: string | null; email: string | null; properties: unknown } | null = null;

  for (const m of rows) {
    const goal = readFlowGoal(m.goal);
    const goalWatches = goal !== null && conditionEventNames(goal.condition).has(eventName);

    if (m.status === "active") {
      // A paused flow does not advance anyone, so there is nothing to wake.
      if (m.flowStatus !== "active") continue;
      let watching = goalWatches;
      if (!watching) {
        for (const exit of extractExitConditions(m.compiledPlan) ?? []) {
          if (planExitEventNames(exit).has(eventName)) {
            watching = true;
            break;
          }
        }
      }
      if (!watching && extractVersion(m.compiledPlan) === 2) {
        // Sitting on a wait-until fork whose condition is waiting on this event.
        const fork = (extractBranches(m.compiledPlan) ?? []).find((b) => b.order === m.currentStep);
        if (fork && fork.early === true && conditionEventNames(fork.condition).has(eventName)) watching = true;
      }
      if (watching) result.advanceMembershipIds.push(m.id);
      continue;
    }

    // Already left the flow: only a goal can still be waiting.
    if (!goal || !goalWatches) continue;
    if (contactState === null) {
      const c = await db
        .select({
          lifecycleState: contacts.lifecycleState,
          paymentStatus: contacts.paymentStatus,
          engagementDepth: contacts.engagementDepth,
          email: contacts.email,
          properties: contacts.properties,
        })
        .from(contacts)
        .where(eq(contacts.id, contactId))
        .limit(1);
      if (c.length === 0) return result;
      contactState = c[0]!;
    }
    const outcome = await checkGoal(
      db,
      tenantId,
      { id: m.id, contactId, flowId: m.flowId, enteredAt: m.enteredAt },
      goal,
      contactState as never,
      eventCheckerFor(db, contactId),
      now,
    );
    if (outcome === "converted") result.conversionsRecorded++;
  }
  return result;
}
