/**
 * What the assistant may know about the workspace asking: a handful of plain facts about how far along setup is, worked out by the
 * server from the database. Never anything a person typed or anything about an individual contact, and never keys, tokens or secrets:
 * the browser does not get to say what the assistant sees, so it cannot be used to read another workspace's facts.
 *
 * Mirror side: PUBLIC (packages/api is mirrored).
 */
import { sql } from "drizzle-orm";
import { PLANS, effectivePlan, trialDaysLeft } from "@loomail/core";
import type { Db } from "../plugins/db.js";
import { loadOnboarding } from "../onboarding/state.js";
import { planKind, type PlanKind } from "./limits.js";

export interface WorkspaceFacts {
  kind: PlanKind;
  planName: string;
  trialDaysLeft: number | null;
  setup: {
    hasPostalAddress: boolean;
    hasSender: boolean;
    hasActiveFlow: boolean;
    hasEvents: boolean;
    hasSentEmail: boolean;
  };
  /** Next unfinished setup step's title, or null when setup is complete. */
  nextStep: string | null;
  /** Approved emails that cannot go out yet, and a plain reason. */
  waiting: { count: number; reason: string | null };
}

export interface TenantRow {
  plan: string | null;
  trialEndsAt: Date | null;
  paidThrough: Date | null;
}

export async function loadTenantRow(db: Db, tenantId: string): Promise<TenantRow | null> {
  const r = await db.execute<{ plan: string | null; trial_ends_at: Date | string | null; plan_paid_through: Date | string | null }>(
    sql`SELECT plan, trial_ends_at, plan_paid_through FROM tenants WHERE id = ${tenantId}::uuid LIMIT 1`,
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    plan: row.plan,
    trialEndsAt: row.trial_ends_at ? new Date(row.trial_ends_at) : null,
    paidThrough: row.plan_paid_through ? new Date(row.plan_paid_through) : null,
  };
}

export async function loadWorkspaceFacts(db: Db, tenantId: string, tenant: TenantRow, now: Date = new Date()): Promise<WorkspaceFacts> {
  const kind = planKind(tenant, now);
  const eff = effectivePlan(tenant.plan, tenant.trialEndsAt, now, tenant.paidThrough);
  const snap = await loadOnboarding(db, tenantId);
  const facts = snap?.facts;
  const next = snap?.progress.steps.find((s) => s.id === snap.progress.next);
  return {
    kind,
    planName: PLANS[eff].name,
    trialDaysLeft: kind === "trial" ? trialDaysLeft(tenant.trialEndsAt, now) : null,
    setup: {
      hasPostalAddress: facts?.hasPostalAddress ?? false,
      hasSender: facts?.hasSender ?? false,
      hasActiveFlow: facts?.hasActiveFlow ?? false,
      hasEvents: facts?.hasEvents ?? false,
      hasSentEmail: facts?.hasSentEmail ?? false,
    },
    nextStep: next?.title ?? null,
    waiting: { count: snap?.waiting.count ?? 0, reason: snap?.waiting.reason ? String(snap.waiting.reason).replace(/_/g, " ") : null },
  };
}

const yesNo = (v: boolean) => (v ? "yes" : "no");

/** The facts as the lines the model reads. */
export function renderFacts(f: WorkspaceFacts): string {
  const lines = [
    `Plan: ${f.planName}${f.kind === "trial" ? ` (trial, ${f.trialDaysLeft} day${f.trialDaysLeft === 1 ? "" : "s"} left)` : ""}`,
    `Business postal address entered: ${yesNo(f.setup.hasPostalAddress)}`,
    `Email sending set up: ${yesNo(f.setup.hasSender)}`,
    `At least one flow active: ${yesNo(f.setup.hasActiveFlow)}`,
    `Events received: ${yesNo(f.setup.hasEvents)}`,
    `An email has been sent: ${yesNo(f.setup.hasSentEmail)}`,
    f.nextStep ? `Next setup step on Home: ${f.nextStep}` : "Setup checklist: complete",
  ];
  if (f.waiting.count > 0) lines.push(`Approved emails waiting to go out: ${f.waiting.count}${f.waiting.reason ? ` (${f.waiting.reason})` : ""}`);
  return lines.join("\n");
}
