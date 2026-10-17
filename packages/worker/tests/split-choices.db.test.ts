/**
 * Random splits in the engine: a person never changes version, concurrent runs agree, the choice is always
 * recorded, and the shares that come out of the real scan match what was asked for.
 *
 * (Scenario-by-scenario behaviour, and that the scan and the targeted job agree, is in advance-parity.)
 *
 * Requires local Postgres (see enrollment.db.test.ts for DATABASE_URL).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { and, eq, sql } from "drizzle-orm";
import { splitVersion } from "@loomail/core";
import { tenants, contacts, flows, flowMemberships, flowSplitChoices, lifecycleMessages } from "@loomail/db/schema";
import { handleAdvanceMembership } from "../src/advance-membership.js";
import { phaseStepAdvancement } from "../src/scan-step-advancement.js";

const TEST_DB_URL = process.env.DATABASE_URL;
if (!TEST_DB_URL) throw new Error("[split-choices.test] DATABASE_URL is not set (see enrollment.db.test.ts).");

const SLUG = "test-split-choices";
const HOUR = 3_600_000;

let pool: pg.Pool;
let db: ReturnType<typeof drizzle>;
let dbAvailable = false;
let tenantId: string;

const TABLES = ["flow_split_choices", "flow_conversions", "lifecycle_messages", "flow_memberships", "flows", "events", "contacts"];

async function wipe() {
  for (const table of TABLES) {
    await db.execute(sql.raw(`DELETE FROM ${table} WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = '${SLUG}')`));
  }
}

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: TEST_DB_URL, connectionTimeoutMillis: 3000, max: 10 });
  try {
    await pool.query("SELECT 1");
    db = drizzle(pool);
    dbAvailable = true;
  } catch {
    console.warn("[split-choices.test] DATABASE_URL not reachable - tests skipped.");
    return;
  }
  await wipe();
  await db.execute(sql.raw(`DELETE FROM tenants WHERE slug = '${SLUG}'`));
  const [t] = await db.insert(tenants).values({ name: "Split choices", slug: SLUG, plan: "free" }).returning({ id: tenants.id });
  tenantId = t!.id;
});

beforeEach(async () => {
  if (dbAvailable) await wipe();
});

afterAll(async () => {
  if (dbAvailable) {
    await wipe();
    await db.execute(sql.raw(`DELETE FROM tenants WHERE slug = '${SLUG}'`));
  }
  await pool.end();
});

const step = (order: number) => ({ order, action_type: "nurture_value", delay: "0m", window_policy: "immediate", next: "end" });
const splitPlan = (percentA: number, elsePath: number | "end" = 3) => ({
  version: 2,
  trigger: { type: "event", condition: {} },
  steps: elsePath === "end" ? [step(2)] : [step(2), step(3)],
  branches: [{ order: 1, delay: "0m", split: { percent_a: percentA }, then: 2, else: elsePath }],
});

async function mkFlow(plan: unknown) {
  const [f] = await db
    .insert(flows)
    .values({ tenantId, name: "split flow", triggerType: "event", triggerConfig: { event: "x" }, steps: [], status: "active", compileStatus: "ready", compiledPlan: plan, approvalMode: "require" })
    .returning({ id: flows.id });
  return f!.id;
}

async function mkMembership(flowId: string, id?: string) {
  const [c] = await db
    .insert(contacts)
    .values({ tenantId, externalId: `c-${randomUUID()}`, lifecycleState: "engaged", firstSeenAt: new Date(), lastSeenAt: new Date() })
    .returning({ id: contacts.id });
  const [m] = await db
    .insert(flowMemberships)
    .values({ ...(id ? { id } : {}), tenantId, contactId: c!.id, flowId, currentStep: 1, status: "active", enteredAt: new Date(Date.now() - HOUR), stepEnteredAt: new Date(Date.now() - HOUR) })
    .returning({ id: flowMemberships.id });
  return { membershipId: m!.id, contactId: c!.id };
}

const advance = (membershipId: string) => handleAdvanceMembership({ tenant_id: tenantId, membership_id: membershipId } as never, db);
const choicesOf = (membershipId: string) => db.select().from(flowSplitChoices).where(eq(flowSplitChoices.membershipId, membershipId));
const messageOrders = async (membershipId: string) =>
  (await db.select().from(lifecycleMessages).where(eq(lifecycleMessages.membershipId, membershipId))).map((m) => m.flowStepOrder);
const idFor = (order: number, percent: number, version: "a" | "b") => {
  let id: string;
  do id = randomUUID();
  while (splitVersion(id, order, percent) !== version);
  return id;
};

describe("a person never changes version", () => {
  it("an existing choice wins over what the hash says now (a crash before the move, then the percentage was edited)", async () => {
    if (!dbAvailable) return;
    const flowId = await mkFlow(splitPlan(50));
    const id = idFor(1, 50, "b"); // the hash says B...
    const { membershipId } = await mkMembership(flowId, id);
    await db.insert(flowSplitChoices).values({ tenantId, flowId, membershipId, nodeOrder: 1, version: "a", chosenAt: new Date() }); // ...but A was already recorded
    await advance(membershipId);
    expect(await messageOrders(membershipId)).toEqual([2]); // went down the A path
    const rows = await choicesOf(membershipId);
    expect(rows.map((r) => r.version)).toEqual(["a"]);
  });

  it("two workers advancing the same person at once agree: one choice, one path, one message", async () => {
    if (!dbAvailable) return;
    const flowId = await mkFlow(splitPlan(50));
    const { membershipId } = await mkMembership(flowId);
    await Promise.all([advance(membershipId), advance(membershipId), advance(membershipId)]);
    expect(await choicesOf(membershipId)).toHaveLength(1);
    const orders = await messageOrders(membershipId);
    expect(orders).toHaveLength(1);
    const version = (await choicesOf(membershipId))[0]!.version;
    expect(orders).toEqual([version === "a" ? 2 : 3]);
  });

  it("advancing again after the person has moved on changes nothing", async () => {
    if (!dbAvailable) return;
    const flowId = await mkFlow(splitPlan(50));
    const { membershipId } = await mkMembership(flowId);
    await advance(membershipId);
    const before = { choices: await choicesOf(membershipId), orders: await messageOrders(membershipId) };
    await advance(membershipId);
    await phaseStepAdvancement(db, new Date(), [tenantId]);
    expect(await choicesOf(membershipId)).toEqual(before.choices);
    expect(await messageOrders(membershipId)).toEqual(before.orders);
  });
});

describe("the choice is recorded", () => {
  it("for version A and version B, with the split's number and a time", async () => {
    if (!dbAvailable) return;
    const flowId = await mkFlow(splitPlan(50));
    for (const version of ["a", "b"] as const) {
      const { membershipId } = await mkMembership(flowId, idFor(1, 50, version));
      await advance(membershipId);
      const [row] = await choicesOf(membershipId);
      expect(row).toMatchObject({ tenantId, flowId, membershipId, nodeOrder: 1, version });
      expect(Math.abs(row!.chosenAt.getTime() - Date.now())).toBeLessThan(60_000);
    }
  });

  it("for a holdout, including the people who are sent nothing", async () => {
    if (!dbAvailable) return;
    const flowId = await mkFlow(splitPlan(90, "end"));
    const held = await mkMembership(flowId, idFor(1, 90, "b"));
    await advance(held.membershipId);
    expect((await choicesOf(held.membershipId))[0]!.version).toBe("b");
    expect(await messageOrders(held.membershipId)).toEqual([]);
    expect((await db.select().from(flowMemberships).where(eq(flowMemberships.id, held.membershipId)))[0]!.status).toBe("completed");
  });
});

describe("through the real scan", () => {
  it("sends the requested share down each path, and each person's path matches their recorded choice", async () => {
    if (!dbAvailable) return;
    const flowId = await mkFlow(splitPlan(30));
    const ids: string[] = [];
    for (let i = 0; i < 400; i++) ids.push((await mkMembership(flowId)).membershipId);
    await phaseStepAdvancement(db, new Date(), [tenantId]);

    const choices = await db.select().from(flowSplitChoices).where(and(eq(flowSplitChoices.flowId, flowId), eq(flowSplitChoices.nodeOrder, 1)));
    expect(choices).toHaveLength(400);
    const aShare = (choices.filter((c) => c.version === "a").length / 400) * 100;
    expect(Math.abs(aShare - 30), `got ${aShare}%`).toBeLessThan(8); // 400 draws: about 2.3 points of standard error

    const messages = await db.select().from(lifecycleMessages).where(eq(lifecycleMessages.flowId, flowId));
    expect(messages).toHaveLength(400);
    const versionOf = new Map(choices.map((c) => [c.membershipId, c.version]));
    for (const m of messages) expect(m.flowStepOrder, m.membershipId!).toBe(versionOf.get(m.membershipId!) === "a" ? 2 : 3);
    // and the recorded version is what the hash says
    for (const id of ids) expect(versionOf.get(id)).toBe(splitVersion(id, 1, 30));
  });
});
