/**
 * The condition evaluator, without a database: a fake event lookup records what it was asked, so the time
 * windows, counts and short-circuiting can be checked exactly.
 */
import { describe, it, expect } from "vitest";
import {
  evaluateStepCondition,
  evaluatePlanExitCondition,
  type ContactState,
  type EventChecker,
} from "../src/condition-evaluator.js";

const DAY = 86_400_000;
const NOW = new Date("2026-07-20T12:00:00Z");
const ENTERED = new Date(NOW.getTime() - 10 * DAY);
const STEP_REACHED = new Date(NOW.getTime() - 2 * DAY);

/** Events as [name, ms before NOW]. Records every question asked. */
function events(list: Array<[string, number]> = [], opts: { counting?: boolean } = {}) {
  const asked: Array<{ name: string; since: Date; limit?: number }> = [];
  const within = (name: string, since: Date) =>
    list.filter(([n, ago]) => n === name && NOW.getTime() - ago >= since.getTime());
  const checker: EventChecker = {
    async hasEventSince(name, since) {
      asked.push({ name, since });
      return within(name, since).length > 0;
    },
  };
  if (opts.counting !== false) {
    checker.countEventsSince = async (name, since, limit) => {
      asked.push({ name, since, limit });
      return Math.min(within(name, since).length, limit);
    };
  }
  return { checker, asked };
}

const contact = (over: Partial<ContactState> = {}): ContactState => ({
  lifecycleState: "engaged",
  paymentStatus: "paid",
  engagementDepth: "regular",
  email: "a@b.c",
  properties: { plan: "Pro", seats: 12, country: "Ghana" },
  ...over,
});

const step = (condition: unknown, c = contact(), ev = events()) =>
  evaluateStepCondition(condition, c, ev.checker, STEP_REACHED, { now: NOW, enteredAt: ENTERED }).then((r) => r.outcome);

describe("the original shapes", () => {
  it("lifecycle state is / is not, and event since the step", async () => {
    expect(await step({ lifecycle_state: "engaged" })).toBe("pass");
    expect(await step({ lifecycle_state: "dormant" })).toBe("fail");
    expect(await step({ lifecycle_state_not: "dormant" })).toBe("pass");
    expect(await step({ event_since_step: "x" }, contact(), events([["x", DAY]]))).toBe("pass");
    expect(await step({ event_since_step: "x" }, contact(), events([["x", 5 * DAY]]))).toBe("fail");
  });
});

describe("contact fields", () => {
  it("payment status, plan, engagement, email, traits", async () => {
    expect(await step({ field: "payment_status", op: "is", value: "paid" })).toBe("pass");
    expect(await step({ field: "payment_status", op: "in", value: ["free", "trial"] })).toBe("fail");
    expect(await step({ field: "plan", op: "is", value: "pro" })).toBe("pass");
    expect(await step({ field: "engagement_depth", op: "is_not", value: "power" })).toBe("pass");
    expect(await step({ field: "has_email", op: "is", value: false })).toBe("fail");
    expect(await step({ field: "trait", key: "seats", op: "gt", value: 10 })).toBe("pass");
    expect(await step({ field: "trait", key: "country", op: "is", value: "Kenya" })).toBe("fail");
  });

  it("a field the caller did not supply counts as not set", async () => {
    const bare: ContactState = { lifecycleState: "engaged" };
    expect(await step({ field: "payment_status", op: "is", value: "paid" }, bare)).toBe("fail");
    expect(await step({ field: "plan", op: "is_not", value: "Pro" }, bare)).toBe("pass");
    expect(await step({ field: "has_email", op: "is", value: false }, bare)).toBe("pass");
    expect(await step({ field: "trait", key: "x", op: "is_not_set" }, bare)).toBe("pass");
  });
});

describe("event conditions", () => {
  it("not_performed within N days: only recent events count", async () => {
    const c = { field: "event", name: "exported", op: "not_performed", within_days: 7 };
    expect(await step(c, contact(), events([["exported", 3 * DAY]]))).toBe("fail");
    expect(await step(c, contact(), events([["exported", 9 * DAY]]))).toBe("pass");
    expect(await step(c, contact(), events([]))).toBe("pass");
  });

  it("performed within N days measures back from now, not from the step", async () => {
    const ev = events([["login", 2.5 * DAY]]);
    expect(await step({ field: "event", name: "login", op: "performed", within_days: 3 }, contact(), ev)).toBe("pass");
    expect(ev.asked[0]!.since.getTime()).toBe(NOW.getTime() - 3 * DAY);
  });

  it("since step starts at the step's reference time, since flow at entry", async () => {
    const e = [["login", 5 * DAY]] as Array<[string, number]>; // after entry, before the step
    expect(await step({ field: "event", name: "login", op: "performed", since: "step" }, contact(), events(e))).toBe("fail");
    expect(await step({ field: "event", name: "login", op: "performed", since: "flow" }, contact(), events(e))).toBe("pass");
    const old = [["login", 20 * DAY]] as Array<[string, number]>; // before entry
    expect(await step({ field: "event", name: "login", op: "performed", since: "flow" }, contact(), events(old))).toBe("fail");
  });

  it("min_count needs that many, and never reads more than that", async () => {
    const e = [["login", DAY], ["login", 2 * DAY], ["login", 3 * DAY], ["login", 4 * DAY]] as Array<[string, number]>;
    const three = { field: "event", name: "login", op: "performed", since: "flow", min_count: 3 };
    const ev = events(e);
    expect(await step(three, contact(), ev)).toBe("pass");
    expect(ev.asked[0]!.limit).toBe(3);
    expect(await step({ ...three, min_count: 5 }, contact(), events(e))).toBe("fail");
  });

  it("min_count without a counting lookup is reported, not guessed", async () => {
    const r = await evaluateStepCondition(
      { field: "event", name: "x", op: "performed", since: "flow", min_count: 2 },
      contact(),
      events([], { counting: false }).checker,
      STEP_REACHED,
    );
    expect(r.outcome).toBe("unknown_shape");
  });

  it("older callers that pass no times still work", async () => {
    const r = await evaluateStepCondition(
      { field: "event", name: "x", op: "not_performed", since: "flow" },
      contact(),
      events([]).checker,
      STEP_REACHED,
    );
    expect(r.outcome).toBe("pass");
  });
});

