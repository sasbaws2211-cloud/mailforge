/**
 * Flow goals: the schema both the API and the engine rely on.
 */
import { describe, it, expect } from "vitest";
import { flowGoalSchema, readFlowGoal, GOAL_DEFAULT_WINDOW_DAYS, GOAL_MAX_WINDOW_DAYS } from "../src/index.js";

const event = { field: "event", name: "project_created", op: "performed", since: "flow" };
const ok = (g: Record<string, unknown>) => flowGoalSchema.safeParse(g);

describe("flowGoalSchema", () => {
  it("fills in the defaults: 30 days, leave the flow on success", () => {
    const r = ok({ name: "Created a project", condition: event });
    expect(r.success && r.data).toEqual({ name: "Created a project", condition: event, window_days: GOAL_DEFAULT_WINDOW_DAYS, exit_on_conversion: true });
    expect(GOAL_DEFAULT_WINDOW_DAYS).toBe(30);
  });

  it("trims the name", () => {
    const r = ok({ name: "  Paid  ", condition: event });
    expect(r.success && r.data.name).toBe("Paid");
  });

  it("accepts any condition from the shared vocabulary", () => {
    for (const condition of [
      event,
      { field: "payment_status", op: "is", value: "paid" },
      { lifecycle_state: "engaged" },
      { all: [event, { field: "plan", op: "is", value: "Pro" }] },
      { any: [event, { lifecycle_state: "engaged" }] },
    ]) {
      expect(ok({ name: "x", condition }).success, JSON.stringify(condition)).toBe(true);
    }
  });

  it("refuses an empty or too-long name", () => {
    expect(ok({ name: "", condition: event }).success).toBe(false);
    expect(ok({ name: "   ", condition: event }).success).toBe(false);
    expect(ok({ name: "x".repeat(81), condition: event }).success).toBe(false);
    expect(ok({ name: "x".repeat(80), condition: event }).success).toBe(true);
  });

  it("needs a condition the engine understands", () => {
    expect(ok({ name: "x" }).success).toBe(false);
    expect(ok({ name: "x", condition: { nope: 1 } }).success).toBe(false);
    expect(ok({ name: "x", condition: null }).success).toBe(false);
  });

  it("keeps the window between 1 and 90 whole days", () => {
    expect(GOAL_MAX_WINDOW_DAYS).toBe(90);
    for (const days of [1, 7, 90]) expect(ok({ name: "x", condition: event, window_days: days }).success, String(days)).toBe(true);
    for (const days of [0, -1, 91, 2.5, "30", Number.NaN]) expect(ok({ name: "x", condition: event, window_days: days }).success, String(days)).toBe(false);
  });

  it("exit_on_conversion must be a boolean, and either value is fine", () => {
    expect(ok({ name: "x", condition: event, exit_on_conversion: false }).success).toBe(true);
    expect(ok({ name: "x", condition: event, exit_on_conversion: "no" }).success).toBe(false);
  });

  it("refuses keys it does not know", () => {
    expect(ok({ name: "x", condition: event, colour: "red" }).success).toBe(false);
  });
});

describe("readFlowGoal", () => {
  it("returns a valid stored goal, with defaults filled", () => {
    expect(readFlowGoal({ name: "x", condition: event })).toMatchObject({ name: "x", window_days: 30, exit_on_conversion: true });
  });

  it("returns null for nothing, and for anything that is no longer valid, never throwing", () => {
    for (const bad of [null, undefined, {}, "goal", 3, [], { name: "", condition: event }, { name: "x", condition: { nope: 1 } }, { name: "x", condition: event, window_days: 500 }]) {
      expect(readFlowGoal(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});
