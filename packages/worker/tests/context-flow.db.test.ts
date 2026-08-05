/**
 * Integration tests for context-flow.ts (slice 18.3).
 *
 * Tests the flow step metadata section of the context packet builder.
 * All integration tests run against a real Postgres database.
 *
 * Coverage:
 *   brain_instruction:
 *     - Valid flow and step order yields the correct brain_instruction.
 *     - Step order beyond the end of the plan returns absent (undefined).
 *     - Step that exists in the plan but carries no brain_instruction returns absent.
 *     - compiled_plan = null (flow not yet compiled) returns absent.
 *     - Flow belonging to another tenant is never read (returns absent).
 *
 *   sender_name:
 *     - Active transport config with from_name -> senderName is populated.
 *     - Active transport config with from_name = null -> senderName is absent.
 *     - No transport config -> senderName is absent (Phase 1: transport is Phase 4).
 *
 *   product_name:
 *     - Always resolved from tenants.name when tenant exists.
 *
 *   isolation:
 *     - A flow belonging to another tenant is never returned.
 *
 * Requires local Postgres (docker compose up postgres).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { sql } from "drizzle-orm";
import { tenants, flows, transportConfigs } from "@claros/db/schema";
import { buildFlowStepSection } from "../src/context-flow.js";

// ---------------------------------------------------------------------------
// DB setup
// ---------------------------------------------------------------------------

const TEST_DB_URL = process.env.DATABASE_URL;
if (!TEST_DB_URL) {
  const inCI = process.env.CI === "true";
  throw new Error(
    `[context-flow.test] DATABASE_URL is not set.\n\n` +
      `This test requires a Postgres connection.\n` +
      (inCI
        ? `Set the variable in the workflow env block:\n\n  DATABASE_URL: postgres://claros:claros@localhost:5432/claros\n`
        : `Set the variable in .env (see .env.example) or export it:\n\n  export DATABASE_URL='postgres://claros:claros@localhost:5433/claros'\n`),
  );
}

let pool: pg.Pool;
let db: ReturnType<typeof drizzle>;
let dbAvailable = false;
let testTenantId: string;
let otherTenantId: string;

const SLUG = "test-ctx-flow";
const SLUG_OTHER = "test-ctx-flow-other";

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: TEST_DB_URL, connectionTimeoutMillis: 3000 });
  try {
    await pool.query("SELECT 1");
    db = drizzle(pool);
    dbAvailable = true;
  } catch (err) {
    const inCI = process.env.CI === "true";
    if (inCI) {
      throw new Error(
        `[context-flow.test] DATABASE_URL not reachable in CI.\n` +
          `URL: ${TEST_DB_URL}\nCause: ${(err as Error).message}`,
      );
    }
    console.warn("[context-flow.test] DATABASE_URL not reachable - tests skipped.");
    return;
  }

  await cleanup();

  const [tenant] = await db
    .insert(tenants)
    .values({ name: "Acme Platform", slug: SLUG, plan: "free" })
    .returning({ id: tenants.id });
  testTenantId = tenant!.id;

  const [other] = await db
    .insert(tenants)
    .values({ name: "Other Tenant", slug: SLUG_OTHER, plan: "free" })
    .returning({ id: tenants.id });
  otherTenantId = other!.id;
});

beforeEach(async () => {
  if (!dbAvailable) return;
  // Delete child rows before parent rows (FK ordering).
  await db.execute(sql`DELETE FROM transport_configs WHERE tenant_id = ${testTenantId}`);
  await db.execute(sql`DELETE FROM transport_configs WHERE tenant_id = ${otherTenantId}`);
  await db.execute(sql`DELETE FROM flows WHERE tenant_id = ${testTenantId}`);
  await db.execute(sql`DELETE FROM flows WHERE tenant_id = ${otherTenantId}`);
  // Reset tenant settings (brain_context tests mutate it).
  await db.execute(sql`UPDATE tenants SET settings = NULL WHERE id IN (${testTenantId}, ${otherTenantId})`);
});

afterAll(async () => {
  if (dbAvailable) await cleanup();
  await pool.end();
});

async function cleanup() {
  for (const slug of [SLUG, SLUG_OTHER]) {
    await db.execute(
      sql`DELETE FROM transport_configs WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${slug})`,
    );
    await db.execute(
      sql`DELETE FROM flows WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${slug})`,
    );
    await db.execute(sql`DELETE FROM tenants WHERE slug = ${slug}`);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal valid compiled plan with the given steps. */