describe("groups", () => {
  it("all needs every check, any needs one", async () => {
    const yes = { field: "payment_status", op: "is", value: "paid" };
    const no = { field: "payment_status", op: "is", value: "free" };
    expect(await step({ all: [yes, yes] })).toBe("pass");
    expect(await step({ all: [yes, no] })).toBe("fail");
    expect(await step({ any: [no, yes] })).toBe("pass");
    expect(await step({ any: [no, no] })).toBe("fail");
  });

  it("nests, mixing contact fields and events", async () => {
    const cond = {
      all: [
        { field: "payment_status", op: "is", value: "paid" },
        {
          any: [
            { field: "event", name: "a", op: "performed", since: "flow" },
            { field: "event", name: "b", op: "performed", since: "flow" },
          ],
        },
      ],
    };
    expect(await step(cond, contact(), events([["b", DAY]]))).toBe("pass");
    expect(await step(cond, contact(), events([]))).toBe("fail");
    expect(await step(cond, contact({ paymentStatus: "free" }), events([["b", DAY]]))).toBe("fail");
  });

  it("stops at the first answer, so later event checks are not even queried", async () => {
    const ev = events([["a", DAY]]);
    await step(
      { all: [{ field: "payment_status", op: "is", value: "free" }, { field: "event", name: "a", op: "performed", since: "flow" }] },
      contact(),
      ev,
    );
    expect(ev.asked).toHaveLength(0); // the first check already failed
    const ev2 = events([["a", DAY]]);
    await step(
      { any: [{ field: "event", name: "a", op: "performed", since: "flow" }, { field: "event", name: "b", op: "performed", since: "flow" }] },
      contact(),
      ev2,
    );
    expect(ev2.asked.map((q) => q.name)).toEqual(["a"]); // the first check already passed
  });
});

describe("shapes it does not know", () => {
  it.each([
    { favourite_colour: "red" },
    { field: "hair", op: "is", value: "x" },
    { field: "event", name: "x", op: "performed" }, // no window
    { all: [] },
    { all: [{ nope: 1 }] },
    "paid",
    null,
  ])("%j is reported, never guessed at", async (bad) => {
    expect(await step(bad)).toBe("unknown_shape");
  });
});

describe("plan-level exits", () => {
  const exit = (ec: unknown, c = contact(), ev = events()) =>
    evaluatePlanExitCondition(ec, c, ev.checker, ENTERED, { now: NOW }).then((r) => r.outcome);

  it("the original shapes still work", async () => {
    expect(await exit({ event: "upgraded" }, contact(), events([["upgraded", DAY]]))).toBe("pass");
    expect(await exit({ event: "upgraded" }, contact(), events([["upgraded", 20 * DAY]]))).toBe("fail");
    expect(await exit({ lifecycle_state_change: { to: "engaged" } })).toBe("pass");
  });

  it("{ condition } takes any condition, judged from entry", async () => {
    const cond = {
      condition: {
        any: [
          { field: "payment_status", op: "is", value: "cancelled" },
          { field: "event", name: "upgraded", op: "performed", since: "flow" },
        ],
      },
    };
    expect(await exit(cond, contact(), events([["upgraded", 3 * DAY]]))).toBe("pass");
    expect(await exit(cond, contact({ paymentStatus: "cancelled" }))).toBe("pass");
    expect(await exit(cond, contact(), events([["upgraded", 20 * DAY]]))).toBe("fail");
  });

  it("'since step' means since entry at the plan level", async () => {
    const ev = events([["x", 5 * DAY]]);
    expect(await exit({ condition: { field: "event", name: "x", op: "performed", since: "step" } }, contact(), ev)).toBe("pass");
  });

  it("refuses a bad { condition }, and one with company", async () => {
    expect(await exit({ condition: { nope: 1 } })).toBe("unknown_shape");
    expect(await exit({ condition: { lifecycle_state: "x" }, event: "y" })).toBe("unknown_shape");
  });
});
