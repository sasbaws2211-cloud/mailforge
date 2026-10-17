/**
 * Random splits (A/B tests and holdouts): who goes where, the plan format, and the comparison of two versions.
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import {
  compareVersions,
  compiledPlanSchema,
  splitBucket,
  splitVersion,
  splitPathSteps,
  SPLIT_MIN_PER_VERSION,
  SPLIT_MIN_TOTAL_CONVERSIONS,
} from "../src/index.js";

describe("who goes down which path", () => {
  it("is fixed: the same membership at the same split always gets the same answer", () => {
    const id = randomUUID();
    const first = splitVersion(id, 3, 50);
    for (let i = 0; i < 50; i++) expect(splitVersion(id, 3, 50)).toBe(first);
    expect(splitBucket(id, 3)).toBe(splitBucket(id, 3));
  });

  it("the bucket is always in [0, 100)", () => {
    for (let i = 0; i < 5000; i++) {
      const b = splitBucket(randomUUID(), 1 + (i % 7));
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThan(100);
    }
  });

  it("shares match the requested percentages over many memberships", () => {
    const ids = Array.from({ length: 50_000 }, () => randomUUID());
    for (const pct of [1, 10, 25, 50, 75, 90, 99]) {
      const a = ids.filter((id) => splitVersion(id, 1, pct) === "a").length;
      const share = (a / ids.length) * 100;
      // 50,000 draws: the standard error is at most 0.23 points; allow about 5 of them.
      expect(Math.abs(share - pct), `${pct}%: got ${share.toFixed(2)}%`).toBeLessThan(1.2);
    }
  });

  it("different splits in one flow are independent of each other", () => {
    const ids = Array.from({ length: 50_000 }, () => randomUUID());
    const both = ids.filter((id) => splitVersion(id, 1, 50) === "a" && splitVersion(id, 2, 50) === "a").length;
    // Independent: about 25% land in A for both. If the second split copied the first it would be 50%.
    expect(Math.abs((both / ids.length) * 100 - 25)).toBeLessThan(1.2);
  });

  it("memberships created one after another do not land in runs", () => {
    // Sequential-looking ids (a counter) must still spread: no long streaks of one version.
    const versions = Array.from({ length: 2000 }, (_, i) => splitVersion(`00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, 1, 50));
    let longest = 0;
    let run = 0;
    for (let i = 0; i < versions.length; i++) {
      run = i > 0 && versions[i] === versions[i - 1] ? run + 1 : 1;
      longest = Math.max(longest, run);
    }
    expect(longest).toBeLessThan(25); // a fair coin over 2000 flips almost never runs past ~14
    const a = versions.filter((v) => v === "a").length;
    expect(Math.abs((a / versions.length) * 100 - 50)).toBeLessThan(4);
  });

  it("a larger percent only ever adds people to version A (raising it never moves anyone from A to B)", () => {
    for (let i = 0; i < 2000; i++) {
      const id = randomUUID();
      if (splitVersion(id, 1, 30) === "a") expect(splitVersion(id, 1, 60)).toBe("a");
    }
  });
});

describe("a random split in a plan", () => {
  const plan = (branch: Record<string, unknown>) => ({
    version: 2,
    trigger: { type: "event", condition: {} },
    steps: [
      { order: 2, action_type: "nurture_value", delay: "0m", next: "end" },
      { order: 3, action_type: "nurture_reactivate", delay: "0m", next: "end" },
    ],
    branches: [{ order: 1, delay: "0m", then: 2, else: 3, ...branch }],
  });
  const ok = (branch: Record<string, unknown>) => compiledPlanSchema.safeParse(plan(branch));
  const cond = { field: "payment_status", op: "is", value: "paid" };

  it("accepts a split with a percentage from 1 to 99", () => {
    for (const p of [1, 50, 99]) expect(ok({ split: { percent_a: p } }).success, String(p)).toBe(true);
  });

  it("refuses a percentage outside 1 to 99, or not a whole number", () => {
    for (const p of [0, 100, -5, 50.5, "50", null]) expect(ok({ split: { percent_a: p } }).success, String(p)).toBe(false);
  });

  it("refuses a split with other keys, and one without a percentage", () => {
    expect(ok({ split: { percent_a: 50, extra: 1 } }).success).toBe(false);
    expect(ok({ split: {} }).success).toBe(false);
  });

  it("is a split or a condition, never both and never neither", () => {
    const both = ok({ split: { percent_a: 50 }, condition: cond });
    expect(both.success).toBe(false);
    expect(JSON.stringify(both.error?.issues)).toMatch(/one or the other/);
    const neither = ok({});
    expect(neither.success).toBe(false);
    expect(JSON.stringify(neither.error?.issues)).toMatch(/condition, or a random split/);
    expect(ok({ condition: cond }).success).toBe(true);
  });

  it("cannot be a wait-until fork", () => {
    const r = ok({ split: { percent_a: 50 }, early: true, delay: "3d" });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toMatch(/wait-until/);
  });

  it("a holdout (one path is end) is a valid plan, and keeps its split when parsed", () => {
    const holdout = {
      version: 2,
      trigger: { type: "event", condition: {} },
      steps: [{ order: 2, action_type: "nurture_value", delay: "0m", next: "end" }],
      branches: [{ order: 1, delay: "0m", split: { percent_a: 90 }, then: 2, else: "end" }],
    };
    const r = compiledPlanSchema.safeParse(holdout);
    expect(r.success && r.data.branches?.[0]).toMatchObject({ split: { percent_a: 90 }, else: "end" });
  });

  it("the usual graph rules still apply: a split to a node that does not exist is refused", () => {
    expect(ok({ split: { percent_a: 50 }, then: 9 }).success).toBe(false);
  });
});

describe("comparing two versions", () => {
  it("a clear difference with enough people picks the better version", () => {
    // A 100/1000 = 10%, B 150/1000 = 15%: z is about 3.4, p under 0.001
    const r = compareVersions({ n: 1000, k: 100 }, { n: 1000, k: 150 });
    expect(r.verdict).toBe("b_better");
    expect(r.rateA).toBeCloseTo(0.1, 6);
    expect(r.rateB).toBeCloseTo(0.15, 6);
    expect(r.difference).toBeCloseTo(0.05, 6);
    expect(r.pValue!).toBeLessThan(0.001);
    expect(r.pValue!).toBeGreaterThan(0.0003);
  });

  it("is symmetric: swapping the versions swaps the verdict and keeps the p-value", () => {
    const x = compareVersions({ n: 1000, k: 150 }, { n: 1000, k: 100 });
    expect(x.verdict).toBe("a_better");
    expect(x.pValue).toBeCloseTo(compareVersions({ n: 1000, k: 100 }, { n: 1000, k: 150 }).pValue!, 10);
  });

  it("matches a worked example done by hand (20 of 100 against 28 of 100 gives p of about 0.185)", () => {
    // pooled = 48/200 = 0.24; se = sqrt(0.24*0.76*(2/100)) = 0.060399; z = 0.08/0.060399 = 1.3245; two-sided p = 0.1853
    const r = compareVersions({ n: 100, k: 20 }, { n: 100, k: 28 });
    expect(r.pValue!).toBeCloseTo(0.1853, 3);
    expect(r.verdict).toBe("no_difference");
  });

  it("a small difference is called no difference, not a winner", () => {
    expect(compareVersions({ n: 500, k: 50 }, { n: 500, k: 55 }).verdict).toBe("no_difference");
  });

  it("is too early with few people in either version", () => {
    expect(compareVersions({ n: SPLIT_MIN_PER_VERSION - 1, k: 20 }, { n: 1000, k: 100 }).verdict).toBe("too_early");
    expect(compareVersions({ n: 1000, k: 100 }, { n: SPLIT_MIN_PER_VERSION - 1, k: 20 }).verdict).toBe("too_early");
    expect(compareVersions({ n: SPLIT_MIN_PER_VERSION, k: 5 }, { n: SPLIT_MIN_PER_VERSION, k: 6 }).verdict).not.toBe("too_early");
  });

  it("is too early with too few conversions overall, however many people", () => {
    expect(compareVersions({ n: 5000, k: 2 }, { n: 5000, k: SPLIT_MIN_TOTAL_CONVERSIONS - 3 }).verdict).toBe("too_early");
    expect(compareVersions({ n: 5000, k: 4 }, { n: 5000, k: SPLIT_MIN_TOTAL_CONVERSIONS - 4 }).verdict).not.toBe("too_early");
  });

  it("too early still reports the rates, with no p-value", () => {
    const r = compareVersions({ n: 10, k: 5 }, { n: 10, k: 1 });
    expect(r).toMatchObject({ verdict: "too_early", pValue: null });
    expect(r.rateA).toBeCloseTo(0.5, 6);
    expect(r.rateB).toBeCloseTo(0.1, 6);
  });

  it("copes with nobody, everybody, and nobody converting", () => {
    expect(compareVersions({ n: 0, k: 0 }, { n: 0, k: 0 })).toMatchObject({ verdict: "too_early", rateA: null, rateB: null, difference: null });
    expect(compareVersions({ n: 100, k: 100 }, { n: 100, k: 100 }).verdict).toBe("no_difference");
    expect(compareVersions({ n: 100, k: 0 }, { n: 100, k: 0 }).verdict).toBe("too_early"); // under the conversions floor
  });

  it("never throws on nonsense, and says too early", () => {
    for (const bad of [{ n: -1, k: 0 }, { n: 10, k: 11 }, { n: Number.NaN, k: 1 }, { n: Infinity, k: 1 }]) {
      expect(() => compareVersions(bad, { n: 100, k: 10 })).not.toThrow();
      expect(compareVersions(bad, { n: 100, k: 10 }).verdict).toBe("too_early");
    }
  });
});

describe("which emails sit on each path of a split", () => {
  const e = (order: number, next?: number | "end") => ({ order, ...(next !== undefined ? { next } : {}) });

  it("lists the emails down each path, in order", () => {
    const plan = { steps: [e(2, 4), e(3, "end"), e(4, "end")], branches: [{ order: 1, then: 2, else: 3 }] };
    expect(splitPathSteps(plan, 1)).toEqual({ a: [2, 4], b: [3] });
  });

  it("a holdout path has no emails", () => {
    const plan = { steps: [e(2, "end")], branches: [{ order: 1, then: 2, else: "end" }] };
    expect(splitPathSteps(plan, 1)).toEqual({ a: [2], b: [] });
  });

  it("follows later forks and shared steps, and does not count emails before the split", () => {
    const plan = {
      steps: [e(1, 2), e(3, 5), e(4, 5), e(5, "end")],
      branches: [{ order: 2, then: 3, else: 4 }],
    };
    expect(splitPathSteps(plan, 2)).toEqual({ a: [3, 5], b: [4, 5] }); // email 1 is before the split: on neither path
    const nested = { steps: [e(3, "end"), e(4, "end"), e(5, "end")], branches: [{ order: 1, then: 2, else: 5 }, { order: 2, then: 3, else: 4 }] };
    expect(splitPathSteps(nested, 1)).toEqual({ a: [3, 4], b: [5] });
  });

  it("an email with no next goes to the next higher order, like the engine", () => {
    const plan = { steps: [e(2), e(3)], branches: [{ order: 1, then: 2, else: "end" }] };
    expect(splitPathSteps(plan, 1)).toEqual({ a: [2, 3], b: [] });
  });

  it("returns null for something that is not a node, and never loops on a bad plan", () => {
    expect(splitPathSteps({ steps: [e(2, "end")], branches: [{ order: 1, then: 2, else: 2 }] }, 7)).toBeNull();
    expect(splitPathSteps(null, 1)).toBeNull();
    const loop = { steps: [e(2, 3), e(3, 2)], branches: [{ order: 1, then: 2, else: 3 }] };
    expect(() => splitPathSteps(loop, 1)).not.toThrow();
    expect(splitPathSteps(loop, 1)).toEqual({ a: [2, 3], b: [2, 3] });
  });
});