function makePlan(steps: Array<{ order: number; brain_instruction?: string }>) {
  return {
    trigger: { type: "lifecycle_transition", condition: { from: "engaged", to: "at_risk" } },
    steps: steps.map((s) => ({
      order: s.order,
      action_type: "nurture_value",
      delay: "0m",
      ...(s.brain_instruction !== undefined ? { brain_instruction: s.brain_instruction } : {}),
    })),
  };
}

/**
 * Insert a flow with the given compiled_plan.
 * compiledPlan = null simulates a flow that has not been compiled yet.
 */
async function insertFlow(opts: {
  tenantId?: string;
  compiledPlan?: object | null;
}): Promise<string> {
  const tenantId = opts.tenantId ?? testTenantId;
  const [row] = await db
    .insert(flows)
    .values({
      tenantId,
      name: "Test Flow",
      priority: 0,
      triggerType: "lifecycle_transition",
      triggerConfig: { from: "engaged", to: "at_risk" },
      steps: [{ order: 1, action_type: "nurture_value", delay: "0m" }],
      status: "active",
      flowClass: "nurture",
      compiledPlan: opts.compiledPlan === undefined ? null : opts.compiledPlan,
    })
    .returning({ id: flows.id });
  return row!.id;
}

/** Insert an active transport config for the given tenant. */
async function insertTransport(opts: {
  tenantId?: string;
  fromName?: string | null;
}): Promise<void> {
  const tenantId = opts.tenantId ?? testTenantId;
  await db.insert(transportConfigs).values({
    tenantId,
    provider: "smtp",
    config: { host: "smtp.example.com" },
    isActive: true,
    fromEmail: "noreply@example.com",
    fromName: opts.fromName ?? null,
  });
}

// ---------------------------------------------------------------------------
// Tests: brain_instruction
// ---------------------------------------------------------------------------

