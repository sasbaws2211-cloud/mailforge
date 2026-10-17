/**
 * Scan phase: conversions for people who have already left a flow.
 *
 * People still in a flow are checked against its goal as they are advanced (see advance-core.ts). This phase
 * covers the rest: contacts who finished or were exited from the flow and are still inside the goal window
 * ("converted a week after the last email"). A conversion is recorded once per membership.
 *
 * Bounded: at most GOAL_SCAN_PER_FLOW memberships per flow per scan, in id order. Ones beyond the bound are
 * reached on later scans only as earlier ones convert or age out of their window, so reaching the bound is logged.
 *
 * Mirror side: PUBLIC (packages/worker is mirrored).
 */
import { and, eq, gt, inArray, isNotNull, ne, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { contacts, flowMemberships, flows } from "@loomail/db/schema";
import { readFlowGoal } from "@loomail/core";
import { checkGoal, eventCheckerFor } from "./advance-core.js";

type Db = NodePgDatabase<Record<string, never>>;

export const GOAL_SCAN_PER_FLOW = 5000;
const BATCH = 500;

export interface PhaseGoalConversionsResult {
  flowsEvaluated: number;
  membershipsChecked: number;
  conversionsRecorded: number;
  flowsCapped: number;
}

/** `tenantIds` limits the pass to those workspaces (tests and one-off runs); the scan passes none and covers all. */
export async function phaseGoalConversions(db: Db, now: Date, tenantIds?: string[]): Promise<PhaseGoalConversionsResult> {
  const result: PhaseGoalConversionsResult = { flowsEvaluated: 0, membershipsChecked: 0, conversionsRecorded: 0, flowsCapped: 0 };

  const flowRows = await db
    .select({ id: flows.id, tenantId: flows.tenantId, goal: flows.goal })
    .from(flows)
    .where(and(isNotNull(flows.goal), ne(flows.status, "archived"), ...(tenantIds && tenantIds.length > 0 ? [inArray(flows.tenantId, tenantIds)] : [])))
    .orderBy(flows.id);

  for (const flow of flowRows) {
    const goal = readFlowGoal(flow.goal);
    if (!goal) continue;
    result.flowsEvaluated++;
    const windowStart = new Date(now.getTime() - goal.window_days * 86_400_000);
    let lastId: string | null = null;
    let checked = 0;

    for (;;) {
      const conds = [
        eq(flowMemberships.flowId, flow.id),
        ne(flowMemberships.status, "active"),
        sql`${flowMemberships.enteredAt} >= ${windowStart}`,
        sql`NOT EXISTS (SELECT 1 FROM flow_conversions fc WHERE fc.membership_id = ${flowMemberships.id})`,
      ];
      if (lastId !== null) conds.push(gt(flowMemberships.id, lastId));
      const batch = await db
        .select({
          id: flowMemberships.id,
          contactId: flowMemberships.contactId,
          flowId: flowMemberships.flowId,
          enteredAt: flowMemberships.enteredAt,
          lifecycleState: contacts.lifecycleState,
          paymentStatus: contacts.paymentStatus,
          engagementDepth: contacts.engagementDepth,
          email: contacts.email,
          properties: contacts.properties,
        })
        .from(flowMemberships)
        .innerJoin(contacts, eq(contacts.id, flowMemberships.contactId))
        .where(and(...conds))
        .orderBy(flowMemberships.id)
        .limit(Math.min(BATCH, GOAL_SCAN_PER_FLOW - checked));
      if (batch.length === 0) break;

      for (const m of batch) {
        result.membershipsChecked++;
        checked++;
        const outcome = await checkGoal(
          db,
          flow.tenantId,
          m,
          goal,
          { lifecycleState: m.lifecycleState, paymentStatus: m.paymentStatus, engagementDepth: m.engagementDepth, email: m.email, properties: m.properties },
          eventCheckerFor(db, m.contactId),
          now,
        );
        if (outcome === "converted") result.conversionsRecorded++;
      }
      lastId = batch[batch.length - 1]!.id;
      if (checked >= GOAL_SCAN_PER_FLOW) {
        result.flowsCapped++;
        console.warn(`[scan] goal-conversions: flow ${flow.id} reached the per-scan limit of ${GOAL_SCAN_PER_FLOW}`);
        break;
      }
      if (batch.length < BATCH) break;
    }
  }
  return result;
}
