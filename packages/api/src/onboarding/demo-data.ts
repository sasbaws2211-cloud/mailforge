/**
 * Demo data: a set of made-up customers so a new workspace can explore the retention grid,
 * People and Lifecycle before its own app is connected.
 *
 * Safe by construction:
 *   - every demo contact has an external id starting "demo_" and no email address, so nothing can
 *     ever be sent to one and no flow is started for them (they are inserted directly, not
 *     through event ingest);
 *   - demo contacts never count against plan limits (see plan/usage.ts countContacts);
 *   - clearing removes exactly those rows, and nothing else.
 *
 * Mirror side: PUBLIC (packages/api is mirrored).
 */
import { sql } from "drizzle-orm";
import type { Db } from "../plugins/db.js";

export const DEMO_PREFIX = "demo_";

interface DemoRow {
  name: string;
  state: string;
  /** Days since the person first appeared. */
  ageDays: number;
  /** Days since they were last active. */
  quietDays: number;
  paid: boolean;
}

// Spread over the grid: tenure (new <30, growing 30-89, established 90-179, loyal 180+)
// against how long they have been quiet (active <7, cooling 7-13, idle 14-27, dormant 28+).
const NAMES = [
  "Ama", "Kofi", "Esi", "Kwame", "Abena", "Yaw", "Akua", "Kojo", "Efua", "Nana",
  "Adwoa", "Kwesi", "Afia", "Yaa", "Kwabena", "Maame", "Fiifi", "Araba", "Selorm", "Dela",
];
const SHAPE: Array<[number, number, string, boolean]> = [
  // ageDays, quietDays, state, paid
  [5, 1, "signed_up", false], [9, 2, "activated", false], [14, 3, "engaged", true], [20, 5, "engaged", true],
  [12, 8, "at_risk", false], [18, 10, "at_risk", false], [25, 16, "at_risk", false],
  [40, 2, "engaged", true], [55, 4, "engaged", true], [70, 6, "engaged", true], [45, 9, "at_risk", true],
  [60, 12, "at_risk", false], [75, 20, "at_risk", false], [85, 35, "dormant", false],
  [120, 1, "engaged", true], [140, 3, "engaged", true], [100, 5, "engaged", true], [150, 11, "at_risk", true],
  [130, 19, "at_risk", true], [160, 40, "dormant", false],
  [220, 2, "engaged", true], [300, 4, "engaged", true], [200, 13, "at_risk", true], [260, 45, "dormant", true],
];

function rows(): DemoRow[] {
  return SHAPE.map(([ageDays, quietDays, state, paid], i) => ({
    name: `Demo ${NAMES[i % NAMES.length]}`,
    state,
    ageDays,
    quietDays,
    paid,
  }));
}

/** Add the demo customers. Returns how many were added (0 when they are already there). */
export async function addDemoData(db: Db, tenantId: string, now: Date = new Date()): Promise<number> {
  const existing = await hasDemoData(db, tenantId);
  if (existing) return 0;
  const list = rows();
  let n = 0;
  for (let i = 0; i < list.length; i++) {
    const r = list[i]!;
    const first = new Date(now.getTime() - r.ageDays * 86_400_000);
    const last = new Date(now.getTime() - r.quietDays * 86_400_000);
    await db.execute(sql`
      INSERT INTO contacts (tenant_id, external_id, email, name, properties, lifecycle_state, payment_status, first_seen_at, last_seen_at, activated_at, created_at)
      VALUES (${tenantId}::uuid, ${`${DEMO_PREFIX}${i + 1}`}, NULL, ${`${r.name} ${i + 1}`}, ${JSON.stringify({ demo: true })}::jsonb,
              ${r.state}, ${r.paid ? "paid" : "free"}, ${first.toISOString()}, ${last.toISOString()},
              ${r.state === "signed_up" ? null : first.toISOString()}, ${first.toISOString()})
      ON CONFLICT (tenant_id, external_id) DO NOTHING`);
    n++;
  }
  return n;
}

/** Remove the demo customers (and only them). Returns how many were removed. */
export async function clearDemoData(db: Db, tenantId: string): Promise<number> {
  // Events, memberships and messages cannot exist for demo contacts, but delete defensively in
  // dependency order in case a demo contact was ever touched.
  const ids = await db.execute<{ id: string }>(sql`
    SELECT id FROM contacts WHERE tenant_id = ${tenantId}::uuid AND left(external_id, 5) = 'demo_'`);
  if (ids.rows.length === 0) return 0;
  const list = ids.rows.map((r) => r.id).join(",");
  await db.execute(sql`DELETE FROM events WHERE tenant_id = ${tenantId}::uuid AND contact_id = ANY(string_to_array(${list}, ',')::uuid[])`);
  await db.execute(sql`DELETE FROM flow_split_choices WHERE tenant_id = ${tenantId}::uuid AND membership_id IN (SELECT id FROM flow_memberships WHERE tenant_id = ${tenantId}::uuid AND contact_id = ANY(string_to_array(${list}, ',')::uuid[]))`);
  await db.execute(sql`DELETE FROM flow_conversions WHERE tenant_id = ${tenantId}::uuid AND contact_id = ANY(string_to_array(${list}, ',')::uuid[])`);
  await db.execute(sql`DELETE FROM flow_memberships WHERE tenant_id = ${tenantId}::uuid AND contact_id = ANY(string_to_array(${list}, ',')::uuid[])`);
  const del = await db.execute(sql`DELETE FROM contacts WHERE tenant_id = ${tenantId}::uuid AND id = ANY(string_to_array(${list}, ',')::uuid[]) RETURNING id`);
  return del.rows.length;
}

export async function hasDemoData(db: Db, tenantId: string): Promise<boolean> {
  const r = await db.execute<{ n: string }>(sql`
    SELECT count(*)::text AS n FROM contacts WHERE tenant_id = ${tenantId}::uuid AND left(external_id, 5) = 'demo_'`);
  return Number(r.rows[0]?.n ?? 0) > 0;
}