describe("buildFlowStepSection", () => {
  it("skips all DB tests when DATABASE_URL is not reachable", () => {
    if (!dbAvailable) expect(true).toBe(true);
  });

  describe("brain_instruction - valid flow and step order", () => {
    it("returns the correct brain_instruction for a matching step", async () => {
      if (!dbAvailable) return;

      const plan = makePlan([
        { order: 1, brain_instruction: "Highlight features the user has not tried." },
        { order: 2, brain_instruction: "Send a we-miss-you follow-up." },
      ]);
      const flowId = await insertFlow({ compiledPlan: plan });

      const result = await buildFlowStepSection(db, testTenantId, flowId, 1);

      expect(result.brainInstruction).toBe("Highlight features the user has not tried.");
    });

    it("returns the correct brain_instruction for step 2 when multiple steps exist", async () => {
      if (!dbAvailable) return;

      const plan = makePlan([
        { order: 1, brain_instruction: "Step one instruction." },
        { order: 2, brain_instruction: "Step two instruction." },
      ]);
      const flowId = await insertFlow({ compiledPlan: plan });

      const result = await buildFlowStepSection(db, testTenantId, flowId, 2);

      expect(result.brainInstruction).toBe("Step two instruction.");
    });
  });

  // -------------------------------------------------------------------------
  // brain_instruction: step order beyond end of plan
  // -------------------------------------------------------------------------

  describe("brain_instruction - step order beyond end of plan", () => {
    it("returns brainInstruction=undefined when step_order exceeds plan length", async () => {
      if (!dbAvailable) return;

      // Plan has 2 steps (order 1 and 2); requesting order 3 must return absent
      const plan = makePlan([
        { order: 1, brain_instruction: "Step one." },
        { order: 2, brain_instruction: "Step two." },
      ]);
      const flowId = await insertFlow({ compiledPlan: plan });

      const result = await buildFlowStepSection(db, testTenantId, flowId, 3);

      expect(result.brainInstruction).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // brain_instruction: step with no instruction
  // -------------------------------------------------------------------------

  describe("brain_instruction - step carries no brain_instruction", () => {
    it("returns brainInstruction=undefined when the step has no brain_instruction field", async () => {
      if (!dbAvailable) return;

      // Step 1 has no brain_instruction (template-only step, for example)
      const plan = makePlan([{ order: 1 }]);
      const flowId = await insertFlow({ compiledPlan: plan });

      const result = await buildFlowStepSection(db, testTenantId, flowId, 1);

      expect(result.brainInstruction).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // brain_instruction: compiled_plan is null
  // -------------------------------------------------------------------------

  describe("brain_instruction - compiled_plan is null", () => {
    it("returns brainInstruction=undefined when the flow has no compiled plan", async () => {
      if (!dbAvailable) return;

      // Flow not yet compiled (compile_status pending or draft)
      const flowId = await insertFlow({ compiledPlan: null });

      const result = await buildFlowStepSection(db, testTenantId, flowId, 1);

      expect(result.brainInstruction).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // brain_instruction: compiled_plan fails schema validation (corrupt/stale data)
  // -------------------------------------------------------------------------

  describe("brain_instruction - compiled_plan fails schema validation", () => {
    it("returns brainInstruction=undefined and emits console.warn with flow context", async () => {
      if (!dbAvailable) return;

      // Insert a flow whose compiled_plan is structurally present but fails
      // compiledPlanSchema validation. The plan is missing the required 'steps'
      // array, so safeParse will return success=false.
      const corruptPlan = { trigger: { type: "lifecycle_transition" }, not_steps: [] };
      const flowId = await insertFlow({ compiledPlan: corruptPlan });

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const result = await buildFlowStepSection(db, testTenantId, flowId, 1);

        // Return value is still absent (correct behavior preserved)
        expect(result.brainInstruction).toBeUndefined();

        // The validation failure must have been surfaced via console.warn
        expect(warnSpy).toHaveBeenCalledOnce();
        const [warnMessage] = warnSpy.mock.calls[0] as [string];
        // Message must include enough context to identify the affected flow
        expect(warnMessage).toContain("[context-flow]");
        expect(warnMessage).toContain(flowId);
        expect(warnMessage).toContain(testTenantId);
        expect(warnMessage).toContain("1"); // step_order
        expect(warnMessage).toContain("schema validation failed");
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("does NOT emit console.warn for a normal null compiled_plan (expected absence)", async () => {
      if (!dbAvailable) return;

      const flowId = await insertFlow({ compiledPlan: null });

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        await buildFlowStepSection(db, testTenantId, flowId, 1);
        // null plan is a normal case: no warning should be emitted
        expect(warnSpy).not.toHaveBeenCalled();
      } finally {
        warnSpy.mockRestore();
      }
    });
  });

  // -------------------------------------------------------------------------
  // brain_instruction: tenant isolation
  // -------------------------------------------------------------------------

  describe("brain_instruction - tenant isolation", () => {
    it("does not read a flow belonging to another tenant", async () => {
      if (!dbAvailable) return;

      // Insert a flow in otherTenant with a brain_instruction
      const plan = makePlan([{ order: 1, brain_instruction: "Other tenant's instruction." }]);
      const otherFlowId = await insertFlow({ tenantId: otherTenantId, compiledPlan: plan });

      // Query with testTenantId - must not find otherTenant's flow
      const result = await buildFlowStepSection(db, testTenantId, otherFlowId, 1);

      // Flow not found for testTenantId -> brainInstruction absent
      expect(result.brainInstruction).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // sender_name: populated when active transport config has from_name
  // -------------------------------------------------------------------------

  describe("sender_name - active transport config with from_name", () => {
    it("resolves senderName from the active transport config's from_name", async () => {
      if (!dbAvailable) return;

      await insertTransport({ fromName: "Alice at Acme" });
      const flowId = await insertFlow({
        compiledPlan: makePlan([{ order: 1, brain_instruction: "Test." }]),
      });

      const result = await buildFlowStepSection(db, testTenantId, flowId, 1);

      expect(result.senderName).toBe("Alice at Acme");
    });
  });

  // -------------------------------------------------------------------------
  // sender_name: absent when from_name is null
  // -------------------------------------------------------------------------

  describe("sender_name - from_name is null", () => {
    it("returns senderName=undefined when the active config has from_name=null", async () => {
      if (!dbAvailable) return;

      await insertTransport({ fromName: null });
      const flowId = await insertFlow({ compiledPlan: null });

      const result = await buildFlowStepSection(db, testTenantId, flowId, 1);

      expect(result.senderName).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // sender_name: absent when no transport config exists
  // -------------------------------------------------------------------------

  describe("sender_name - no transport config", () => {
    it("returns senderName=undefined when no transport config exists (Phase 1 state)", async () => {
      if (!dbAvailable) return;

      // No transport config inserted for testTenantId (beforeEach clears them)
      const flowId = await insertFlow({ compiledPlan: null });

      const result = await buildFlowStepSection(db, testTenantId, flowId, 1);

      expect(result.senderName).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // product_name: resolved from tenants.name
  // -------------------------------------------------------------------------

  describe("product_name - resolved from tenant", () => {
    it("always resolves productName from tenants.name", async () => {
      if (!dbAvailable) return;

      const flowId = await insertFlow({ compiledPlan: null });

      const result = await buildFlowStepSection(db, testTenantId, flowId, 1);

      // testTenant was inserted with name "Acme Platform"
      expect(result.productName).toBe("Acme Platform");
    });

    it("productName for the other tenant resolves to its own name", async () => {
      if (!dbAvailable) return;

      const plan = makePlan([{ order: 1, brain_instruction: "Other tenant step." }]);
      const otherFlowId = await insertFlow({ tenantId: otherTenantId, compiledPlan: plan });

      // Query with otherTenantId to test its own product name
      const result = await buildFlowStepSection(db, otherTenantId, otherFlowId, 1);

      expect(result.productName).toBe("Other Tenant");
      expect(result.brainInstruction).toBe("Other tenant step.");
    });
  });

  // -------------------------------------------------------------------------
  // brain_context: resolved from tenants.settings.brain_context
  // -------------------------------------------------------------------------

  describe("brain_context - resolved from tenant settings", () => {
    it("returns brainContext when settings.brain_context is set", async () => {
      if (!dbAvailable) return;

      await db.execute(sql`
        UPDATE tenants
        SET settings = '{"brain_context":"Acme is a kanban tool. No Gantt charts."}'::jsonb
        WHERE id = ${testTenantId}
      `);
      const flowId = await insertFlow({ compiledPlan: null });

      const result = await buildFlowStepSection(db, testTenantId, flowId, 1);

      expect(result.brainContext).toBe("Acme is a kanban tool. No Gantt charts.");
    });

    it("returns brainContext=undefined when the tenant has no settings", async () => {
      if (!dbAvailable) return;

      const flowId = await insertFlow({ compiledPlan: null });

      const result = await buildFlowStepSection(db, testTenantId, flowId, 1);

      expect(result.brainContext).toBeUndefined();
    });

    it("returns brainContext=undefined when brain_context is not a string (corrupt settings)", async () => {
      if (!dbAvailable) return;

      await db.execute(sql`
        UPDATE tenants
        SET settings = '{"brain_context":42}'::jsonb
        WHERE id = ${testTenantId}
      `);
      const flowId = await insertFlow({ compiledPlan: null });

      const result = await buildFlowStepSection(db, testTenantId, flowId, 1);

      expect(result.brainContext).toBeUndefined();
    });

    it("does not leak another tenant's brain_context", async () => {
      if (!dbAvailable) return;

      await db.execute(sql`
        UPDATE tenants
        SET settings = '{"brain_context":"Other tenant context."}'::jsonb
        WHERE id = ${otherTenantId}
      `);
      const flowId = await insertFlow({ compiledPlan: null });

      const result = await buildFlowStepSection(db, testTenantId, flowId, 1);

      expect(result.brainContext).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Combined: all fields present together
  // -------------------------------------------------------------------------

  describe("combined: all fields resolve correctly in a single call", () => {
    it("populates brainInstruction, senderName, and productName together", async () => {
      if (!dbAvailable) return;

      await insertTransport({ fromName: "Bob Smith" });
      const plan = makePlan([
        { order: 1, brain_instruction: "Welcome them warmly." },
        { order: 2 },
      ]);
      const flowId = await insertFlow({ compiledPlan: plan });

      const result = await buildFlowStepSection(db, testTenantId, flowId, 1);

      expect(result.brainInstruction).toBe("Welcome them warmly.");
      expect(result.senderName).toBe("Bob Smith");
      expect(result.productName).toBe("Acme Platform");
    });
  });
});
