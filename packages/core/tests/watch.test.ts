/**
 * Which events can make a flow condition newly true (what the instant wake-up listens for).
 */
import { describe, it, expect } from "vitest";
import { conditionEventNames, planExitEventNames } from "../src/index.js";

const did = (name: string, extra: Record<string, unknown> = {}) => ({ field: "event", name, op: "performed", since: "flow", ...extra });
const names = (c: unknown) => [...conditionEventNames(c)].sort();

describe("conditionEventNames", () => {
  it("a 'did X' leaf watches X, whatever its window", () => {
    expect(names(did("a"))).toEqual(["a"]);
    expect(names({ field: "event", name: "b", op: "performed", within_days: 7 })).toEqual(["b"]);
    expect(names(did("c", { min_count: 3 }))).toEqual(["c"]);
  });

  it("the original 'happened since this step' shape watches its event", () => {
    expect(names({ event_since_step: "feature_used" })).toEqual(["feature_used"]);
  });

  it("'did not do X' is not watched: X arriving can only make it false", () => {
    expect(names({ field: "event", name: "x", op: "not_performed", within_days: 7 })).toEqual([]);
  });

  it("contact facts and lifecycle stages are not about events", () => {
    expect(names({ field: "payment_status", op: "is", value: "paid" })).toEqual([]);
    expect(names({ lifecycle_state: "engaged" })).toEqual([]);
    expect(names({ lifecycle_state_not: "churned" })).toEqual([]);
  });

  it("walks groups, including nested ones, and collects each name once", () => {
    const c = { all: [did("a"), { any: [did("b"), { field: "plan", op: "is", value: "Pro" }, did("a")] }] };
    expect(names(c)).toEqual(["a", "b"]);
  });

  it("a group mixing watched and unwatched leaves watches only the events that can help", () => {
    expect(names({ all: [did("a"), { field: "event", name: "z", op: "not_performed", within_days: 1 }] })).toEqual(["a"]);
  });

  it("never throws on anything, and gives nothing for it", () => {
    for (const odd of [null, undefined, 3, "x", [], {}, { all: "no" }, { any: [null, 4] }, { field: "event" }, { field: "event", op: "performed", name: 5 }]) {
      expect(() => conditionEventNames(odd)).not.toThrow();
      expect(names(odd), JSON.stringify(odd)).toEqual([]);
    }
  });

  it("stops at a sensible depth instead of recursing forever", () => {
    let deep: unknown = did("deep");
    for (let i = 0; i < 50; i++) deep = { all: [deep] };
    expect(() => conditionEventNames(deep)).not.toThrow();
  });
});

describe("planExitEventNames", () => {
  it("the four exit shapes", () => {
    expect([...planExitEventNames({ event: "cancelled" })]).toEqual(["cancelled"]);
    expect([...planExitEventNames({ event: "cancelled", lifecycle_state_change: { to: "churned" } })]).toEqual(["cancelled"]);
    expect([...planExitEventNames({ lifecycle_state_change: { to: "churned" } })]).toEqual([]);
    expect([...planExitEventNames({ condition: did("paid") })]).toEqual(["paid"]);
    expect([...planExitEventNames({ condition: { field: "payment_status", op: "is", value: "cancelled" } })]).toEqual([]);
  });

  it("never throws on odd input", () => {
    for (const odd of [null, undefined, 3, "x", [], {}, { event: 5 }, { condition: null }]) {
      expect(() => planExitEventNames(odd)).not.toThrow();
      expect(planExitEventNames(odd).size, JSON.stringify(odd)).toBe(0);
    }
  });
});
