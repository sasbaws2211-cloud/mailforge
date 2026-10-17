/**
 * Trigger audience in the enrollment guard, without a database.
 *
 * attemptEnrollment loads the contact row first. A fake db that serves that row and then throws on any further
 * query shows two things: a mismatch or unreadable audience stops enrollment BEFORE the suppression, concurrency
 * and re-entry guards (so a failed audience can never evict a running flow), and a match goes on to them.
 *
 * The same behaviour against real rows is covered in enrollment.db.test.ts ("trigger audience").
 */
import { describe, it, expect, vi } from "vitest";
import { attemptEnrollment } from "../src/enroll.js";
import type { EnrollableFlow } from "@loomail/core";

const REACHED_NEXT_GUARD = "reached the guards after the audience";

function fakeDb(contactRow: Record<string, unknown> | null) {
  let selects = 0;
  const db = {
    select: vi.fn(() => {
      selects++;
      if (selects > 1) throw new Error(REACHED_NEXT_GUARD);
      return { from: () => ({ where: () => ({ limit: () => Promise.resolve(contactRow ? [contactRow] : []) }) }) };
    }),
    update: vi.fn(),
    insert: vi.fn(),
  };
  return db;
}

const contact = (over: Record<string, unknown> = {}) => ({
  email: "a@b.c",
  paymentStatus: "paid",
  engagementDepth: "regular",
  properties: { plan: "Pro" },
  ...over,
});

const flow = (triggerType: string, triggerConfig: unknown): EnrollableFlow => ({
  id: "flow-1",
  tenantId: "t-1",
  priority: 5,
  triggerType: triggerType as EnrollableFlow["triggerType"],
  triggerConfig,
  flowClass: "nurture",
  reentryPolicy: "cooldown",
  reentryCooldownDays: 30,
});

const paid = { conditions: [{ field: "payment_status", op: "is", value: "paid" }] };
const NOW = new Date("2026-07-20T12:00:00Z");
const run = (db: ReturnType<typeof fakeDb>, f: EnrollableFlow) =>
  attemptEnrollment(db as never, { flow: f, tenantId: "t-1", contactId: "c-1" }, NOW);

describe("attemptEnrollment - trigger audience", () => {
  it("stops on a mismatch before any other guard, touching nothing", async () => {
    const db = fakeDb(contact({ paymentStatus: "free" }));
    const result = await run(db, flow("lifecycle_transition", { from: "engaged", to: "at_risk", audience: paid }));
    expect(result).toEqual({ enrolled: false, reason: "audience_mismatch" });
    expect(db.select).toHaveBeenCalledTimes(1);
    expect(db.update).not.toHaveBeenCalled(); // no eviction of a running flow
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("goes on to the other guards on a match", async () => {
    const db = fakeDb(contact());
    await expect(run(db, flow("event", { event: "x", audience: paid }))).rejects.toThrow(REACHED_NEXT_GUARD);
  });

  it("does not enroll on an audience it cannot read", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const db = fakeDb(contact());
    const result = await run(db, flow("event", { event: "x", audience: { conditions: [{ field: "hair", op: "is", value: "red" }] } }));
    expect(result).toEqual({ enrolled: false, reason: "audience_invalid" });
    expect(db.select).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("skips the check when there is no audience", async () => {
    const db = fakeDb(contact({ paymentStatus: "free" }));
    await expect(run(db, flow("event", { event: "x" }))).rejects.toThrow(REACHED_NEXT_GUARD);
  });

  it("does not apply to segment triggers", async () => {
    const db = fakeDb(contact({ paymentStatus: "free" }));
    await expect(
      run(db, flow("segment", { tenure_bucket: "new", recency_bucket: "active", audience: paid })),
    ).rejects.toThrow(REACHED_NEXT_GUARD);
  });

  it("reports a contact that no longer exists", async () => {
    const db = fakeDb(null);
    const result = await run(db, flow("event", { event: "x", audience: paid }));
    expect(result).toEqual({ enrolled: false, reason: "contact_not_found" });
  });
});
